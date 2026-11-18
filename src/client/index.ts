/**
 * dsh-wakatime client 端：把 WakaTime 设置卡片注册到 WebUI 插件页与设置面板。
 *
 * 编译说明：本文件以单文件 CommonJS 打包进 __ModuleLoader__.load，
 * 运行时 react / react-dom / @deepseek-ai/dsh-client-ui-primitives 从宿主解析。
 *
 * **本版对齐官方插件的设置页实现**（参考 `dsh-client-ui-settings-web-search`）：
 * 卡片不再手写表单状态机，而是经官方 `SettingsFormModel` 暂存草稿、由
 * `SettingsForm` 渲染外框与保存按钮。数据源也统一为宿主 `configForms`：
 * `configForms.get(entryId)` 返回的 ConfigForm（getSnapshot/subscribe/mutate）
 * 与官方 `SettingsFormScope` 契约同形（dsh-client-ui-settings/lib/types/client/
 * config-form-types.d.ts），直接喂给 model，插件侧不再有裸线适配器
 * （旧 `remote.settings` 手写 remoteSettingsScope/回读校验整套删除）。
 *
 * 槽位与 key：
 *  - `plugins.bundle.config`（插件详情页配置区）：key = **插件包名**
 *    （见 BUNDLE_PACKAGE_NAME），表单/寻址用条目 id（见 ENTRY_ID）；
 *  - `settings.section`（设置对话框独立页）：默认不注册，由详情页的
 *    「在设置中显示」开关（localStorage）控制，刷新页面生效。
 * 两处注册都包在 `configForms.whileServed([ENTRY_ID])` 里：命名空间不被
 * 宿主服务时（插件未加载）两处都静默消失，与官方行为一致。
 *
 * secret「已配置」状态：settings 线路对 `role('secret')` 字段全程脱敏，
 * 配置与否只能经共享 describe 镜像的 `secrets` 槽位观察
 * （`ctx.get('configForms').describe()` → SettingsDescribeFace）。
 * 取不到镜像面时传 undefined：卡片照旧，只是不显示已配置状态。
 * **新增服务读取必须同步写进顶层 inject 数组**，否则宿主
 * dynamicCordisContext 会抛 `cannot get property … without inject`。
 * @module dsh-wakatime/client
 */

import type { Context } from '@deepseek-ai/cordis';
import { SettingsFormModel, type SettingsFieldSpec, type SettingsFormScope } from '@deepseek-ai/dsh-client-ui-primitives';
import { WakaTimeCard, WAKATIME_FIELDS, type WkProjection } from './settings-card.tsx';
import { booleanField, numberField, textField } from './field-specs.ts';
import type { WkFieldKey } from './strings.ts';
import type { LocaleFaceLike } from './useWkT.ts';
import type { SettingsMirrorFace } from './mirror.ts';
// SETTINGS_NAMESPACE_CANDIDATES：0.2.x 起 settings 命名空间 = profile 条目 id
// （`dsh-wakatime`），旧 settings.yaml 时代才是 section 名（`wakatime`）。
// 镜像查 secret 行用它，与 host 端行判定对齐。
import { SETTINGS_NAMESPACE_CANDIDATES, secretSlotSet } from './mirror.ts';
import { PLUGIN_ID, SHOW_SETTINGS_KEY } from './plugin-id.ts';

/** 插件名（与 manifest id 一致）。 */
const name = PLUGIN_ID;

/** 设置页导航文案（与 dsh-suggest-ghost 同模式：thunk 随语言切换重读）。 */
const SECTION_LABELS: Record<string, string> = {
  zh: 'WakaTime',
  en: 'WakaTime',
};

/** 设置 section 的自有 id（宿主没有的 id 才会并排新增一页）。 */
const SETTINGS_SECTION_ID = PLUGIN_ID;

/**
 * 插件 profile 条目 id（与 `cordis.patch.yml` 的 `id: dsh-wakatime` 一致）。
 * `configForms.get()` 与 `whileServed()` 都用它寻址。
 */
const ENTRY_ID = PLUGIN_ID;

