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

  private async enforceLimit(): Promise<void> {
    if (!existsSync(this.cachePath)) return;
    const content = await readFile(this.cachePath, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    if (lines.length > this.config.cache_limit) {
      const trimmed = lines.slice(-this.config.cache_limit);
      await writeFile(this.cachePath, trimmed.join('\n') + '\n');
    }
  }
}
