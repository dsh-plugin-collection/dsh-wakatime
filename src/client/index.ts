/**
 * dsh-wakatime client 端：注册 WakaTime 设置卡片到 WebUI 设置面板。
 *
 * 编译说明：本文件以单文件 CommonJS 打包进 __ModuleLoader__.load，
 * 运行时零依赖（react 从宿主运行时解析）。
 *
 * 文案语言：卡片经 useWkT 跟随宿主 DSH 界面语言（locale 服务，zh/en）。
 * locale 在模块级 inject 数组声明、apply 内可选读取：服务在位时向卡片
 * 传递 locale face；缺失时传 undefined，卡片回退中文（v1 行为）。
 *
 * secret「已配置」状态：卡片经 `mirror` prop 读共享 describe 镜像的 secrets 槽位，
 * 来源是 `ctx.get('configForms').describe()`（宿主 ConfigForms 的
 * SettingsDescribeFace，见 dsh-client-ui-settings/lib/types/client/config-form.d.ts）。
 * `configForms` 已在顶层 inject 数组声明——**新增服务读取必须同步写进该数组**，否则
 * 宿主 dynamicCordisContext 会抛 `cannot get property … without inject`，整个 client
 * fiber 失败。取不到 describe 面时传 undefined：卡片照旧注册，只是不显示已配置状态。
 *
 * 0.1.7 兼容性：`settingsScope` 服务已随 settings.yaml 体系移除。取数改为
 * `remote.settings`（cordis reflect 把嵌套属性读拼成 `remote.settings` 子服务名）。
 * 槽位名改为 `settings.section`（`settings.plugin.item` 在 0.1.7/0.2.0 不存在）。
 *
 * TODO（本版刻意未做）：
 *  - 卡片组件级测试（保存流程两条判定的渲染断言）：本仓库 vitest 是 node 环境、
 *    无 jsdom，也没有 react 依赖，这一版只测 mirror.ts 的纯函数。
 * @module dsh-wakatime/client
 */

import type {} from '@deepseek-ai/dsh-client-runtime';
import type { Context } from '@deepseek-ai/cordis';
import { WakaTimeCard } from './settings-card.tsx';
import type { LocaleFaceLike } from './useWkT.ts';
import type { SettingsMirrorFace } from './mirror.ts';
// SETTINGS_NAMESPACE_CANDIDATES：0.2.x 起 settings 命名空间 = profile 条目 id
// （`dsh-wakatime`），旧 settings.yaml 时代才是 section 名（`wakatime`）。适配器取数
// 与卡片查 secret 行都用它，两处共用 mirror.ts 里同一份常量，避免各写一份、
// 改一处漏一处（只认一个名字时，另一个体系里镜像接上了也查不到行）。
import { SETTINGS_NAMESPACE_CANDIDATES, writeAccepted } from './mirror.ts';

/** 插件名（与 manifest id 一致）。 */
const name = 'dsh-wakatime';

/** 设置页导航文案（与 dsh-suggest-ghost 同模式：thunk 随语言切换重读）。 */
const SECTION_LABELS: Record<string, string> = {
  zh: 'WakaTime',
  en: 'WakaTime',
};

/** 设置 section 的自有 id（宿主没有的 id 才会并排新增一页）。 */
const SETTINGS_SECTION_ID = 'dsh-wakatime';

/**
 * 插件 profile 条目 id（与 `cordis.patch.yml` 的 `id: dsh-wakatime` 一致）。
 * 详情页卡片的寻址键是条目 id，不是 settings 命名空间，故与
 * SETTINGS_NAMESPACE_CANDIDATES 分开声明。
 */
const ENTRY_ID = 'dsh-wakatime';

