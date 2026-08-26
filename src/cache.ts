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
   * 并发调用会被串行化（后到的排队执行）；部分批次成功时只把未发送的
   * 写回缓存，已发送的不重发。
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
    let sentCount = 0;
    try {
      for (let i = 0; i < heartbeats.length; i += batchSize) {
        await client.sendHeartbeats(heartbeats.slice(i, i + batchSize));
        sentCount = Math.min(i + batchSize, heartbeats.length);
      }
    } catch (error) {
      if (sentCount > 0) {
        // 部分成功：写回未发送的尾部；写回失败则保留全量文件
        //（下次重发会重复已发部分，但宁可重复也不丢数据）
        try {
          const remaining = heartbeats.slice(sentCount)
            .map(hb => JSON.stringify(hb) + '\n')
            .join('');
          await writeFile(this.cachePath, remaining);
        } catch {
          // 保留原文件内容
        }
      }
      throw error;
    }

    await this.clear();
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
