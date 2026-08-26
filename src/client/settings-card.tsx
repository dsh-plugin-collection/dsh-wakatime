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
 * secret 回读的特别说明：settings 线路契约对 `role('secret')` 字段全程脱敏
 * （value/base/user 三层都不携带），因此 secret 是否落地、是否已配置，只能
 * 经共享 describe 镜像的 `secrets` 槽位列表（`{ path, set }`）观察。普通字段
 * 则以 user 层为准（写入即覆盖），回退比对解析值。
 * @module dsh-wakatime/client/settings-card
 */

import { useEffect, useState } from 'react';
import type { FieldKind, MirrorSnapshotLike, ScopeLike, SettingsMirrorFace } from './mirror.ts';
import { fieldLanded, secretSlotSet } from './mirror.ts';

export type { FieldKind } from './mirror.ts';
export type { MirrorSnapshotLike, ScopeLike, SettingsMirrorFace } from './mirror.ts';
export { fieldLanded, secretSlotSet } from './mirror.ts';

/** 配置字段定义（key / 显示名 / 提示 / 输入形态 / 所属分组）。 */
export const WAKATIME_FIELDS: ReadonlyArray<{
  readonly key: string;
  readonly label: string;
  readonly hint: string;
  readonly kind: FieldKind;
  readonly section: string;
  /** number 形态的合法闭区间；undefined 表示不校验。 */
  readonly min?: number;
  readonly max?: number;
}> = [
  // —— API ——
  { key: 'api_key', label: 'API Key', hint: 'WakaTime 密钥；留空时回退环境变量与 ~/.wakatime.cfg', kind: 'secret', section: 'API' },
  { key: 'api_url', label: 'API URL', hint: '自托管端点；留空使用官方 wakatime.com', kind: 'text', section: 'API' },
  // —— 追踪 ——
  { key: 'heartbeat_interval_ms', label: '心跳间隔（毫秒）', hint: '60000–300000；批量发送的节拍', kind: 'number', section: '追踪', min: 60000, max: 300000 },
  { key: 'include_tool_calls', label: '追踪工具调用', hint: '记录文件读写、命令执行等工具调用', kind: 'boolean', section: '追踪' },
  { key: 'include_user_messages', label: '追踪用户消息', hint: '记录用户消息（增加心跳量）', kind: 'boolean', section: '追踪' },
  { key: 'include_assistant_messages', label: '追踪 AI 消息', hint: '记录 AI 回复（增加心跳量）', kind: 'boolean', section: '追踪' },
  { key: 'project_name', label: '项目名称', hint: '覆盖自动检测的项目名', kind: 'text', section: '追踪' },
  { key: 'language', label: '语言', hint: '覆盖自动检测的语言', kind: 'text', section: '追踪' },
  // —— 缓存与调试 ——
  { key: 'cache_heartbeats', label: '缓存失败心跳', hint: '网络失败时落盘，恢复后重发', kind: 'boolean', section: '缓存与调试' },
  { key: 'cache_limit', label: '缓存上限', hint: '10–1000；最多缓存的条数', kind: 'number', section: '缓存与调试', min: 10, max: 1000 },
  { key: 'debug', label: '调试模式', hint: '输出详细日志到 DSH 控制台', kind: 'boolean', section: '缓存与调试' },
];

/** settings 命名空间（与 host 端一致）。 */
const SETTINGS_NAMESPACE = 'wakatime';