/**
 * `plugins.bundle.config` 槽位的 key —— **必须是插件包名**（`package.json` 的
 * `name`），不是 settings 命名空间、也不是条目 id。
 *
 * 宿主侧三处证据（0.2.0-rc.2）：
 *  - 槽位契约 `dsh-client-ui-plugin-manager/lib/types/client/slot-contract.d.ts`
 *    原文：*"A bundle's own configuration, keyed by the bundle's **package name**"*；
 *  - `PluginManagerPage` 渲染时以 `renderSlot('plugins.bundle.config',
 *    { view: 'page' }, { entryKey: pkg.name })` 派发 —— 查的就是包名；
 *  - `configured` 为假时整段配置区直接不渲染（`configured ? <section…> : null`），
 *    且 `configured` 取自 `ledger.bundles.has(pkg.name)`（`bundles:
 *    keysOf('plugins.bundle.config')`）—— key 不匹配即 `configured=false`
 *    → **卡片静默不渲染**，没有任何报错可循。
 *
 * 故这里固定用包名常量，**不要**改回 `SETTINGS_NAMESPACE_CANDIDATES[0]` /
 * `ENTRY_ID` 之类的数组下标或别名：本插件三者当前恰好都是 `dsh-wakatime`，
 * 一旦命名空间候选顺序调整或条目 id 改名，取值就会悄悄漂移、卡片无声消失。
 * （参考实现 dsh-suggest-ghost 的包名 `dsh-suggest-ghost` 与其条目 id
 * `suggest-ghost` 不同，正是靠「包名硬编码 + 条目 id 只用于
 * `configForms.get()`」区分这两套域。）
 */
const BUNDLE_PACKAGE_NAME = 'dsh-wakatime';

/**
 * 一条路径写操作。与宿主 `SettingsPathOpView`（dsh-settings/lib/types/
 * types.d.ts）同形：`set` 携带值、`unset` 只带路径——`unset` 不能带 `value`
 * 键，否则宿主侧 union 判定会多收一个 undefined 字段。
 */
type WriteOp = { op: 'set'; path: string[]; value: unknown } | { op: 'unset'; path: string[] };

/**
 * 宿主 `remote` 服务的最小结构视图（读 `remote.settings` 用）。
 *
 * **必须走 `ctx.get('remote')`，不能读 `ctx.remote` 属性。** 0.1.7 的 client runner
 * 用 `dynamicCordisContext` 把插件 ctx 换成严格门控 Proxy：任何非动词属性读取都走
 * `readService(prop, true)`，未在插件 `inject` 里声明就抛
 * `cannot get property "remote" without inject`，整个 client fiber 失败。
 *
 * 且 `inject` 里**必须同时声明 `remote.settings`**：cordis reflect 读嵌套属性时把键
 * 拼成 `remote.settings` 这个独立子服务名，未声明即抛
 * `cannot get property "remote.settings" without inject`。
 *
 * `mutate` 的应答是 `RemoteResult<SettingsNamespaceView>` 信封（`{ok,value|error}`），
 * **不是** ConfigForm 那种 boolean——受理位从 `.ok` 取，见 `settleWrite`。
 */
interface RemoteLike {
  readonly settings?: {
    describe(): Promise<unknown>;
    mutate(ns: string, ops: ReadonlyArray<WriteOp>, expectedRevision: number): Promise<unknown>;
  };
  $on?(event: string, listener: () => void): () => void;
}

/**
 * `configForms` 服务（`ctx.get('configForms')`）的最小视图。宿主实现见
 * dsh-client-ui-settings/lib/types/client/config-form.d.ts 的 `ConfigForms`：
 *  - `get(entryId)`：单命名空间表单（写走 `remote.settings`，读走共享镜像）；
 *  - `whileServed(namespaces, register)`：命名空间被宿主服务时才注册贡献；
 *  - `describe()`：**共享 describe 镜像的读面**，注释写明给"跨命名空间面"用
 *    （schema introspection / served-namespace directory）。本插件要 secret
 *    槽位的 `{ path, set }` 状态，用的就是这个面——`get(ns).getSnapshot()`
 *    只有单命名空间的 value/base/user，对 secret 一样是脱敏的，看不到槽位。
 */
interface ConfigFormsLike {
  get?(entryId: string): unknown;
  whileServed?(namespaces: readonly string[], register: (served: ReadonlySet<string>) => () => void): () => void;
  describe?(): SettingsMirrorFace | undefined;
}

/**
 * 取共享 describe 镜像面（secret「已配置」状态的唯一来源）。
 *
 * 只认形状、不认版本：`configForms` 缺席、没有 `describe`、或返回的对象没有
 * `getSnapshot` 时一律返回 undefined，卡片保持现有降级（照旧注册、只是不显示
 * 已配置状态），不抛错也不静默卡死。
 */
function describeFaceOf(forms: ConfigFormsLike | undefined): SettingsMirrorFace | undefined {
  if (forms === undefined || typeof forms.describe !== 'function') return undefined;
  try {
    const face = forms.describe();
    if (face === undefined || typeof face.getSnapshot !== 'function' || typeof face.subscribe !== 'function') return undefined;
    return face;
  } catch {
    // describe 在宿主侧理论上不会抛；抛了也只是没有镜像状态，不影响卡片注册。
    return undefined;
  }
}

