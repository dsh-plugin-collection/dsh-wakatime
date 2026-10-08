/**
 * `@deepseek-ai/dsh-settings` 的跨代类型面。
 *
 * ## 为什么需要它
 *
 * 内核 **0.1.7 删除了 `SettingsScope`**（连带整个 `settings.yaml` 体系）：
 *
 * | 符号 | 0.1.5 | 0.1.7 |
 * |---|---|---|
 * | `SettingsNamespace` | ✅ | ✅ |
 * | `SettingsScope` | ✅ | ❌ 已删除 |
 * | `SettingsProvider`（`ctx.settings`） | ✅ `register()` | 改为 `SettingsForms`（无 `register`） |
 *
 * 本插件的设置注册走 `ctx.settings.register(...)`，用 `SettingsScope<T>` 声明其返回值。
 * 直接 import 该类型在 0.1.7 下**编译失败**；而它是 `import type`，运行时会擦除，
 * 所以**运行时不会崩** —— 宿主侧 `ctx.settings.register` 不存在，被 `index.ts` 的
 * `try/catch` 捕获，降级为「设置页不可用、走静态配置」（runtime 用 `baseConfig` 初值，
 * 心跳追踪本身不受影响）。
 *
 * ## 处置
 *
 * 本地声明本插件**实际用到的最小面**（`get` / `watch`），不 import 上游类型：
 * 两代内核都能编译，且 0.1.7 下运行时的降级路径由 `index.ts` 的 `try/catch` 承担。
 *
 * 只声明用到的成员而非照抄上游，是为了让「一旦开始使用 `update`/`replace`」
 * 暴露为类型错误 —— 那两个成员在当前两代都没有可依赖的替代路径。
 *
 * TODO(0.1.7 配置迁移)：内核改为 **profile 声明式配置**（payload 由 profile 提供，
 * 不再由插件注册）。届时本文件的 `register` 侧类型需整体替换为读取
 * `SettingsDescriptor` 的形态。这是跨插件的架构课题。
 *
 * @module dsh-wakatime/settings-scope
 */

/**
 * 设置命名空间 owner scope —— 本插件用到的最小面。
 *
 * 与 0.1.5 `SettingsScope<T>` 的对应关系：
 * - `get()`：schema 默认 → `base` → 用户层，按序解析后的当前值（语义一致）
 * - `watch(cb)`：提交后以 (next, prev) 触发；返回 disposer（语义一致）
 */
export interface PluginSettingsScope<T> {
  /** 当前解析值：schema 默认 → `base` → 用户层。 */
  get(): T;
  /**
   * 观察该命名空间已提交的变更。
   * @param callback - 每次提交后以 (next, prev) 调用。
   * @returns 移除该观察者的 disposer。
   */
  watch(callback: (next: T, prev: T) => void | Promise<void>): () => void;
}
