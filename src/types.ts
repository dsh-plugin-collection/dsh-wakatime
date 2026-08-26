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
