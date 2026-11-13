import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
// Type-only side-effect imports: register the `agent/status` and
// `session/event` extensions on the Cordis event surface.
// `dsh-settings` 同理：它把 `ctx.settings` 属性与 `settings/document-updated` 事件
// 合并进 cordis 的 Context/Events 类型。原先这个副作用由 src/settings.ts 顶部的一行
// import 提供（该文件其余部分已确认无任何消费者，随本次清理移除）。
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-settings';
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent';
import type { WakaTimeHeartbeat } from './types.js';
import { WakaTimeClient } from './wakatime.js';
import { FileTracker } from './tracker.js';
import { HeartbeatCache } from './cache.js';
import { readWakatimeCfgApiKey, readWakatimeCfgProxy, maskApiKey } from './project.js';
import { CONFIG_DEFAULTS, NUMBER_RANGES, normalizeConfig, normalizeDocument, plainValue, type DegradedField } from './config-value.js';
import { applyBanner } from './build-stamp.js';

export const name = 'dsh-wakatime';
export const inject = ['sessions'];

/**
 * 0.2.0 配置迁移：`Config` 用 `.volatile()` 标记用户可调字段，
 * 内核自动把 Config 投影成设置页（ns = Loader 条目 id = `dsh-wakatime`）。
 * 不再需要 `ctx.settings.register()`（该 API 在 0.1.7 已删除）。
 *
 * 注意：`.volatile()` 意味着宿主把字段以 volatile ref **对象**交给 apply()，
 * 因此所有使用点都必须先经 config-value.ts 规范化，不能直接当值读。
 */
export interface Config {
  api_key: string;
  api_url: string;
  /**
   * 出口代理地址（`http://host:port`）。非空时优先级最高，覆盖环境变量与
   * `~/.wakatime.cfg`；填 `none` / `direct` 表示强制直连。
   * 留空＝沿用环境变量 → cfg 的回退链（见 wakatime.ts 的 resolveProxy）。
   */
  proxy_url: string;
  /**
   * 不走代理的地址表（逗号分隔）。非空时覆盖 `NO_PROXY` 环境变量。
   * 语义同宿主 `dsh-http-proxy`：`example.com` 也匹配其子域，支持 `*` 与 `.suffix`。
   */
  no_proxy: string;
  heartbeat_interval_ms: number;
  project_name: string;
  language: string;
  /**
   * shell / 会话类心跳（`type: 'app'`）上报的 entity —— 即「这次活动发生在哪个应用上」。
   * 默认 `Terminal`，对齐 wakatime-cli 对 app 类型 entity 的定义（应用名，不是命令行）。
   * 空白值按默认值处理：entity 为空会被服务端逐条 400 拒收（校验是 "between 1 and 2083"）。
   */
  app_entity: string;
  include_tool_calls: boolean;
  include_user_messages: boolean;
  include_assistant_messages: boolean;
  cache_heartbeats: boolean;
  cache_limit: number;
  debug: boolean;
}

// 默认值与数值区间都取自 config-value 那一份常量：Schema 的 `.default()` 与
// 规范化失败时的回退必须是同一个值，两处各写字面量迟早漂移。
const [INTERVAL_MIN, INTERVAL_MAX] = NUMBER_RANGES.heartbeat_interval_ms as [number, number];
const [CACHE_MIN, CACHE_MAX] = NUMBER_RANGES.cache_limit as [number, number];

export const Config = Schema.object({
  api_key: Schema.string().default(CONFIG_DEFAULTS.api_key).role('secret').volatile(),
  api_url: Schema.string().default(CONFIG_DEFAULTS.api_url).volatile(),
  proxy_url: Schema.string().default(CONFIG_DEFAULTS.proxy_url).volatile(),
  no_proxy: Schema.string().default(CONFIG_DEFAULTS.no_proxy).volatile(),
  heartbeat_interval_ms: Schema.natural().min(INTERVAL_MIN).max(INTERVAL_MAX).default(CONFIG_DEFAULTS.heartbeat_interval_ms).volatile(),
  project_name: Schema.string().default(CONFIG_DEFAULTS.project_name).volatile(),
  language: Schema.string().default(CONFIG_DEFAULTS.language).volatile(),
  app_entity: Schema.string().default(CONFIG_DEFAULTS.app_entity).volatile(),
  include_tool_calls: Schema.boolean().default(CONFIG_DEFAULTS.include_tool_calls).volatile(),
  include_user_messages: Schema.boolean().default(CONFIG_DEFAULTS.include_user_messages).volatile(),
  include_assistant_messages: Schema.boolean().default(CONFIG_DEFAULTS.include_assistant_messages).volatile(),
  cache_heartbeats: Schema.boolean().default(CONFIG_DEFAULTS.cache_heartbeats).volatile(),
  cache_limit: Schema.natural().min(CACHE_MIN).max(CACHE_MAX).default(CONFIG_DEFAULTS.cache_limit).volatile(),
  debug: Schema.boolean().default(CONFIG_DEFAULTS.debug).volatile(),
});