/**
 * `plugins.bundle.config` 槽位的 key —— **必须是插件包名**（`package.json` 的
 * `name`），不是 settings 命名空间、也不是条目 id。宿主侧证据（0.2.0-rc.2）：
 * 槽位契约（slot-contract.d.ts：*"keyed by the bundle's package name"*）、
 * PluginManagerPage 以 `{ entryKey: pkg.name }` 派发、`configured` 判定取自
 * `keysOf('plugins.bundle.config')`——key 不匹配即卡片静默不渲染。
 * （参考实现 dsh-suggest-ghost 的包名与其条目 id 不同，正是靠「包名硬编码 +
 * 条目 id 只用于 `configForms.get()`」区分这两套域。）
 */
const BUNDLE_PACKAGE_NAME = PLUGIN_ID;

/** 「在设置中显示」开关的 localStorage 键（详情页开关写、此处读，注册一次定夺）。 */

/**
 * `configForms` 服务（`ctx.get('configForms')`）的最小视图。宿主实现见
 * dsh-client-ui-settings/lib/types/client/config-form.d.ts 的 `ConfigForms`：
 *  - `get(entryId)`：单命名空间表单（写走 `remote.settings`，读走共享镜像）；
 *  - `whileServed(namespaces, register)`：命名空间被宿主服务时才注册贡献；
 *  - `describe()`：共享 describe 镜像的读面（本插件用它的 secrets 槽位）。
 */
interface ConfigFormsLike {
  get?(entryId: string): unknown;
  whileServed?(namespaces: readonly string[], register: (served: ReadonlySet<string>) => () => void): () => void;
  describe?(): SettingsMirrorFace | undefined;
}

/**
 * 取共享 describe 镜像面（secret「已配置」状态的唯一来源）。
 * 只认形状、不认版本；取不到时返回 undefined，卡片降级为不显示已配置状态。
 */
function describeFaceOf(forms: ConfigFormsLike | undefined): SettingsMirrorFace | undefined {
  if (forms === undefined || typeof forms.describe !== 'function') return undefined;
  try {
    const face = forms.describe();
    if (face === undefined || typeof face.getSnapshot !== 'function' || typeof face.subscribe !== 'function') return undefined;
    return face;
  } catch {
    return undefined;
  }
}

/** 按字段定义生成官方 spec（secret 走写-only 控件，不在这里）。 */
function specsOf(): SettingsFieldSpec[] {
  return WAKATIME_FIELDS.filter((def) => def.kind !== 'secret').map((def) => {
    if (def.kind === 'boolean') return booleanField(def.key);
    if (def.kind === 'number') return numberField(def.key, def.min, def.max);
    return textField(def.key);
  });
}

/**
 * 宿主包装 `hooks.wkCard` store 后卡片收到的形状（bind 返回值的最小使用面：
 * 官方 controller 模式里插件只额外调 set 做镜像变更的发布）。
 */
interface WkProjectionStore {
  set(projection: WkProjection): void;
}

/**
 * 卡片表单的 controller：官方 SettingsFormModel + 绑定投影 store + 镜像观察。
 *
 * 生命周期对齐官方 web-search 的 WebSearchCardController：apply 时创建、
 * ctx.effect 卸载时 dispose。scope 的变化由 model 内部订阅（scope.subscribe
 * → publish → bind 的 store 更新）；镜像（secret 槽位）的变化不走 model，
 * 由这里补一条订阅手动重发投影。
 */
class WkCardController {
  private readonly model: SettingsFormModel<Record<string, unknown>>;
  private readonly store: WkProjectionStore;
  private readonly mirror: SettingsMirrorFace | undefined;
  private readonly offMirror: (() => void) | undefined;

  constructor(scope: SettingsFormScope<Record<string, unknown>>, mirror: SettingsMirrorFace | undefined) {
    this.mirror = mirror;
    // secret 控件的写通道：同一个命名空间的原子 mutate（线路对 secret 值
    // 脱敏只出不进；受理位即 Host 的 boolean 应答）。
    const secrets = [{
      field: 'api_key',
      write: (text: string) => scope.mutate([{ op: 'set', path: ['api_key'], value: text }]),
    }];
    this.model = new SettingsFormModel(scope, specsOf(), secrets);
    this.store = this.model.bind<WkProjection>(() => this.projection()) as unknown as WkProjectionStore;
    void (async () => {
      // 起读共享镜像（幂等；ensure 缺席时什么都不做）。
      try { await mirror?.ensure?.(); } catch { /* 镜像不可用只影响已配置徽章 */ }
      this.publish();
    })();
    this.offMirror = mirror?.subscribe(() => this.publish());
  }

