/**
 * WakaTime 设置卡片微文案字典（双语：跟随宿主 DSH 的 locale 设置）。
 *
 * 语言解析：`useWkT(locale)` 读取宿主 locale 服务的 active id（zh/en），
 * 从这里取对应字典；locale 服务缺失或 id 未收录时回退中文（v1 默认语言）。
 * 字段定义（WAKATIME_FIELDS）只存 key/形态/分组 id，label/hint 一律经
 * `t.fields[key]` 解析，保证 zh/en 键集一致（由 en 的映射类型强制）。
 * @module dsh-wakatime/client/strings
 */

export type WkLocaleId = 'zh' | 'en';

/** 设置卡片的分组 id（FIELDS.section 取值；显示文案在字典的 sections 表）。 */
export type WkSectionId = 'api' | 'tracking' | 'cacheDebug' | 'display';

const zh = {
  /** 分组标题 */
  sections: {
    api: 'API',
    tracking: '追踪',
    cacheDebug: '缓存与调试',
    display: '显示设置',
  },
  /** 字段 label / hint（key 与 settings 命名空间字段一致） */
  fields: {
    api_key: { label: 'API Key', hint: 'WakaTime 密钥；留空时回退环境变量与 ~/.wakatime.cfg' },
    api_url: { label: 'API URL', hint: '自托管端点；留空使用官方 wakatime.com' },
    heartbeat_interval_ms: { label: '心跳间隔（毫秒）', hint: '60000–300000；批量发送的节拍' },
    include_tool_calls: { label: '追踪工具调用', hint: '记录文件读写、命令执行等工具调用' },
    include_user_messages: { label: '追踪用户消息', hint: '记录用户消息（增加心跳量）' },
    include_assistant_messages: { label: '追踪 AI 消息', hint: '记录 AI 回复（增加心跳量）' },
    project_name: { label: '项目名称', hint: '覆盖自动检测的项目名' },
    language: { label: '语言', hint: '覆盖自动检测的语言' },
    cache_heartbeats: { label: '缓存失败心跳', hint: '网络失败时落盘，恢复后重发' },
    cache_limit: { label: '缓存上限', hint: '10–1000；最多缓存的条数' },
    debug: { label: '调试模式', hint: '输出详细日志到 DSH 控制台' },
  },
  /** 固定 chrome 文案 */
  overridden: '已覆盖',
  reset: '重置',
  configured: '已配置',
  notConfigured: '未配置',
  readOnlyNote: '当前部署不可写（内存模式）',
  saveFailed: '保存未落地，请检查后重试',
  discard: '放弃修改',
  save: '保存',
  saving: '保存中…',
  /** 「在设置中显示」开关文案（仅详情页显示） */
  showInSettings: '在设置中显示',
  showInSettingsHint: '在设置对话框中显示本插件的设置页（刷新页面后生效）',
  /** 帮助按钮 aria-label 模板（{field} 占位符） */
  helpAriaLabel: '{field}说明',
  /** 数值越界校验（{min}/{max} 占位符） */
  invalidRange: '需为 {min}–{max} 的整数',
} as const;

const en: { [K in keyof typeof zh]: string } = {
  sections: {
    api: 'API',
    tracking: 'Tracking',
    cacheDebug: 'Cache & Debug',
    display: 'Display',
  },
  fields: {
    api_key: { label: 'API Key', hint: 'WakaTime API key; falls back to env vars and ~/.wakatime.cfg when empty' },
    api_url: { label: 'API URL', hint: 'Self-hosted endpoint; leave empty for official wakatime.com' },
    heartbeat_interval_ms: { label: 'Heartbeat interval (ms)', hint: '60000–300000; cadence for batched sends' },
    include_tool_calls: { label: 'Track tool calls', hint: 'Log tool calls such as file reads/writes and command execution' },
    include_user_messages: { label: 'Track user messages', hint: 'Log user messages (increases heartbeat volume)' },
    include_assistant_messages: { label: 'Track AI messages', hint: 'Log AI replies (increases heartbeat volume)' },
    project_name: { label: 'Project name', hint: 'Override the auto-detected project name' },
    language: { label: 'Language', hint: 'Override the auto-detected language' },
    cache_heartbeats: { label: 'Cache failed heartbeats', hint: 'Persist on network failure and resend after recovery' },
    cache_limit: { label: 'Cache limit', hint: '10–1000; maximum number of cached entries' },
    debug: { label: 'Debug mode', hint: 'Log verbose output to the DSH console' },
  },
  overridden: 'Overridden',
  reset: 'Reset',
  configured: 'Configured',
  notConfigured: 'Not configured',
  readOnlyNote: 'Read-only on this deployment (in-memory mode)',
  saveFailed: 'Save did not land; check and retry',
  discard: 'Discard changes',
  save: 'Save',
  saving: 'Saving…',
  showInSettings: 'Show in settings',
  showInSettingsHint: 'Show this plugin\'s settings page in the settings dialog (refresh to take effect)',
  helpAriaLabel: '{field} help',
  invalidRange: 'Must be an integer between {min} and {max}',
};

/** 单语言文案字典类型（宽化为 string，zh/en 通用）。 */
export type WkStrings = { [K in keyof typeof zh]: string };

/** 字段 key 联合（WAKATIME_FIELDS.key 的合法取值）。 */
export type WkFieldKey = keyof typeof zh.fields;

/** 全部 locale 字典（键集一致，由 en 的映射类型保证）。 */
export const wkDicts: Record<WkLocaleId, WkStrings> = { zh, en };

/** 归一化 locale id：处理 zh-CN/zh-Hans 等变体。 */
export function normalizeLocale(localeId: string | undefined): WkLocaleId {
  if (localeId === 'en') return 'en';
  if (localeId?.startsWith('zh')) return 'zh';
  return 'zh';
}

/** 按 locale id 取字典；未收录 id 回退中文。 */
export function dictFor(localeId: string | undefined): WkStrings {
  return wkDicts[normalizeLocale(localeId)];
}

/** 把 {min}/{max} 类占位符替换为参数。 */
export function format(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) =>
    key in params ? String(params[key]) : `{${key}}`,
  );
}
