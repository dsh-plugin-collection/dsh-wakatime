import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
// Type-only: bring the ctx.settings Context merge into this program.
import type {} from '@deepseek-ai/dsh-settings';
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings';
// 0.1.7 删除了 SettingsScope；本插件只用 get/watch，故本地声明最小面。
import type { PluginSettingsScope } from './settings-scope.js';

/**
 * Namespace for WebUI settings panel.
 * Not via the official settingsNamespace() helper: it was removed in the DSH 0.1.2
 * kernel, where a runtime import fails module linking outright. The helper only
 * validated and returned its argument, and register() runs the same validation on
 * both kernel generations.
 */
export const WAKATIME_NAMESPACE = 'wakatime' as SettingsNamespace;

/** Settings interface for WebUI configuration */
export interface WakaTimeSettings {
  /** WakaTime API Key (secret field) */
  api_key: string;
  /** API base URL (for self-hosted) */
  api_url: string;
  /** Heartbeat send interval in milliseconds */
  heartbeat_interval_ms: number;
  /** Override auto-detected project name */
  project_name: string;
  /** Override auto-detected language */
  language: string;
  /** Track tool calls */
  include_tool_calls: boolean;
  /** Track user messages */
  include_user_messages: boolean;
  /** Track AI messages */
  include_assistant_messages: boolean;
  /** Cache failed heartbeats */
  cache_heartbeats: boolean;
  /** Max cached heartbeats */
  cache_limit: number;
  /** Enable debug logging */
  debug: boolean;
}

/** Settings schema for WebUI rendering */
export const WakaTimeSettingsSchema: Schema<WakaTimeSettings> = Schema.object({
  api_key: Schema.string().default('').role('secret'),
  api_url: Schema.string().default('https://wakatime.com'),
  heartbeat_interval_ms: Schema.natural().min(60000).max(300000).default(120000),
  project_name: Schema.string().default(''),
  language: Schema.string().default(''),
  include_tool_calls: Schema.boolean().default(true),
  include_user_messages: Schema.boolean().default(false),
  include_assistant_messages: Schema.boolean().default(false),
  cache_heartbeats: Schema.boolean().default(true),
  cache_limit: Schema.natural().min(10).max(1000).default(100),
  debug: Schema.boolean().default(false),
});

/**
 * Register WakaTime settings in the WebUI settings panel.
 * The API Key field is marked as secret for secure display.
 * 
 * @param ctx - Context with settings service injected
 * @param base - Base values from plugin config
 */
export function registerWakaTimeSettings(
  ctx: Context,
  base: Partial<WakaTimeSettings>,
): PluginSettingsScope<WakaTimeSettings> {
  const baseSettings: Partial<WakaTimeSettings> = {
    api_key: base.api_key || '',
    api_url: base.api_url || 'https://wakatime.com',
    heartbeat_interval_ms: base.heartbeat_interval_ms || 120000,
    project_name: base.project_name || '',
    language: base.language || '',
    include_tool_calls: base.include_tool_calls ?? true,
    include_user_messages: base.include_user_messages ?? false,
    include_assistant_messages: base.include_assistant_messages ?? false,
    cache_heartbeats: base.cache_heartbeats ?? true,
    cache_limit: base.cache_limit || 100,
    debug: base.debug ?? false,
  };

  // 0.1.7 删除了整个 `settings.yaml` 体系：`SettingsProvider.register()` 不复存在，
  // `ctx.settings` 变为 `SettingsForms`，命名空间 schema 改由 **profile 声明驱动**。
  // 照旧调用会抛错，但调用方（`index.ts`）有 try/catch，故降级为
  // 「设置页不可用、走静态配置」——心跳追踪本身不受影响（`runtime` 用 baseConfig 初值）。
  //
  // 类型收窄：0.1.5 的 `SettingsProvider` 有 `register`，0.1.7 的 `SettingsForms`
  // 没有，直接用任一侧类型都会让另一侧编译失败，故按本插件所需的最小面本地声明。
  //
  // TODO(0.1.7 配置迁移)：跨插件的架构课题（与 dsh-later 同源），单独排期。
  const provider = ctx.settings as unknown as {
    register?: (
      ns: SettingsNamespace,
      schema: typeof WakaTimeSettingsSchema,
      options: { base: Partial<WakaTimeSettings>; applies: 'live' },
    ) => PluginSettingsScope<WakaTimeSettings>;
  };
  if (typeof provider.register !== 'function') {
    throw new Error(
      'settings namespace registration is unavailable on this kernel generation (no register())',
    );
  }
  return provider.register(WAKATIME_NAMESPACE, WakaTimeSettingsSchema, {
    base: baseSettings,
    applies: 'live',
  });
}

/**
 * Get effective config by merging plugin config with live settings.
 * Live settings from WebUI take precedence over plugin defaults.
 */
export function effectiveConfig(
  plugin: Partial<WakaTimeSettings>,
  live: WakaTimeSettings,
): WakaTimeSettings {
  return {
    api_key: live.api_key || plugin.api_key || '',
    api_url: live.api_url || plugin.api_url || 'https://wakatime.com',
    heartbeat_interval_ms: live.heartbeat_interval_ms || plugin.heartbeat_interval_ms || 120000,
    project_name: live.project_name || plugin.project_name || '',
    language: live.language || plugin.language || '',
    include_tool_calls: live.include_tool_calls ?? plugin.include_tool_calls ?? true,
    include_user_messages: live.include_user_messages ?? plugin.include_user_messages ?? false,
    include_assistant_messages: live.include_assistant_messages ?? plugin.include_assistant_messages ?? false,
    cache_heartbeats: live.cache_heartbeats ?? plugin.cache_heartbeats ?? true,
    cache_limit: live.cache_limit || plugin.cache_limit || 100,
    debug: live.debug ?? plugin.debug ?? false,
  };
}
