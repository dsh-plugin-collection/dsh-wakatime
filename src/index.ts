import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
// Type-only side-effect imports: register the `agent/status` and
// `session/event` extensions on the Cordis event surface.
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-session';
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent';
import { WakaTimeClient } from './wakatime.js';
import { FileTracker } from './tracker.js';
import { HeartbeatCache } from './cache.js';
import { readWakatimeCfgApiKey, maskApiKey } from './project.js';

export const name = 'dsh-wakatime';
export const inject = ['sessions'];

/**
 * 0.2.0 配置迁移：`Config` 用 `.volatile()` 标记用户可调字段，
 * 内核自动把 Config 投影成设置页（ns = Loader 条目 id = `dsh-wakatime`）。
 * 不再需要 `ctx.settings.register()`（该 API 在 0.1.7 已删除）。
 */
export interface Config {
  api_key: string;
  api_url: string;
  heartbeat_interval_ms: number;
  project_name: string;
  language: string;
  include_tool_calls: boolean;
  include_user_messages: boolean;
  include_assistant_messages: boolean;
  cache_heartbeats: boolean;
  cache_limit: number;
  debug: boolean;
}

export const Config = Schema.object({
  api_key: Schema.string().default('').role('secret'),
  api_url: Schema.string().default('https://wakatime.com'),
  heartbeat_interval_ms: Schema.natural().min(60000).max(300000).default(120000),
  project_name: Schema.string().default(''),
  language: Schema.string().default(''),
  include_tool_calls: Schema.boolean().default(true),
  include_user_messages: Schema.boolean().default(false),
  include_assistant_messages: Schema.boolean().default(false),
  cache_heartbeats: Schema.boolean().default(true),
  cache_limit: Schema.natural().min(10).max(1000).default(100),
  debug: Schema.boolean().default(false),
}).volatile();

interface SessionState {
  tracker: FileTracker;
  timer: NodeJS.Timeout | null;
}

// Maximum heartbeats per batch (WakaTime limit)
const MAX_BATCH_SIZE = 25;

