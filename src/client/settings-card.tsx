/**
 * WakaTime 设置卡片：渲染到 WebUI 设置 → Plugins 面板
 * （settings.plugin.item 槽位），编辑 `wakatime` settings 命名空间。
 *
 * 视觉与交互对齐官方 PluginCard（dsh-client-ui-settings-plugins 内部私有组件，
 * bundle 纯净性门控禁止 import 其卡片 chrome / 表单模型作为值，这里按相同
 * 结构自实现）：header 整卡按钮默认收起；字段为「label 行（覆盖徽章 + 重置）
 * → 输入控件 → 提示」三段式；非法草稿阻塞保存；保存后回读校验，未落地的
 * 草稿保留并报错；secret 字段只显示配置状态、空白草稿不写入。
 *
 * 文案语言：全部微文案（分组头/label/hint/按钮/徽章/错误）经 `useWkT`
 * 跟随宿主 DSH 的界面语言（zh/en 双语字典见 strings.ts），语言切换实时
 * 重渲染；宿主缺 locale 服务时回退中文。字段定义只存 key/形态/分组 id。
 *
 * secret 回读的特别说明：settings 线路契约对 `role('secret')` 字段全程脱敏
 * （value/base/user 三层都不携带），因此 secret 是否落地、是否已配置，只能
 * 经共享 describe 镜像的 `secrets` 槽位列表（`{ path, set }`）观察。普通字段
 * 则以 user 层为准（写入即覆盖），回退比对解析值。
 * @module dsh-wakatime/client/settings-card
 */

import { useEffect, useState } from 'react';
import type { FieldKind, MirrorSnapshotLike, ScopeLike, SettingsMirrorFace } from './mirror.ts';
import { fieldLanded, secretSlotSet } from './mirror.ts';
import type { WkFieldKey, WkSectionId, WkStrings } from './strings.ts';
import { format } from './strings.ts';
import { useWkT, type LocaleFaceLike } from './useWkT.ts';

export type { FieldKind } from './mirror.ts';
export type { MirrorSnapshotLike, ScopeLike, SettingsMirrorFace } from './mirror.ts';
export { fieldLanded, secretSlotSet } from './mirror.ts';
export type { LocaleFaceLike } from './useWkT.ts';

/** 配置字段定义（key / 输入形态 / 所属分组 id）；label/hint 经字典按 key 解析。 */
export const WAKATIME_FIELDS: ReadonlyArray<{
  readonly key: WkFieldKey;
  readonly kind: FieldKind;
  readonly section: WkSectionId;
  /** number 形态的合法闭区间；undefined 表示不校验。 */
  readonly min?: number;
  readonly max?: number;
}> = [
  // —— API ——
  { key: 'api_key', kind: 'secret', section: 'api' },
  { key: 'api_url', kind: 'text', section: 'api' },
  // —— 追踪 ——
  { key: 'heartbeat_interval_ms', kind: 'number', section: 'tracking', min: 60000, max: 300000 },
  { key: 'include_tool_calls', kind: 'boolean', section: 'tracking' },
  { key: 'include_user_messages', kind: 'boolean', section: 'tracking' },
  { key: 'include_assistant_messages', kind: 'boolean', section: 'tracking' },
  { key: 'project_name', kind: 'text', section: 'tracking' },
  { key: 'language', kind: 'text', section: 'tracking' },
  // —— 缓存与调试 ——
  { key: 'cache_heartbeats', kind: 'boolean', section: 'cacheDebug' },
  { key: 'cache_limit', kind: 'number', section: 'cacheDebug', min: 10, max: 1000 },
  { key: 'debug', kind: 'boolean', section: 'cacheDebug' },
];

/** 分组渲染顺序（标题文案经字典 sections 表解析）。 */
const SECTIONS: ReadonlyArray<WkSectionId> = ['api', 'tracking', 'cacheDebug'];

/** settings 命名空间（与 host 端一致）。 */
const SETTINGS_NAMESPACE = 'wakatime';

