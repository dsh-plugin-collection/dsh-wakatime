/**
 * 设置卡片的线路观察辅助：settings 线路契约对 `role('secret')` 字段全程脱敏
 * （value/base/user 三层都不携带），secret 是否落地、是否已配置，只能经共享
 * describe 镜像的 `secrets` 槽位列表（`{ path, set }`）观察；普通字段以 user
 * 层为准（写入即覆盖）、回退比对解析值。本模块保持零依赖（不引 react），可
 * 直接单测。
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

/** 客户端 settings scope 的最小结构视图（getSnapshot/subscribe/set/unset）。 */
export interface ScopeLike {
  getSnapshot(): ScopeSnapshotLike;
  subscribe(listener: () => void): () => void;
  set(field: string, value: unknown): Promise<void>;
  unset(field: string): Promise<void>;
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

/** 共享 describe 镜像面的最小结构视图（由宿主 settingsScope 服务 describe() 提供）。 */
export interface SettingsMirrorFace {
  getSnapshot(): MirrorSnapshotLike;
  subscribe(listener: () => void): () => void;
  ensure?(): Promise<void>;
}

/** 从镜像快照读取某命名空间下某 secret 字段是否已配置（线路全程脱敏，唯一可信源）。 */
export function secretSlotSet(
  snapshot: MirrorSnapshotLike | undefined,
  ns: string,
  key: string,
): boolean {
  const row = snapshot?.view?.namespaces?.find(candidate => candidate.ns === ns);
  return row?.secrets?.some(slot => slot.path.length === 1 && slot.path[0] === key && slot.set) ?? false;
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