export function apply(ctx: Context, config: Config): void {
  // Check for conflicting plugin: dsh-codetime
  let hasCodetime = false;
  for (const entry of ctx.registry.values()) {
    if (entry.name === 'dsh-codetime') {
      hasCodetime = true;
      break;
    }
  }
  if (hasCodetime) {
    ctx.logger.warn('dsh-wakatime: 检测到 dsh-codetime 已安装，二者都是 telemetry backend，建议只保留一个');
  }

  // Resolve API key with priority:
  // 1. Config from cordis.patch.yml (already resolved)
  // 2. Environment variable WAKATIME_API_KEY
  // 3. ~/.wakatime.cfg api_key
  let apiKey = config.api_key;
  if (!apiKey) {
    apiKey = process.env.WAKATIME_API_KEY || '';
  }
  if (!apiKey) {
    apiKey = readWakatimeCfgApiKey();
  }

  if (!apiKey) {
    ctx.logger.warn('dsh-wakatime: 未配置 API Key，请在 cordis.patch.yml、环境变量 WAKATIME_API_KEY 或 ~/.wakatime.cfg 中设置');
    return;
  }

  /**
   * 运行时配置单例：WebUI 设置更新经 settings/document-updated 事件原地合并进同一对象，
   * client / cache / tracker / 各事件处理器都持有这个引用 —— 除心跳间隔
   * 需要重建定时器外，其余改动即时生效。
   */
  const runtime: Config = { ...config, api_key: apiKey };

  if (runtime.debug) {
    ctx.logger.info(`dsh-wakatime: loaded with API key ${maskApiKey(apiKey)}`);
  }

  const client = new WakaTimeClient(runtime);
  const cache = new HeartbeatCache(runtime);
  
  // Use WeakMap for session states as specified in PRD
  const states = new WeakMap<Session, SessionState>();
  // Keep track of all sessions for shutdown cleanup
  const activeSessions = new Set<Session>();

  // 0.2.0 设置监听：订阅 settings/document-updated 事件，重新读取配置
  // 并合并进 runtime。内核在 describe 检测到变化时发该事件。
  ctx.inject(['settings'], (settingsCtx: Context) => {
    const ENTRY_ID = 'dsh-wakatime';
    const SETTINGS_NAMESPACE = 'wakatime';

    const readSettings = (value: unknown): Config => {
      if (value === undefined) return runtime;
      const v = value as Partial<Config>;
      return {
        api_key: v.api_key !== undefined ? v.api_key : runtime.api_key,
        api_url: v.api_url !== undefined ? v.api_url : runtime.api_url,
        heartbeat_interval_ms: v.heartbeat_interval_ms !== undefined ? v.heartbeat_interval_ms : runtime.heartbeat_interval_ms,
        project_name: v.project_name !== undefined ? v.project_name : runtime.project_name,
        language: v.language !== undefined ? v.language : runtime.language,
        include_tool_calls: v.include_tool_calls !== undefined ? v.include_tool_calls : runtime.include_tool_calls,
        include_user_messages: v.include_user_messages !== undefined ? v.include_user_messages : runtime.include_user_messages,
        include_assistant_messages: v.include_assistant_messages !== undefined ? v.include_assistant_messages : runtime.include_assistant_messages,
        cache_heartbeats: v.cache_heartbeats !== undefined ? v.cache_heartbeats : runtime.cache_heartbeats,
        cache_limit: v.cache_limit !== undefined ? v.cache_limit : runtime.cache_limit,
        debug: v.debug !== undefined ? v.debug : runtime.debug,
      };
    };

    let getSettings = (): Config => runtime;

    // 启动即读一次：以当前解析值校正 runtime
    const forms = settingsCtx.settings as unknown as {
      describe?: (opts?: { redactSecrets?: boolean }) => Array<{ ns: string; value?: unknown }>;
    };
    if (forms?.describe) {
      try {
        const row = forms.describe({ redactSecrets: true }).find((candidate) => candidate.ns === ENTRY_ID || candidate.ns === SETTINGS_NAMESPACE);
        if (row?.value !== undefined) {
          const next = readSettings(row.value);
          const prevInterval = runtime.heartbeat_interval_ms;
          Object.assign(runtime, next);
          client.updateConfig(runtime);
          if (runtime.heartbeat_interval_ms !== prevInterval) {
            restartActiveTimers();
          }
          if (runtime.debug) {
            ctx.logger.info(
              `dsh-wakatime: runtime hydrated from settings (tool=${runtime.include_tool_calls}, user=${runtime.include_user_messages}, ai=${runtime.include_assistant_messages}, debug=${runtime.debug})`,
            );
          }
        }
      } catch {
        // describe 不可用时保留现值
      }
    }

    // 文档更新 → 重新取值
    settingsCtx.on('settings/document-updated', (ns: unknown) => {
      if (ns !== ENTRY_ID && ns !== SETTINGS_NAMESPACE) return;
      if (!forms?.describe) return;
      try {
        const row = forms.describe({ redactSecrets: true }).find((candidate) => candidate.ns === ENTRY_ID || candidate.ns === SETTINGS_NAMESPACE);
        if (row?.value !== undefined) {
          const next = readSettings(row.value);
          const prevInterval = runtime.heartbeat_interval_ms;
          Object.assign(runtime, next);
          client.updateConfig(runtime);
          if (runtime.heartbeat_interval_ms !== prevInterval) {
            restartActiveTimers();
          }
          if (runtime.debug) {
            ctx.logger.info('dsh-wakatime: settings updated from WebUI');
          }
        }
      } catch {
        // 读取失败时保留现值
      }
    });
  });

  // dsh 启动器对 unhandledRejection 是 fail-loud 策略（打印 "fatal load failure" 并
  // exit(1)，见 dsh-app-boot installFailLoud）。因此所有后台冲刷必须自行兜底，
  // 绝不让 rejection 冒泡成进程级未处理拒绝。失败时心跳仍留在磁盘缓存，
  // 由下次冲刷自动重试。
  const flushCacheSafely = (): void => {
    cache.flush(client).catch((error) => {
      ctx.logger.warn(`dsh-wakatime: cache flush failed, heartbeats kept for retry: ${String(error)}`);
    });
  };

  const flushPendingSafely = (session: Session): void => {
    flushPending(session).catch((error) => {
      ctx.logger.warn(`dsh-wakatime: pending flush failed: ${String(error)}`);
    });
  };

  const getOrCreateState = (session: Session): SessionState => {
    let state = states.get(session);
    if (!state) {
      // pending 心跳的唯一缓冲在 tracker 内部（按 entity 5 秒合并），
      // flush 时经 tracker.getPending() 取出，避免双缓冲互不相通。
      // tracker 持有 runtime 引用：project_name/language 的 WebUI 覆盖即时生效。
      state = { tracker: new FileTracker(session, runtime), timer: null };
      states.set(session, state);
      activeSessions.add(session);
    }
    return state;
  };

  const flushPending = async (session: Session): Promise<void> => {
    const state = states.get(session);
    if (!state) return;

    // 先等齐在途追踪再收干缓冲：事件处理器对 track 是 fire-and-forget，
    // 直接快照会把「已入队但未完成」的条目留到下一次冲刷（停止边界即丢失）。
    await state.tracker.idle();
    let heartbeats = state.tracker.getPending();
    if (heartbeats.length === 0) return;
    state.tracker.clearPending();
    await state.tracker.idle();
    const late = state.tracker.getPending();
    if (late.length > 0) {
      state.tracker.clearPending();
      heartbeats = [...heartbeats, ...late];
    }

    try {
      for (let i = 0; i < heartbeats.length; i += MAX_BATCH_SIZE) {
        const batch = heartbeats.slice(i, i + MAX_BATCH_SIZE);
        await client.sendHeartbeats(batch);
      }
      if (runtime.debug) {
        ctx.logger.info(`dsh-wakatime: flushed ${heartbeats.length} heartbeats`);
      }
    } catch (error) {
      if (runtime.debug) {
        ctx.logger.warn(`dsh-wakatime: flush failed, caching ${heartbeats.length} heartbeats`);
      }
      if (runtime.cache_heartbeats) {
        // Use appendBatch for better performance
        try {
          await cache.appendBatch(heartbeats);
        } catch (cacheError) {
          // 磁盘写失败也不能让 rejection 冒泡（fail-loud 会杀死整个 dsh 进程）
          ctx.logger.warn(`dsh-wakatime: failed to cache heartbeats: ${String(cacheError)}`);
        }
      }
    }
  };

  const startHeartbeatTimer = (session: Session): void => {
    const state = getOrCreateState(session);
    if (state.timer) return;
    state.timer = setInterval(() => {
      flushPendingSafely(session);
    }, runtime.heartbeat_interval_ms);
  };

  const stopHeartbeatTimer = (session: Session): void => {
    const state = states.get(session);
    if (state?.timer) {
      clearInterval(state.timer);
      state.timer = null;
    }
  };

  /** 心跳间隔变更后重建所有会话的在跑定时器（WebUI 实时调整间隔）。 */
  // 函数声明（非 const 箭头）：settings 服务可能同步就绪，inject 回调在
  // restartActiveTimers 初始化前执行，函数声明的提升可避开 TDZ。
  function restartActiveTimers(): void {
    for (const session of activeSessions) {
      const state = states.get(session);
      if (!state?.timer) continue;
      clearInterval(state.timer);
      state.timer = setInterval(() => {
        flushPendingSafely(session);
      }, runtime.heartbeat_interval_ms);
    }
  }

  // 监听器常驻注册，include_* 开关在事件到达时检查 runtime —— WebUI 切换即时生效
  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    if (!runtime.include_tool_calls || event.type !== 'tool/call') return;
    const state = getOrCreateState(session);
    state.tracker.trackToolCall(event as any);

    // Trigger flush if pending heartbeats reach batch size
    if (state.tracker.getPending().length >= MAX_BATCH_SIZE) {
      flushPendingSafely(session);
    }
  });

  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    if (!runtime.include_user_messages || event.type !== 'user/message') return;
    getOrCreateState(session).tracker.trackUserMessage(event as any);
  });

  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    if (!runtime.include_assistant_messages || event.type !== 'assistant/message') return;
    getOrCreateState(session).tracker.trackAssistantMessage(event as any);
  });

  ctx.on('agent/status', ({ agent, status }: { agent: Agent; status: AgentStatus }) => {
    const session = agent.session;
    if (status === 'running') {
      startHeartbeatTimer(session);
    } else {
      stopHeartbeatTimer(session);
      flushPendingSafely(session);
      flushCacheSafely();
    }
  });

  // Graceful shutdown on fiber disposal
  ctx.effect(() => () => {
    for (const session of activeSessions) {
      const state = states.get(session);
      if (state?.timer) {
        clearInterval(state.timer);
        state.timer = null;
      }
      flushPendingSafely(session);
    }
  });

  // Process exit signal handling for graceful shutdown
  const gracefulShutdown = async () => {
    if (runtime.debug) {
      ctx.logger.info('dsh-wakatime: process exiting, flushing remaining heartbeats');
    }
    for (const session of activeSessions) {
      const state = states.get(session);
      if (state?.timer) {
        clearInterval(state.timer);
        state.timer = null;
      }
      flushPendingSafely(session);
    }
    try {
      await cache.flush(client);
    } catch {
      // Ignore errors during shutdown
    }
  };

  process.on('SIGINT', () => {
    void gracefulShutdown().then(() => process.exit(0));
  });
  process.on('SIGTERM', () => {
    void gracefulShutdown().then(() => process.exit(0));
  });
}
