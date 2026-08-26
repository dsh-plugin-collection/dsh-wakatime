import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockWakaTimeServer } from './mock-server.js';
import { WakaTimeClient } from '../src/wakatime.js';
import { FileTracker } from '../src/tracker.js';
import { HeartbeatCache } from '../src/cache.js';
import { WakaTimeHeartbeat } from '../src/types.js';
import { apply } from '../src/index.js';
import type { Context } from '@deepseek-ai/cordis';
import { rmSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('Integration Tests', () => {
  let server: MockWakaTimeServer;
  let client: WakaTimeClient;
  let cache: HeartbeatCache;
  const testCacheDir = join(tmpdir(), 'dsh-wakatime-int-test-' + Date.now());

  beforeEach(async () => {
    server = new MockWakaTimeServer();
    const port = await server.start();
    client = new WakaTimeClient({
      api_key: 'test_key_12345',
      api_url: `http://127.0.0.1:${port}`,
    });
    process.env.HOME = testCacheDir;
    cache = new HeartbeatCache({ cache_limit: 100 });
  });

  afterEach(async () => {
    await server.stop();
    rmSync(testCacheDir, { recursive: true, force: true });
  });

  describe('Full workflow', () => {
    it('should track tool calls and send heartbeats', async () => {
      const mockSession = {
        id: 'test-session',
        header: { cwd: process.cwd() },
      };
      const tracker = new FileTracker(mockSession as any, {
        project_name: '',
        language: '',
        debug: false,
      });

      // Track multiple tool calls
      await tracker.trackToolCall({
        type: 'tool/call',
        data: { turn: 1, step: 1, callId: 'call-1', name: 'write', arguments: JSON.stringify({ file_path: '/path/file1.ts', content: 'line1\nline2' }) },
      } as any);

      await tracker.trackToolCall({
        type: 'tool/call',
        data: { turn: 1, step: 2, callId: 'call-2', name: 'read', arguments: JSON.stringify({ file_path: '/path/file2.ts' }) },
      } as any);

      await tracker.trackToolCall({
        type: 'tool/call',
        data: { turn: 1, step: 3, callId: 'call-3', name: 'bash', arguments: JSON.stringify({ command: 'npm test' }) },
      } as any);

      const pending = tracker.getPending();
      expect(pending).toHaveLength(3);

      // Send heartbeats
      for (const hb of pending) {
        await client.sendHeartbeat(hb);
      }

      expect(server.getReceivedHeartbeats()).toHaveLength(3);
    });

    it('should cache failed heartbeats and flush later', async () => {
      const mockSession = {
        id: 'test-session',
        header: { cwd: process.cwd() },
      };
      const tracker = new FileTracker(mockSession as any, {
        project_name: '',
        language: '',
        debug: false,
      });

      // Track a tool call
      await tracker.trackToolCall({
        type: 'tool/call',
        data: { turn: 1, step: 1, callId: 'call-1', name: 'write', arguments: JSON.stringify({ file_path: '/path/file.ts', content: 'test' }) },
      } as any);

      const pending = tracker.getPending();

      // Simulate network failure
      server.setShouldFail500(true);
      try {
        await client.sendHeartbeats(pending);
      } catch {
        // Cache the failed heartbeats
        await cache.appendBatch(pending);
      }

      // Verify cache has the heartbeat
      expect(await cache.count()).toBe(1);

      // Network recovers
      server.setShouldFail500(false);
      await cache.flush(client);

      // Verify server received the cached heartbeat
      expect(server.getReceivedHeartbeats()).toHaveLength(1);
      expect(await cache.count()).toBe(0);
    });

    it('should handle batch sending when heartbeats exceed 25', async () => {
      const mockSession = {
        id: 'test-session',
        header: { cwd: process.cwd() },
      };
      const tracker = new FileTracker(mockSession as any, {
        project_name: '',
        language: '',
        debug: false,
      });

      // Track 30 tool calls (exceeds batch size of 25)
      for (let i = 0; i < 30; i++) {
        await tracker.trackToolCall({
          type: 'tool/call',
          data: { turn: 1, step: i, callId: `call-${i}`, name: 'read', arguments: JSON.stringify({ file_path: `/path/file${i}.ts` }) },
        } as any);
      }

      const pending = tracker.getPending();
      expect(pending).toHaveLength(30);

      // Send in batches
      const batchSize = 25;
      for (let i = 0; i < pending.length; i += batchSize) {
        const batch = pending.slice(i, i + batchSize);
        await client.sendHeartbeats(batch);
      }

      expect(server.getReceivedHeartbeats()).toHaveLength(30);
    });
  });

  describe('Error handling', () => {
    it('should handle 401 error gracefully', async () => {
      server.setShouldFail401(true);
      
      const heartbeat: WakaTimeHeartbeat = {
        entity: '/path/file.ts',
        type: 'file',
        time: Date.now() / 1000,
      };

      await expect(client.sendHeartbeat(heartbeat)).rejects.toThrow('API Key');
    });

    it('should handle 429 error gracefully', async () => {
      server.setShouldFail429(true);
      
      const heartbeat: WakaTimeHeartbeat = {
        entity: '/path/file.ts',
        type: 'file',
        time: Date.now() / 1000,
      };

      await expect(client.sendHeartbeat(heartbeat)).rejects.toThrow('限流');
    });

    it('should handle network failure gracefully', async () => {
      // Create a client pointing to a non-existent port to simulate network failure
      const offlineClient = new WakaTimeClient({
        api_key: 'test_key',
        api_url: 'http://127.0.0.1:59999', // Unlikely to be listening
      });

      const heartbeat: WakaTimeHeartbeat = {
        entity: '/path/file.ts',
        type: 'file',
        time: Date.now() / 1000,
      };

      // Should reject with connection error
      await expect(offlineClient.sendHeartbeat(heartbeat)).rejects.toThrow();
    });

    it('should time out instead of hanging forever when server hangs', async () => {
      server.setShouldHang(true); // 服务端收下请求但永不响应

      const fastClient = new WakaTimeClient({
        api_key: 'test_key',
        api_url: server.getBaseUrl(),
        timeout_ms: 300, // 用短超时避免拖慢测试
      });

      const heartbeat: WakaTimeHeartbeat = {
        entity: '/path/file.ts',
        type: 'file',
        time: Date.now() / 1000,
      };

      await expect(fastClient.sendHeartbeat(heartbeat)).rejects.toThrow(/超时/);
    });
  });

  describe('Cache persistence', () => {
    it('should persist cache across client instances', async () => {
      const heartbeat: WakaTimeHeartbeat = {
        entity: '/path/file.ts',
        type: 'file',
        time: Date.now() / 1000,
      };

      // Add to cache
      await cache.append(heartbeat);
      expect(await cache.count()).toBe(1);

      // Create new cache instance (simulating restart)
      const newCache = new HeartbeatCache({ cache_limit: 100 });
      expect(await newCache.count()).toBe(1);

      // Flush with new client
      await newCache.flush(client);
      expect(server.getReceivedHeartbeats()).toHaveLength(1);
    });

    it('should write back only unsent heartbeats on partial failure', async () => {
      for (let i = 0; i < 30; i++) {
        await cache.append({ entity: `/p/f${i}.ts`, type: 'file', time: Date.now() / 1000 });
      }

      // 第一个批量请求（25 条）成功，第二个批量请求（5 条）失败
      server.setShouldFail500After(1);
      await expect(cache.flush(client)).rejects.toThrow();

      expect(server.getReceivedHeartbeats()).toHaveLength(25);
      expect(await cache.count()).toBe(5); // 只剩未发送的尾部

      // 网络恢复后补发剩余部分，不重复已发送的 25 条
      server.setShouldFail500After(-1);
      await cache.flush(client);
      expect(server.getReceivedHeartbeats()).toHaveLength(30);
      expect(await cache.count()).toBe(0);
    });

    it('should serialize concurrent flushes to avoid double sending', async () => {
      await cache.append({ entity: '/p/a.ts', type: 'file', time: Date.now() / 1000 });
      await cache.append({ entity: '/p/b.ts', type: 'file', time: Date.now() / 1000 });

      // 多会话同时触发 flush：串行化后第二条发现文件已被清空，不再重发
      await Promise.all([cache.flush(client), cache.flush(client)]);

      expect(server.getReceivedHeartbeats()).toHaveLength(2);
      expect(await cache.count()).toBe(0);
    });

    it('should skip corrupt lines instead of failing the whole flush', async () => {
      mkdirSync(join(testCacheDir, '.dsh', 'wakatime'), { recursive: true });
      appendFileSync(
        join(testCacheDir, '.dsh', 'wakatime', 'heartbeat-cache.jsonl'),
        '{broken json\n' + JSON.stringify({ entity: '/p/ok.ts', type: 'file', time: Date.now() / 1000 }) + '\n',
      );

      await cache.flush(client);

      expect(server.getReceivedHeartbeats()).toHaveLength(1);
      expect(server.getReceivedHeartbeats()[0].entity).toBe('/p/ok.ts');
      expect(await cache.count()).toBe(0); // 坏行随成功冲刷一并清除
    });
  });
});

describe('Plugin wiring (apply)', () => {
  let server: MockWakaTimeServer;
  const testCacheDir = join(tmpdir(), 'dsh-wakatime-wiring-test-' + Date.now());

  /** 最小假 ctx：捕获事件处理器，settings 服务缺席（跳过注册）。 */
  function makeFakeCtx() {
    const handlers = new Map<string, Array<(...args: any[]) => void>>();
    const raw = {
      registry: { values: () => [] },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      inject: (_names: string[], _cb: (c: unknown) => void) => {},
      on: (name: string, cb: (...args: any[]) => void) => {
        handlers.set(name, [...(handlers.get(name) ?? []), cb]);
      },
      effect: (_fn: () => () => void) => {},
    };
    const emit = (name: string, ...args: any[]) => {
      for (const h of handlers.get(name) ?? []) h(...args);
    };
    return { ctx: raw as unknown as Context, emit };
  }

  beforeEach(async () => {
    server = new MockWakaTimeServer();
    await server.start();
    process.env.HOME = testCacheDir;
  });

  afterEach(async () => {
    await server.stop();
    rmSync(testCacheDir, { recursive: true, force: true });
  });

  it('should send heartbeats from tool/call events through apply() wiring', async () => {
    const { ctx, emit } = makeFakeCtx();
    const session = { id: 'wiring-session', header: { cwd: process.cwd() } };

    apply(ctx as Context, {
      api_key: 'test_key_12345',
      api_url: server.getBaseUrl(),
      heartbeat_interval_ms: 60000,
      project_name: '',
      language: '',
      include_tool_calls: true,
      include_user_messages: true,
      include_assistant_messages: true,
      cache_heartbeats: true,
      cache_limit: 100,
      debug: false,
    } as any);

    // agent 进入 running：启动该会话的 flush 定时器
    emit('agent/status', { agent: { session }, status: 'running' });
    // 三次工具调用 → 心跳进入 tracker 缓冲
    for (let i = 0; i < 3; i++) {
      emit('session/event', session, {
        type: 'tool/call',
        data: { turn: 1, step: i, callId: `call-${i}`, name: 'read', arguments: JSON.stringify({ file_path: `/path/wiring-${i}.ts` }) },
      });
    }
    // 等 fire-and-forget 的 trackToolCall 完成内部异步探测
    await new Promise(r => setTimeout(r, 50));
    // agent 停止：触发 flushPending + 缓存 flush
    emit('agent/status', { agent: { session }, status: 'idle' });
    await new Promise(r => setTimeout(r, 100));

    expect(server.getReceivedHeartbeats()).toHaveLength(3);
    // trackToolCall 为 fire-and-forget，完成顺序不保证与调用顺序一致
    expect(server.getReceivedHeartbeats().map((h: any) => h.entity).sort())
      .toEqual(['/path/wiring-0.ts', '/path/wiring-1.ts', '/path/wiring-2.ts']);
  });

  it('should not lose in-flight tool calls flushed at the stop boundary', async () => {
    const { ctx, emit } = makeFakeCtx();
    const session = { id: 'wiring-stop', header: { cwd: process.cwd() } };

    apply(ctx as Context, {
      api_key: 'test_key_12345',
      api_url: server.getBaseUrl(),
      heartbeat_interval_ms: 60000,
      project_name: '', language: '',
      include_tool_calls: true, include_user_messages: false, include_assistant_messages: false,
      cache_heartbeats: true, cache_limit: 100, debug: false,
    } as any);

    emit('agent/status', { agent: { session }, status: 'running' });
    // 连续发射后立刻停止：idle 冲刷跑在部分 trackToolCall 的异步探测完成之前。
    // 回归背景：旧实现在此边界会永久丢失在途心跳（无后续冲刷可带走它们）。
    for (let i = 0; i < 6; i++) {
      emit('session/event', session, {
        type: 'tool/call',
        data: { turn: 1, step: i, callId: `call-${i}`, name: 'read', arguments: JSON.stringify({ file_path: `/path/stop-${i}.ts` }) },
      });
    }
    emit('agent/status', { agent: { session }, status: 'idle' });
    // 全部 6 条最终必须到达 mock（轮询等待，不设固定睡眠）
    for (let t = 0; t < 120 && server.getReceivedHeartbeats().length !== 6; t++) {
      await new Promise(r => setTimeout(r, 50));
    }
    expect(server.getReceivedHeartbeats().map((h: any) => h.entity).sort())
      .toEqual(['/path/stop-0.ts', '/path/stop-1.ts', '/path/stop-2.ts', '/path/stop-3.ts', '/path/stop-4.ts', '/path/stop-5.ts']);
  });

  it('should respect include_* toggles checked at event time', async () => {
    const { ctx, emit } = makeFakeCtx();
    const session = { id: 'wiring-toggle', header: { cwd: process.cwd() } };

    apply(ctx as Context, {
      api_key: 'test_key_12345',
      api_url: server.getBaseUrl(),
      heartbeat_interval_ms: 60000,
      project_name: '', language: '',
      include_tool_calls: false,          // 关闭工具调用追踪
      include_user_messages: true,
      include_assistant_messages: false,
      cache_heartbeats: true, cache_limit: 100, debug: false,
    } as any);

    emit('agent/status', { agent: { session }, status: 'running' });
    // tool/call 被开关过滤，不应产生心跳
    for (let i = 0; i < 3; i++) {
      emit('session/event', session, {
        type: 'tool/call',
        data: { turn: 1, step: i, callId: `call-${i}`, name: 'read', arguments: JSON.stringify({ file_path: `/path/toggle-${i}.ts` }) },
      });
    }
    // user/message 开启，应产生一条心跳
    emit('session/event', session, { type: 'user/message', data: { content: 'hi' } });
    emit('agent/status', { agent: { session }, status: 'idle' });

    for (let t = 0; t < 60 && server.getReceivedHeartbeats().length !== 1; t++) {
      await new Promise(r => setTimeout(r, 50));
    }
    expect(server.getReceivedHeartbeats()).toHaveLength(1);
    expect(server.getReceivedHeartbeats()[0].entity).toBe('dsh-session-wiring-toggle');
  });
});
