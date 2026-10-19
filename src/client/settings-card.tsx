/**
 * WakaTime 设置卡片：渲染到 WebUI 设置 → Plugins 面板
 * （settings.plugin.item 槽位），编辑 `wakatime` settings 命名空间。
 *
 * 视觉与交互对齐官方 SettingsForm（dsh-client-ui-primitives）：裸表单、
 * 无卡片 chrome（无边框/背景/可折叠头部），字段按 section 分组（api /
 * tracking / cacheDebug），每组有 13px/600 标题；布尔字段用 toggle 行
 * （label 左 + switch 右，说明常驻）；文本/数值/secret 字段的说明收进
 * 24×24 帮助按钮（12px 圆圈问号，点击展开）；底部保留保存/放弃按钮。
 *
 * 行为不变：字段为「label 行（覆盖徽章 + 重置）→ 输入控件 → 说明/错误」
 * 结构；非法草稿阻塞保存；保存后回读校验，未落地的草稿保留并报错；
 * secret 字段只显示配置状态、空白草稿不写入（值不回显）。
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
import { injectStyles } from './styles.ts';
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
  /** 渲染表面：`'detail'` = 插件详情页卡片（显示「在设置中显示」开关）；`'settings'` = 设置对话框页。 */
  surface?: 'detail' | 'settings';
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

/** 覆盖徽章 + 重置按钮（label 行右侧；与官方 PluginCard 同构）。 */
function OverriddenBadge({ disabled, t, onReset }: {
  disabled: boolean;
  t: WkStrings;
  onReset: () => void;
}) {
  return (
    <span className="wk-card-badges">
      <span className="wk-card-badge">{t.overridden}</span>
      <button type="button" className="wk-card-reset" disabled={disabled} onClick={onReset}>{t.reset}</button>
    </span>
  );
}

/** 帮助按钮（对齐官方 _helpButton_：24×24、radius 8px、12px 圆圈问号图标）。 */
function HelpButton({ open, label, controls, onToggle }: {
  open: boolean;
  label: string;
  controls: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={open ? 'wk-help-btn wk-help-btnOpen' : 'wk-help-btn'}
      aria-label={label}
      aria-expanded={open}
      aria-controls={controls}
      onClick={onToggle}
    >
      <svg width="12" height="12" viewBox="0 0 14 14" fill="none" aria-hidden="true">
        <path d="M12.5757 7.00012C12.5757 3.92085 10.0794 1.42463 7.00012 1.42456C3.9208 1.42456 1.42456 3.9208 1.42456 7.00012C1.42463 10.0794 3.92085 12.5757 7.00012 12.5757C10.0793 12.5756 12.5756 10.0793 12.5757 7.00012ZM13.8002 7.00012C13.8001 10.7559 10.7559 13.8001 7.00012 13.8002C3.2443 13.8002 0.199291 10.7559 0.199219 7.00012C0.199219 3.24426 3.24426 0.199219 7.00012 0.199219C10.7559 0.199291 13.8002 3.2443 13.8002 7.00012Z" fill="currentColor" />
        <path d="M7.6127 3.18921V4.55986H6.38735V3.18921H7.6127Z" fill="currentColor" />
        <path d="M7.6127 5.68921V10.8109H6.38735V5.68921H7.6127Z" fill="currentColor" />
      </svg>
    </button>
  );
}

/** 展开后的说明区（对齐官方 _help_：12px / 1.6 行高）。 */
function HelpRegion({ id, label, text }: { id: string; label: string; text: string }) {
  return (
    <div id={id} role="region" aria-label={label} className="wk-help">
      <p>{text}</p>
    </div>
  );
}

/** 布尔字段：官方 toggle 行（label 左 + switch 右），说明常驻。 */
function ToggleField({ id, def, checked, overridden, disabled, t, onToggle, onReset }: {
  id: string;
  def: (typeof WAKATIME_FIELDS)[number];
  checked: boolean;
  overridden: boolean;
  disabled: boolean;
  t: WkStrings;
  onToggle: () => void;
  onReset: () => void;
}) {
  const copy = t.fields[def.key];
  return (
    <div className="wk-field">
      <div className="wk-toggle-row">
        <div className="wk-label-group">
          <label htmlFor={id} className="wk-toggle-label">{copy.label}</label>
        </div>
        {overridden ? <OverriddenBadge disabled={disabled} t={t} onReset={onReset} /> : null}
        <button
          type="button"
          id={id}
          role="switch"
          aria-checked={checked}
          aria-label={copy.label}
          className="wk-toggle-switch"
          disabled={disabled}
          onClick={onToggle}
        />
      </div>
      <p className="wk-toggle-description">{copy.hint}</p>
    </div>
  );
}

