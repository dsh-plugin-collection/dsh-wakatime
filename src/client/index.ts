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
 * 0.1.7 兼容性：`settingsScope` 服务已随 settings.yaml 体系移除。取数改为
 * `remote.settings`（cordis reflect 把嵌套属性读拼成 `remote.settings` 子服务名）。
 * 槽位名改为 `settings.section`（`settings.plugin.item` 在 0.1.7/0.2.0 不存在）。
 * @module dsh-wakatime/client
 */

import type {} from '@deepseek-ai/dsh-client-runtime';
import type { Context } from '@deepseek-ai/cordis';
import { WakaTimeCard } from './settings-card.tsx';
import type { LocaleFaceLike } from './useWkT.ts';

/**
 * 0.2.0 设置命名空间 = profile 条目 id（非插件名）。
 * 按序取 describe() 中首个存在的命名空间，避免硬编码与 profile 解耦。
 */
const SETTINGS_NAMESPACE_CANDIDATES = ['dsh-wakatime', 'wakatime'];

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
 */
interface RemoteLike {
  readonly settings?: {
    describe(): Promise<unknown>;
    mutate(ns: string, ops: ReadonlyArray<{ op: string; path: ReadonlyArray<string>; value: unknown }>, expectedRevision: number): Promise<unknown>;
  };
  $on?(event: string, listener: () => void): () => void;
}

/** `remote.settings` 适配出的 scope 快照信封（卡片按此形状读取）。 */
interface ScopeSnapshot {
  status: 'loading' | 'ready' | 'unavailable';
  value: Record<string, unknown>;
  base?: Record<string, unknown>;
  user?: Record<string, unknown>;
  writable: boolean;
}

/** 卡片用的 scope 最小面（getSnapshot / subscribe / set / unset）。 */
interface ScopeLike {
  getSnapshot(): ScopeSnapshot;
  subscribe(listener: () => void): () => void;
  set(field: string, value: unknown): Promise<void>;
  unset(field: string): Promise<void>;
}

/** 取 `remote` 服务（读 `remote.settings` 用）。 */
const remoteOf = (ctx: Context): RemoteLike | undefined => ctx.get('remote') as RemoteLike | undefined;

/**
 * 把 `remote.settings` 适配成设置卡片要用的 scope 最小面。
 *
 * 这是 0.1.7 的替代品：旧 `settingsScope.bind({namespace})` 返回的对象直接给卡片。
 * 形状以卡片的实际调用为准（settings-card.tsx）：
 *  - getSnapshot：返回 ScopeSnapshot 信封（status / value / writable），引用稳定；
 *  - subscribe：内核转发 `settings/document-updated` 事件即通知（回调不传参，
 *    调用方重读快照）；
 *  - set / unset：经 `mutate` 写字段，返回 Promise 供卡片 `await`。
 */
function remoteSettingsScope(remote: RemoteLike, candidates: string[]): ScopeLike {
  const nsList = Array.isArray(candidates) ? candidates : [candidates];
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

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.push(listener);
      return () => {
        const i = listeners.indexOf(listener);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    set: (key, next) => {
      const svc = remote.settings;
      if (svc === undefined || activeNs === undefined) return Promise.resolve();
      const expected = revision < 0 ? 0 : revision;
      return svc.mutate(activeNs, [{ op: 'set', path: [key], value: next }], expected)
        .then(() => { readValue(); })
        .catch(() => { /* 写入失败：宿主随后推来的事件会带回真值 */ });
    },
    unset: (key) => {
      const svc = remote.settings;
      if (svc === undefined || activeNs === undefined) return Promise.resolve();
      const expected = revision < 0 ? 0 : revision;
      return svc.mutate(activeNs, [{ op: 'unset', path: [key] }], expected)
        .then(() => { readValue(); })
        .catch(() => { /* 同上 */ });
    },
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
  if (slots === undefined || remoteForCard?.settings === undefined) return;
  const locale = ctx.get('locale') as LocaleFaceLike | undefined;

  // scope 只建一次并挂在注册表上（生命周期由槽位 disposer 负责）。
  const cardScope = remoteSettingsScope(remoteForCard, SETTINGS_NAMESPACE_CANDIDATES);
  const disposeSection = slots.inject('settings.section', () => slots.register({
    name: 'settings.section',
    id: SETTINGS_SECTION_ID,
    order: 30,
    label: () => {
      const active = locale === undefined ? 'zh' : locale.getSnapshot().active;
      return active === 'en' ? SECTION_LABELS.en : SECTION_LABELS.zh;
    },
    inject: () => ({ scope: cardScope, locale }),
  }, WakaTimeCard));
  if (typeof disposeSection === 'function') {
    ctx.effect(() => () => {
      disposeSection();
      cardScope.dispose();
    });
  }

  // 插件详情页卡片（0.1.7+ / 0.2.0+）：configForms 表单 + `plugins.bundle.config` 卡片。
  // 寻址键是条目 id（`cordis.patch.yml` 的 `id: dsh-wakatime`），不是 settings namespace。
  const ENTRY_ID = 'dsh-wakatime';
  const forms = ctx.get('configForms') as any;
  if (forms !== undefined && typeof forms.get === 'function' && typeof forms.whileServed === 'function') {
    const formScope = forms.get(ENTRY_ID);
    ctx.effect(
      () =>
        forms.whileServed([ENTRY_ID], () =>
          slots.inject('plugins.bundle.config', () =>
            slots.register({
              name: 'plugins.bundle.config',
              key: SETTINGS_NAMESPACE_CANDIDATES[0],
              locale: 'dsh-wakatime',
              inject: () => ({ scope: formScope, locale }),
            }, WakaTimeCard),
          ),
        ),
      'dsh-wakatime: plugins-page card',
    );
  }
}

export { inject, name };