/** 卡片组件 props：由槽位注册的 inject 提供。 */
export interface WakaTimeCardProps {
  scope: ScopeLike;
  /** 共享 describe 镜像面：secret 槽位的配置状态只经此观察（线路对 secret 脱敏）。 */
  mirror?: SettingsMirrorFace;
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
function ValueField({ id, def, text, invalid, overridden, disabled, onEdit, onReset }: {
  id: string;
  def: (typeof WAKATIME_FIELDS)[number];
  text: string;
  invalid: boolean;
  overridden: boolean;
  disabled: boolean;
  onEdit: (text: string) => void;
  onReset: () => void;
}) {
  return (
    <div className="wk-field">
      <div className="wk-head">
        <label className="wk-label" htmlFor={id}>{def.label}</label>
        {overridden ? (
          <span className="wk-badges">
            <span className="wk-badge">已覆盖</span>
            <button type="button" className="wk-reset" disabled={disabled} onClick={onReset}>重置</button>
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
        {invalid ? `需为 ${def.min}–${def.max} 的整数` : def.hint}
      </p>
    </div>
  );
}

/** 布尔字段：官方卡片无数值外的专用控件，这里用同款样式的下拉框。 */
function BooleanField({ id, def, text, overridden, disabled, onEdit, onReset }: {
  id: string;
  def: (typeof WAKATIME_FIELDS)[number];
  text: string;
  overridden: boolean;
  disabled: boolean;
  onEdit: (text: string) => void;
  onReset: () => void;
}) {
  return (
    <div className="wk-field">
      <div className="wk-head">
        <label className="wk-label" htmlFor={id}>{def.label}</label>
        {overridden ? (
          <span className="wk-badges">
            <span className="wk-badge">已覆盖</span>
            <button type="button" className="wk-reset" disabled={disabled} onClick={onReset}>重置</button>
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
        <option value="true">开启</option>
        <option value="false">关闭</option>
      </select>
      <p className="wk-hint">{def.hint}</p>
    </div>
  );
}

/** secret 字段：值不回显，只报配置状态；空白草稿不写入（保留已存密钥）。 */
function SecretField({ id, def, text, configured, disabled, onEdit }: {
  id: string;
  def: (typeof WAKATIME_FIELDS)[number];
  text: string;
  configured: boolean;
  disabled: boolean;
  onEdit: (text: string) => void;
}) {
  return (
    <div className="wk-field">
      <div className="wk-head">
        <label className="wk-label" htmlFor={id}>{def.label}</label>
        <span className="wk-badges">
          <span className={configured ? 'wk-badge' : 'wk-badgeMuted'}>
            {configured ? '已配置' : '未配置'}
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
      <p className="wk-hint">{def.hint}</p>
    </div>
  );
}

/** 设置卡片主组件：staged 编辑 + 保存/放弃 + 回读校验。 */
export function WakaTimeCard({ scope, mirror }: WakaTimeCardProps): React.ReactElement | null {
  ensureStyles();
  const [snap, setSnap] = useState(scope.getSnapshot());
  useEffect(() => scope.subscribe(() => setSnap(scope.getSnapshot())), [scope]);
  // 镜像订阅：secret 槽位的 set 状态只在镜像视图里翻转，保存后徽章据此刷新。
  const [, bumpMirror] = useState(0);
  useEffect(() => {
    if (!mirror) return;
    void mirror.ensure?.();
    return mirror.subscribe(() => bumpMirror(t => t + 1));
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
  const renderSection = (section: string): React.ReactElement[] =>
    WAKATIME_FIELDS.filter(f => f.section === section).map((f) => {
      const id = `plugin-config-wakatime-${f.key}`;
      const text = fieldValue(f.key);
      if (f.kind === 'secret') {
        return (
          <SecretField
            key={f.key} id={id} def={f} text={'api_key' in edits ? edits.api_key : ''}
            configured={secretSlotSet(mirror?.getSnapshot(), SETTINGS_NAMESPACE, f.key)}
            disabled={!writable || saving}
            onEdit={(t) => edit(f.key, t)}
          />
        );
      }
      if (f.kind === 'boolean') {
        return (
          <BooleanField
            key={f.key} id={id} def={f} text={text}
            overridden={isOverridden(f.key)} disabled={!writable || saving}
            onEdit={(t) => edit(f.key, t)} onReset={() => resetField(f.key)}
          />
        );
      }
      return (
        <ValueField
          key={f.key} id={id} def={f} text={text}
          invalid={invalidKeys.has(f.key)} overridden={isOverridden(f.key)}
          disabled={!writable || saving}
          onEdit={(t) => edit(f.key, t)} onReset={() => resetField(f.key)}
        />
      );
    });

  const sections = ['API', '追踪', '缓存与调试'];

  return (
    <li className={open ? 'wk-card wk-cardOpen' : 'wk-card'}>
      <button
        type="button"
        className="wk-header"
        aria-expanded={open}
        aria-label={`${open ? '折叠' : '展开'}：WakaTime`}
        onClick={() => setOpen(o => !o)}
      >
        <span className="wk-headText">
          <span className="wk-name">WakaTime</span>
          <span className="wk-description">编码活动统计：文件级心跳同步到 WakaTime 仪表板</span>
        </span>
        {dirty ? <span className="wk-pending">未保存</span> : null}
        <ChevronDown className={open ? 'wk-chevron wk-chevronOpen' : 'wk-chevron'} />
      </button>
      {open ? (
        <div className="wk-body">
          {!writable ? <p className="wk-readOnly" role="status">当前部署不可写（内存模式）</p> : null}
          {sections.map((s, i) => (
            <div key={s}>
              {i > 0 || true ? <div className="wk-section">{s}</div> : null}
              {renderSection(s)}
            </div>
          ))}
          <div className="wk-footer">
            {failed ? <p className="wk-failed" role="status">保存未落地，请检查后重试</p> : null}
            <button type="button" className="wk-discard" disabled={!dirty || saving} onClick={discard}>放弃修改</button>
            <button type="button" className="wk-save" disabled={blocked} onClick={() => void save()}>
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
      ) : null}
    </li>
  );
}
