import { appendFile, readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { WakaTimeHeartbeat } from './types.js';
import { WakaTimeClient } from './wakatime.js';

export class HeartbeatCache {
  private cachePath: string;
  /** 动态读取：WebUI 更新 cache_limit 后无需重建实例即可生效 */
  private config: { cache_limit: number };
  /**
   * flush 串行链：多会话同时触发 flush 时依次执行，
   * 杜绝「并发读同一缓存文件 → 双份上报」的竞态。
   */
  private flushChain: Promise<void> = Promise.resolve();
  /** 尚未被 takeDropped() 取走的裁剪统计。 */
  private lastDrop: { count: number; from: number; to: number } | null = null;

  /** 进程生命周期内累计被裁剪的心跳条数（仅用于日志与诊断）。 */
  private droppedTotal = 0;

  constructor(config: { cache_limit: number }) {
    this.config = config;
    // os.homedir()：POSIX 优先 $HOME，Windows 取 USERPROFILE（测试可覆盖 HOME 重定向）
    this.cachePath = join(homedir(), '.dsh', 'wakatime', 'heartbeat-cache.jsonl');
  }

  async append(heartbeat: WakaTimeHeartbeat): Promise<void> {
    await mkdir(dirname(this.cachePath), { recursive: true });
    const line = JSON.stringify(heartbeat) + '\n';
    await appendFile(this.cachePath, line);
    await this.enforceLimit();
  }

  /**
   * Append multiple heartbeats in a single write operation
   */
  async appendBatch(heartbeats: WakaTimeHeartbeat[]): Promise<void> {
    if (heartbeats.length === 0) return;
    await mkdir(dirname(this.cachePath), { recursive: true });
    const lines = heartbeats.map(hb => JSON.stringify(hb) + '\n').join('');
    await appendFile(this.cachePath, lines);
    await this.enforceLimit();
  }

  async readAll(): Promise<WakaTimeHeartbeat[]> {
    if (!existsSync(this.cachePath)) return [];
    const content = await readFile(this.cachePath, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    return lines.map(l => JSON.parse(l));
  }

  async clear(): Promise<void> {
    if (existsSync(this.cachePath)) {
      await writeFile(this.cachePath, '');
    }
  }

  async count(): Promise<number> {
    if (!existsSync(this.cachePath)) return 0;
    const content = await readFile(this.cachePath, 'utf-8');
    return content.split('\n').filter(Boolean).length;
  }

  /**
   * Flush cached heartbeats to WakaTime.
   * 并发调用会被串行化（后到的排队执行）。
   *
   * 只把【确实没落库】的条目留在缓存里：
   * - 传输失败批次起点之后的全部；
   * - 之前批次里被逐条拒绝、但重试有意的（429/5xx）。
   * 被逐条 4xx 校验拒绝的条目重试必然再失败，直接丢弃——否则一条坏心跳会
   * 永久占着缓存名额，把好数据从 enforceLimit 的尾部挤掉。
   * 全部成功则清空文件；失败时抛出，让调用方记账。
   */
  flush(client: WakaTimeClient): Promise<void> {
    const run = this.flushChain.then(() => this.doFlush(client));
    // 链上吞掉错误：前一次失败不阻塞后续 flush
    this.flushChain = run.then(() => undefined, () => undefined);
    return run;
  }

  private async doFlush(client: WakaTimeClient): Promise<void> {
    if (!existsSync(this.cachePath)) return;

    const content = await readFile(this.cachePath, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    if (lines.length === 0) return;

    // 跳过损坏行：一条坏 JSON 不应永久卡死整个补发通道
    const heartbeats: WakaTimeHeartbeat[] = [];
    for (const line of lines) {
      try {
        heartbeats.push(JSON.parse(line) as WakaTimeHeartbeat);
      } catch {
        // 忽略无法解析的行
      }
    }
    if (heartbeats.length === 0) {
      await writeFile(this.cachePath, '');
      return;
    }

    // Send in batches of 25
    const batchSize = 25;
    /** 逐条被拒且可重试的条目（来自失败点之前的批次）。 */
    const retryable: WakaTimeHeartbeat[] = [];
    let failure: { at: number; error: unknown } | null = null;
    for (let i = 0; i < heartbeats.length; i += batchSize) {
      const batch = heartbeats.slice(i, i + batchSize);
      let result;
      try {
        result = await client.sendHeartbeats(batch);
      } catch (error) {
        failure = { at: i, error };
        break;
      }
      for (const rejected of result.rejected) {
        const heartbeat = batch[rejected.index];
        if (heartbeat && !rejected.permanent) retryable.push(heartbeat);
      }
    }

    // 留在缓存里的 = 失败点之后未发出的 + 各批中被逐条退回且可重试的。
    // 「外层成功」不等于「全部落库」：只有逐条 429/5xx 时 failure 为空，
    // 此时若直接 clear()，那些心跳就被当成永久失败悄悄丢掉了。
    const remaining = failure ? [...heartbeats.slice(failure.at), ...retryable] : retryable;

    if (remaining.length === 0) {
      await this.clear();
      return;
    }

    // 写回真实剩余集合，避免把已落库的条目再发一遍。
    try {
      await writeFile(this.cachePath, remaining.map(hb => JSON.stringify(hb) + '\n').join(''));
    } catch {
      // 写回失败则保留原文件内容：宁可重复已发部分，也不丢未发数据
    }

    if (failure !== null) throw failure.error;
  }

  /**
   * 把缓存裁到 cache_limit 以内。
   *
   * 原实现是无条件 `lines.slice(-limit)`：缓存涨过上限时，**最旧的心跳被静默删除**
   * ——用户只会看到「那段时间的数据没了」，而日志里没有任何证据。这里改成：
   * 1. 先按时间排序再裁剪（不再依赖文件写入顺序，重试回写的条目本来就会乱序）；
   * 2. 记录累计丢弃条数与最早/最晚被丢弃的时间，供调用方告警。
   *
   * 仍然会丢：缓存存在的意义是兜住短暂失败，超过上限说明失败已持续很久，
   * 若不裁剪就会无限增长、把磁盘和重试时间都拖垮。所以这里的产出不是"不丢"，
   * 而是"丢得可见"。
   */
  private async enforceLimit(): Promise<void> {
    if (!existsSync(this.cachePath)) return;
    const content = await readFile(this.cachePath, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    const limit = this.config.cache_limit;
    // limit 不是合法数字（配置层可能仍给来非数字）时不裁剪，宁可不裁也不要
    // 因为 `n > undefined` 恒 false 而误判"无需裁剪"——那种情况下缓存会无界增长。
    if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) return;
    if (lines.length <= limit) return;

    const parsed: Array<{ line: string; time: number }> = [];
    for (const line of lines) {
      try {
        const hb = JSON.parse(line) as WakaTimeHeartbeat;
        parsed.push({ line, time: typeof hb.time === 'number' ? hb.time : 0 });
      } catch {
        // 损坏行没有时间可依，排在最前，优先被裁掉
        parsed.push({ line, time: 0 });
      }
    }
    parsed.sort((a, b) => a.time - b.time);
    const dropped = parsed.slice(0, parsed.length - limit);
    const kept = parsed.slice(parsed.length - limit);

    try {
      await writeFile(this.cachePath, kept.map((entry) => entry.line + '\n').join(''));
    } catch {
      return;
    }

    const droppedCount = dropped.length;
    const first = dropped[0]?.time ?? 0;
    const last = dropped[dropped.length - 1]?.time ?? 0;
    this.droppedTotal += droppedCount;
    // 累加而不是覆盖：一次 appendBatch 会让缓存短暂超限好几次，每次只裁掉一两条；
    // 若每次覆盖，告警里就只剩最后一两条，"总共丢了多久"这个信息会消失。
    const previous = this.lastDrop;
    this.lastDrop = {
      count: (previous?.count ?? 0) + droppedCount,
      from: previous !== null && previous.from > 0 && (first === 0 || previous.from < first) ? previous.from : first,
      to: Math.max(previous?.to ?? 0, last),
    };
  }

  /**
   * 取走「自上次调用以来被裁剪掉的心跳」统计。
   *
   * 调用方据此告警：数据被裁掉是必须被看见的事件，但重复告警会刷屏，
   * 因此读取即清零。
   *
   * @returns 累计丢弃条数与时间跨度；没有发生裁剪时为 null。
   */
  takeDropped(): { count: number; from: number; to: number } | null {
    const drop = this.lastDrop;
    this.lastDrop = null;
    return drop;
  }

}
