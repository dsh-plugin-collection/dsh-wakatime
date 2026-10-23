/**
 * WakaTime heartbeat payload
 */
export interface WakaTimeHeartbeat {
  entity: string;
  type: 'file' | 'domain' | 'app';
  category?: string;
  time: number;
  project?: string;
  project_root_count?: number;
  branch?: string;
  language?: string;
  dependencies?: string[];
  lines?: number;
  line_additions?: number;
  line_deletions?: number;
  is_write?: boolean;
  /** GenAI 指标（WakaTime 心跳可选字段）：本次会话 id */
  ai_session?: string;
  /** 距上一心跳消耗的输入 token */
  ai_input_tokens?: number;
  /** 距上一心跳消耗的输出 token */
  ai_output_tokens?: number;
  /** 距上一心跳的用户提示字符数 */
  ai_prompt_length?: number;
}

/**
 * Diff calculation result
 */
export interface DiffResult {
  lines: number;
  lineAdditions: number;
  lineDeletions: number;
}

/**
 * WakaTime API error
 */
export class WakaTimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WakaTimeError';
  }
}

/**
 * WakaTime authentication error
 */
export class WakaTimeAuthError extends WakaTimeError {
  constructor(message: string) {
    super(message);
    this.name = 'WakaTimeAuthError';
  }
}

/**
 * WakaTime rate limit error
 */
export class WakaTimeRateLimitError extends WakaTimeError {
  constructor(message: string) {
    super(message);
    this.name = 'WakaTimeRateLimitError';
  }
}

/**
 * DSH tool name to WakaTime category mapping
 * 严格遵循 PRD 3.2 映射表
 */
export const TOOL_CATEGORY_MAP: Record<string, string> = {
  write: 'coding',
  edit: 'coding',
  read: 'browsing',
  bash: 'building',
  pwsh: 'building',
  grep: 'browsing',
  glob: 'browsing',
  web_search: 'researching',
  mcp__codegraph__codegraph_explore: 'code reviewing',
  subagent: 'coding',
  subagent_fork: 'coding',
  workflow: 'coding',
  todo_write: 'coding',
  ask_user_question: 'communicating',
  skill: 'learning',
};

/**
 * MCP tools that map to debugging category
 */
export const MCP_DEBUGGING_PREFIX = 'mcp__langfuse__';

/**
 * Tools that are considered write operations
 */
export const WRITE_TOOLS = new Set(['write', 'edit']);

/**
 * File extension to language mapping
 */
export const EXTENSION_LANGUAGE_MAP: Record<string, string> = {
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript',
  '.py': 'Python',
  '.go': 'Go',
  '.rs': 'Rust',
  '.java': 'Java',
  '.kt': 'Kotlin',
  '.swift': 'Swift',
  '.cpp': 'C++',
  '.cc': 'C++',
  '.cxx': 'C++',
  '.c': 'C',
  '.h': 'C/C++',
  '.rb': 'Ruby',
  '.php': 'PHP',
  '.scala': 'Scala',
  '.html': 'HTML',
  '.css': 'CSS',
  '.scss': 'SCSS',
  '.sass': 'SCSS',
  '.json': 'JSON',
  '.yaml': 'YAML',
  '.yml': 'YAML',
  '.toml': 'TOML',
  '.md': 'Markdown',
  '.sh': 'Shell',
  '.sql': 'SQL',
};

/**
 * Maximum file size for diff calculation (lines)
 */
export const MAX_DIFF_LINES = 10000;

/**
 * WakaTime 对心跳各字符串字段的长度上限。
 *
 * 全部是线上对 `/users/current/heartbeats.bulk` 逐条实测得到（不是文档值）：
 * 超限或空串的条目会拿到逐条 400，而批量接口外层仍是 HTTP 202 —— 不裁剪就是
 * 看不见、也不会重试的静默丢数据。
 * - entity：`Field must be between 1 and 2083 characters long.`
 * - project / branch：`Field must be between 1 and 1024 characters long.`
 * - language / dependency：未触发过报错，按同档 1024 保守裁剪。
 *
 * 「between 1 and N」意味着**空串同样被拒**，所以这些字段要么给合法值、
 * 要么整个不发（见 tracker 的写入处），不能图省事传 ''。
 */
export const HEARTBEAT_FIELD_LIMITS = {
  entity: 2083,
  project: 1024,
  branch: 1024,
  language: 1024,
  dependency: 1024,
} as const;

/**
 * 把任意来源的值裁剪进某个字段的长度上限。
 *
 * @param value - 原始值（非字符串一律视为「没给」）。
 * @param max - 该字段上限，取自 {@link HEARTBEAT_FIELD_LIMITS}。
 * @returns 去首尾空白后的值；超限时保留前缀并以 `...` 结尾，总长不超过 max；
 *   空白或非字符串输入返回空串——调用方据此决定「不发这个字段」。
 */
export function clampField(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (trimmed === '') return '';
  if (trimmed.length <= max) return trimmed;
  // 预留 3 字符给省略号，保证结果恰好落在上限内。
  return trimmed.slice(0, max - 3) + '...';
}

/**
 * 把任意字符串裁剪成合法的 WakaTime entity。
 *
 * @param value - 原始 entity 候选。
 * @returns 裁剪后的 entity；空白输入返回空串（空 entity 会被服务端 400 拒绝，
 *   调用方必须丢弃这条心跳）。
 */
export function clampEntity(value: string): string {
  return clampField(value, HEARTBEAT_FIELD_LIMITS.entity);
}
