/**
 * 设置页「项目名称」候选的路由 handler 工厂。
 *
 * 单独成模块是为了可测：apply 里只剩 `webServer.register({ path, handler })`
 * 的接线，缓存/降级逻辑都在这里，用假 fetch + 假 res 即可断言。
 *
 * 契约（client 侧 useProjectOptions 依赖此形状）：
 *  - 成功：`{ projects: string[] }`（WakaTime 近期项目名，host 侧 60s 缓存）；
 *  - 失败：**仍返回 200 + 空列表 + error 原因**——候选缺席不是资源错误，
 *    client 据此把下拉退化为「空候选 + 可自由输入」，不显示错误弹窗。
 * @module dsh-wakatime/projects-route
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

/** 默认上游缓存窗口：挡住反复开合下拉的重复请求，又不至于让新项目长期缺席。 */
export const PROJECTS_CACHE_MS = 60_000;

/**
 * 构造 GET /api/dsh-wakatime/projects 的 handler。
 * @param fetchNames - 上游取数（WakaTimeClient.fetchProjects 的绑定）。
 * @param cacheMs - 内存缓存窗口；0 表示不缓存（测试用）。
 * @returns 路由 handler 与缓存清空钩子（注册 disposer 时一并丢弃）。
 */
export function createProjectsHandler(
  fetchNames: () => Promise<string[]>,
  cacheMs: number = PROJECTS_CACHE_MS,
): {
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
} {
  let cache: { at: number; names: string[] } | null = null;
  const handler = async (_req: IncomingMessage, res: ServerResponse): Promise<void> => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    try {
      const now = Date.now();
      // `>=`：窗口传 0 即"从不缓存"（测试用）；默认 60s 内命中缓存。
      if (cache === null || now - cache.at >= cacheMs) {
        cache = { at: now, names: await fetchNames() };
      }
      res.end(JSON.stringify({ projects: cache.names }));
    } catch (error) {
      // 失败不缓存：下一次点开下拉即重试（网络恢复即时可用）。
      res.end(JSON.stringify({ projects: [], error: (error as Error)?.message ?? String(error) }));
    }
  };
  return { handler };
}
