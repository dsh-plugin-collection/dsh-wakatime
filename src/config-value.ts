/**
 * 插件配置的规范化：解包 volatile ref + 逐字段类型校验 + 回退默认值。
 *
 * 为什么必须有这一层（两次线上事故的共同根因）：
 * 标记 `.volatile()` 的字段由宿主以 cosmokit 的 volatile ref 交付给插件，形状是
 * `Object.freeze({ get: () => value, [write]: … })` —— **是对象，不是值**。
 * `dsh-settings` 自己消费 config 前也先做 `isVolatile(v) ? plainConfig(v.get()) : v`
 * （见其 `plainConfig`），可见"交来的不是裸值"是宿主的既定契约，不是异常。
 *
 * 未规范化时会发生什么（都是实测，不是推测）：
 * - `api_key` 是对象 → `btoa(obj + ':')` = base64("[object Object]:") → 服务端恒 401
 *   → 触发 authFailRetryAfter（5 分钟跳过发送）→ 心跳只进本地缓存并被裁掉，
 *   静默断流一整周。
 * - `api_url` 是对象 → `` `${api_url}/api/v1` `` 拼出非法 URL → `new URL()` 直接
 *   抛 `Invalid URL`，请求根本没发出去。
 * - `heartbeat_interval_ms` 是对象 → `setInterval(fn, NaN)` → Node 把 delay 当 1ms
 *   （Node 侧行为在隔离进程复现过：delay 非数字 → 1 秒触发 915 次并打
 *   "Timeout duration was set to 1"）。注意证据强度：宿主进程日志里从未出现该警告，
 *   所以这里只断言「按 1ms 跑」是 Node 对非法 delay 的既定行为，不断言它必然在宿主内发生，
 *   也不把任何 CPU 数字归因给它——重启并规范化配置后宿主 CPU 仍在 240% 量级，
 *   说明瓶颈不在这里。
 * - `include_*` 是对象 → truthy → **设置里的 false 被无视**，该关的追踪照发。
 * - `project_name` / `language` 是对象 → 上报时这两个字段被当成空值整个不发
 *   → 数据落进"无项目 / 无语言"。
 * - `cache_limit` 是对象 → `lines.length > 对象` 恒 false → 缓存永不裁剪。
 *
 * 私有 `write` symbol 在插件侧拿不到，因此用鸭子类型识别 ref（`{ get(): unknown }`）：
 * 本插件没有任何字段本身是带 `get` 方法的对象，不会误判。
 *
 * @module dsh-wakatime/config-value
 */

import type { Config } from './index.js';

/**
 * 判断并解包一个 cosmokit volatile ref。
 *
 * @param value - 任意来源的配置值。
 * @param depth - 内部递归深度上限，防止畸形值造成死循环。
 * @returns 解包后的裸值；不是 ref 时原样返回。
 */
export function plainValue(value: unknown, depth = 0): unknown {
  if (depth >= 4) return value;
  if (value !== null && typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function') {
    try {
      return plainValue((value as { get: () => unknown }).get(), depth + 1);
    } catch {
      // ref 的 get() 自身抛错（宿主内部状态异常）：按「不可用」处理，交给类型校验回退默认值。
      return undefined;
    }
  }
  return value;
}

/** 一个字段被判为不可用时的记录，用于聚合告警。 */
export interface DegradedField {
  field: keyof Config;
  /** 只报形状与类型，绝不报值：api_key 等槽位可能承载凭据。 */
  shape: string;
}

/** 数值字段的合法闭区间（与 index.ts 里 Schema 的 min/max 必须一致，共用这一份）。 */
export const NUMBER_RANGES: Partial<Record<keyof Config, [number, number]>> = {
  heartbeat_interval_ms: [60_000, 300_000],
  cache_limit: [10, 1000],
};

/**
 * 配置字段的默认值——**唯一来源**。
 *
 * Schema 用它取 `.default()`，规范化失败时也回退到这里，两处不可能漂移；
 * 早先两处各写一份字面量，正是这类问题难查的原因之一。
 */
