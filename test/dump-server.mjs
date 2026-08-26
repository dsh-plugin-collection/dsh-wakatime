#!/usr/bin/env node
/**
 * 独立心跳接收器：手动端到端测试用。
 * 把插件的 API URL 指到本服务，即可在终端看到插件发出的每一条心跳 JSON。
 *
 * 用法：
 *   node test/dump-server.mjs [port]      # 默认 9867
 * 停止：Ctrl+C
 */
import { createServer } from 'node:http';

const port = Number(process.argv[2]) || 9867;
const seen = [];

createServer((req, res) => {
  if (!req.url.includes('heartbeats') || req.method !== 'POST') {
    res.writeHead(404).end('{}');
    return;
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    try {
      const arr = JSON.parse(body);
      const list = Array.isArray(arr) ? arr : [arr];
      seen.push(...list);
      console.log(`\n[${new Date().toLocaleTimeString()}] +${list.length} heartbeat(s), total ${seen.length}`);
      for (const h of list) {
        console.log(JSON.stringify(h, null, 2));
      }
    } catch {
      console.error('bad json:', body.slice(0, 200));
    }
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
  });
}).listen(port, '127.0.0.1', () => {
  console.log(`dump-server listening on http://127.0.0.1:${port}  (把插件 API URL 指到这里)`);
});
