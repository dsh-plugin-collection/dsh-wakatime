import { WakaTimeHeartbeat, WakaTimeError, WakaTimeAuthError, WakaTimeRateLimitError } from './types.js';
import type { Socket } from 'node:net';

/** 默认请求超时：挂起的服务端不能让 flush 永不返回、并发请求越积越多。 */
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/**
 * 单条心跳被服务端拒绝的记录。
 *
 * 存在的理由：`heartbeats.bulk` 是「整体 2xx + 逐条状态码」的协议——一条被拒时
 * HTTP 状态仍是 202，只看 `response.ok` 会把 24/25 成功的批次和 0/25 成功的批次
 * 判成同一件事。没有这个结构，任何逐条失败都是不可观测的。
 */
export interface RejectedHeartbeat {
  /** 在该批次 payloads 中的下标，调用方据此把坏条目从重试集合里剔除。 */
  index: number;
  /** 该条目自己的状态码（201 之外即被拒）。 */
  status: number;
  /** 服务端给出的原因摘要，仅用于日志。 */
  detail: string;
  /** 400 之类的校验失败：同一条载荷重试也必然再失败，不该回写缓存。 */
  permanent: boolean;
}

/**
 * 把 fetch 抛出的错误展开成一行可诊断的文本。
 *
 * `TypeError: fetch failed` 本身信息量为零：undici 把真正的原因放在 `error.cause`
 * 里（ECONNRESET / ENOTFOUND / EAI_AGAIN / SELF_SIGNED_CERT_IN_CHAIN / 具体 syscall）。
 * 丢掉 cause 就等于把「进程内网络路径坏了」和「服务端有问题」写成同一句话，
 * 排查只能靠猜——本次间歇断流就是这样卡住十几分钟的。
 *
 * @param error - fetch / 隧道抛出的原始错误。
 * @returns 形如 `TypeError: fetch failed（cause: ECONNRESET / read / syscall=read）`。
 */
export function describeNetworkError(error: unknown): string {
  const e = error as (Error & { cause?: unknown }) | undefined;
  const name = e?.name ?? 'Error';
  const base = e?.message ?? String(error);
  const cause = e?.cause as (Error & { code?: string; syscall?: string; errno?: number } | undefined) | undefined;
  if (!cause || typeof cause !== 'object') return `${name}: ${base}`;
  const parts = [cause.code, cause.message, cause.syscall ? `syscall=${cause.syscall}` : ''].filter(Boolean);
  if (parts.length === 0) return `${name}: ${base}`;
  return `${name}: ${base}（cause: ${parts.join(' / ')}）`;
}

/** 一次批量上报的结果。 */
export interface HeartbeatSendResult {
  accepted: number;
  rejected: RejectedHeartbeat[];
}

/**
 * 把被拒条目的服务端返回压成一行日志摘要。
 *
 * WakaTime 的校验错误是 `{"errors": {字段: [原因,…]}}`，另有少数路径直接返回
 * `{"error": "…"}`。这里两种都取，并把整条载荷序列化兜底——摘要只为让人
 * 一眼看出「哪几个字段被拒、为什么」，不承担还原原始响应的责任。
 *
 * @param item - bulk 响应里该条目的结果对象。
 * @returns 单行摘要（已截断）。
 */
function summarizeRejection(item: unknown): string {
  const record = (item ?? {}) as { errors?: unknown; error?: unknown };
  const limit = 200;
  if (record.errors && typeof record.errors === 'object') {
    return JSON.stringify(record.errors).slice(0, limit);
  }
  if (typeof record.error === 'string' && record.error) {
    return record.error.slice(0, limit);
  }
  try {
    return (JSON.stringify(item) ?? '').slice(0, limit);
  } catch {
    return String(item).slice(0, limit);
  }
}

/** WakaTime HTTP 客户端配置 */
export interface WakaTimeClientConfig {
  api_key: string;
  api_url: string;
  /** 单次 HTTP 请求超时（毫秒），默认 10000 */
  timeout_ms?: number;
  /**
   * ~/.wakatime.cfg 里配置的代理（`proxy = http://host:port`）。
   * 由调用方注入而不是在这里读文件，客户端因此保持无文件系统依赖、可单测。
   */
  cfg_proxy?: string;
  /**
   * 设置页「代理地址」。非空时**优先级最高**，覆盖环境变量与 cfg。
   * 特殊值 `none` 表示强制直连（用来临时绕过坏掉的代理，不必改环境或 cfg 文件）。
   */
  proxy_url?: string;
  /**
   * 设置页「不走代理的地址」。非空时覆盖 `NO_PROXY` 环境变量与宿主默认的表。
   * 语义与宿主 `dsh-http-proxy` 的 `bypassesProxy` 一致（见该包 policy.d.ts）。
   */
  no_proxy?: string;
}