  /** 当前投影：壳状态 + 每字段草稿状态 + 密钥配置状态。 */
  projection(): WkProjection {
    const fields = {} as Record<WkFieldKey, WkProjection["fields"][WkFieldKey]>;
    for (const def of WAKATIME_FIELDS) fields[def.key] = this.model.field(def.key);
    return {
      shell: this.model.shell(),
      fields,
      configured: secretSlotSet(this.mirror?.getSnapshot(), SETTINGS_NAMESPACE_CANDIDATES, 'api_key'),
    };
  }

  /** 镜像驱动的变更不经过 model，发布要手动补一次。 */
  private publish(): void {
    this.store.set(this.projection());
  }

  /** 槽位注册的 inject 面：hooks（宿主包装成 useWkCard）+ 表单动作 + 表面标记。 */
  inject(surface: 'detail' | 'settings', locale: LocaleFaceLike | undefined): Record<string, unknown> {
    const actions = this.model.actions();
    return {
      hooks: { wkCard: this.store },
      edit: actions.edit,
      resetField: actions.resetField,
      save: () => { void this.model.save(); },
      discard: actions.discard,
      locale,
      surface,
    };
  }

  dispose(): void {
    this.offMirror?.();
    // SettingsForm 卸载时已经过 discard；这里释放 model 对 scope 的订阅。
    this.model.dispose();
  }
}

/** 所需服务：slots 注册、locale 面向文案跟随宿主语言、configForms 表单与镜像。 */
const inject = ['slots', 'locale', 'configForms'];

export function apply(ctx: Context): void {
  const slots = ctx.get('slots');
  // 两个宿主服务缺一不可：slots 无处注册卡片；configForms 是唯一的取数/写数
  // 通道（0.1.7-rc.2 无 configForms 服务时两处静默不注册，与旧行为一致）。
  if (slots === undefined) return;
  const locale = ctx.get('locale') as LocaleFaceLike | undefined;
  const forms = ctx.get('configForms') as ConfigFormsLike | undefined;
  if (forms === undefined || typeof forms.get !== 'function' || typeof forms.whileServed !== 'function') return;

  // 共享 describe 镜像面：api_key「已配置」徽章的唯一数据源；取不到传 undefined。
  const mirror = describeFaceOf(forms);
  const scope = forms.get(ENTRY_ID) as unknown as SettingsFormScope<Record<string, unknown>>;
  const controller = new WkCardController(scope, mirror);
  ctx.effect(() => () => controller.dispose(), `${PLUGIN_ID}: card controller`);

  // 插件详情页配置区：`plugins.bundle.config`，key = 包名（见 BUNDLE_PACKAGE_NAME）。
  ctx.effect(
    () =>
      forms.whileServed!([ENTRY_ID], () =>
        slots.inject('plugins.bundle.config', () =>
          slots.register({
            name: 'plugins.bundle.config',
            key: BUNDLE_PACKAGE_NAME,
            locale: PLUGIN_ID,
            inject: () => controller.inject('detail', locale),
          }, WakaTimeCard),
        ),
      ),
    `${PLUGIN_ID}: plugins-page card`,
  );

  // 设置对话框中的独立设置页：默认不显示，由详情页「在设置中显示」开关控制。
  // localStorage 非响应式：切换开关后需刷新页面才影响注册。
  if (typeof localStorage !== 'undefined' && localStorage.getItem(SHOW_SETTINGS_KEY) === 'true') {
    ctx.effect(
      () =>
        forms.whileServed!([ENTRY_ID], () =>
          slots.inject('settings.section', () =>
            slots.register({
              name: 'settings.section',
              id: SETTINGS_SECTION_ID,
              order: 30,
              label: () => {
                const active = locale === undefined ? 'zh' : locale.getSnapshot().active;
                return active === 'en' ? SECTION_LABELS.en : SECTION_LABELS.zh;
              },
              inject: () => controller.inject('settings', locale),
            }, WakaTimeCard),
          ),
        ),
      `${PLUGIN_ID}: settings-section`,
    );
  }
}

export { inject, name };