/** 取 `remote` 服务（读 `remote.settings` 用）。 */
const remoteOf = (ctx: Context): RemoteLike | undefined => ctx.get('remote') as RemoteLike | undefined;

/**
 * 裸线写应答 → 受理布尔，并把应答里的新视图折回共享镜像。
 *
 * **只服务于走裸线 `remote.settings.mutate` 的适配器**。宿主
 * `ConfigForms.get(entryId)` 返回的 ConfigForm 已经做过这层映射
 * （`mutate` 内部 `if (!response.ok) return false` 然后 `acceptView` 返回 true），
 * 拿到的就是 boolean，不要再对它取 `.ok`。
 *
 * 裸线应答是 `RemoteResult<SettingsNamespaceView>`（`{ok:true,value}` /
 * `{ok:false,error}`），不是 boolean，故经 `writeAccepted` 取布尔本体；受理成功
 * 时把 `value` 折回镜像（宿主 ConfigFormController 同款做法），否则「已配置」徽章
 * 要等宿主推 `settings/document-updated` 才翻转。
 */
function settleWrite(result: unknown, mirror: SettingsMirrorFace | undefined): boolean {
  const accepted = writeAccepted(result);
  if (accepted && mirror !== undefined && typeof mirror.acceptView === 'function') {
    const view = (result as { value?: unknown } | undefined)?.value;
    if (view !== undefined && view !== null) {
      try { mirror.acceptView(view); } catch { /* 折叠失败不影响受理结果，镜像会被下一次刷新纠正 */ }
    }
  }
  return accepted;
}

/** 适配出的 scope 快照信封（卡片按此形状读取）。 */
interface ScopeSnapshot {
  status: 'loading' | 'ready' | 'unavailable';
  value: Record<string, unknown>;
  base?: Record<string, unknown>;
  user?: Record<string, unknown>;
  writable: boolean;
}

/**
 * 卡片用的 scope 最小面（getSnapshot / subscribe / set / unset）。
 *
 * `set / unset` 返回 **Host 是否受理这次写入**：宿主 `ConfigForm` 自 0.2.0 起
 * 就是 `Promise<boolean>`（拒绝不抛异常），本插件此前声明成 `Promise<void>`
 * 并在适配器里 `.then(() => readValue()).catch(() => {})` 把结果吞掉了——
 * 与宿主版本无关，是本地接线丢弃了信号。类型改对之后，卡片的保存流程才拿得
 * 到「未受理」这个成因，与既有的「回读未落地」判定并存。
 */
interface ScopeLike {
  getSnapshot(): ScopeSnapshot;
  subscribe(listener: () => void): () => void;
  set(field: string, value: unknown): Promise<boolean>;
  unset(field: string): Promise<boolean>;
  dispose(): void;
}

/**
 * 把 `remote.settings` 适配成设置卡片要用的 scope 最小面。
 *
 * 这是 0.1.7 的替代品：旧 `settingsScope.bind({namespace})` 返回的对象直接给卡片。
 * 形状以卡片的实际调用为准（settings-card.tsx）：
 *  - getSnapshot：返回 ScopeSnapshot 信封（status / value / writable），引用稳定；
 *  - subscribe：内核转发 `settings/document-updated` 事件即通知（回调不传参，
 *    调用方重读快照）；
 *  - set / unset：经 `mutate` 写字段，**返回 Host 的受理结果**（boolean）供卡片判定。
 * @param mirror - 共享 describe 镜像面（可缺席）：写入受理成功后把应答视图折回
 *   镜像，让 secret「已配置」徽章同刻翻转，不必等宿主推事件。
 */
