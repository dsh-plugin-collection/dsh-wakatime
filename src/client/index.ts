/**
 * dsh-wakatime client 端：注册 WakaTime 设置卡片到 WebUI Settings → Plugins 面板。
 *
 * 编译说明：本文件以单文件 CommonJS 打包进 __ModuleLoader__.load，
 * 运行时零依赖（react 从宿主运行时解析）。
 *
 * 文案语言：卡片经 useWkT 跟随宿主 DSH 界面语言（locale 服务，zh/en）。
 * locale 在模块级 inject 数组声明、apply 内可选读取：服务在位时向卡片
 * 传递 locale face；缺失时传 undefined，卡片回退中文（v1 行为）。
 * @module dsh-wakatime/client
 */

import type {} from '@deepseek-ai/dsh-client-runtime';
import type { Context } from '@deepseek-ai/cordis';
import type { ScopeLike, SettingsMirrorFace } from './mirror.ts';
import { WakaTimeCard } from './settings-card.tsx';
import type { LocaleFaceLike } from './useWkT.ts';

/** settings 命名空间（与 host 端一致）。 */
const SETTINGS_NAMESPACE = 'wakatime';

/** 插件名（与 manifest id 一致）。 */
const name = 'dsh-wakatime';

/** 所需服务：locale 面向卡片文案跟随宿主语言（缺失时卡片回退中文）。 */
const inject: string[] = ['locale'];

/**
 * 宿主 settingsScope 服务所需的最小结构视图：bind 出命名空间 scope，
 * describe() 给出共享 describe 镜像面（secret 槽位状态的唯一可见来源——
 * settings 线路对 role('secret') 字段全程脱敏）。
 */
interface SettingsScopeBinderLike {
  bind(spec: { namespace: string }): ScopeLike;
  describe(): SettingsMirrorFace;
}

export function apply(ctx: Context): void {
  // 设置卡片：独立读取 slots/settingsScope（可选服务，缺失时不阻塞）。
  const slots = ctx.get('slots');
  const settingsScopeForCard = ctx.get('settingsScope') as unknown as
    | SettingsScopeBinderLike
    | undefined;
  // 宿主 locale 服务（结构化子集读取；缺失时 undefined，卡片回退中文）。
  const locale = ctx.get('locale') as unknown as LocaleFaceLike | undefined;
  if (slots === undefined || settingsScopeForCard === undefined) return;

  slots.inject('settings.plugin.item', () => slots.register({
    name: 'settings.plugin.item',
    key: SETTINGS_NAMESPACE,
    order: 30,
    inject: () => ({
      scope: settingsScopeForCard.bind({ namespace: SETTINGS_NAMESPACE }),
      mirror: settingsScopeForCard.describe(),
      locale,
    }),
  }, WakaTimeCard));
}

export { inject, name };