/**
 * `proxy_url` 的直连哨兵值。
 *
 * 为什么需要它：留空表示"沿用环境变量 / cfg"，而用户常常需要一个明确的"这次不走代理"
 * ——尤其是代理抖动时。给一个可读的字面量比再加一个布尔字段更容易在配置里看懂。
 */
export const PROXY_NONE = 'none';

/**
 * 设置项里写的 `no_proxy` 是否可以被采用。
 *
 * @param value - 设置页提交的值（可能是 ref 对象、null 等任意形状）。
 * @returns 规范化后的串；不可用时为 undefined，表示"这一层没给"。
 */
export function usableNoProxy(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** 环境变量里可能被使用的代理名（小写优先，与 undici 的读取顺序一致）。 */
const PROXY_ENV_NAMES = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'] as const;

/**
 * 解析本进程应使用的出口代理。
 *
 * 优先级（高一档覆盖低一档，**只有显式给了才往下退**）：
 *   1. 设置页 `proxy_url`（用户在 WebUI 里改的，最直观也最该优先）；
 *   2. 环境变量 `HTTPS_PROXY` / `https_proxy` / `HTTP_PROXY` / `http_proxy`
 *      （代表"这次启动明确要求的网络路径"，也是 DSH 自己全部出网的口径）；
 *   3. `~/.wakatime.cfg` 的 `[settings] proxy`——wakatime-cli 读的就是它，
 *      插件不读就会成为同机上唯一不走代理的那条链路。
 *
 * `proxy_url` 支持两个显式值：`none` 强制直连；`direct` 同义。
 * 非法 URL（比如漏了 `http://`）不会被静默采用，而是**跳过该层继续往下退**，
 * 并通过 {@link resolveProxy} 的 `ignored` 告诉调用方，避免"配了却没生效"。
 *
 * @param env - 进程环境（默认 process.env，便于测试注入）。
 * @param cfgProxy - ~/.wakatime.cfg 的 proxy 值（可为空串）。
 * @param setting - 设置页提交的 proxy_url 原始值（任意形状）。
 * @returns 生效的代理（null＝直连）、来源标记，以及被忽略的层。
 */
export function resolveProxy(
  env: Record<string, string | undefined> = process.env,
  cfgProxy = '',
  setting?: unknown,
): { proxy: string | null; source: 'setting' | 'env' | 'cfg' | 'direct' | 'none'; ignored?: string } {
  const isSupported = (value: string): boolean => {
    try {
      const parsed = new URL(value);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  };

  let ignored: string | undefined;

  // 1. 设置页
  if (typeof setting === 'string') {
    const value = setting.trim();
    if (value !== '') {
      if (value.toLowerCase() === PROXY_NONE || value.toLowerCase() === 'direct') {
        return { proxy: null, source: 'none' };
      }
      if (isSupported(value)) return { proxy: value, source: 'setting' };
      // 形状不对：记下被忽略的层，继续往下退——而不是让整条链路静默不走代理。
      ignored = `设置页 proxy_url 不是合法的 http(s) 地址（${value.length} 字符），已忽略并继续回退`;
    }
  }

  // 2. 环境变量
  for (const key of PROXY_ENV_NAMES) {
    const value = env[key];
    if (typeof value === 'string' && value.trim() !== '' && isSupported(value.trim())) {
      return { proxy: value.trim(), source: 'env', ignored };
    }
  }

  // 3. ~/.wakatime.cfg
  const fromCfg = cfgProxy.trim();
  if (fromCfg !== '' && isSupported(fromCfg)) return { proxy: fromCfg, source: 'cfg', ignored };
  if (fromCfg !== '' && ignored === undefined) {
    ignored = '~/.wakatime.cfg 的 proxy 不是合法的 http(s) 地址，已忽略';
  }

  return { proxy: null, source: 'direct', ignored };
}

/**
 * 只要代理 URL 的薄封装。
 *
 * @param env - 进程环境。
 * @param cfgProxy - cfg 里的 proxy 值。
 * @param setting - 设置页的值。
 * @returns 代理 URL；null 表示直连。
 */
export function resolveProxyUrl(
  env: Record<string, string | undefined> = process.env,
  cfgProxy = '',
  setting?: unknown,
): string | null {
  return resolveProxy(env, cfgProxy, setting).proxy;
}

/**
 * 某个目标主机是否应当走这条代理。
 *
 * NO_PROXY 的支持范围比"整串相等"宽一点：支持 `*`、前导点/前缀匹配
 * （`.example.com` 与 `example.com` 都能匹配子域），并忽略空项——
 * 原实现只做 `includes(host)`，`NO_PROXY=.corp.example` 这类常见写法形同失效。
 *
 * @param proxyUrl - 已解析的代理，null 表示不用代理。
 * @param targetHost - 目标主机名。
 * @param noProxy - NO_PROXY 原始串。
 */
export function shouldUseProxy(proxyUrl: string | null, targetHost: string, noProxy = ''): boolean {
  if (proxyUrl === null || proxyUrl === '') return false;
  const host = targetHost.toLowerCase();
  for (const raw of noProxy.split(',')) {
    const entry = raw.trim().toLowerCase();
    if (entry === '') continue;
    if (entry === '*') return false;
    if (entry === host) return false;
    if (entry.startsWith('.') && (host === entry.slice(1) || host.endsWith(entry))) return false;
    if (!entry.startsWith('.') && host.endsWith(`.${entry}`)) return false;
  }
  return true;
}

export class WakaTimeClient {
  private apiKey: string;
  private baseUrl: string;
  private userAgent: string;
  private retryAfter: number = 0;
  private authFailRetryAfter: number = 0;
  private proxyUrl: string | null;
  /** 生效的不走代理表：设置项优先，其次 NO_PROXY 环境变量。 */
  private noProxy: string;
  /** 生效代理的来源（setting / env / cfg / direct / none），供日志与诊断。 */
  private proxySource: 'setting' | 'env' | 'cfg' | 'direct' | 'none' = 'direct';
  /** 解析过程中被忽略的配置层（供上层一次性告警后清空）。 */

  private configDiagnostics: string[] = [];
  private requestTimeoutMs: number;

  constructor(config: WakaTimeClientConfig) {
    this.apiKey = config.api_key;
    this.baseUrl = `${config.api_url}/api/v1`;
    this.userAgent = `dsh/1.0.0 dsh-wakatime/1.0.0`;
    const resolved = resolveProxy(process.env, config.cfg_proxy, config.proxy_url);
    this.proxyUrl = resolved.proxy;
    this.noProxy = usableNoProxy(config.no_proxy) ?? process.env.NO_PROXY ?? '';
    // 被忽略的层必须说出来：配了代理却没生效，是排查里最费时间的一种。
    if (resolved.ignored !== undefined) {
      this.configDiagnostics.push(resolved.ignored);
    }
    this.proxySource = resolved.source;
    this.requestTimeoutMs = config.timeout_ms ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  /**
   * Update client config (called when settings change from WebUI)
   */
  updateConfig(config: Pick<WakaTimeClientConfig, 'api_key' | 'api_url' | 'timeout_ms' | 'cfg_proxy' | 'proxy_url' | 'no_proxy'>): void {
    this.apiKey = config.api_key;
    this.baseUrl = `${config.api_url}/api/v1`;
    const resolved = resolveProxy(process.env, config.cfg_proxy, config.proxy_url);
    this.proxyUrl = resolved.proxy;
    this.noProxy = usableNoProxy(config.no_proxy) ?? process.env.NO_PROXY ?? '';
    // 被忽略的层必须说出来：配了代理却没生效，是排查里最费时间的一种。
    if (resolved.ignored !== undefined) {
      this.configDiagnostics.push(resolved.ignored);
    }
    this.proxySource = resolved.source;
    if (config.timeout_ms !== undefined) {
      this.requestTimeoutMs = config.timeout_ms;
    }
    // Reset retry timers on config update
    this.retryAfter = 0;
    this.authFailRetryAfter = 0;
  }

  /**
   * 取走「配置层被忽略」的诊断信息。
   *
   * 读取即清空：这些消息由上层在合适的时机（启动、设置变更）打一次，
   * 每次请求都重复打印会把真正的告警淹掉。
   *
   * @returns 自上次调用以来累积的消息；没有则为空数组。
   */
  takeConfigDiagnostics(): string[] {
    const messages = this.configDiagnostics;
    this.configDiagnostics = [];
    return messages;
  }

  /**
   * 当前生效代理的描述，用于启动日志。
   *
   * @returns 形如 `经代理 http://host:port（来源：设置页）` 或 `直连（来源：无配置）`。
   */
  describeProxy(): string {
    const sourceLabel = { setting: '设置页', env: '环境变量', cfg: '~/.wakatime.cfg', direct: '无配置', none: '设置页强制直连' }[this.proxySource];
    return this.proxyUrl === null ? `直连（来源：${sourceLabel}）` : `经代理 ${this.proxyUrl}（来源：${sourceLabel}）`;
  }

  async sendHeartbeat(payload: WakaTimeHeartbeat): Promise<HeartbeatSendResult> {
    return this.sendHeartbeats([payload]);
  }

  async sendHeartbeats(payloads: WakaTimeHeartbeat[]): Promise<HeartbeatSendResult> {
    if (payloads.length === 0) return { accepted: 0, rejected: [] };

    // 没有可用 key 就直说。放过去让服务端回 401 的话，一来错误会变成
    // 「API Key 无效，请检查配置」（把「没配」伪装成「配错」），二来那次 401
    // 会写入 authFailRetryAfter，之后 5 分钟的心跳全部只进本地缓存。
    if (!this.apiKey) {
      throw new WakaTimeAuthError('未配置 WakaTime API Key（配置层 / 环境变量 WAKATIME_API_KEY / ~/.wakatime.cfg 均无可用值）');
    }

    // Check if we're in a retry-after period
    const now = Date.now();
    if (this.authFailRetryAfter > now) {
      throw new WakaTimeAuthError('WakaTime API Key 无效，跳过发送（5分钟后重试）');
    }
    if (this.retryAfter > now) {
      throw new WakaTimeRateLimitError('WakaTime API 限流，稍后重试');
    }

    const url = `${this.baseUrl}/users/current/heartbeats.bulk`;
    const body = JSON.stringify(payloads);

    let response: Response;
    const targetHost = new URL(url).hostname;
    if (shouldUseProxy(this.proxyUrl, targetHost, this.noProxy)) {
      response = await this.fetchWithProxy(url, body);
    } else {
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: {
            'Authorization': `Basic ${btoa(this.apiKey + ':')}`,
            'Content-Type': 'application/json',
            'User-Agent': this.userAgent,
          },
          body,
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        });
      } catch (error) {
        const name = (error as Error | undefined)?.name;
        // Node 的 AbortSignal.timeout 以 TimeoutError 拒绝；兼容一般 AbortError
        if (name === 'TimeoutError' || name === 'AbortError') {
          throw new WakaTimeError(`WakaTime API 请求超时（${this.requestTimeoutMs}ms）`);
        }
        // 网络类失败必须带上 cause：`TypeError: fetch failed` 单独出现时，
        // 「DNS 挂了」「连接被重置」「证书被中间盒换掉」「宿主改了全局 fetch」
        // 长得一模一样，只能靠 cause 里的 code/syscall 区分。
        throw new WakaTimeError(`WakaTime API 网络错误: ${describeNetworkError(error)}`, { cause: error });
      }
    }

    if (response.status === 401) {
      // Auth failed - retry after 5 minutes
      this.authFailRetryAfter = Date.now() + 5 * 60 * 1000;
      throw new WakaTimeAuthError('WakaTime API Key 无效，请检查配置');
    }
    if (response.status === 429) {
      // Rate limited - retry after 30 seconds
      this.retryAfter = Date.now() + 30 * 1000;
      throw new WakaTimeRateLimitError('WakaTime API 限流，30秒后重试');
    }
    if (!response.ok) {
      throw new WakaTimeError(`WakaTime API 错误: ${response.status}`);
    }

    // Success - reset retry timers
    this.retryAfter = 0;
    this.authFailRetryAfter = 0;
    return this.parseBulkResult(response, payloads.length);
  }

  /**
   * 解析 heartbeats.bulk 的【逐条】结果。
   *
   * 该端点的契约是「外层 2xx + 内层逐条状态码」：
   * `{"responses": [[{"data":{"id":"…"}}, 201], [{"errors":{"entity":["…"]}}, 400], …]}`，
   * 整批被拒时外层依然是 202。只判 `response.ok` 会把 0/25 成功和 25/25 成功
   * 读成同一件事——被拒的心跳既不重试也不留缓存，等于永久静默丢数据。
   *
   * 响应形状不认识时（网关改写、非 JSON、缺 responses）保守按「全部接受」处理：
   * 宁可少报一次拒绝，也不把已经落库的数据当坏数据反复重投。
   *
   * @param response - 已确认外层 2xx 的响应（body 未被读过）。
   * @param count - 本批 payloads 条数，用于把下标映射回心跳。
   */
  private async parseBulkResult(response: Response, count: number): Promise<HeartbeatSendResult> {
    const acceptedAll = (): HeartbeatSendResult => ({ accepted: count, rejected: [] });
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return acceptedAll();
    }
    const items = (body as { responses?: unknown } | null)?.responses;
    if (!Array.isArray(items)) return acceptedAll();

    const rejected: RejectedHeartbeat[] = [];
    items.forEach((item, index) => {
      // 每个条目是 [载荷结果, 该条状态码]；形状不符就跳过，不影响其余判定。
      if (!Array.isArray(item) || index >= count) return;
      const status = typeof item[1] === 'number' ? item[1] : undefined;
      if (status === undefined || (status >= 200 && status < 300)) return;
      rejected.push({
        index,
        status,
        detail: summarizeRejection(item[0]),
        // 4xx 校验类失败与传输状态无关，同一条载荷重试必然再失败；
        // 429 例外——它只是限流，载荷本身没问题，该继续重试。
        permanent: status >= 400 && status < 500 && status !== 429,
      });
    });

    return { accepted: Math.max(count - rejected.length, 0), rejected };
  }

  /**
   * Fetch via HTTP(S) proxy using CONNECT tunnel.
   * 整个隧道（CONNECT + 实际请求）共享同一个超时：到时销毁 socket 并拒绝，
   * 避免挂起的代理让 flush 永不返回。
   * @param url - 目标绝对地址。
   * @param body - 请求体（心跳批量上报的 JSON）。
   */
  private async fetchWithProxy(url: string, body: string): Promise<Response> {
    const parsed = new URL(url);
    const proxyParsed = new URL(this.proxyUrl!);

    // Build proxy request
    const connectReq = `${parsed.host}:443`;

    // Use Node.js http module for proxy tunneling
    const http = await import('node:http');
    const https = await import('node:https');

    return new Promise<Response>((resolvePromise, rejectPromise) => {
      let settled = false;
      let activeSocket: Socket | null = null;
      let activeRequest: import('node:http').ClientRequest | null = null;

      const settle = (error: Error | null, response?: Response): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error !== null) rejectPromise(error);
        else resolvePromise(response!);
      };

      const timer = setTimeout(() => {
        activeRequest?.destroy();
        activeSocket?.destroy();
        connectRequest.destroy();
        settle(new WakaTimeError(`WakaTime API 请求超时（${this.requestTimeoutMs}ms，经代理）`));
      }, this.requestTimeoutMs);

      const connectOptions = {
        hostname: proxyParsed.hostname,
        port: parseInt(proxyParsed.port, 10) || 80,
        method: 'CONNECT',
        path: connectReq,
        headers: {
          'Host': connectReq,
        },
      };

      const connectRequest = http.request(connectOptions);

      connectRequest.on('connect', (res, socket) => {
        if (res.statusCode !== 200) {
          socket.destroy();
          settle(new Error(`Proxy CONNECT failed with status ${res.statusCode}`));
          return;
        }
        activeSocket = socket;

        // Now make the actual request through the tunnel
        const requestOptions = {
          hostname: parsed.hostname,
          port: 443,
          path: parsed.pathname + parsed.search,
          method: 'POST',
          headers: {
            'Authorization': `Basic ${btoa(this.apiKey + ':')}`,
            'Content-Type': 'application/json',
            'Content-Length': String(Buffer.byteLength(body)),
            'User-Agent': this.userAgent,
            'Host': parsed.host,
          },
          socket,
          agent: false,
        };

        const req = https.request(requestOptions, (response) => {
          // Collect response data
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => {
            const responseBody = Buffer.concat(chunks);
            settle(null, new Response(responseBody, {
              status: response.statusCode || 500,
              statusText: response.statusMessage || '',
              headers: response.headers as Record<string, string>,
            }));
          });
          response.on('error', (err: Error) => {
            settle(new Error(`Response failed: ${err.message}`));
          });
        });
        activeRequest = req;

        req.on('error', (err: Error) => {
          settle(new Error(`Request failed: ${err.message}`));
        });

        req.write(body);
        req.end();
      });

      connectRequest.on('error', (err: Error) => {
        settle(new Error(`Proxy connection failed: ${err.message}`));
      });

      connectRequest.end();
    });
  }
}