/** 卡片组件 props：由槽位注册的 inject 提供。 */
export interface WakaTimeCardProps {
  scope: ScopeLike;
  /** 共享 describe 镜像面：secret 槽位的配置状态只经此观察（线路对 secret 脱敏）。 */
  mirror?: SettingsMirrorFace;
  /** 宿主 locale 服务（可选）：卡片文案跟随宿主界面语言，缺失回退中文。 */
  locale?: LocaleFaceLike;
}

/** 官方同款样式表（类名加 wk- 前缀避免冲突；变量在暗/亮主题下均受支持）。 */
const CSS = `
.wk-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}
.wk-card:hover{border-color:var(--dsw-alias-label-dimmed)}
.wk-cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}
.wk-header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}
.wk-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.wk-headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}
.wk-name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}
.wk-description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}
.wk-chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}
.wk-chevronOpen{transform:rotate(180deg)}
.wk-body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}
.wk-readOnly{color:var(--dsw-alias-label-tertiary);margin:12px 0 0;font-size:12px;line-height:1.5}
.wk-pending{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;flex:none;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}
.wk-footer{border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}
.wk-failed{min-width:0;color:var(--dsw-alias-label-error);flex:1;margin:0;font-size:12px;line-height:1.5}
.wk-discard,.wk-save{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}
.wk-discard{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0}
.wk-discard:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}
.wk-save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}
.wk-discard:disabled,.wk-save:disabled{opacity:.4;cursor:default}
.wk-discard:focus-visible,.wk-save:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.wk-section{color:var(--dsw-alias-label-secondary);margin:14px 0 0;font-size:12px;font-weight:600;line-height:1.5;text-transform:uppercase;letter-spacing:.04em}
.wk-field{flex-direction:column;gap:6px;padding:12px 0;display:flex}
.wk-field+.wk-field{border-top:1px solid var(--dsw-alias-border-l2)}
.wk-head{align-items:center;gap:8px;display:flex}
.wk-label{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5}
.wk-badges{align-items:center;gap:8px;display:inline-flex}
.wk-badge{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}
.wk-badgeMuted{white-space:nowrap;color:var(--dsw-alias-label-tertiary);border-radius:999px;padding:1px 8px;font-size:11px;line-height:17px}
.wk-reset{font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;padding:0;font-size:12px;line-height:1.5}
.wk-reset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.wk-reset:disabled{cursor:default}
.wk-input,.wk-select{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font-size:13px;line-height:1.5;width:100%;box-sizing:border-box}
.wk-select{appearance:auto}
.wk-input:focus-visible,.wk-select:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}
.wk-input:disabled,.wk-select:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}
.wk-inputInvalid{border-color:var(--dsw-alias-label-error)}
.wk-invalid{color:var(--dsw-alias-label-error);margin:0;font-size:12px;line-height:1.5}
.wk-hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}
`;

/** 注入一次样式表（幂等）。 */
function ensureStyles(): void {
  if (typeof document === 'undefined') return;
  const tagId = 'dsh-wakatime/settings-card';
  if (document.querySelector(`style[data-plugin-css="${tagId}"]`) !== null) return;
  const tag = document.createElement('style');
  tag.dataset.plugin = 'dsh-wakatime';
  tag.dataset.pluginCss = tagId;
  tag.textContent = CSS;
  document.head.appendChild(tag);
}

/** 与官方 PluginCard 视觉一致的 chevron-down 图标（内联 SVG，零依赖）。 */
function ChevronDown({ className }: { className?: string }): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className={className} aria-hidden="true">
      <path d="M3.5 5.25 7 8.75l3.5-3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** 草稿状态：key -> 用户输入的原始文本（布尔为 'true'/'false'）。 */
type Edits = Record<string, string>;

