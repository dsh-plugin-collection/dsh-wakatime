import { WakaTimeHeartbeat, WakaTimeError, WakaTimeAuthError, WakaTimeRateLimitError } from './types.js';
import type { Socket } from 'node:net';

/** 默认请求超时：挂起的服务端不能让 flush 永不返回、并发请求越积越多。 */
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

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

  async sendHeartbeat(payload: WakaTimeHeartbeat): Promise<void> {
    await this.sendHeartbeats([payload]);
  }

  async sendHeartbeats(payloads: WakaTimeHeartbeat[]): Promise<void> {
    if (payloads.length === 0) return;

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
  }

  /**
   * Fetch via HTTP(S) proxy using CONNECT tunnel.
   * 整个隧道（CONNECT + 实际请求）共享同一个超时：到时销毁 socket 并拒绝，
   * 避免挂起的代理让 flush 永不返回。
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
            'User-Agent': this.userAgent,
            'Content-Length': Buffer.byteLength(body),
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
