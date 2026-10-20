/**
 * 设置卡片的线路观察辅助：settings 线路契约对 `role('secret')` 字段全程脱敏
 * （value/base/user 三层都不携带），secret 是否落地、是否已配置，只能经共享
 * describe 镜像的 `secrets` 槽位列表（`{ path, set }`）观察；普通字段以 user
 * 层为准（写入即覆盖）、回退比对解析值。本模块另放写入「受理位」的取值与保存
 * 失败成因的判定，都是纯函数。本模块保持零依赖（不引 react），可直接单测。
 * @module dsh-wakatime/client/mirror
 */

/** 字段输入形态。 */
export type FieldKind = 'number' | 'text' | 'boolean' | 'secret';

/** 客户端 scope 快照的最小结构视图（与宿主 dsh-client-runtime 契约对齐）。 */
export interface ScopeSnapshotLike {
  status: 'loading' | 'ready' | 'unavailable';
  value: unknown;
  base?: unknown;
  user?: unknown;
  writable: boolean;
}

/**
 * 客户端 settings scope 的最小结构视图（getSnapshot/subscribe/set/unset）。
 *
 * `set / unset` 返回 **Host 是否受理了这次写入**（`Promise<boolean>`），
 * 不是 `Promise<void>`：宿主 `ConfigForm` 自 0.2.0 起就返回受理结果
 * （dsh-client-ui-settings/lib/types/client/config-form-types.d.ts：*"true for
 * Host acceptance, false for refusal or skipped writes"*，且**拒绝不抛异常**）。
 * 本接口此前把它声明成 void，等于主动丢弃这个信号——写失败时卡片只能靠
 * 回读校验间接发现。这是插件自身的接线缺陷，与宿主版本无关。
 */
export interface ScopeLike {
  getSnapshot(): ScopeSnapshotLike;
  subscribe(listener: () => void): () => void;
  set(field: string, value: unknown): Promise<boolean>;
  unset(field: string): Promise<boolean>;
}

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
 * types.d.ts:18-35，"每个 schema 声明的 secret 槽位及其配置状态"）是 secret
 * 是否落地的唯一来源——value/base/user 三层对 secret 全程脱敏。
 */
export interface SettingsMirrorFace {
  getSnapshot(): MirrorSnapshotLike;
  subscribe(listener: () => void): () => void;
  ensure?(): Promise<void>;
  /**
   * 把一次写应答携带的命名空间视图折回镜像，省掉一次 wire 读——宿主
   * ConfigFormController 自己就是这么做的（其 mutate 成功后调
   * `mirror.acceptView(response.value)`）。本插件走 `remote.settings.mutate`
   * 的裸线写入没有这个折叠，镜像只能等宿主推 `settings/document-updated`
   * 才刷新，故这里补上，让「已配置」徽章与写回同一次翻转；face 上不存在这个
   * 方法时（老宿主）降级为不折叠，仍由后续事件刷新。
   */
  acceptView?(view: unknown): void;
}

/**
 * settings 命名空间候选：0.2.x 起命名空间 = profile 条目 id（`dsh-wakatime`），
 * `wakatime` 是旧 settings.yaml 时代的 section 名。镜像按命名空间查行，只猜
 * 一个必然漏掉另一个（只写 `wakatime` 时，0.2.x 的行根本找不到 → 「已配置」
 * 徽章永远不亮），故统一用候选序列，与 host 端 src/index.ts:191 的
 * `row.ns === ENTRY_ID || row.ns === SETTINGS_NAMESPACE` 判定对齐。
 */
export const SETTINGS_NAMESPACE_CANDIDATES: readonly string[] = ['dsh-wakatime', 'wakatime'];

/**
 * 从镜像快照读取某 secret 字段是否已配置（线路全程脱敏，唯一可信源）。
 * @param ns - 命名空间，或按优先级排列的命名空间候选。
 *
 * 槽位按**单层路径**匹配（`path.length === 1 && path[0] === key`）。这对本插件是
 * 充分的：宿主 `redactSecrets(schema, value)` 从 `walk(schema, value, [], secrets)`
 * 起步、每下一层就 `[...path, key]`（dsh-settings/lib/index.js:22 与 :73-75），而本
 * 插件的 `Config` 是扁平的、`api_key` 就在顶层（src/index.ts:36），故它的 path 恒为
 * `['api_key']`。
 * ⚠️ 约束（今天成立、改结构就悄悄坏）：若将来把 secret 字段挪进嵌套对象（例如
 * `auth.api_key`，path 会变成 `['auth','api_key']`），这里会**静默失效**——徽章不亮、
 * 保存判定恒报未落地，且不抛任何错。动 Config 结构时必须同步改成整段路径比较。
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

/**
 * 从一次写入的返回值取出「Host 是否受理」的布尔本体。
 *
 * 不同宿主版本的返回形态不同，三条分支覆盖已知全部形状：
 *  - `true` / `false`：宿主直接给受理结果（`ConfigForm.set/unset/mutate`，
 *    自 0.2.0 起就是这个契约：*"true for Host acceptance, false for refusal or
 *    skipped writes"*，且**拒绝不抛异常**）→ 原样透传；
 *  - `{ ok: boolean, value?, error? }`：裸线 `remote.settings.mutate` 的
 *    `RemoteResult` 信封（dsh-typert-protocol/lib/types/types.d.ts:110）→ 取 `ok === true`；
 *  - 其它（含 `undefined`，即不带任何判别信息的老宿主）：这类宿主用**抛异常**
 *    表达失败，能 resolve 就说明没被拒 → 视为受理，最终仍由回读校验把关。
 * 只有显式的 `false` / `ok:false` 才算拒绝：空串、0、null 都不是这里的信号。
 */
export function writeAccepted(result: unknown): boolean {
  if (typeof result === 'boolean') return result;
  if (result !== null && typeof result === 'object' && 'ok' in result) {
    return (result as { ok: unknown }).ok === true;
  }
  return true;
}

/** 保存失败的两种成因：`refused` = Host 未受理写入；`notLanded` = 受理了但回读没看到真值。 */
export type SaveFailure = 'refused' | 'notLanded';

/**
 * 保存结果的两条独立判定（并存，不互相覆盖）：任一写入被拒 → `refused`
 * （更靠前的因，优先报它）；否则回读未落地 → `notLanded`；都通过 → null。
 */
export function saveFailureOf(refused: boolean, landed: boolean): SaveFailure | null {
  if (refused) return 'refused';
  if (!landed) return 'notLanded';
  return null;
}

/**
 * 单字段落地判定：secret 看镜像 secrets 槽位；普通字段以 user 层为准
 * （Host 对「覆盖值等于组合层」仍记录 user 条目），回退比对解析值。
 */
export function fieldLanded(
  key: string,
  kind: FieldKind,
  final: unknown,
  postUser: Record<string, unknown>,
  postValue: Record<string, unknown>,
  secretSet: boolean,
): boolean {
  if (kind === 'secret') return secretSet;
  if (Object.prototype.hasOwnProperty.call(postUser, key)) return postUser[key] === final;
  return postValue[key] === final;
}
