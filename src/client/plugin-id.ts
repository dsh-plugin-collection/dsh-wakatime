/**
 * 客户端插件身份的唯一来源。
 *
 * 打包时由 build.mjs 通过 esbuild `define` 注入 `package.json` 的 `name`；
 * 非打包环境（vitest 直接 import 源码）没有注入，回退到字面量。
 *
 * 为什么必须单一来源：client 侧有一组**互相必须相等**的标识——
 * client-modules 的工厂注册 id（`__ModuleLoader__.load({ id })`）、
 * `plugins.bundle.config` 槽位 key（= 包名）、`configForms.get()` 的条目 id、
 * settings 命名空间（= 条目 id）。11-16 改名时只改了 host 与 manifest，
 * 这一组留在旧名 `dsh-wakatime`，结果 web boot 以新包名加载 bundle、
 * 工厂却注册旧 id，invalidate 按包名清不掉旧工厂 → 二次执行报
 * `duplicate factory registration` → 整个 client entry 不激活。
 * 注入包名后这组标识不可能再各自漂移。
 *
 * @module dsh-wakatime/client/plugin-id
 */

declare const __WAKATIME_PLUGIN_ID__: string | undefined;

/** 插件包名 = client 工厂 id = 槽位 key = 条目 id = settings 命名空间。 */
export const PLUGIN_ID: string =
  typeof __WAKATIME_PLUGIN_ID__ === 'string' && __WAKATIME_PLUGIN_ID__ !== ''
    ? __WAKATIME_PLUGIN_ID__
    : 'dsh-wakatime';

/**
 * 「在设置中显示」开关的 localStorage 键。
 *
 * **故意保留旧名**：它只是浏览器私有存储键，不是宿主契约；改名会把用户已保存的
 * 开关偏好重置回默认。详情页开关与设置页注册读同一个键，故集中在此。
 */
export const SHOW_SETTINGS_KEY = 'dsh-wakatime:show-settings-section';
