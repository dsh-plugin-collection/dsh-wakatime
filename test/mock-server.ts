/**
 * Mock WakaTime server for testing
 * Runs a local HTTP server that simulates the WakaTime API
 */
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';

export class MockWakaTimeServer {
  private server: ReturnType<typeof createServer>;
  public receivedHeartbeats: any[] = [];
  public shouldFail401 = false;
  public shouldFail429 = false;
  public shouldFail500 = false;
  /** 成功放行 N 个 POST 后开始返回 500；-1 表示不启用（用于部分失败场景） */
  public shouldFail500After = -1;
  private postCount = 0;
  public shouldHang = false;
  /**
   * 逐条拒绝规则：entity 包含其中任一子串的心跳，在 bulk 响应里拿到 400。
   *
   * 存在的理由：真实 heartbeats.bulk 是「外层 202 + 逐条状态码」，客户端只判
   * 外层就看不见单条失败。没有可编排的逐条拒绝，这条契约就完全没被测试覆盖。
   */
  public rejectEntitySubstrings: string[] = [];
  /** 命中 rejectEntitySubstrings 时返回的逐条状态码（默认 400＝校验失败）。 */
  public perItemRejectStatus = 400;
  /** projects 端点（fetchProjects 测试）：请求计数、最后一次 Authorization 头、可编排数据。 */
  public projectRequestCount = 0;
  public lastProjectAuth: string | null = null;
  /** 心跳端点最后一次 Authorization 头：用于断言「实际用哪个 key 发了请求」。 */
  public lastHeartbeatAuth: string | null = null;
  public projectsFail401 = false;
  public projectsData: Array<{ id?: string; name?: unknown }> = [
    { id: 'p1', name: 'dsh-plugins' },
    { id: 'p2', name: 'apbot_server' },
    { id: 'p3', name: 'dsh-plugins' },
    { id: 'p4', name: 12345 },
  ];
  private port: number | null = null;

  constructor() {
    this.server = createServer((req, res) => {
      this.handleRequest(req, res);
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse) {
    // Parse URL
    const url = new URL(req.url || '/', `http://localhost`);
    
    // Projects endpoint（fetchProjects）：GET /users/current/projects
    if (url.pathname.includes('users/current/projects')) {
      this.projectRequestCount++;
      this.lastProjectAuth = (req.headers['authorization'] as string | undefined) ?? null;
      if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return;
      }
      if (this.projectsFail401) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: this.projectsData }));
      return;
    }

    // Only handle heartbeats endpoint
    if (!url.pathname.includes('heartbeats')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    // 记录实际收到的凭据头：断言「插件到底拿哪个值去鉴权」。
    this.lastHeartbeatAuth = (req.headers['authorization'] as string | undefined) ?? null;

    // Check method
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    // Read body
    const body = await this.readBody(req);
    
    // Simulate failures
    if (this.shouldFail401) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    if (this.shouldFail429) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '30' });
      res.end(JSON.stringify({ error: 'Too many requests' }));
      return;
    }
    if (this.shouldFail500) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
      return;
    }
    if (this.shouldFail500After >= 0 && this.postCount >= this.shouldFail500After) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error (after N)' }));
      return;
    }
    this.postCount++;
    if (this.shouldHang) {
      // Never respond to simulate network hang
      return;
    }

    // Parse heartbeats
    let heartbeats: any[] | null = null;
    try {
      const parsed = JSON.parse(body);
      heartbeats = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Bad request' }));
      return;
    }
    if (heartbeats === null) return;

    // Success response —— 真实 heartbeats.bulk 的形状：外层 202，逐条各带状态码。
    // `{"responses": [[{"data":{"id":"…"}}, 201], [{"errors":{…}}, 400], …]}`
    // receivedHeartbeats 只记录【真正入库】的条目：把被逐条拒绝的也算进去，
    // 「已落库/未落库」就无法在断言里区分了。
    const responses = heartbeats.map((hb, index) => {
      const entity = typeof hb?.entity === 'string' ? hb.entity : '';
      if (this.rejectEntitySubstrings.some((needle) => needle && entity.includes(needle))) {
        // 默认复刻线上实测的校验错误文案（entity 超 2083 字符即触发）；
        // 状态码可编排，用于区分「重试无效」与「限流可重试」。
        const body = this.perItemRejectStatus === 400
          ? { errors: { entity: ['Field must be between 1 and 2083 characters long.'] } }
          : { error: `per-item status ${this.perItemRejectStatus}` };
        return [body, this.perItemRejectStatus];
      }
      return [{ data: { id: `mock-${this.postCount}-${index}` } }, 201];
    });
    // 只把接受下来的条目计入「已入库」集合
    heartbeats.forEach((hb, index) => {
      const status = (responses[index] as [unknown, number])[1];
      if (status >= 200 && status < 300) this.receivedHeartbeats.push(hb);
    });
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ responses }));
  }

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => {
        body += chunk.toString();
      });
      req.on('end', () => {
        resolve(body);
      });
      req.on('error', reject);
    });
  }

  async start(): Promise<number> {
    this.postCount = 0;
    return new Promise((resolve) => {
      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server.address() as AddressInfo;
        this.port = addr.port;
        resolve(this.port);
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }

  getBaseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  getReceivedHeartbeats(): any[] {
    return this.receivedHeartbeats;
  }

  clearReceivedHeartbeats(): void {
    this.receivedHeartbeats = [];
  }

  setShouldFail401(value: boolean): void {
    this.shouldFail401 = value;
  }

  setShouldFail429(value: boolean): void {
    this.shouldFail429 = value;
  }

  setShouldFail500(value: boolean): void {
    this.shouldFail500 = value;
  }

  /** 成功放行 N 个 POST 后开始返回 500；传 -1 关闭 */
  setShouldFail500After(count: number): void {
    this.shouldFail500After = count;
  }

  /** 设置逐条 400 的 entity 子串规则（空数组＝不启用） */
  setRejectEntitySubstrings(substrings: string[]): void {
    this.rejectEntitySubstrings = substrings;
  }

  /** 设置命中拒绝规则时返回的逐条状态码 */
  setPerItemRejectStatus(status: number): void {
    this.perItemRejectStatus = status;
  }

  setShouldHang(value: boolean): void {
    this.shouldHang = value;
  }
}
