/**
 * WakaTime 设置卡片：渲染到 WebUI 插件页配置区（`plugins.bundle.config` 槽位）
 * 与设置对话框（`settings.section` 槽位），编辑 `dsh-wakatime` settings 命名空间。
 *
 * **本版起完全改用官方 primitives 组件渲染**（对齐官方网页搜索插件
 * `dsh-client-ui-settings-web-search` 的实现）：
 *  - `SettingsForm`：表单外框——只读提示、底部保存按钮、保存失败文案、
 *    离开页面自动丢弃草稿，全部由官方组件负责，样式与官方插件天然一致；
 *  - `SettingsValueField`：文本/数值字段——label、说明、覆盖徽章、重置、
 *    非法草稿报错，内置；
 *  - `SettingsSecretField`：密钥字段——值不回显、只显示配置状态，内置；
 *  - `Switch`：布尔 toggle 与「在设置中显示」开关；
 *  - `SettingsFormModel`（在 index.ts 的 controller 里实例化）：草稿暂存、
 *    一次原子 mutate 保存、Host 受理判定与失败留稿。
 * 卡片本身是纯渲染器：props 收到 projection（经宿主包装的 `useWkCard`
 * hook）与表单动作，没有本地表单状态（除「在设置中显示」的 localStorage 开关）。
 *
 * 文案语言：全部微文案经 `useWkT` 跟随宿主 DSH 的界面语言（zh/en 双语字典
 * 见 strings.ts），语言切换实时重渲染；宿主缺 locale 服务时回退中文。
 * @module dsh-wakatime/client/settings-card
 */

import { useEffect, useRef, useState, type ReactElement } from 'react';
import {
  MenuSurface,
  MenuItemButton,
  SettingsForm,
  SettingsSecretField,
  SettingsValueField,
  Switch,
  IconChevronDownOutlineRegular,
  IconCheckOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives';
import type { SettingsFormShell, SettingsFieldState } from '@deepseek-ai/dsh-client-ui-primitives';
import { injectStyles } from './styles.ts';
import type { WkFieldKey, WkSectionId, WkStrings } from './strings.ts';
import { format } from './strings.ts';
import { useWkT, type LocaleFaceLike } from './useWkT.ts';

/** 字段输入形态（spec 工厂按此分派，见 field-specs.ts；仅本文件消费）。 */
type FieldKind = 'number' | 'text' | 'boolean' | 'secret' | 'combo';

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
  { key: 'project_name', kind: 'combo', section: 'tracking' },
  { key: 'language', kind: 'combo', section: 'tracking' },
  // 应用名是自由文本：候选值无意义（它就是要表达「这是哪个应用」），且留空有
  // 明确的服务端默认（Terminal），不必做成 combobox。
  { key: 'app_entity', kind: 'text', section: 'tracking' },
  // —— 缓存与调试 ——
  { key: 'cache_heartbeats', kind: 'boolean', section: 'cacheDebug' },
  { key: 'cache_limit', kind: 'number', section: 'cacheDebug', min: 10, max: 1000 },
  { key: 'debug', kind: 'boolean', section: 'cacheDebug' },
];

/** 分组渲染顺序（标题文案经字典 sections 表解析；仅本文件消费）。 */
const SECTIONS: ReadonlyArray<WkSectionId> = ['api', 'tracking', 'cacheDebug'];

/**
 * 卡片的可观察投影：表单壳状态 + 每个字段的草稿状态 + 密钥配置状态。
 * controller（index.ts）在 scope/草稿/镜像任一变化时重算并经 store 发布。
 */
export interface WkProjection {
  shell: SettingsFormShell;
  fields: Record<WkFieldKey, SettingsFieldState>;
  /** api_key 是否已配置（线路对 secret 全程脱敏，唯一可信源是 describe 镜像的槽位状态）。 */
  configured: boolean;
}

