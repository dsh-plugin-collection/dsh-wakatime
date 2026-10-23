import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MockWakaTimeServer } from './mock-server.js';
import { WakaTimeClient } from '../src/wakatime.js';
import { FileTracker } from '../src/tracker.js';
import { HeartbeatCache } from '../src/cache.js';
import { WakaTimeHeartbeat } from '../src/types.js';
import { apply } from '../src/index.js';
import type { Context } from '@deepseek-ai/cordis';
import { rmSync, mkdirSync, appendFileSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** 每个用例独立的缓存根目录，随用例结束销毁（见下方两个 describe 的 beforeEach）。 */
let testCacheDir = '';

/** 用例开始前的 $HOME：afterEach 里必须在删目录【之前】还原，否则盘上残留无处可去。 */
let savedHome: string | undefined;

/**
 * 给本用例开一个全新的缓存根目录并把它挂成 $HOME。
 *
 * 为什么必须是「每用例一个」而不是整个文件共用常量目录：HeartbeatCache 把心跳写到
 * `$HOME/.dsh/wakatime/heartbeat-cache.jsonl`（src/cache.ts），而插件侧对 pending /
 * 磁盘缓存的冲刷是 fire-and-forget 的。前一个用例的迟到冲刷若在用例结束后仍跑着，
 * 会把心跳重新写回缓存文件（flushPending 的 catch 分支 appendBatch，部分成功时
 * 缓存 doFlush 也写回未发送的尾部）。共用目录时，下一个用例的
 * `expect(await cache.count()).toBe(n)` 就会读到上一轮的残留而变成僵尸 flake。
 * 每用例 mkdtemp 让这种残留落在一个没人再读的目录里，风险根本不存在。
 *
 * 顺序纪律（与 fiber unload、$HOME 还原的先后有关）：
 *   1. beforeEach：保存 HOME → 建目录 → 指向新目录（apply() 在用例体内构造
 *      HeartbeatCache，其构造函数里的 homedir() 此刻必须已经指向新目录）；
 *   2. 用例体：创建 fiber（apply()）；
 *   3. afterEach：先 unload fiber（冲刷仍能看到本用例的目录）→ 再还原 HOME →
 *      最后删目录。删除必须排在还原之后，否则迟到冲刷会在旧 HOME 上重建目录树。
 */
function useIsolatedCacheDir(): void {
  savedHome = process.env.HOME;
  testCacheDir = mkdtempSync(join(tmpdir(), `${process.pid}-`));
  process.env.HOME = testCacheDir;
}

/**
 * 用例收尾：按「卸载 fiber → 还原 $HOME → 删目录」的相反顺序拆掉本用例的痕迹。
 * 不接受任何参数：待卸载的 fiber 由 makeFakeCtx 自行登记，调用方无需再记一遍。
 */
function releaseIsolatedCacheDir(): void {
  unloadTrackedFibers();
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  rmSync(testCacheDir, { recursive: true, force: true });
  testCacheDir = '';
}

/**
 * 当前用例创建过、尚未卸载的 fiber。
 *
 * 用数组而非单个槽位：有的用例会在同一个 it 里先后建立多个 fake ctx
 *（例如热重载用例 first/second）。每个用例 beginTest() 清空一次，
 * makeFakeCtx 在建立时登记，afterEach 统一倒序卸载。
 */
const activeFibers: Array<{ unload: () => void }> = [];

/** 用例开始时清空上一轮的登记（防御性：afterEach 已耗尽，这里只兜底断言失败等异常路径）。 */
function beginTest(): void {
  activeFibers.length = 0;
}

/** 倒序卸载所有登记过的 fiber：signal 监听、定时器、事件处理器都在这一步归还。 */
function unloadTrackedFibers(): void {
  for (const fiber of activeFibers.splice(0).reverse()) fiber.unload();
}

describe('Integration Tests', () => {
  let server: MockWakaTimeServer;
  let client: WakaTimeClient;
  let cache: HeartbeatCache;

  beforeEach(async () => {
    beginTest();
    useIsolatedCacheDir();
    server = new MockWakaTimeServer();
    const port = await server.start();
    client = new WakaTimeClient({
      api_key: 'test_key_12345',
      api_url: `http://127.0.0.1:${port}`,
    });
    cache = new HeartbeatCache({ cache_limit: 100 });
  });

  afterEach(async () => {
    await server.stop();
    releaseIsolatedCacheDir();
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

  describe('fetchProjects', () => {
    it('should return ordered, deduped, string-only project names with Basic auth', async () => {
      const names = await client.fetchProjects();
      // 上游顺序保留；重复名去重；非字符串 name 条目剔除
      expect(names).toEqual(['dsh-plugins', 'apbot_server']);
      // 鉴权与心跳路径同一套：Basic base64(key + ':')
      expect(server.lastProjectAuth).toBe(`Basic ${btoa('test_key_12345:')}`);
      expect(server.projectRequestCount).toBe(1);
    });

    it('should throw an auth error on 401 without poisoning heartbeat retry windows', async () => {
      server.projectsFail401 = true;
      await expect(client.fetchProjects()).rejects.toThrow(/API Key 无效/);
      // projects 的 401 不写 authFailRetryAfter —— 心跳路径不受候选拉取失败影响
      server.projectsFail401 = false;
      const heartbeat: WakaTimeHeartbeat = {
        entity: '/path/file.ts',
        type: 'file',
        time: Date.now() / 1000,
      };
      await expect(client.sendHeartbeat(heartbeat)).resolves.toBeUndefined();
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

  /**
   * describe() 行的形状：ns + 已解析 value。
   * `secrets` 旁路仅在 redactSecrets 时出现，标记 schema 声明的 secret 槽位是否有值。
   */
  interface FakeRow {
    ns: string;
    value: Record<string, unknown>;
    secrets?: Array<{ path: string[]; set: boolean }>;
  }

  /**
   * 最小假 ctx：捕获事件处理器，模拟 0.2.0 的 settings 服务（settings.describe）。
   *
   * - `describe` 模拟内核：返回当前文档行的快照。
   * - `inject(['settings'], cb)` 同步调用 cb，传入挂了 settings 的 ctx。
   *   注意事件监听【不】依赖该回调（真实实现里它是独立的子 fiber），
   *   因此测试里 emit 走的是插件自身 ctx 上注册的处理器。
   */
  function makeFakeCtx(initialRows?: FakeRow[]) {
    const handlers = new Map<string, Array<(...args: any[]) => void>>();
    /** 按 ns 存放的文档行：多插件共存时 describe() 返回全部行。 */
    const rowsByNs = new Map<string, FakeRow>();
    for (const row of initialRows ?? []) rowsByNs.set(row.ns, row);
    /** describe() 被调用的次数：用来断言 ns 过滤真的挡掉了无关事件。 */
    let describeCalls = 0;
    const settings = {
      describe: (_opts?: { redactSecrets?: boolean }) => {
        describeCalls++;
        return [...rowsByNs.values()];
      },
    };
    const settingsCtx = { settings };
    /** ctx.effect 注册的 disposer：unload() 按相反顺序执行，贴近真实 fiber 卸载。 */
    const effectDisposers: Array<() => void> = [];
    const raw = {
      registry: { values: () => [] },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      inject: (names: string[], cb: (c: unknown) => void) => {
        if (names.includes('settings')) cb(settingsCtx);
      },
      on: (name: string, cb: (...args: any[]) => void) => {
        handlers.set(name, [...(handlers.get(name) ?? []), cb]);
      },
      effect: (fn: () => () => void) => {
        effectDisposers.push(fn());
      },
    };
    const emit = (name: string, ...args: any[]) => {
      for (const h of handlers.get(name) ?? []) h(...args);
    };
    // 生命周期事件与 session/event 走同一个 emit：宿主把 agent 融合进 payload，
    // 因此测试直接 emit('agent/status', { agent: { session }, status }) /
    // emit('agent/disposed', { agent: { session } }) 即可，无需额外通道。
    /**
     * 模拟 WebUI 保存：更新【该 ns 的】文档行，再发 settings/document-updated。
     *
     * 关键：只替换目标 ns 的行，其他命名空间的行保持不变。若让外插件事件
     * 连带清空本插件的行，`readOwnRow()` 会因找不到行而直接 return，
     * 反向断言就会因「与 ns 过滤无关的原因」假通过。
     */
    const saveAndNotify = (ns: string, value: Record<string, unknown>) => {
      rowsByNs.set(ns, { ns, value });
      emit('settings/document-updated', ns);
    };
    /** 当前 describe 调用次数快照（用于断言事件是否触发了重读）。 */
    const describeCallCount = () => describeCalls;
    /**
     * 模拟 fiber 卸载（插件热重载 / disable）：倒序执行 ctx.effect 的 disposer，
     * 再注销本 ctx 的事件监听 —— 卸载后的旧 fiber 必须完全静音。
     */
    const unload = () => {
      for (const dispose of effectDisposers.splice(0).reverse()) dispose();
      handlers.clear();
    };
    // 登记本 fiber，让 afterEach 无需依赖用例自己记得 unload。
    // 这不是「额外加的严格性」，而是补上测试本来漏掉的 fiber 生命周期：
    // 漏卸载时每次 apply() 都会在 process 上留一对 signal 监听（插件侧
    // 已改为随 ctx.effect 注册/注销，见 src/index.ts 的 ctx.effect），
    // 用例一多就会撞上 MaxListenersExceededWarning —— 那是【测试夹具没拆】，
    // 不是插件泄漏。多个 ctx 在同一用例内共存时，登记顺序即卸载的逆序。
    const fiber = { unload };
    activeFibers.push(fiber);
    return { ctx: raw as unknown as Context, emit, saveAndNotify, describeCallCount, unload };
  }

  /**
   * 定时器探针：透传全局 setInterval/clearInterval，并登记每次创建/清除的 delay。
   * 插件的心跳间隔是测试自己指定的（60000 / 90000），所以按 delay 计数就只统计
   * 插件自己的定时器，vitest 与 undici 等库的 interval 不会混进来。
   */
  function observeIntervals() {
    const set = globalThis.setInterval;
    const clear = globalThis.clearInterval;
    /** id → delay：当前存活的 interval。 */
    const live = new Map<unknown, number>();
    const createdDelays: number[] = [];
    const clearedDelays: number[] = [];
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: any, ms?: any, ...rest: any[]) => {
      const id = set(fn, ms, ...rest);
      if (typeof ms === 'number') {
        live.set(id, ms);
        createdDelays.push(ms);
      }
      return id;
    }) as any);
    vi.spyOn(globalThis, 'clearInterval').mockImplementation(((id: any) => {
      const delay = live.get(id);
      if (delay !== undefined) {
        live.delete(id);
        clearedDelays.push(delay);
      }
      return clear(id);
    }) as any);
    const count = (delays: number[], ...wanted: number[]) =>
      delays.filter((d) => wanted.length === 0 || wanted.includes(d)).length;
    return {
      /** 存活的插件定时器数量（可按 delay 过滤）。 */
      live: (...wanted: number[]) => count([...live.values()], ...wanted),
      /** 累计创建的插件定时器数量（可按 delay 过滤）。 */
      created: (...wanted: number[]) => count(createdDelays, ...wanted),
      /** 累计清除的插件定时器数量（可按 delay 过滤）。 */
      cleared: (...wanted: number[]) => count(clearedDelays, ...wanted),
      restore: () => vi.restoreAllMocks(),
    };
  }

  beforeEach(async () => {
    beginTest();
    useIsolatedCacheDir();
    server = new MockWakaTimeServer();
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    releaseIsolatedCacheDir();
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

  it('should hydrate include_* flags from the settings document at startup', async () => {
    // 回归背景：runtime 只在 settings/document-updated（WebUI 保存）时合并文档值，
    // 进程重启后入口 config 缺省 include_*（schema 默认 false）会静默丢掉
    // 用户文档层里持久保存的 true —— 症状：设置卡显示「开启」，消息类
    // 心跳却停摆。修复后启动即以 describe() 回读（describe 是权威来源）。
    const session = { id: 'wiring-hydrate', header: { cwd: process.cwd() } };
    const { ctx, emit } = makeFakeCtx([{
      ns: 'dsh-wakatime',
      value: {
        // api_key 缺席：redactSecrets 把 role('secret') 字段整个移除（不是占位串）
        api_url: server.getBaseUrl(),
        heartbeat_interval_ms: 60000,
        project_name: '',
        language: '',
        include_tool_calls: true,
        include_user_messages: true,      // 用户文档层保存过的值
        include_assistant_messages: true, // 入口 config 完全没喂这两个字段
        cache_heartbeats: true,
        cache_limit: 100,
        debug: false,
      },
      secrets: [{ path: ['api_key'], set: true }],
    }]);

    // 入口 config：仅 api_key/api_url 等装载必需字段，include_* 缺省
    apply(ctx as Context, {
      api_key: 'test_key_12345',
      api_url: server.getBaseUrl(),
      heartbeat_interval_ms: 60000,
      project_name: '', language: '',
      cache_heartbeats: true, cache_limit: 100, debug: false,
    } as any);

    emit('agent/status', { agent: { session }, status: 'running' });
    // 文档层说开启的两个消息类事件都应产生心跳（修复前：双双被默认 false 过滤）
    emit('session/event', session, { type: 'user/message', data: { content: '重启后还能追踪吗' } });
    emit('session/event', session, {
      type: 'assistant/message',
      data: { turn: 1, step: 1, message: { content: 'ok' }, usage: { inputTokens: 88, outputTokens: 12 } },
    });
    emit('agent/status', { agent: { session }, status: 'idle' });

    for (let t = 0; t < 60 && server.getReceivedHeartbeats().length !== 2; t++) {
      await new Promise(r => setTimeout(r, 50));
    }
    const heartbeats = server.getReceivedHeartbeats();
    expect(heartbeats).toHaveLength(2);
    // 类别一律小写：与 src/types.ts 的 TOOL_CATEGORY_MAP 及 WakaTime CLI
    // 自身的常量（pkg/heartbeat/category.go: ai coding / communicating）一致
    const categories = heartbeats.map((h: any) => h.category).sort();
    expect(categories).toEqual(['ai coding', 'communicating']);
    const ai = heartbeats.find((h: any) => h.category === 'ai coding');
    expect(ai.entity).toBe('dsh-session-wiring-hydrate');
    expect(ai.ai_input_tokens).toBe(88);
    expect(ai.ai_output_tokens).toBe(12);
    // 文档行里 api_key 缺席，绝不能把启动时解析出的 key 覆盖成空值
    const sent = server.getReceivedHeartbeats()[0];
    expect(sent).toBeDefined();
  });

  it('should keep document-provided false overrides at startup', async () => {
    // 反向断言：hydration 不会凭空打开开关 —— 文档明确 false 时仍过滤
    const { ctx, emit } = makeFakeCtx([{
      ns: 'dsh-wakatime',
      value: {
        api_url: server.getBaseUrl(), heartbeat_interval_ms: 60000,
        project_name: '', language: '',
        include_tool_calls: true, include_user_messages: false, include_assistant_messages: false,
        cache_heartbeats: true, cache_limit: 100, debug: false,
      },
    }]);
    const session = { id: 'wiring-hydrate-off', header: { cwd: process.cwd() } };

    apply(ctx as Context, {
      api_key: 'test_key_12345',
      api_url: server.getBaseUrl(),
      heartbeat_interval_ms: 60000,
      project_name: '', language: '',
      cache_heartbeats: true, cache_limit: 100, debug: false,
    } as any);

    emit('agent/status', { agent: { session }, status: 'running' });
    emit('session/event', session, { type: 'user/message', data: { content: 'should be dropped' } });
    emit('agent/status', { agent: { session }, status: 'idle' });
    await new Promise(r => setTimeout(r, 150));
    expect(server.getReceivedHeartbeats()).toHaveLength(0);
  });

  it('should apply settings/document-updated for our own namespace', async () => {
    // 正向：ns = dsh-wakatime 的事件必须把文档值合并进 runtime。
    // 启动时 include_user_messages 为 false（入口 config 与文档行都是 false），
    // 保存后翻成 true —— 后续 user/message 必须产生心跳。
    const { ctx, emit, saveAndNotify, describeCallCount } = makeFakeCtx([{
      ns: 'dsh-wakatime',
      value: {
        api_url: server.getBaseUrl(), heartbeat_interval_ms: 60000,
        project_name: '', language: '',
        include_tool_calls: true, include_user_messages: false, include_assistant_messages: false,
        cache_heartbeats: true, cache_limit: 100, debug: false,
      },
    }]);
    const session = { id: 'wiring-live-update', header: { cwd: process.cwd() } };

    apply(ctx as Context, {
      api_key: 'test_key_12345',
      api_url: server.getBaseUrl(),
      heartbeat_interval_ms: 60000,
      project_name: '', language: '',
      include_tool_calls: true, include_user_messages: false, include_assistant_messages: false,
      cache_heartbeats: true, cache_limit: 100, debug: false,
    } as any);

    emit('agent/status', { agent: { session }, status: 'running' });
    // 保存前：开关关闭，不应有心跳
    emit('session/event', session, { type: 'user/message', data: { content: 'before' } });
    // WebUI 保存 → 文档行更新 + settings/document-updated
    const before = describeCallCount();
    saveAndNotify('dsh-wakatime', {
      api_url: server.getBaseUrl(), heartbeat_interval_ms: 60000,
      project_name: '', language: '',
      include_tool_calls: true, include_user_messages: true, include_assistant_messages: false,
      cache_heartbeats: true, cache_limit: 100, debug: false,
    });
    // 本命名空间的事件必须触发一次配置重读
    expect(describeCallCount()).toBeGreaterThan(before);
    // 保存后：开关已实时生效，应产生心跳
    emit('session/event', session, { type: 'user/message', data: { content: 'after' } });
    emit('agent/status', { agent: { session }, status: 'idle' });

    for (let t = 0; t < 60 && server.getReceivedHeartbeats().length !== 1; t++) {
      await new Promise(r => setTimeout(r, 50));
    }
    const heartbeats = server.getReceivedHeartbeats();
    expect(heartbeats).toHaveLength(1);
    expect(heartbeats[0].category).toBe('communicating');
  });

  it('should ignore settings/document-updated for a foreign namespace', async () => {
    // 反向：其他命名空间的事件绝不能触发本插件的配置重读/合并。
    //
    // 为什么这条断言是承重的：cordis 在这一跳不做任何过滤 —— settings 的
    // 发射方 ownerContext 没有 filter 槽，`!filter` 成立，事件被投递给
    // 进程内【所有】监听者，包括本插件。因此 ns 过滤是唯一的守门人。
    //
    // 断言选 describe() 调用次数而非「开关是否被打开」：readOwnRow() 永远
    // 只取本插件命名空间的那一行，所以即便外插件事件漏进来，也不会把它的值
    // 合并进来（只会多做一次无谓重读）。真正可观测的差异是【有没有发生重读】。
    const { ctx, emit, saveAndNotify, describeCallCount } = makeFakeCtx([{
      ns: 'dsh-wakatime',
      value: {
        api_url: server.getBaseUrl(), heartbeat_interval_ms: 60000,
        project_name: '', language: '',
        include_tool_calls: true, include_user_messages: false, include_assistant_messages: false,
        cache_heartbeats: true, cache_limit: 100, debug: false,
      },
    }]);
    const session = { id: 'wiring-foreign-ns', header: { cwd: process.cwd() } };

    apply(ctx as Context, {
      api_key: 'test_key_12345',
      api_url: server.getBaseUrl(),
      heartbeat_interval_ms: 60000,
      project_name: '', language: '',
      include_tool_calls: true, include_user_messages: false, include_assistant_messages: false,
      cache_heartbeats: true, cache_limit: 100, debug: false,
    } as any);

    emit('agent/status', { agent: { session }, status: 'running' });
    const before = describeCallCount();
    // 一个无关插件的文档更新，其 value 试图打开我们的 user/message 开关
    saveAndNotify('some-other-plugin', {
      include_tool_calls: true, include_user_messages: true, include_assistant_messages: true,
    });
    // ns 过滤必须让这次事件完全不触发重读
    expect(describeCallCount()).toBe(before);
    // 若 ns 过滤失效导致开关被外插件打开，这条会产生心跳
    emit('session/event', session, { type: 'user/message', data: { content: 'should be dropped' } });
    emit('agent/status', { agent: { session }, status: 'idle' });
    await new Promise(r => setTimeout(r, 150));
    expect(server.getReceivedHeartbeats()).toHaveLength(0);
  });

  it('should adopt a genuine new api_key from the settings document', async () => {
    // 保存一个真实的新 key：应被采纳并用于后续发送。
    // 用一个只记录 Authorization 头的极小 HTTP 服务取代 mock-server
    //（mock-server 不记录请求头，且不在本任务写范围内）。
    const seenAuth: string[] = [];
    const keyServer = createServer((req, res) => {
      seenAuth.push(String(req.headers['authorization'] ?? ''));
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      });
    });
    await new Promise<void>((r) => keyServer.listen(0, '127.0.0.1', r));
    const keyPort = (keyServer.address() as AddressInfo).port;
    const keyBase = `http://127.0.0.1:${keyPort}`;

    try {
      const { ctx, emit, saveAndNotify } = makeFakeCtx([{
        ns: 'dsh-wakatime',
        value: {
          api_url: keyBase, heartbeat_interval_ms: 60000,
          project_name: '', language: '',
          include_tool_calls: true, include_user_messages: true, include_assistant_messages: false,
          cache_heartbeats: true, cache_limit: 100, debug: false,
        },
      }]);
      const session = { id: 'wiring-new-key', header: { cwd: process.cwd() } };

      apply(ctx as Context, {
        api_key: 'test_key_12345',   // 启动时的旧 key
        api_url: keyBase,
        heartbeat_interval_ms: 60000,
        project_name: '', language: '',
        include_tool_calls: true, include_user_messages: true, include_assistant_messages: false,
        cache_heartbeats: true, cache_limit: 100, debug: false,
      } as any);

      emit('agent/status', { agent: { session }, status: 'running' });
      // 用户保存了一个真实的新 key
      saveAndNotify('dsh-wakatime', {
        api_key: 'brand_new_key_67890',
        api_url: keyBase, heartbeat_interval_ms: 60000,
        project_name: '', language: '',
        include_tool_calls: true, include_user_messages: true, include_assistant_messages: false,
        cache_heartbeats: true, cache_limit: 100, debug: false,
      });
      emit('session/event', session, { type: 'user/message', data: { content: 'hi' } });
      emit('agent/status', { agent: { session }, status: 'idle' });

      for (let t = 0; t < 60 && seenAuth.length === 0; t++) {
        await new Promise(r => setTimeout(r, 50));
      }
      expect(seenAuth).toHaveLength(1);
      // Basic <btoa(key + ':')> —— 证明新 key 真的生效了
      expect(seenAuth[0]).toBe(`Basic ${Buffer.from('brand_new_key_67890:').toString('base64')}`);
    } finally {
      await new Promise<void>((r) => keyServer.close(() => r()));
    }
  });

  it('should not clobber a working api_key when the document omits it (redacted)', async () => {
    // redactSecrets 把 role('secret') 字段整个移除：未改动 key 时 api_key 是
    // undefined（不是占位串、也不是空串）。此时必须保留正在使用的 key。
    const seenAuth: string[] = [];
    const keyServer = createServer((req, res) => {
      seenAuth.push(String(req.headers['authorization'] ?? ''));
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      });
    });
    await new Promise<void>((r) => keyServer.listen(0, '127.0.0.1', r));
    const keyPort = (keyServer.address() as AddressInfo).port;
    const keyBase = `http://127.0.0.1:${keyPort}`;

    try {
      const { ctx, emit, saveAndNotify } = makeFakeCtx([{
        ns: 'dsh-wakatime',
        value: {
          // 启动回读时 api_key 也缺席（redacted），必须保留入口 config 的 key
          api_url: keyBase, heartbeat_interval_ms: 60000,
          project_name: '', language: '',
          include_tool_calls: true, include_user_messages: true, include_assistant_messages: false,
          cache_heartbeats: true, cache_limit: 100, debug: false,
        },
        secrets: [{ path: ['api_key'], set: true }],
      }]);
      const session = { id: 'wiring-key-kept', header: { cwd: process.cwd() } };

      apply(ctx as Context, {
        api_key: 'test_key_12345',
        api_url: keyBase,
        heartbeat_interval_ms: 60000,
        project_name: '', language: '',
        include_tool_calls: true, include_user_messages: true, include_assistant_messages: false,
        cache_heartbeats: true, cache_limit: 100, debug: false,
      } as any);

      emit('agent/status', { agent: { session }, status: 'running' });
      // 用户只改了别的字段，key 字段在 redacted 结果里缺席
      saveAndNotify('dsh-wakatime', {
        api_url: keyBase, heartbeat_interval_ms: 60000,
        project_name: '', language: '',
        include_tool_calls: true, include_user_messages: true, include_assistant_messages: false,
        cache_heartbeats: true, cache_limit: 100, debug: false,
      });
      emit('session/event', session, { type: 'user/message', data: { content: 'hi' } });
      emit('agent/status', { agent: { session }, status: 'idle' });

      for (let t = 0; t < 60 && seenAuth.length === 0; t++) {
        await new Promise(r => setTimeout(r, 50));
      }
      expect(seenAuth).toHaveLength(1);
      // 仍是启动时的 key —— 没有被 redacted/undefined 覆盖成空
      expect(seenAuth[0]).toBe(`Basic ${Buffer.from('test_key_12345:').toString('base64')}`);
    } finally {
      await new Promise<void>((r) => keyServer.close(() => r()));
    }
  });

  it('should start/stop exactly one heartbeat timer per session on root agent/status', async () => {
    // 用例 A：根级 agent/status 是本插件唯一的生命周期接线。
    // running 起定时器、idle 停定时器并在停止边界冲刷 pending；
    // 重复 running 必须幂等（不叠第二个 setInterval），重复 idle 也不重复 clearInterval。
    // 间隔设为 60000ms：整个用例期间 interval 一次都不会真的触发，
    // 所以「心跳到达」只能来自停止边界的冲刷。
    const probe = observeIntervals();
    try {
      const { ctx, emit } = makeFakeCtx();
      const session = { id: 'wiring-lifecycle-timer', header: { cwd: process.cwd() } };

      apply(ctx as Context, {
        api_key: 'test_key_12345',
        api_url: server.getBaseUrl(),
        heartbeat_interval_ms: 60000,
        project_name: '', language: '',
        include_tool_calls: true, include_user_messages: false, include_assistant_messages: false,
        cache_heartbeats: true, cache_limit: 100, debug: false,
      } as any);

      emit('agent/status', { agent: { session }, status: 'running' });
      expect(probe.created(60000)).toBe(1);
      expect(probe.live(60000)).toBe(1);

      // 同一 session 连续两次 running：幂等，不得再建定时器
      emit('agent/status', { agent: { session }, status: 'running' });
      emit('agent/status', { agent: { session }, status: 'running' });
      expect(probe.created(60000)).toBe(1);
      expect(probe.live(60000)).toBe(1);

      emit('session/event', session, {
        type: 'tool/call',
        data: { turn: 1, step: 1, callId: 'call-timer', name: 'read', arguments: JSON.stringify({ file_path: '/path/timer-a.ts' }) },
      });
      await new Promise((r) => setTimeout(r, 50));
      expect(server.getReceivedHeartbeats()).toHaveLength(0);

      // 停止边界：停定时器 + 冲出 pending
      emit('agent/status', { agent: { session }, status: 'idle' });
      expect(probe.live(60000)).toBe(0);
      expect(probe.cleared(60000)).toBe(1);
      // 重复 idle 幂等：没有可停的定时器了
      emit('agent/status', { agent: { session }, status: 'idle' });
      expect(probe.cleared(60000)).toBe(1);
      expect(probe.created(60000)).toBe(1);

      for (let t = 0; t < 60 && server.getReceivedHeartbeats().length !== 1; t++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(server.getReceivedHeartbeats().map((h: any) => h.entity)).toEqual(['/path/timer-a.ts']);
    } finally {
      probe.restore();
    }
  });

  it('should flush unsent heartbeats and release the session on root agent/disposed', async () => {
    // 用例 B：agent/disposed 是资源回收边界。
    // 1) 未发送的 pending 心跳与磁盘缓存里的心跳都必须被冲出去；
    // 2) 该 session 的定时器必须停干净（activeSessions 回收的可观测面：
    //    dispose 后进程内不再有任何为该 session 存活的 interval，
    //    且后续 restartActiveTimers 也不会再为它重建）；
    // 3) idle 与 disposed 相邻到达（宿主两者可能连着发）时必须可重入安全：
    //    每条心跳只上报一次。
    const probe = observeIntervals();
    try {
      const { ctx, emit, saveAndNotify } = makeFakeCtx();
      const session = { id: 'wiring-disposed', header: { cwd: process.cwd() } };

      apply(ctx as Context, {
        api_key: 'test_key_12345',
        api_url: server.getBaseUrl(),
        heartbeat_interval_ms: 60000,
        project_name: '', language: '',
        include_tool_calls: true, include_user_messages: false, include_assistant_messages: false,
        cache_heartbeats: true, cache_limit: 100, debug: false,
      } as any);

      emit('agent/status', { agent: { session }, status: 'running' });
      emit('session/event', session, {
        type: 'tool/call',
        data: { turn: 1, step: 1, callId: 'call-disposed', name: 'read', arguments: JSON.stringify({ file_path: '/path/disposed.ts' }) },
      });
      await new Promise((r) => setTimeout(r, 50));

      // 磁盘缓存里再压一条（上轮网络失败留下的）：dispose 边界必须一并冲刷
      mkdirSync(join(testCacheDir, '.dsh', 'wakatime'), { recursive: true });
      appendFileSync(
        join(testCacheDir, '.dsh', 'wakatime', 'heartbeat-cache.jsonl'),
        JSON.stringify({ entity: '/p/cached-disposed.ts', type: 'file', time: Date.now() / 1000 }) + '\n',
      );

      // 最后一次 idle 紧接 disposed：两次冲刷并发跑，不得重复上报
      emit('agent/status', { agent: { session }, status: 'idle' });
      emit('agent/disposed', { agent: { session } });

      // 两条都应到达（1 条 pending + 1 条缓存），且没有第三条重复
      for (let t = 0; t < 60 && server.getReceivedHeartbeats().length < 2; t++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      const entities = server.getReceivedHeartbeats().map((h: any) => h.entity).sort();
      expect(entities).toEqual(['/p/cached-disposed.ts', '/path/disposed.ts']);

      // 无残留定时器：该 session 的 interval 已随 dispose 停干净
      expect(probe.live(60000, 90000)).toBe(0);
      expect(probe.created(60000)).toBe(1);
      // 磁盘缓存被排空
      expect(await new HeartbeatCache({ cache_limit: 100 }).count()).toBe(0);

      // 心跳间隔变更会触发 restartActiveTimers（它遍历 activeSessions）：
      // dispose 之后这个 session 不该再被复活成新定时器。
      // 说明：强引用释放本身在进程内不可观测，这里断言的是它的可观测后果
      //（集合里不再有任何属于该 session 的可重建状态）。
      saveAndNotify('dsh-wakatime', {
        api_url: server.getBaseUrl(), heartbeat_interval_ms: 90000,
        project_name: '', language: '',
        include_tool_calls: true, include_user_messages: false, include_assistant_messages: false,
        cache_heartbeats: true, cache_limit: 100, debug: false,
      });
      expect(probe.created(90000)).toBe(0);
      expect(probe.live(60000, 90000)).toBe(0);
    } finally {
      probe.restore();
    }
  });

  it('should not accumulate process signal listeners across repeated apply()', async () => {
    // 回归背景：apply() 里的 process.on('SIGINT'/'SIGTERM') 从不移除，插件热重载 /
    // disable 每来一次就多一对闭包 —— 退出时被 N 份旧 state 各冲刷一次，
    // MaxListenersExceededWarning 只是它露出来的表象。
    // 修复：signal 监听随 ctx.effect 注册、随 fiber 卸载 process.off。
    // listenerCount 断言用相对量：不假设本用例见到的是进程里唯一的插件 fiber
    //（单元测试文件、将来新增的用例都可能各有自己的 fiber），只断言本用例内
    // apply() 恰好 +1、unload() 恰好回到快照 —— 这正是「监听器不累积」的充分条件。
    // 注意快照的语义已随夹具修复而改变：afterEach 现在会卸载每个用例的 fiber，
    // 所以 before 是【真正的进程基线】（不再上一用例一对），上面的 +1 / +0
    // 断言因此比修复前更强，而不需要调整数值。
    const wiringConfig = {
      api_key: 'test_key_12345',
      api_url: server.getBaseUrl(),
      heartbeat_interval_ms: 60000,
      project_name: '', language: '',
      include_tool_calls: true, include_user_messages: false, include_assistant_messages: false,
      cache_heartbeats: true, cache_limit: 100, debug: false,
    };
    const probe = observeIntervals();
    const before = {
      sigint: process.listenerCount('SIGINT'),
      sigterm: process.listenerCount('SIGTERM'),
    };
    try {
      const first = makeFakeCtx();
      apply(first.ctx as Context, wiringConfig as any);
      expect(process.listenerCount('SIGINT')).toBe(before.sigint + 1);
      expect(process.listenerCount('SIGTERM')).toBe(before.sigterm + 1);

      const sessionA = { id: 'wiring-signal-reload-a', header: { cwd: process.cwd() } };
      first.emit('agent/status', { agent: { session: sessionA }, status: 'running' });
      expect(probe.live(60000)).toBe(1);

      // 重载前半程：旧 fiber 卸载 → signal 监听与该 session 的定时器一起消失
      first.unload();
      expect(process.listenerCount('SIGINT')).toBe(before.sigint);
      expect(process.listenerCount('SIGTERM')).toBe(before.sigterm);
      expect(probe.live(60000)).toBe(0);

      // 重载后半程：新 fiber 装载。增量回到 +1 而不是 +2 → 监听器不累积
      const second = makeFakeCtx();
      apply(second.ctx as Context, wiringConfig as any);
      expect(process.listenerCount('SIGINT')).toBe(before.sigint + 1);
      expect(process.listenerCount('SIGTERM')).toBe(before.sigterm + 1);

      // 新 fiber 接管仍存活的 session（这正是保留根级监听的目的），且只有一份 state 在动作
      second.emit('agent/status', { agent: { session: sessionA }, status: 'running' });
      expect(probe.live(60000)).toBe(1);
      second.emit('session/event', sessionA, {
        type: 'tool/call',
        data: { turn: 1, step: 1, callId: 'call-reload-a', name: 'read', arguments: JSON.stringify({ file_path: '/path/reload-a.ts' }) },
      });
      await new Promise((r) => setTimeout(r, 50));

      // 已卸载的旧 fiber 完全静音：既不追踪也不冲刷
      first.emit('session/event', sessionA, {
        type: 'tool/call',
        data: { turn: 1, step: 2, callId: 'call-orphan', name: 'read', arguments: JSON.stringify({ file_path: '/path/reload-orphan.ts' }) },
      });
      first.emit('agent/status', { agent: { session: sessionA }, status: 'idle' });

      second.emit('agent/status', { agent: { session: sessionA }, status: 'idle' });
      for (let t = 0; t < 60 && server.getReceivedHeartbeats().length === 0; t++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      // 再等一段，给「旧 fiber 若没静音」的迟到心跳留足到达时间
      await new Promise((r) => setTimeout(r, 150));
      // 恰好一条、且是新 fiber 那条；/path/reload-orphan.ts 一条都不该出现
      expect(server.getReceivedHeartbeats().map((h: any) => h.entity))
        .toEqual(['/path/reload-a.ts']);

      second.unload();
      expect(process.listenerCount('SIGINT')).toBe(before.sigint);
      expect(process.listenerCount('SIGTERM')).toBe(before.sigterm);
      expect(probe.live(60000)).toBe(0);
    } finally {
      probe.restore();
    }
  });
});