function remoteSettingsScope(remote: RemoteLike, candidates: string | readonly string[], mirror?: SettingsMirrorFace): ScopeLike {
  const nsList: readonly string[] = typeof candidates === 'string' ? [candidates] : candidates;
  let snapshot: ScopeSnapshot = { status: 'loading', value: {}, writable: false };
  let revision = -1;
  let activeNs: string | undefined;
  const listeners: Array<() => void> = [];
  let disposed = false;

  const notify = (): void => {
    for (const listener of [...listeners]) {
      try { listener(); } catch { /* 单个订阅者抛错不牵连其余 */ }
    }
  };

  const readValue = (): void => {
    void (async () => {
      if (disposed) return;
      try {
        const described = await remote.settings?.describe();
        // describe() 的返回可能被包一层（不同宿主版本形状不同），取出文档本体。
        const doc = (described as any)?.value ?? (described as any)?.data ?? described;
        const rows = (doc?.namespaces ?? []) as ReadonlyArray<{ ns: string; value?: Record<string, unknown>; revision?: number }>;
        // 按优先级取首个存在的命名空间
        let entry: { ns: string; value?: Record<string, unknown>; revision?: number } | undefined;
        let ns: string | undefined;
        for (const candidate of nsList) {
          const found = rows.find((row) => row.ns === candidate);
          if (found !== undefined) {
            entry = found;
            ns = candidate;
            break;
          }
        }
        if (entry === undefined) {
          snapshot = { status: 'unavailable', value: {}, writable: false };
          notify();
          return;
        }
        activeNs = ns;
        const rev = typeof entry.revision === 'number' ? entry.revision : 0;
        if (rev === revision) return;
        revision = rev;
        const v = (entry.value ?? {}) as Record<string, unknown>;
        snapshot = {
          status: 'ready',
          value: v,
          // value/base/user 三层：secret 字段全程脱敏，普通字段以 user 层为准。
          // describe() 返回的 value 是组合层；base/user 需要从 describe 的完整响应里取。
          // 为简化，这里把 value 同时赋给 base 和 user（卡片对普通字段以 user 为准）。
          base: v,
          user: v,
          writable: doc?.writable !== false,
        };
        notify();
      } catch {
        // 后端未就绪时保留现值，等下一个事件或调用方重试。
      }
    })();
  };

  // 启动即读一次（卡片 mount 时就能拿到真值，不必等首个事件）。
  readValue();
  // 此后由内核转发的设置变更事件驱动——无轮询。
  const offUpdated = remote.$on?.('settings/document-updated', () => readValue());

  /**
   * 提交一批路径写，返回 **Host 是否受理**。
   *
   * 关键修正：不再吞掉结果。此前这里是
   * `.then(() => { readValue(); }).catch(() => {})`——set/unset 永远 resolve 成
   * undefined，卡片无从区分「Host 明确拒绝」与「受理了但回读尚未刷出」，
   * 只能靠回读间接发现；而宿主拒绝时**根本不抛异常**，catch 那条路永远不走。
   *
   * 两条写入路径的判定入口不同，别混用（详见 settleWrite 的注释）：
   *  - 本函数（设置页卡片，裸线 `remote.settings.mutate`）：应答是
   *    `RemoteResult` 信封 → 用 `writeAccepted` 从 `.ok` 取受理位；
   *  - 详情页卡片（`configForms.get(entryId)` 的宿主 ConfigForm）：**已经是 boolean**，
   *    由宿主自己完成 `ok → boolean` 的映射，卡片直接判 `=== false`。
   *
   * readValue() 两种结局都要跑，语义等同宿主的 `recover()`（config-form.js:1171
   * 在 `!response.ok` 时 `await this.mirror.load()`）：拒绝往往源于 revision 栅栏
   * 过期，回读把新值和**新 revision** 取回来，下一次写才不会再被同因拒绝；
   * 同时 Host 可能其实已落盘、只是应答没回到本端。
   */
  const send = (ops: readonly WriteOp[]): Promise<boolean> => {
    const svc = remote.settings;
    // 还没有可用命名空间（describe 未命中候选）＝无处可写：明确报未受理，
    // 不再像过去那样 resolve 成 undefined 让卡片以为"写过了"。
    if (svc === undefined || activeNs === undefined) return Promise.resolve(false);
    const expected = revision < 0 ? 0 : revision;
    return svc.mutate(activeNs, ops, expected)
      .then((result) => {
        const accepted = settleWrite(result, mirror);
        readValue();
        if (!accepted && mirror !== undefined && typeof mirror.ensure === 'function') {
          // 拒绝对文档无改动，镜像本身不脏；这里只 best-effort 推一把处于 idle
          // 的镜像重新起读（共享面刻意不暴露 load()，故只能到此为止，其余交给
          // 宿主推来的 settings/document-updated 事件）。不 await、不抛。
          void Promise.resolve(mirror.ensure()).catch(() => {});
        }
        return accepted;
      })
      .catch(() => {
        // 传输/装配层异常（超时、方法未挂载）：按未受理处理，同时仍回读一次。
        readValue();
        return false;
      });
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.push(listener);
      return () => {
        const i = listeners.indexOf(listener);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    set: (key, next) => send([{ op: 'set', path: [key], value: next }]),
    unset: (key) => send([{ op: 'unset', path: [key] }]),
    dispose: () => {
      disposed = true;
      offUpdated?.();
      listeners.length = 0;
    },
  };
}

/** 所需服务：locale 面向卡片文案跟随宿主语言（缺失时卡片回退中文）。 */
const inject = ['remote', 'remote.settings', 'slots', 'locale', 'configForms'];

export function apply(ctx: Context): void {
  const slots = ctx.get('slots');
  const remoteForCard = remoteOf(ctx);
  // 两个宿主服务各有独立职责：`slots` 缺任一卡片都无处注册；`remote.settings`
  // 只决定设置页能否取数，缺席时仍要注册插件详情页卡片（见下）。
  if (slots === undefined) return;
  const locale = ctx.get('locale') as LocaleFaceLike | undefined;

  // 插件详情页卡片（0.1.7+ / 0.2.0+）：configForms 表单 + `plugins.bundle.config` 卡片。
  // 两个域要分清：`configForms.get()` 用**条目 id**（`cordis.patch.yml` 的
  // `id: dsh-wakatime`）；`plugins.bundle.config` 的 key 用**插件包名**（见 BUNDLE_PACKAGE_NAME）。
  // `configForms` 已在顶层 inject 数组里声明（dynamicCordisContext 会拦未声明的
  // 服务读取）；命名空间是否真被宿主服务仍由 `forms.whileServed` 决定。
  // 必须在提前返回之前注册，否则 remote.settings 缺失时卡片不会显示。
  const forms = ctx.get('configForms') as ConfigFormsLike | undefined;
  // 共享 describe 镜像面：卡片上 api_key「已配置」徽章的唯一数据源。
  // 此前两处注入面都只给了 { scope, locale, surface }，mirror prop 声明了却
  // 从未传过 → `secretSlotSet(mirror?.getSnapshot(), …)` 恒为 undefined → false，
  // 指示灯永远不亮（这条与宿主版本无关，是接线遗漏）。
  // 取不到时（无 configForms / 无 describe / 形状不符）传 undefined，卡片照旧
  // 注册、只是不显示已配置状态。
  const mirror = describeFaceOf(forms);
  if (forms !== undefined && typeof forms.get === 'function' && typeof forms.whileServed === 'function') {
    const formScope = forms.get(ENTRY_ID) as unknown as ScopeLike;
    ctx.effect(
      () =>
        forms.whileServed([ENTRY_ID], () =>
          slots.inject('plugins.bundle.config', () =>
            slots.register({
              name: 'plugins.bundle.config',
              key: BUNDLE_PACKAGE_NAME,
              locale: 'dsh-wakatime',
              inject: () => ({ scope: formScope, locale, surface: 'detail' as const, mirror }),
            }, WakaTimeCard),
          ),
        ),
      'dsh-wakatime: plugins-page card',
    );
  }

  // 设置对话框中的设置页：默认不显示，由插件详情页的开关控制。
  // 开关状态存储在 localStorage 中，key 为 'dsh-wakatime:show-settings-section'。
  if (remoteForCard?.settings === undefined) return;

  const SHOW_SETTINGS_KEY = 'dsh-wakatime:show-settings-section';
  const showSettingsSection = typeof localStorage !== 'undefined' && localStorage.getItem(SHOW_SETTINGS_KEY) === 'true';

  if (!showSettingsSection) return;

  // scope 只建一次并挂在注册表上（生命周期由槽位 disposer 负责）。
  // 这条路径写走裸线 `remote.settings.mutate`，故把同一个镜像面交给适配器：
  // 受理成功后由它把写应答折回镜像（见 remoteSettingsScope 的 send）。
  const cardScope = remoteSettingsScope(remoteForCard, SETTINGS_NAMESPACE_CANDIDATES, mirror);
  const disposeSection = slots.inject('settings.section', () => slots.register({
    name: 'settings.section',
    id: SETTINGS_SECTION_ID,
    order: 30,
    label: () => {
      const active = locale === undefined ? 'zh' : locale.getSnapshot().active;
      return active === 'en' ? SECTION_LABELS.en : SECTION_LABELS.zh;
    },
    inject: () => ({ scope: cardScope, locale, surface: 'settings' as const, mirror }),
  }, WakaTimeCard));
  if (typeof disposeSection === 'function') {
    ctx.effect(() => () => {
      disposeSection();
      cardScope.dispose();
    });
  }
}

export { inject, name };