export const CONFIG_DEFAULTS: Config = {
  api_key: '',
  api_url: 'https://wakatime.com',
  heartbeat_interval_ms: 120_000,
  project_name: '',
  language: '',
  app_entity: 'Terminal',
  include_tool_calls: true,
  include_user_messages: false,
  include_assistant_messages: false,
  cache_heartbeats: true,
  cache_limit: 100,
  debug: false,
};

/** 描述一个不可用取值的形状（只报类型/键名，不报值）。 */
function describeShape(value: unknown): string {
  const unwrapped = plainValue(value);
  if (unwrapped === null) return 'null';
  if (unwrapped === undefined) return 'undefined';
  if (Array.isArray(unwrapped)) return `array(${unwrapped.length})`;
  if (typeof unwrapped === 'object') {
    const keys = Object.keys(unwrapped as Record<string, unknown>);
    return `object{${keys.slice(0, 4).join(',')}${keys.length > 4 ? ',…' : ''}}`;
  }
  return `${typeof unwrapped}(${String(unwrapped).length})`;
}

/** 解包后按 string 取值；非字符串（含空白值本身合法）记为不可用。 */
export function readString(value: unknown, fallback: string, field?: keyof Config, degraded?: DegradedField[]): string {
  const raw = plainValue(value);
  if (typeof raw === 'string') return raw;
  if (value !== undefined && field !== undefined && degraded !== undefined) {
    degraded.push({ field, shape: describeShape(value) });
  }
  return fallback;
}

/** 解包后按有限数值取值，并要求落在 {@link NUMBER_RANGES} 声明的区间内。 */
export function readNumber(
  value: unknown,
  field: keyof Config,
  fallback: number,
  degraded?: DegradedField[],
): number {
  const raw = plainValue(value);
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    if (value !== undefined && degraded !== undefined) degraded.push({ field, shape: describeShape(value) });
    return fallback;
  }
  const range = NUMBER_RANGES[field];
  if (range !== undefined && (raw < range[0] || raw > range[1])) {
    if (degraded !== undefined) degraded.push({ field, shape: `越界 ${raw}∉[${range[0]},${range[1]}]` });
    return fallback;
  }
  return raw;
}

/** 解包后按 boolean 取值。 */
export function readBoolean(value: unknown, field: keyof Config, fallback: boolean, degraded?: DegradedField[]): boolean {
  const raw = plainValue(value);
  if (typeof raw === 'boolean') return raw;
  if (value !== undefined && degraded !== undefined) degraded.push({ field, shape: describeShape(value) });
  return fallback;
}

/**
 * `api_url` 的额外校验：必须是带协议的绝对地址。
 *
 * 这是把「Invalid URL 让所有发送在发出之前就失败」这一整类故障挡在入口：
 * 值再离谱也只会回退默认端点并告警，而不会让插件静默瘫痪。
 *
 * @param value - 解包后的候选值。
 * @returns 可作为 `${api_url}/api/v1` 前缀的地址，去掉尾部斜杠；不合法时为 undefined。
 */
function usableApiUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().replace(/\/+$/, '');
  if (trimmed === '') return undefined;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 规范化宿主交来的整份配置。
 *
 * @param raw - apply() 收到的 config（字段可能是 volatile ref 对象）。
 * @returns 全部字段都是可用裸值的新对象，以及需要回退的字段清单。
 */