/** 数值字段的草稿是否合法。 */
function isNumberValid(raw: string, def: (typeof WAKATIME_FIELDS)[number]): boolean {
  if (!/^-?\d+$/.test(raw.trim())) return false;
  const n = Number(raw);
  if (def.min !== undefined && n < def.min) return false;
  if (def.max !== undefined && n > def.max) return false;
  return true;
}

/** 未改动项的原始值 -> 显示用字符串。 */
function displayValue(v: unknown): string {
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return v === undefined || v === null ? '' : String(v);
}

/** 文本/数值字段：label 行（覆盖徽章 + 重置）→ 输入框 → 提示/错误。 */
function ValueField({ id, def, text, invalid, overridden, disabled, t, onEdit, onReset }: {
  id: string;
  def: (typeof WAKATIME_FIELDS)[number];
  text: string;
  invalid: boolean;
  overridden: boolean;
  disabled: boolean;
  t: WkStrings;
  onEdit: (text: string) => void;
  onReset: () => void;
}) {
  const copy = t.fields[def.key];
  return (
    <div className="wk-field">
      <div className="wk-head">
        <label className="wk-label" htmlFor={id}>{copy.label}</label>
        {overridden ? (
          <span className="wk-badges">
            <span className="wk-badge">{t.overridden}</span>
            <button type="button" className="wk-reset" disabled={disabled} onClick={onReset}>{t.reset}</button>
          </span>
        ) : null}
      </div>
      <input
        id={id}
        className={invalid ? 'wk-input wk-inputInvalid' : 'wk-input'}
        type={def.kind === 'secret' ? 'password' : 'text'}
        autoComplete={def.kind === 'secret' ? 'off' : undefined}
        {...def.kind === 'number' ? { inputMode: 'numeric' as const } : {}}
        {...invalid ? { 'aria-invalid': true } : {}}
        value={text}
        placeholder=""
        disabled={disabled}
        onChange={(e) => onEdit(e.target.value)}
      />
      <p className={invalid ? 'wk-invalid' : 'wk-hint'}>
        {invalid ? format(t.invalidRange, { min: def.min ?? '', max: def.max ?? '' }) : copy.hint}
      </p>
    </div>
  );
}

/** 布尔字段：官方卡片无数值外的专用控件，这里用同款样式的下拉框。 */
function BooleanField({ id, def, text, overridden, disabled, t, onEdit, onReset }: {
  id: string;
  def: (typeof WAKATIME_FIELDS)[number];
  text: string;
  overridden: boolean;
  disabled: boolean;
  t: WkStrings;
  onEdit: (text: string) => void;
  onReset: () => void;
}) {
  const copy = t.fields[def.key];
  return (
    <div className="wk-field">
      <div className="wk-head">
        <label className="wk-label" htmlFor={id}>{copy.label}</label>
        {overridden ? (
          <span className="wk-badges">
            <span className="wk-badge">{t.overridden}</span>
            <button type="button" className="wk-reset" disabled={disabled} onClick={onReset}>{t.reset}</button>
          </span>
        ) : null}
      </div>
      <select
        id={id}
        className="wk-select"
        value={text === 'true' ? 'true' : 'false'}
        disabled={disabled}
        onChange={(e) => onEdit(e.target.value)}
      >
        <option value="true">{t.on}</option>
        <option value="false">{t.off}</option>
      </select>
      <p className="wk-hint">{copy.hint}</p>
    </div>
  );
}

/** secret 字段：值不回显，只报配置状态；空白草稿不写入（保留已存密钥）。 */
function SecretField({ id, def, text, configured, disabled, t, onEdit }: {
  id: string;
  def: (typeof WAKATIME_FIELDS)[number];
  text: string;
  configured: boolean;
  disabled: boolean;
  t: WkStrings;
  onEdit: (text: string) => void;
}) {
  const copy = t.fields[def.key];
  return (
    <div className="wk-field">
      <div className="wk-head">
        <label className="wk-label" htmlFor={id}>{copy.label}</label>
        <span className="wk-badges">
          <span className={configured ? 'wk-badge' : 'wk-badgeMuted'}>
            {configured ? t.configured : t.notConfigured}
          </span>
        </span>
      </div>
      <input
        id={id}
        className="wk-input"
        type="password"
        autoComplete="off"
        value={text}
        disabled={disabled}
        onChange={(e) => onEdit(e.target.value)}
      />
      <p className="wk-hint">{copy.hint}</p>
    </div>
  );
}

