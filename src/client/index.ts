/**
 * dsh-wakatime client 端：注册 WakaTime 设置卡片到 WebUI Settings → Plugins 面板。
 *
 * 编译说明：本文件以单文件 CommonJS 打包进 __ModuleLoader__.load，
 * 运行时零依赖（react 从宿主运行时解析）。
 * @module dsh-wakatime/client
 */

import type {} from '@deepseek-ai/dsh-client-runtime';
import type { Context } from '@deepseek-ai/cordis';
import type { ScopeLike, SettingsMirrorFace } from './mirror.ts';
import { WakaTimeCard } from './settings-card.tsx';

/** settings 命名空间（与 host 端一致）。 */
const SETTINGS_NAMESPACE = 'wakatime';

/** 插件名（与 manifest id 一致）。 */
const name = 'dsh-wakatime';

/** 所需服务：无（settings 卡片通过 ctx.get 可选读取，不声明为必需）。 */
const inject: string[] = [];

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
  if (slots === undefined || settingsScopeForCard === undefined) return;

  slots.inject('settings.plugin.item', () => slots.register({
    name: 'settings.plugin.item',
    key: SETTINGS_NAMESPACE,
    order: 30,
    inject: () => ({
      scope: settingsScopeForCard.bind({ namespace: SETTINGS_NAMESPACE }),
      mirror: settingsScopeForCard.describe(),
    }),
  }, WakaTimeCard));
}