interface SessionState {
  tracker: FileTracker;
  timer: NodeJS.Timeout | null;
}

/**
 * 把任意来源的 api_key 收成可用字符串：非字符串、空串、纯空白都算「没给」。
 *
 * 只用于 api_key 这一条链（配置层 → 环境变量 → ~/.wakatime.cfg），因为它有
 * 两级外部兜底；其余字段的形状校验统一在 config-value.ts。
 *
 * @param value - 配置层/环境变量/配置文件的原始值。
 * @returns 可直接用于 Basic 凭据的 key，不可用时为空串。
 */
function usableApiKey(value: unknown): string {
  const raw = plainValue(value);
  return typeof raw === 'string' ? raw.trim() : '';
}

/** 该层是否【根本没提供】api_key（缺席/空值），用于区分「没给」与「给了但不可用」。 */
function isAbsentApiKey(value: unknown): boolean {
  const raw = plainValue(value);
  return raw === undefined || raw === null || raw === '';
}

/**
 * warn 级消息的统一出口：宿主 logger + console 双写。
 *
 * 本宿主的 `ctx.logger` 输出不进 stdout/stderr 捕获文件（实测 dsh-web.log 里
 * 只有 console.* 的行）。这不是洁癖：插件两次「上报静默中断」（一次一周、
 * 一次四小时）之所以没人发现，就是因为唯一的失败线索落在了看不见的通道里。
 *
 * @param ctx - 插件上下文。
 * @param message - 已带 `dsh-wakatime:` 前缀的正文。
 */
function warnOut(ctx: Context, message: string): void {
  ctx.logger.warn(message);
  console.warn(`[${name}] ${message}`);
}

/**
 * 逐字段规范化失败/回退的统一告警。
 *
 * 宿主 logger 之外再走一次 console.warn：本宿主的 `ctx.logger` 输出不进
 * stdout/stderr 捕获文件（实测 dsh-web.log 只有 console.* 的行），而「配置被
 * 静默降级」恰恰是必须被看见的那类事件——本插件两次断流（一次一周、一次四小时）
 * 都没留下任何可见痕迹，原因就在这里。
 *
 * @param ctx - 插件上下文。
 * @param degraded - 需要回退的字段清单。
 * @param source - 触发来源（apply / settings 文档），用于定位是哪一层给的坏值。
 */
function reportDegraded(ctx: Context, degraded: DegradedField[], source: string): void {
  if (degraded.length === 0) return;
  const summary = degraded.map((d) => `${d.field}=${d.shape}`).join(', ');
  const message = `dsh-wakatime: ${source} 有 ${degraded.length} 个配置字段不是可用值，已按默认值/现值回退：${summary}`;
  ctx.logger.warn(message);
  console.warn(`[${name}] ${message}`);
}

// Maximum heartbeats per batch (WakaTime limit)
const MAX_BATCH_SIZE = 25;

