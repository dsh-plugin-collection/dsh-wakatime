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
  /** projects 端点（fetchProjects 测试）：请求计数、最后一次 Authorization 头、可编排数据。 */
  public projectRequestCount = 0;
  public lastProjectAuth: string | null = null;
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
    try {
      const heartbeats = JSON.parse(body);
      if (Array.isArray(heartbeats)) {
        this.receivedHeartbeats.push(...heartbeats);
      } else {
        this.receivedHeartbeats.push(heartbeats);
      }
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Bad request' }));
      return;
    }

    // Success response
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
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

  setShouldHang(value: boolean): void {
    this.shouldHang = value;
  }
}
