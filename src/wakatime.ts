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
}

export class WakaTimeClient {
  private apiKey: string;
  private baseUrl: string;
  private userAgent: string;
  private retryAfter: number = 0;
  private authFailRetryAfter: number = 0;
  private proxyUrl: string | null;
  private requestTimeoutMs: number;

  constructor(config: WakaTimeClientConfig) {
    this.apiKey = config.api_key;
    this.baseUrl = `${config.api_url}/api/v1`;
    this.userAgent = `dsh/1.0.0 dsh-wakatime/1.0.0`;
    this.proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy || null;
    this.requestTimeoutMs = config.timeout_ms ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  /**
   * Update client config (called when settings change from WebUI)
   */
  updateConfig(config: Pick<WakaTimeClientConfig, 'api_key' | 'api_url' | 'timeout_ms'>): void {
    this.apiKey = config.api_key;
    this.baseUrl = `${config.api_url}/api/v1`;
    this.proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy || null;
    if (config.timeout_ms !== undefined) {
      this.requestTimeoutMs = config.timeout_ms;
    }
    // Reset retry timers on config update
    this.retryAfter = 0;
    this.authFailRetryAfter = 0;
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
    const noProxy = (process.env.NO_PROXY || '').split(',').map(h => h.trim());
    if (this.proxyUrl && !noProxy.includes(targetHost) && !noProxy.includes('*')) {
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
        throw error;
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
   * 拉取当前用户的 WakaTime 项目名列表（GET /users/current/projects）。
   *
   * 只服务于设置页「项目名称」的下拉候选：只读、由用户点开下拉触发、
   * 调用方（路由）自带缓存，故不共用 sendHeartbeats 的限流/退避窗口——
   * 401/429 直接抛出，由调用方降级为空候选，绝不影响心跳上报路径。
   * WakaTime 按 last_heartbeat 倒序返回，这里保序去重、剔除无名条目。
   * @param limit - 最多取多少个近期项目（WakaTime 上限 100）。
   * @returns 项目名列表（上游顺序）。
   */
  async fetchProjects(limit = 100): Promise<string[]> {
    const url = `${this.baseUrl}/users/current/projects?limit=${limit}`;
    let response: Response;
    const targetHost = new URL(url).hostname;
    const noProxy = (process.env.NO_PROXY || '').split(',').map(h => h.trim());
    if (this.proxyUrl && !noProxy.includes(targetHost) && !noProxy.includes('*')) {
      response = await this.fetchWithProxy(url, null, 'GET');
    } else {
      try {
        response = await fetch(url, {
          method: 'GET',
          headers: {
            'Authorization': `Basic ${btoa(this.apiKey + ':')}`,
            'User-Agent': this.userAgent,
          },
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        });
      } catch (error) {
        const name = (error as Error | undefined)?.name;
        if (name === 'TimeoutError' || name === 'AbortError') {
          throw new WakaTimeError(`WakaTime API 请求超时（${this.requestTimeoutMs}ms）`);
        }
        throw error;
      }
    }
    if (response.status === 401) throw new WakaTimeAuthError('WakaTime API Key 无效');
    if (response.status === 429) throw new WakaTimeRateLimitError('WakaTime API 限流，稍后重试');
    if (!response.ok) throw new WakaTimeError(`WakaTime API 错误: ${response.status}`);
    const payload = (await response.json()) as { data?: Array<{ name?: unknown }> };
    const names = (payload.data ?? [])
      .map(item => (typeof item.name === 'string' ? item.name : ''))
      .filter(name => name !== '');
    return [...new Set(names)];
  }

  /**
   * Fetch via HTTP(S) proxy using CONNECT tunnel.
   * 整个隧道（CONNECT + 实际请求）共享同一个超时：到时销毁 socket 并拒绝，
   * 避免挂起的代理让 flush 永不返回。
   * @param url - 目标绝对地址。
   * @param body - 请求体；GET 等无体请求传 null（不发 Content-Length、不 write）。
   * @param method - HTTP 方法（默认 POST，心跳批量上报的路径不变）。
   */
  private async fetchWithProxy(url: string, body: string | null, method = 'POST'): Promise<Response> {
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
          method,
          headers: {
            'Authorization': `Basic ${btoa(this.apiKey + ':')}`,
            ...(body === null ? {} : { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) }),
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

        if (body !== null) req.write(body);
        req.end();
      });

      connectRequest.on('error', (err: Error) => {
        settle(new Error(`Proxy connection failed: ${err.message}`));
      });

      connectRequest.end();
    });
  }
}
