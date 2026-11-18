/**
 * 设置卡片的线路观察辅助。settings 线路契约对 `role('secret')` 字段全程脱敏
 * （value/base/user 三层都不携带），api_key 是否已配置，只能经共享 describe
 * 镜像的 `secrets` 槽位列表（`{ path, set }`）观察。保存的受理与失败判定
 * 已交给官方 `SettingsFormModel`（写应答即受理位，Host 是唯一权威），本模块
 * 只剩配置状态观察这一个纯函数。保持零依赖（不引 react），可直接单测。
 * @module dsh-wakatime/client/mirror
 */

import { PLUGIN_ID } from './plugin-id.ts';
/** 共享 describe 镜像快照的最小结构视图（secret 槽位状态仅在此可见）。 */
export interface MirrorSnapshotLike {
  view?: {
    namespaces?: ReadonlyArray<{
      ns: string;
      secrets?: ReadonlyArray<{ path: readonly string[]; set: boolean }>;
    }>;
  } | undefined;
}

/**
 * 共享 describe 镜像面的最小结构视图。
 *
 * 宿主侧来源是 `ConfigForms.describe(): SettingsDescribeFace`
 * （dsh-client-ui-settings/lib/types/client/config-form.d.ts，注释写明给
 * "cross-namespace surfaces (schema introspection, the served-namespace
 * directory)" 用）。形状与本视图逐字对齐：
 * `{ status, view: { namespaces, writable, hasDocument }, error }`，其中
 * `SettingsNamespaceView.secrets: SettingsSecretView[]`（dsh-settings/lib/types/
 * types.d.ts，"每个 schema 声明的 secret 槽位及其配置状态"）是 secret 配置
 * 状态的唯一来源——value/base/user 三层对 secret 全程脱敏。
 *
 * 写入统一走宿主 `ConfigForm.mutate`（它自己会把应答折回镜像），插件侧不再
 * 有裸线写，也就无需 acceptView。
 */
export interface SettingsMirrorFace {
  getSnapshot(): MirrorSnapshotLike;
  subscribe(listener: () => void): () => void;
  ensure?(): Promise<void>;
}

/**
 * settings 命名空间候选：0.2.x 起命名空间 = profile 条目 id（`dsh-wakatime`），
 * `wakatime` 是旧 settings.yaml 时代的 section 名。镜像按命名空间查行，只猜
 * 一个必然漏掉另一个（只写 `wakatime` 时，0.2.x 的行根本找不到 → 「已配置」
 * 徽章永远不亮），故统一用候选序列，与 host 端 `src/index.ts` 的
 * `row.ns === ENTRY_ID || row.ns === SETTINGS_NAMESPACE` 判定对齐。
 */
export const SETTINGS_NAMESPACE_CANDIDATES: readonly string[] = [PLUGIN_ID, 'wakatime'];

/**
 * 从镜像快照读取某 secret 字段是否已配置（线路全程脱敏，唯一可信源）。
 * @param ns - 命名空间，或按优先级排列的命名空间候选。
 *
 * 槽位按**单层路径**匹配（`path.length === 1 && path[0] === key`）。这对本插件是
 * 充分的：宿主 `redactSecrets(schema, value)` 从 `walk(schema, value, [], secrets)`
 * 起步、每下一层就 `[...path, key]`（dsh-settings/lib/index.js），而本插件的
 * `Config` 是扁平的、`api_key` 就在顶层，故它的 path 恒为 `['api_key']`。
 * ⚠️ 约束（今天成立、改结构就悄悄坏）：若将来把 secret 字段挪进嵌套对象（例如
 * `auth.api_key`，path 会变成 `['auth','api_key']`），这里会**静默失效**——徽章不亮，
 * 且不抛任何错。动 Config 结构时必须同步改成整段路径比较。
 */
export function secretSlotSet(
  snapshot: MirrorSnapshotLike | undefined,
  ns: string | readonly string[],
  key: string,
): boolean {
  const candidates = typeof ns === 'string' ? [ns] : ns;
  const rows = snapshot?.view?.namespaces;
  if (rows === undefined) return false;
  for (const candidate of candidates) {
    const row = rows.find(found => found.ns === candidate);
    // 首个命中的行即权威：schema 声明的 secret 槽位总是带 set 状态列出，
    // 行在而槽位不在 = 未配置，不必再看后续候选。
    if (row !== undefined) {
      return row.secrets?.some(slot => slot.path.length === 1 && slot.path[0] === key && slot.set) ?? false;
    }
  }
  return false;
}