/** 卡片组件 props：由槽位注册的 inject 提供（hooks 由宿主包装成 useWkCard）。 */
export interface WakaTimeCardProps {
  /** 读投影快照的绑定选择器（宿主把 inject 的 hooks.wkCard store 包装成此 hook）。 */
  useWkCard: (selector: (projection: WkProjection) => WkProjection) => WkProjection;
  /** Stage 一个字段的草稿文本。 */
  edit: (field: string, text: string) => void;
  /** Stage 一个字段的清除（保存后回退组合层）。 */
  resetField: (field: string) => void;
  /** 写全部暂存修改（一次原子 mutate；失败保留草稿并报错）。 */
  save: () => void;
  /** 丢弃全部暂存修改（SettingsForm 卸载时也调用）。 */
  discard: () => void;
  /** 宿主 locale 服务 face（可选增强；缺失回退中文）。 */
  locale?: LocaleFaceLike;
  /** 渲染表面：`'detail'` = 插件详情页（显示「在设置中显示」开关）；`'settings'` = 设置对话框页。 */
  surface?: 'detail' | 'settings';
}

/** 布尔字段行：label 左 + 官方 Switch 右，说明常驻在下（对齐 web-search 的开关行）。 */
function ToggleRow({ def, state, disabled, t, onToggle }: {
  def: (typeof WAKATIME_FIELDS)[number];
  state: SettingsFieldState;
  disabled: boolean;
  t: WkStrings;
  onToggle: (next: boolean) => void;
}): ReactElement {
  const copy = t.fields[def.key];
  return (
    <div className="wk-feature">
      <div className="wk-toggle-row">
        <span>{copy.label}</span>
        <Switch
          checked={state.text === 'true'}
          label={copy.label}
          disabled={disabled}
          onChange={onToggle}
        />
      </div>
      <p className="wk-hint">{copy.hint}</p>
    </div>
  );
}

/** 「在设置中显示」开关：纯本地视图偏好（localStorage），不进设置文档、不参与保存。 */
function ShowInSectionToggle({ t }: { t: WkStrings }): ReactElement {
  const SHOW_SETTINGS_KEY = 'dsh-wakatime:show-settings-section';
  const [showSettings, setShowSettings] = useState<boolean>(() => {
    if (typeof localStorage === 'undefined') return false;
    return localStorage.getItem(SHOW_SETTINGS_KEY) === 'true';
  });
  const toggle = (): void => {
    const next = !showSettings;
    setShowSettings(next);
    if (typeof localStorage !== 'undefined') {
      if (next) localStorage.setItem(SHOW_SETTINGS_KEY, 'true');
      else localStorage.removeItem(SHOW_SETTINGS_KEY);
    }
  };
  return (
    <section className="wk-section" aria-label={t.sections.display}>
      <h3 className="wk-section-heading">{t.sections.display}</h3>
      <div className="wk-feature">
        <div className="wk-toggle-row">
          <span>{t.showInSettings}</span>
          <Switch checked={showSettings} label={t.showInSettings} onChange={toggle} />
        </div>
        <p className="wk-hint">{t.showInSettingsHint}</p>
      </div>
    </section>
  );
}

/**
 * 「项目名称」候选：经 host 代理路由 `/api/dsh-wakatime/projects` 拉取
 * （api_key 在 host 侧、线路对 client 脱敏，client 无法直连 WakaTime）。
 * 首次点开下拉才请求；host 侧另有 60s 缓存，这里只做组件生命周期内的一次
 * 加载与失败态。失败/无 key 时候选为空，字段退化为自由输入。
 */
type ComboStatus = 'idle' | 'loading' | 'ready' | 'error';

interface ProjectsState {
  status: ComboStatus;
  options: readonly string[];
}