export function apply(ctx: Context, config: Config): void {
  console.log(applyBanner('dsh-wakatime', import.meta.url));
  // Check for conflicting plugin: dsh-codetime
  let hasCodetime = false;
  for (const entry of ctx.registry.values()) {
    if (entry.name === 'dsh-codetime') {
      hasCodetime = true;
      break;
    }
  }
  if (hasCodetime) {
    warnOut(ctx, 'dsh-wakatime: 检测到 dsh-codetime 已安装，二者都是 telemetry backend，建议只保留一个');
  }

  // 先把整份配置规范化：`.volatile()` 字段到这里还是 cosmokit 的 ref 对象
  // （`Object.freeze({ get, [write] })`），直接当值用会让每个字段各自以一种
  // 难看的形态失效（api_url → Invalid URL、interval → 1ms 风暴、include_* →
  // 恒真、project_name/language → 字段整个不发、cache_limit → 永不裁剪）。
  // 详见 config-value.ts 顶部的实测清单。
  const { config: resolved, degraded } = normalizeConfig(config);
  reportDegraded(ctx, degraded, 'apply');

  // API key 解析优先级：
  // 1. Config from cordis.patch.yml（已规范化为裸值）
  // 2. Environment variable WAKATIME_API_KEY
  // 3. ~/.wakatime.cfg api_key
  //
  // 三层都必须【真的是非空字符串】才算命中。旧写法 `let apiKey = config.api_key`
  // 只看 truthy，而 ref 对象是 truthy —— 于是它被当成有效 key：既跳过了后面两级
  // 兜底，又让 Authorization 变成 base64("[object Object]:")。服务端恒 401，
  // 401 还会写 authFailRetryAfter（5 分钟内直接跳过发送），心跳全部只进本地缓存、
  // 再被 cache_limit 截断丢弃：用户侧表现为「WakaTime 上的时间凭空消失」，
  // 而 debug 关闭时旧代码一个字都不打。
  const rawConfigKey = (config as unknown as { api_key?: unknown }).api_key;
  let apiKey = usableApiKey(rawConfigKey);
  if (!apiKey && !isAbsentApiKey(rawConfigKey)) {
    // 形状已由 reportDegraded 汇总，这里只补一句「本层被跳过、正在回退」。
    warnOut(ctx, 'dsh-wakatime: 配置层的 api_key 不是可用字符串，已忽略该层并继续回退');
  }
  if (!apiKey) {
    apiKey = usableApiKey(process.env.WAKATIME_API_KEY);
  }
  if (!apiKey) {
    apiKey = usableApiKey(readWakatimeCfgApiKey());
  }

  if (!apiKey) {
    warnOut(ctx, 'dsh-wakatime: 未配置 API Key，请在 cordis.patch.yml、环境变量 WAKATIME_API_KEY 或 ~/.wakatime.cfg 中设置');
    return;
  }

  /**
   * 运行时配置单例：WebUI 设置更新经 settings/document-updated 事件原地合并进同一对象，
   * client / cache / tracker / 各事件处理器都持有这个引用 —— 除心跳间隔
   * 需要重建定时器外，其余改动即时生效。
   *
   * 必须从 `resolved`（规范化后）展开，而不是原样 `config`：原对象里每个
   * `.volatile()` 字段还是 ref，谁读谁坏。
   */
  const runtime: Config = { ...resolved, api_key: apiKey };

  /**
   * 一次性事件（启动、配置变更、退出）的调试输出。
   *
   * 设置项写着「输出详细日志到 DSH 控制台」，而本宿主的 `ctx.logger` 不进
   * stdout/stderr 捕获文件——只调 logger 等于这个开关根本没用，所以这类
   * **每次节点只发生一次**的诊断同时走 console。
   *
   * 每轮都发生的常态信息（例如「本轮冲刷成功 N 条」）不要用它，见 {@link routineLog}。
   *
   * @param message - 已带 `dsh-wakatime:` 前缀的正文。
   */
  const debugLog = (message: string): void => {
    if (!runtime.debug) return;
    ctx.logger.info(message);
    console.log(`[${name}] ${message}`);
  };

  /**
   * 高频常态事件的输出口径：**只进宿主 logger，不进 console**。
   *
   * 心跳每 120 秒冲刷一次、一次会话可能跑几个小时，这类「成功且无异常」的行
   * 一旦打到 console 就是纯噪音——它会把真正的告警淹没掉，而告警可见性正是
   * 这个插件前两次事故后费力建立起来的东西。所以分流规则是：
   * - 一次性的节点（启动/配置/退出）→ debugLog（debug 时双写）
   * - 每轮都会发生的常态信息 → routineLog（只走 logger，console 保持安静）
   * - 任何异常（失败、逐条拒绝、缓存丢弃）→ warnOut（无条件双写）
   *
   * @param message - 已带 `dsh-wakatime:` 前缀的正文。
   */
  const routineLog = (message: string): void => {
    if (!runtime.debug) return;
    ctx.logger.info(message);
  };


  /**
   * 交给客户端的配置：runtime 之外补上 `~/.wakatime.cfg` 里的代理。
   *
   * 每次构造/更新都重读该文件：它由 wakatime-cli 维护，用户改它不需要重启 DSH，
   * 而文件只有几十字节，读失败也只是"不用 cfg 代理"，不影响环境变量优先级。
   */
  const clientConfig = () => ({
    ...runtime,
    api_key: runtime.api_key,
    api_url: runtime.api_url,
    proxy_url: runtime.proxy_url,
    no_proxy: runtime.no_proxy,
    cfg_proxy: readWakatimeCfgProxy(),
  });

  const client = new WakaTimeClient(clientConfig());

  debugLog(`dsh-wakatime: loaded with API key ${maskApiKey(apiKey)}`);
  // 代理口径必须可见：三个来源（设置页 / 环境变量 / cfg）谁生效、谁被忽略，
  // 是排查"配了代理却没生效"最短的路径。
  debugLog(`dsh-wakatime: 网络出口 ${client.describeProxy()}${runtime.no_proxy ? `，no_proxy=${runtime.no_proxy}` : ''}`);
  for (const message of client.takeConfigDiagnostics()) {
    warnOut(ctx, `dsh-wakatime: ${message}`);
  }
  const cache = new HeartbeatCache(runtime);

  // Use WeakMap for session states as specified in PRD
  const states = new WeakMap<Session, SessionState>();
  // Keep track of all sessions for shutdown cleanup
  const activeSessions = new Set<Session>();

  // 0.2.0 设置监听：订阅 settings/document-updated 事件，重新读取配置
  // 并合并进 runtime。内核在 describe 检测到变化时发该事件。
  //
  // 【事件投递语义】cordis 不做父子树传播，而是用 isolate 作用域相等性过滤：
  //   EventsService.dispatch() 读 `thisArg?.[Context.filter]`，保留
  //   `hook.global || !filter || filter.call(thisArg, hook.ctx)`（cordis 4.0.4）。
  // 而 Service 的 isolate 断言是【服务实例】上的方法，构造时并不会装到 ctx 上；
  // dsh-settings 用 `this.ownerContext.emit('settings/document-updated', ...)` 发射
  // （dsh-settings/lib/index.js:435），该 emitter 的 filter 槽实测为 undefined，
  // 于是 `!filter` 成立 —— 事件被投递给进程内【所有】监听者，与注册深度无关
  // （包括 ctx.inject 回调拿到的子 ctx，以及 ctx.root）。
  //
  // 因此这里注册在插件自己的 ctx 上（而非 root）：语义上更窄、不越权广播，
  // 同时【必须】保留下面的 ns 过滤 —— 本跳根本没有过滤，任何命名空间的事件
  // 都会打进来。历史注释曾称「必须挂在 root 才能收到」，经实测为误判。
  const ENTRY_ID = 'dsh-wakatime';
  // 兼容旧版 settings.yaml 遗留的 section 名
  const SETTINGS_NAMESPACE = 'wakatime';

  /** describe() 返回的行：只声明我们实际用到的字段以避免引入私有类型依赖。 */
  interface SettingsRow {
    ns: string;
    value?: unknown;
    /** 仅在 redactSecrets 时出现：标记 schema 声明的 secret 槽位是否有值。 */
    secrets?: Array<{ path: string[]; set: boolean }>;
  }

  /**
   * describe() 的调用入口。settings 服务可能尚未就绪（无 settings 服务、
   * 或服务未提供 describe），此时返回 undefined，调用方保留现值。
   */
  let describeRows: (() => SettingsRow[] | undefined) | null = null;

  /**
   * 用一行 describe 结果校正 runtime。
   *
   * 两条纪律：
   * 1. 缺席的字段保持现值。`describe({ redactSecrets: true })` 对 role('secret')
   *    字段的行为是【整个字段被移除】（walk() 在 `node.meta.role === 'secret'` 时
   *    直接 return，只把 { path, set } 记进旁路 secrets 数组，见
   *    dsh-settings/lib/index.js 的 redactSecrets），所以「字段缺席」正是
   *    「用户这次没改 key」的正确信号；不能退化成 `v.api_key || ...`，
   *    因为空串是合法的「用户主动清空」。
   * 2. 提交来的值先规范化再用。文档层的字段同样可能是 volatile ref 对象，
   *    直接赋值会让 runtime 从「好值」退化成「坏形状」——那正是 apply() 入口
   *    要避免的事，合并路径不能开后门。归一化由 config-value.normalizeDocument 统一做，
   *    不可用的字段保持现值并进 degraded 告警。
   */
  const applyRow = (row: SettingsRow, source: string): void => {
    const prevInterval = runtime.heartbeat_interval_ms;
    const { partial, degraded } = normalizeDocument(row.value);
    reportDegraded(ctx, degraded, source);

    Object.assign(runtime, partial);

    // api_key 的清空回退只在这一处特殊处理：留空 = 「不用文档层的值」，
    // 而不是「用空 key 去鉴权」（后者会让上报全 401 并触发 5 分钟跳过发送）。
    if ('api_key' in partial) {
      const submitted = usableApiKey(partial.api_key);
      if (submitted) {
        runtime.api_key = submitted;
      } else if (isAbsentApiKey(partial.api_key)) {
        runtime.api_key = usableApiKey(process.env.WAKATIME_API_KEY) || usableApiKey(readWakatimeCfgApiKey());
        debugLog(`dsh-wakatime: api_key 已被清空，回退到 ${maskApiKey(runtime.api_key) || '无可用 key'}`);
      }
      // 非字符串的情况已由 reportDegraded 报出，partial.api_key 保持现值，无需再处理。
    }

    // client 持有配置快照，重建成含最新 cfg 代理的那份
    client.updateConfig(clientConfig());
    for (const message of client.takeConfigDiagnostics()) {
      warnOut(ctx, `dsh-wakatime: ${message}`);
    }
    debugLog(`dsh-wakatime: 网络出口 ${client.describeProxy()}`);
    // 心跳间隔变更需要重建在跑定时器，其余字段在事件到达时读 runtime 即时生效
    if (runtime.heartbeat_interval_ms !== prevInterval) {
      restartActiveTimers();
    }
    debugLog(
      `dsh-wakatime: runtime ${source} (tool=${runtime.include_tool_calls}, user=${runtime.include_user_messages}, ai=${runtime.include_assistant_messages}, debug=${runtime.debug})`,
    );
  };

  /** 读取本插件命名空间的那一行；describe 不可用或缺行时返回 undefined。 */
  const readOwnRow = (): SettingsRow | undefined => {
    // 先取到本地绑定：闭包调用会丢失上面的窄化
    const read = describeRows;
    if (!read) return undefined;
    try {
      const rows = read();
      if (!rows) return undefined;
      return rows.find((row) => row.ns === ENTRY_ID || row.ns === SETTINGS_NAMESPACE);
    } catch {
      // describe 不可用时保留现值
      return undefined;
    }
  };

  ctx.inject(['settings'], (settingsCtx: Context) => {
    const settings = settingsCtx.settings as unknown as {
      describe?: (opts?: { redactSecrets?: boolean }) => SettingsRow[];
    };
    const describe = settings?.describe;
    if (typeof describe !== 'function') return;
    describeRows = () => describe.call(settings, { redactSecrets: true });
  });

  // 启动即读一次：以当前解析值校正 runtime。
  // 回归背景：进程重启后入口 config 缺省 include_*（schema 默认 false），
  // 会静默丢掉用户文档层里持久保存的 true。describe() 是权威来源。
  const bootRow = readOwnRow();
  if (bootRow) applyRow(bootRow, 'hydrated from settings');

  // 文档更新 → 重新取值并合并。
  // 挂插件自身的 ctx；ns 过滤不可省（见上方投递语义说明）。
  ctx.on('settings/document-updated', (ns: unknown) => {
    if (ns !== ENTRY_ID && ns !== SETTINGS_NAMESPACE) return;
    const row = readOwnRow();
    if (!row) return;
    applyRow(row, 'updated from WebUI');
  });

  // dsh 启动器对 unhandledRejection 是 fail-loud 策略（打印 "fatal load failure" 并
  // exit(1)，见 dsh-app-boot installFailLoud）。因此所有后台冲刷必须自行兜底，
  // 绝不让 rejection 冒泡成进程级未处理拒绝。失败时心跳仍留在磁盘缓存，
  // 由下次冲刷自动重试。
  /**
   * 报告「缓存超限被裁剪」这件事。
   *
   * 缓存涨过 cache_limit 意味着失败已经持续到把兜底缓冲撑满了，此时最旧的心跳
   * 会被删掉——旧实现删得无声无息，用户只看到「那段时间数据没了」。这里把每次
   * 裁剪的条数与时间跨度打出来；`POST` 侧同一批回写会连续触发多次 enforceLimit，
   * 因此按"上一次报告之后累计"统计，而不是每裁一条报一次。
   */
  const reportCacheDrops = (): void => {
    const dropped = cache.takeDropped();
    if (dropped === null || dropped.count === 0) return;
    const from = new Date(dropped.from * 1000).toLocaleString('zh-CN', { hour12: false });
    const to = new Date(dropped.to * 1000).toLocaleString('zh-CN', { hour12: false });
    warnOut(
      ctx,
      `dsh-wakatime: 缓存超过上限（${runtime.cache_limit} 条），最旧的 ${dropped.count} 条心跳已被丢弃（${from} → ${to}）。` +
        '这说明上报已持续失败很久，请检查网络/代理；被丢弃的这段时间无法补回。',
    );
  };

  const flushCacheSafely = (): void => {
    cache.flush(client).catch((error) => {
      warnOut(ctx, `dsh-wakatime: cache flush failed, heartbeats kept for retry: ${String(error)}`);
    }).finally(reportCacheDrops);
  };

  const flushPendingSafely = (session: Session): void => {
    flushPending(session).catch((error) => {
      warnOut(ctx, `dsh-wakatime: pending flush failed: ${String(error)}`);
    }).finally(reportCacheDrops);
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

    // 逐批发送，并按「哪几条真的没落库」决定回写缓存的集合。
    //
    // 旧实现是 catch 里无条件 `appendBatch(heartbeats)`：一批 25 条发到第 3 批
    // 失败时，前两批已经进库的心跳也被写回缓存，下次 flush 再发一遍——
    // 服务端把重复心跳计入时长/token，用户看到的就是「数据翻倍」。
    let accepted = 0;
    /** 逐条被拒但载荷本身没问题的（429/5xx）：回缓存重试。 */
    const retryable: WakaTimeHeartbeat[] = [];
    /** 逐条被拒且重试必然再失败的（4xx 校验）：只能丢弃，但必须说出来。 */
    let rejectedPermanent = 0;
    let rejectionSample = '';
    /** 传输层失败（含超时/限流抛出）：该批及其后的批次都算没落库。 */
    let failure: { at: number; error: unknown } | null = null;

    for (let i = 0; i < heartbeats.length; i += MAX_BATCH_SIZE) {
      const batch = heartbeats.slice(i, i + MAX_BATCH_SIZE);
      let result;
      try {
        result = await client.sendHeartbeats(batch);
      } catch (error) {
        failure = { at: i, error };
        break;
      }
      accepted += result.accepted;
      for (const rejected of result.rejected) {
        const heartbeat = batch[rejected.index];
        if (!heartbeat) continue;
        if (rejected.permanent) {
          rejectedPermanent++;
          if (rejectionSample === '') rejectionSample = `${rejected.status}: ${rejected.detail}`;
        } else {
          retryable.push(heartbeat);
        }
      }
    }

    // 未落库 = 失败批次起点之后的全部 + 之前各批里逐条被拒且可重试的。
    const unpersisted = failure ? [...heartbeats.slice(failure.at), ...retryable] : retryable;

    // 回写缓存与「有没有传输失败」是两件事：只有逐条 429/5xx 时外层依旧成功，
    // 但那些条目同样没落库，必须一起回缓存。
    // （回归：上一版把 appendBatch 写在 `if (failure)` 里面，纯限流场景下
    // retryable 被直接丢弃——可重试的数据不该按永久失败处理。）
    if (runtime.cache_heartbeats && unpersisted.length > 0) {
      try {
        await cache.appendBatch(unpersisted);
      } catch (cacheError) {
        // 磁盘写失败也不能让 rejection 冒泡（fail-loud 会杀死整个 dsh 进程）
        warnOut(ctx, `dsh-wakatime: failed to cache heartbeats: ${String(cacheError)}`);
      }
    }

    if (failure) {
      // 无条件 warn（此前只在 debug 下打印，且不打原因）：上报路径一旦持续
      // 失败，缓存会被 enforceLimit 截断成新 100 条，用户侧表现为「时间凭空缺失」，
      // 而日志里一个字都没有——失败原因必须默认可见。
      warnOut(ctx, 
        `dsh-wakatime: 上报失败，${unpersisted.length} 条心跳转入缓存重试（本批 ${heartbeats.length} 条，已落库 ${accepted} 条）：${String(failure.error)}`,
      );
    } else if (rejectedPermanent > 0) {
      // 逐条 4xx 的重试必然再失败，只能丢弃；丢弃必须说出来，否则就是静默丢数据。
      warnOut(ctx, 
        `dsh-wakatime: ${rejectedPermanent}/${heartbeats.length} 条心跳被 WakaTime 逐条拒绝并已丢弃（重试无效），样例 ${rejectionSample}`,
      );
    } else if (retryable.length > 0) {
      warnOut(ctx, 
        `dsh-wakatime: ${retryable.length}/${heartbeats.length} 条心跳被逐条限流或服务端错误退回，已转入缓存重试`,
      );
    } else if (runtime.debug) {
      // 每轮冲刷都会走到这里：用 routineLog，console 保持安静。
      routineLog(`dsh-wakatime: flushed ${accepted}/${heartbeats.length} heartbeats`);
    }
  };

  const startHeartbeatTimer = (session: Session): void => {
    const state = getOrCreateState(session);
    // 幂等：running 可能在一次会话里重复到达（唤醒输入、重试、宿主补发）。
    // state.timer 非空即返回，绝不为同一 session 叠第二个 setInterval，
    // 否则每个重复边都会多一条独立的冲刷节拍并永久留在 activeSessions 里。
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

  /**
   * 【为什么是根级监听】agent/status 由宿主的 agent 融合 carrier 派发（payload 必带
   * agent），dsh-scope 的 filter 对「无 scope tag 的接收 ctx」一律放行，所以插件 ctx
   * 收得到进程内所有 agent 的事件；宿主一方插件用的也是同一写法（0.2.1-rc.2 的源码
   * 证据与一方插件位置见本分支 commit 正文，行号会随宿主版本漂移，不躺在注释里）。
   * 换成 agent/created + agent.ctx.on 会漏掉「插件 fiber 启动前就存在的 agent」：
   * 它们永不触发 created，running/idle 无人接管、心跳定时器根本不启动。
   */
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

  /**
   * agent/disposed（@mode emit）：agent 已离开注册表，此后不再有该 session 的 running
   * 边界。顺序要紧：停定时器（回调闭包持有 session/state）→ 最后一次冲刷 pending 与
   * 磁盘缓存（复用 flushPendingSafely，与相邻的最后一次 idle 可重入安全）→ 从强引用
   * Set activeSessions 移除（此前只增不减，长跑进程会永久持有每个历史 session）。
   * 监听器内不 await，失败一律 *Safely 兜底（宿主对 unhandledRejection 是 fail-loud）。
   * 不做 dispose 黑名单：同一 Session 实例可能承载下一个 Agent，屏蔽迟到事件会让它永久失去追踪。
   */
  ctx.on('agent/disposed', ({ agent }: { agent: Agent }) => {
    const session = agent.session;
    stopHeartbeatTimer(session);
    flushPendingSafely(session);
    flushCacheSafely();
    activeSessions.delete(session);
  });

  /** 退出前把每个会话的 pending 心跳与磁盘缓存都冲出去，再按原有语义 exit(0)。 */
  const gracefulShutdown = async () => {
    if (runtime.debug) {
      debugLog('dsh-wakatime: process exiting, flushing remaining heartbeats');
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

  const handleExitSignal = (): void => {
    void gracefulShutdown().then(() => process.exit(0));
  };

  /**
   * fiber 卸载是本插件资源回收的唯一出口：先摘掉 signal 监听（handler 引用要留着，
   * `process.off` 只在同一引用上生效），再停每个会话的定时器并做最后一次冲刷。
   * signal 监听必须随 fiber 注册/注销：`apply()` 每执行一次就注册一对，热重载/HMR 下
   * 旧 fiber 的闭包会累积（退出时被 N 份旧 state 各冲刷一次；MaxListenersExceededWarning
   * 只是表象）。也不要改成「模块级只注册一次」的单例：第二次 apply() 的闭包会引用到
   * 第一份 config/state，语义更糟。
   */
  ctx.effect(() => {
    process.on('SIGINT', handleExitSignal);
    process.on('SIGTERM', handleExitSignal);
    return () => {
      process.off('SIGINT', handleExitSignal);
      process.off('SIGTERM', handleExitSignal);
      for (const session of activeSessions) {
        const state = states.get(session);
        if (state?.timer) {
          clearInterval(state.timer);
          state.timer = null;
        }
        flushPendingSafely(session);
      }
    };
  });
}