export function normalizeConfig(raw: unknown): { config: Config; degraded: DegradedField[] } {
  const source = (raw ?? {}) as Record<string, unknown>;
  const degraded: DegradedField[] = [];

  const apiUrl = usableApiUrl(plainValue(source.api_url));
  if (apiUrl === undefined && source.api_url !== undefined && source.api_url !== '') {
    degraded.push({ field: 'api_url', shape: describeShape(source.api_url) });
  }

  const config: Config = {
    api_key: readString(source.api_key, CONFIG_DEFAULTS.api_key, 'api_key', degraded),
    api_url: apiUrl ?? CONFIG_DEFAULTS.api_url,
    heartbeat_interval_ms: readNumber(source.heartbeat_interval_ms, 'heartbeat_interval_ms', CONFIG_DEFAULTS.heartbeat_interval_ms, degraded),
    project_name: readString(source.project_name, CONFIG_DEFAULTS.project_name, 'project_name', degraded),
    language: readString(source.language, CONFIG_DEFAULTS.language, 'language', degraded),
    app_entity: readString(source.app_entity, CONFIG_DEFAULTS.app_entity, 'app_entity', degraded),
    include_tool_calls: readBoolean(source.include_tool_calls, 'include_tool_calls', CONFIG_DEFAULTS.include_tool_calls, degraded),
    include_user_messages: readBoolean(source.include_user_messages, 'include_user_messages', CONFIG_DEFAULTS.include_user_messages, degraded),
    include_assistant_messages: readBoolean(source.include_assistant_messages, 'include_assistant_messages', CONFIG_DEFAULTS.include_assistant_messages, degraded),
    cache_heartbeats: readBoolean(source.cache_heartbeats, 'cache_heartbeats', CONFIG_DEFAULTS.cache_heartbeats, degraded),
    cache_limit: readNumber(source.cache_limit, 'cache_limit', CONFIG_DEFAULTS.cache_limit, degraded),
    debug: readBoolean(source.debug, 'debug', CONFIG_DEFAULTS.debug, degraded),
  };

  return { config, degraded };
}

/**
 * 规范化设置文档里的一行（只覆盖文档实际提交的字段）。
 *
 * 与 {@link normalizeConfig} 的区别有两点：
 * 1. 文档行里缺席的字段必须保持 runtime 现值，不能拿默认值去覆盖——
 *    `redactSecrets` 后的 api_key 就是故意缺席的。
 * 2. 提交了但形状不可用的字段【不写进 partial】，而不是写成现值。
 *    这样调用方的 `Object.assign(runtime, partial)` 只反映真正被改动的字段，
 *    降级情况单独走 degraded 告警，不会出现"赋值了却什么都没变"的假动作。
 *
 * @param raw - describe() 行里的 value（字段可能是 volatile ref 对象）。
 * @returns 可合并进 runtime 的部分配置与不可用字段清单。
 */
export function normalizeDocument(raw: unknown): { partial: Partial<Config>; degraded: DegradedField[] } {
  const source = (raw ?? {}) as Record<string, unknown>;
  const partial: Record<string, unknown> = {};
  const degraded: DegradedField[] = [];

  const putString = (field: keyof Config) => {
    if (!(field in source)) return;
    const value = plainValue(source[field]);
    if (typeof value === 'string') partial[field] = value;
    else degraded.push({ field, shape: describeShape(source[field]) });
  };

  const putNumber = (field: keyof Config) => {
    if (!(field in source)) return;
    const value = plainValue(source[field]);
    const range = NUMBER_RANGES[field];
    const inRange = typeof value === 'number' && Number.isFinite(value)
      && (range === undefined || (value >= range[0] && value <= range[1]));
    if (inRange) partial[field] = value;
    else degraded.push({ field, shape: typeof value === 'number' ? `越界 ${value}` : describeShape(source[field]) });
  };

  const putBoolean = (field: keyof Config) => {
    if (!(field in source)) return;
    const value = plainValue(source[field]);
    if (typeof value === 'boolean') partial[field] = value;
    else degraded.push({ field, shape: describeShape(source[field]) });
  };

  putString('api_key');
  // api_url 额外要求「能拼出合法 URL」：这一层不设卡，坏值会让所有发送在
  // 发出请求之前就抛 Invalid URL（Nov 10 的四小时全量断流即为此）。
  if ('api_url' in source) {
    const apiUrl = usableApiUrl(plainValue(source.api_url));
    if (apiUrl !== undefined) partial.api_url = apiUrl;
    else degraded.push({ field: 'api_url', shape: describeShape(source.api_url) });
  }
  putNumber('heartbeat_interval_ms');
  putString('project_name');
  putString('language');
  putString('app_entity');
  putBoolean('include_tool_calls');
  putBoolean('include_user_messages');
  putBoolean('include_assistant_messages');
  putBoolean('cache_heartbeats');
  putNumber('cache_limit');
  putBoolean('debug');

  return { partial: partial as Partial<Config>, degraded };
}