function useProjectOptions(): { state: ProjectsState; load: () => void } {
  const [state, setState] = useState<ProjectsState>({ status: 'idle', options: [] });
  const inflight = useRef(false);
  const load = (): void => {
    setState((prev) => {
      if (prev.status === 'ready' || prev.status === 'loading' || inflight.current) return prev;
      inflight.current = true;
      void fetch('/api/dsh-wakatime/projects')
        .then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
        .then((body: { projects?: string[] }) => {
          inflight.current = false;
          setState({ status: 'ready', options: body.projects ?? [] });
        })
        .catch(() => {
          inflight.current = false;
          setState({ status: 'error', options: [] });
        });
      return { ...prev, status: 'loading' };
    });
  };
  return { state, load };
}

/**
 * 常用 WakaTime 语言候选（内置、非穷举——值域保持开放，输入框可填任意值）。
 * 顺序按使用频率排；不在列表里的合法语言仍可手输。
 */
const LANGUAGE_OPTIONS: readonly string[] = [
  'TypeScript', 'JavaScript', 'Python', 'Go', 'Rust', 'Java', 'C', 'C++', 'C#',
  'Objective-C', 'PHP', 'Ruby', 'Swift', 'Kotlin', 'Scala', 'Dart', 'Elixir',
  'Haskell', 'Lua', 'Perl', 'R', 'Clojure', 'Zig', 'Vue', 'Svelte', 'HTML',
  'CSS', 'SCSS', 'Shell', 'PowerShell', 'SQL', 'JSON', 'YAML', 'TOML',
  'Markdown', 'Docker', 'Nix', 'Solidity', 'Erlang', 'OCaml', 'F#',
];

/**
 * 候选输入框（combobox）：官方 SettingsValueField 的下拉变体——head（label +
 * 覆盖徽章 + 恢复默认）与说明保持官方观感，控件为「输入框 + 下拉钮」，候选
 * 面板用官方 `MenuSurface` + `MenuItemButton`（与工作区切换器同一套菜单件），
 * 当前值打勾。自由输入不受候选限制：草稿语义与 text 字段完全相同。
 */