/** 设置卡片主组件：staged 编辑 + 保存/放弃 + 回读校验。 */
export function WakaTimeCard({ scope, mirror, locale }: WakaTimeCardProps): React.ReactElement | null {
  ensureStyles();
  // 文案语言：订阅宿主 locale 快照，语言切换实时重渲染（缺失回退中文）。
  const { t } = useWkT(locale);
  const [snap, setSnap] = useState(scope.getSnapshot());
  useEffect(() => scope.subscribe(() => setSnap(scope.getSnapshot())), [scope]);
  // 镜像订阅：secret 槽位的 set 状态只在镜像视图里翻转，保存后徽章据此刷新。
  const [, bumpMirror] = useState(0);
  useEffect(() => {
    if (!mirror) return;
    void mirror.ensure?.();
    return mirror.subscribe(() => bumpMirror(c => c + 1));
  }, [mirror]);
  const [edits, setEdits] = useState<Edits>({});
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);

  if (snap.status === 'unavailable') return null; // 命名空间未暴露时不显示卡片

  const value = (snap.value ?? {}) as Record<string, unknown>;
  const user = (snap.user ?? {}) as Record<string, unknown>;
  const base = (snap.base ?? {}) as Record<string, unknown>;
  const writable = snap.writable && snap.status === 'ready';
  const dirty = Object.keys(edits).length > 0;

  /** 草稿合法性：任一字段非法即阻塞保存。 */
  const invalidKeys = new Set<string>();
  for (const [key, raw] of Object.entries(edits)) {
    const def = WAKATIME_FIELDS.find(f => f.key === key)!;
    if (def.kind === 'number' && !isNumberValid(raw, def)) invalidKeys.add(key);
  }
  const blocked = !dirty || invalidKeys.size > 0 || saving;

  const fieldValue = (key: string): string => {
    if (key in edits) return edits[key];
    return displayValue(value[key]);
  };
  const isOverridden = (key: string): boolean => Object.prototype.hasOwnProperty.call(user, key);

  const edit = (key: string, text: string): void => {
    setFailed(false);
    setEdits(prev => ({ ...prev, [key]: text }));
  };

  /** 重置：stage 组合层默认值（不立即写盘），清掉该字段的用户覆盖意图。 */
  const resetField = (key: string): void => {
    const def = WAKATIME_FIELDS.find(f => f.key === key)!;
    const composed = base[key] ?? value[key];
    let staged: string;
    if (def.kind === 'boolean') staged = composed === true || composed === 'true' ? 'true' : 'false';
    else staged = composed === undefined || composed === null ? '' : String(composed);
    setFailed(false);
    setEdits(prev => ({ ...prev, [key]: staged }));
  };

  const save = async (): Promise<void> => {
    setSaving(true);
    setFailed(false);
    try {
      const stagedFinals: Record<string, unknown> = {};
      for (const [key, raw] of Object.entries(edits)) {
        const def = WAKATIME_FIELDS.find(f => f.key === key)!;
        if (def.kind === 'secret') {
          if (raw.trim() === '') continue; // 空白草稿不写入，保留已存密钥
          stagedFinals[key] = raw;
        } else if (def.kind === 'number') {
          stagedFinals[key] = Number(raw);
        } else if (def.kind === 'boolean') {
          stagedFinals[key] = raw === 'true';
        } else {
          stagedFinals[key] = raw;
        }
      }
      for (const [key, final] of Object.entries(stagedFinals)) {
        await scope.set(key, final);
      }
      // 回读校验：Host 是唯一权威；未落地的字段保留草稿并报错。
      // secret 字段在线路上全程脱敏（value/user 均不携带），只能经镜像
      // secrets 槽位的 set 状态判定落地；普通字段以 user 层为准、回退解析值。
      await new Promise(r => setTimeout(r, 50));
      const post = scope.getSnapshot();
      const postUser = (post.user ?? {}) as Record<string, unknown>;
      const postValue = (post.value ?? {}) as Record<string, unknown>;
      const landed = Object.entries(stagedFinals).every(([key, final]) => {
        const def = WAKATIME_FIELDS.find(f => f.key === key)!;
        return fieldLanded(
          key,
          def.kind,
          final,
          postUser,
          postValue,
          secretSlotSet(mirror?.getSnapshot(), SETTINGS_NAMESPACE, key),
        );
      });
      if (landed) {
        setEdits({});
      } else {
        setFailed(true);
      }
    } catch {
      setFailed(true); // 写入被拒（如 revision 冲突）：保留草稿供修正
    } finally {
      setSaving(false);
    }
  };

  const discard = (): void => {
    setEdits({});
    setFailed(false);
  };

  /** 按分组顺序渲染字段。 */
  const renderSection = (section: WkSectionId): React.ReactElement[] =>
    WAKATIME_FIELDS.filter(f => f.section === section).map((f) => {
      const id = `plugin-config-wakatime-${f.key}`;
      const text = fieldValue(f.key);
      if (f.kind === 'secret') {
        return (
          <SecretField
            key={f.key} id={id} def={f} text={'api_key' in edits ? edits.api_key : ''}
            configured={secretSlotSet(mirror?.getSnapshot(), SETTINGS_NAMESPACE, f.key)}
            disabled={!writable || saving} t={t}
            onEdit={(tt) => edit(f.key, tt)}
          />
        );
      }
      if (f.kind === 'boolean') {
        return (
          <BooleanField
            key={f.key} id={id} def={f} text={text}
            overridden={isOverridden(f.key)} disabled={!writable || saving} t={t}
            onEdit={(tt) => edit(f.key, tt)} onReset={() => resetField(f.key)}
          />
        );
      }
      return (
        <ValueField
          key={f.key} id={id} def={f} text={text}
          invalid={invalidKeys.has(f.key)} overridden={isOverridden(f.key)}
          disabled={!writable || saving} t={t}
          onEdit={(tt) => edit(f.key, tt)} onReset={() => resetField(f.key)}
        />
      );
    });

  return (
    <li className={open ? 'wk-card wk-cardOpen' : 'wk-card'}>
      <button
        type="button"
        className="wk-header"
        aria-expanded={open}
        aria-label={open ? t.ariaCollapse : t.ariaExpand}
        onClick={() => setOpen(o => !o)}
      >
        <span className="wk-headText">
          <span className="wk-name">WakaTime</span>
          <span className="wk-description">{t.description}</span>
        </span>
        {dirty ? <span className="wk-pending">{t.unsavedBadge}</span> : null}
        <ChevronDown className={open ? 'wk-chevron wk-chevronOpen' : 'wk-chevron'} />
      </button>
      {open ? (
        <div className="wk-body">
          {!writable ? <p className="wk-readOnly" role="status">{t.readOnlyNote}</p> : null}
          {SECTIONS.map((s, i) => (
            <div key={s}>
              {i > 0 || true ? <div className="wk-section">{t.sections[s]}</div> : null}
              {renderSection(s)}
            </div>
          ))}
          <div className="wk-footer">
            {failed ? <p className="wk-failed" role="status">{t.saveFailed}</p> : null}
            <button type="button" className="wk-discard" disabled={!dirty || saving} onClick={discard}>{t.discard}</button>
            <button type="button" className="wk-save" disabled={blocked} onClick={() => void save()}>
              {saving ? t.saving : t.save}
            </button>
          </div>
        </div>
      ) : null}
    </li>
  );
}