/** 文本/数值字段：label 行（帮助按钮 + 覆盖徽章）→ 输入框 → 错误/帮助展开。 */
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
  const [helpOpen, setHelpOpen] = useState(false);
  const helpAria = format(t.helpAriaLabel, { field: copy.label });
  const helpId = `wk-help-${def.key}`;
  return (
    <div className="wk-field">
      <div className="wk-card-fieldHead">
        <div className="wk-label-group">
          <label htmlFor={id} className="wk-card-label">{copy.label}</label>
          <HelpButton
            open={helpOpen}
            label={helpAria}
            controls={helpId}
            onToggle={() => setHelpOpen((o) => !o)}
          />
        </div>
        {overridden ? <OverriddenBadge disabled={disabled} t={t} onReset={onReset} /> : null}
      </div>
      <input
        id={id}
        className={invalid ? 'wk-input wk-inputInvalid' : 'wk-input'}
        type="text"
        {...def.kind === 'number' ? { inputMode: 'numeric' as const } : {}}
        {...invalid ? { 'aria-invalid': true } : {}}
        value={text}
        placeholder=""
        disabled={disabled}
        onChange={(e) => onEdit(e.target.value)}
      />
      {invalid ? (
        <p className="wk-card-invalid" role="status">
          {format(t.invalidRange, { min: def.min ?? '', max: def.max ?? '' })}
        </p>
      ) : null}
      {helpOpen ? <HelpRegion id={helpId} label={helpAria} text={copy.hint} /> : null}
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
  const [helpOpen, setHelpOpen] = useState(false);
  const helpAria = format(t.helpAriaLabel, { field: copy.label });
  const helpId = `wk-help-${def.key}`;
  return (
    <div className="wk-field">
      <div className="wk-card-fieldHead">
        <div className="wk-label-group">
          <label htmlFor={id} className="wk-card-label">{copy.label}</label>
          <HelpButton
            open={helpOpen}
            label={helpAria}
            controls={helpId}
            onToggle={() => setHelpOpen((o) => !o)}
          />
        </div>
        <span className="wk-card-badges">
          <span className={configured ? 'wk-card-badge' : 'wk-badge-muted'}>
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
      {helpOpen ? <HelpRegion id={helpId} label={helpAria} text={copy.hint} /> : null}
    </div>
  );
}

/** 设置卡片主组件：staged 编辑 + 保存/放弃 + 回读校验。 */
export function WakaTimeCard({ scope, mirror, locale, surface }: WakaTimeCardProps): React.ReactElement | null {
  injectStyles();
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

  // 「在设置中显示」开关：仅详情页显示，控制 settings.section 是否注册。
  // localStorage 非响应式，切换后需刷新页面生效。
  const SHOW_SETTINGS_KEY = 'dsh-wakatime:show-settings-section';
  const [showSettings, setShowSettings] = useState<boolean>(() => {
    if (typeof localStorage === 'undefined') return false;
    return localStorage.getItem(SHOW_SETTINGS_KEY) === 'true';
  });
  const toggleShowSettings = (): void => {
    const next = !showSettings;
    setShowSettings(next);
    if (typeof localStorage !== 'undefined') {
      if (next) localStorage.setItem(SHOW_SETTINGS_KEY, 'true');
      else localStorage.removeItem(SHOW_SETTINGS_KEY);
    }
  };

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

  /** 按分组顺序渲染字段（布尔 → toggle 行；其余 → label+帮助按钮 → 输入）。 */
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
          <ToggleField
            key={f.key} id={id} def={f} checked={text === 'true'}
            overridden={isOverridden(f.key)} disabled={!writable || saving} t={t}
            onToggle={() => edit(f.key, text === 'true' ? 'false' : 'true')}
            onReset={() => resetField(f.key)}
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
    <div className="wk-form">
      {!writable ? <p className="wk-readOnly" role="status">{t.readOnlyNote}</p> : null}
      {/* 仅详情页显示：控制设置对话框中是否出现本插件的设置页。
       *  localStorage 非响应式，切换后需刷新页面生效。 */}
      {surface === 'detail' && (
        <section className="wk-section" aria-labelledby="wk-section-display">
          <h3 className="wk-section-heading" id="wk-section-display">{t.sections.display}</h3>
          <div className="wk-section-fields">
            <div className="wk-field">
              <div className="wk-toggle-row">
                <div className="wk-label-group">
                  <label className="wk-toggle-label" htmlFor="wk-show-settings">{t.showInSettings}</label>
                </div>
                <button
                  type="button"
                  id="wk-show-settings"
                  role="switch"
                  aria-checked={showSettings}
                  aria-label={t.showInSettings}
                  className="wk-toggle-switch"
                  onClick={toggleShowSettings}
                />
              </div>
              <p className="wk-toggle-description">{t.showInSettingsHint}</p>
            </div>
          </div>
        </section>
      )}
      {SECTIONS.map((section) => (
        <section className="wk-section" key={section} aria-labelledby={`wk-section-${section}`}>
          <h3 className="wk-section-heading" id={`wk-section-${section}`}>{t.sections[section]}</h3>
          <div className="wk-section-fields">
            {renderSection(section)}
          </div>
        </section>
      ))}
      <div className="wk-card-footer">
        {failed ? <p className="wk-card-failed" role="status">{t.saveFailed}</p> : null}
        {dirty ? (
          <button type="button" className="wk-card-discard" disabled={saving} onClick={discard}>
            {t.discard}
          </button>
        ) : null}
        <button type="button" className="wk-card-save" disabled={blocked} onClick={() => void save()}>
          {saving ? t.saving : t.save}
        </button>
      </div>
    </div>
  );
}