function ComboboxField({ id, label, hint, state, disabled, t, options, status, onRequest, onEdit, onReset }: {
  id: string;
  label: string;
  hint: string;
  state: SettingsFieldState;
  disabled: boolean;
  t: WkStrings;
  options: readonly string[];
  status: ComboStatus;
  onRequest: () => void;
  onEdit: (text: string) => void;
  onReset: () => void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  // 外点/Esc 收起（官方 Menu 的 onClose 语义，这里自持因为面板是内联绝对定位）。
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  const toggle = (): void => {
    setOpen((prev) => {
      if (!prev) onRequest();
      return !prev;
    });
  };
  const needle = state.text.trim().toLowerCase();
  const visible = needle === '' ? options : options.filter((option) => option.toLowerCase().includes(needle));
  return (
    <div className="wk-field" ref={rootRef}>
      <div className="wk-combo-head">
        <label className="wk-combo-label" htmlFor={id}>{label}</label>
        {state.overridden ? (
          <span className="wk-combo-badges">
            <span className="wk-combo-badge">{t.overridden}</span>
            <button type="button" className="wk-combo-reset" disabled={disabled} onClick={onReset}>{t.reset}</button>
          </span>
        ) : null}
      </div>
      <div className="wk-combo">
        <input
          id={id}
          className="wk-combo-input"
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          value={state.text}
          disabled={disabled}
          onChange={(event) => onEdit(event.target.value)}
        />
        <button type="button" className="wk-combo-btn" aria-label={t.comboAria} disabled={disabled} onClick={toggle}>
          <IconChevronDownOutlineRegular size={14} />
        </button>
        {open ? (
          <MenuSurface compact className="wk-combo-list">
            {status === 'loading' ? (
              <p className="wk-combo-status">{t.comboLoading}</p>
            ) : visible.length === 0 ? (
              <p className="wk-combo-status">{needle === '' ? t.comboEmpty : t.comboNoMatch}</p>
            ) : (
              visible.map((option) => (
                <MenuItemButton key={option} onSelect={() => { onEdit(option); setOpen(false); }}>
                  <span className="wk-combo-item">
                    <span className="wk-combo-itemLabel">{option}</span>
                    {option === state.text ? <IconCheckOutlineRegular size={14} /> : null}
                  </span>
                </MenuItemButton>
              ))
            )}
          </MenuSurface>
        ) : null}
      </div>
      <p className="wk-hint">{hint}</p>
    </div>
  );
}

/** 设置卡片主组件：官方 SettingsForm 渲染外框与保存按钮，字段按分组排布。 */
export function WakaTimeCard(props: WakaTimeCardProps): ReactElement {
  useEffect(() => injectStyles(), []);
  const { t } = useWkT(props.locale);
  const projection = props.useWkCard((value) => value);
  const { shell, fields, configured } = projection;
  const disabled = !shell.writable || shell.saving;
  const projects = useProjectOptions();

  const invalidLabelFor = (def: (typeof WAKATIME_FIELDS)[number]): string =>
    format(t.invalidRange, { min: def.min ?? '', max: def.max ?? '' });

  const renderField = (def: (typeof WAKATIME_FIELDS)[number]): ReactElement => {
    const copy = t.fields[def.key];
    const state = fields[def.key];
    const id = `plugin-config-wakatime-${def.key}`;
    if (def.kind === 'secret') {
      return (
        <SettingsSecretField
          key={def.key}
          id={id}
          label={copy.label}
          hint={copy.hint}
          text={state.text}
          configured={configured}
          stateLabel={configured ? t.configured : t.notConfigured}
          disabled={disabled}
          onEdit={(text) => props.edit(def.key, text)}
        />
      );
    }
    if (def.kind === 'boolean') {
      return (
        <ToggleRow
          key={def.key}
          def={def}
          state={state}
          disabled={disabled}
          t={t}
          onToggle={(next) => props.edit(def.key, next ? 'true' : 'false')}
        />
      );
    }
    if (def.kind === 'combo') {
      // 两个 combo 只差候选来源：project_name 走 host 代理（点开才拉），
      // language 用内置常量（恒 ready，onRequest 无事可做）。
      const isProject = def.key === 'project_name';
      return (
        <ComboboxField
          key={def.key}
          id={id}
          label={copy.label}
          hint={copy.hint}
          state={state}
          disabled={disabled}
          t={t}
          options={isProject ? projects.state.options : LANGUAGE_OPTIONS}
          status={isProject ? projects.state.status : 'ready'}
          onRequest={isProject ? projects.load : () => undefined}
          onEdit={(text) => props.edit(def.key, text)}
          onReset={() => props.resetField(def.key)}
        />
      );
    }
    return (
      <SettingsValueField
        key={def.key}
        id={id}
        label={copy.label}
        hint={copy.hint}
        {...state}
        numeric={def.kind === 'number'}
        overriddenLabel={t.overridden}
        resetLabel={t.reset}
        invalidLabel={invalidLabelFor(def)}
        disabled={disabled}
        onEdit={(text) => props.edit(def.key, text)}
        onReset={() => props.resetField(def.key)}
      />
    );
  };

  return (
    <SettingsForm
      labels={{
        unavailable: t.unavailable,
        readOnly: t.readOnlyNote,
        saveFailed: t.saveFailed,
        save: t.save,
        saving: t.saving,
      }}
      state={shell}
      onSave={props.save}
      onDiscard={props.discard}
    >
      {props.surface === 'detail' ? <ShowInSectionToggle t={t} /> : null}
      {SECTIONS.map((section) => (
        <section className="wk-section" key={section} aria-label={t.sections[section]}>
          <h3 className="wk-section-heading">{t.sections[section]}</h3>
          <div className="wk-section-fields">
            {WAKATIME_FIELDS.filter((def) => def.section === section).map(renderField)}
          </div>
        </section>
      ))}
    </SettingsForm>
  );
}
