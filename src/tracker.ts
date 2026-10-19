import { WakaTimeHeartbeat, TOOL_CATEGORY_MAP, WRITE_TOOLS, MCP_DEBUGGING_PREFIX, DiffResult } from './types.js';
import { resolveLanguage } from './language.js';
import { resolveProject, resolveBranch, resolveProjectRootCount, resolveDependencies } from './project.js';
import { calculateWriteDiff, calculateEditDiff } from './diff.js';
import type { Session } from '@deepseek-ai/dsh-session';

// DSH session event types (from @deepseek-ai/dsh-session)
// session/event passes the event object with { type, data } wrapper
interface ToolCallEvent {
  type: 'tool/call';
  data: {
    turn: number;
    step: number;
    callId: string;
    name: string;
    arguments: string; // JSON string
  };
}

interface UserMessageEvent {
  type: 'user/message';
  data: {
    /** DSH 0.2.0+ content 是 content blocks 数组；旧版本可能是纯字符串。 */
    content: string | Array<{ type: string; text?: string; [k: string]: unknown }>;
  };
}

/** @deepseek-ai/dsh-llm TokenUsage 的结构子集（避免引入未声明依赖） */
interface TokenUsageLike {
  inputTokens?: number;
  outputTokens?: number;
}

interface AssistantMessageEvent {
  type: 'assistant/message';
  data: {
    turn: number;
    step: number;
    message: {
      content: string;
    };
    usage?: TokenUsageLike;
  };
}

/** FileTracker 需要的配置切片；传入共享的 runtime 配置对象即获得实时更新。 */
export interface TrackerConfig {
  /** 覆盖自动检测的项目名 */
  project_name?: string;
  /** 覆盖自动检测的语言 */
  language?: string;
}

export class FileTracker {
  private session: Session;
  private config: TrackerConfig;
  private pending: Map<string, WakaTimeHeartbeat> = new Map();
  /** 在途的追踪任务：flush 前须等齐，否则迟到的条目会滞留到下一个周期。 */
  private inflight: Set<Promise<void>> = new Set();
  /** 最近一条用户消息的字符数，随下一条 assistant 心跳作为 ai_prompt_length 上报。 */
  private lastPromptLength?: number;

  constructor(session: Session, config: TrackerConfig) {
    this.session = session;
    this.config = config;
  }

  /** 等待所有在途追踪任务落袋（含等待期间新启动的）。 */
  async idle(): Promise<void> {
    while (this.inflight.size > 0) {
      await Promise.allSettled([...this.inflight]);
    }
  }

  trackToolCall(event: ToolCallEvent): Promise<void> {
    return this.tracked(this.trackToolCallInner(event));
  }

  trackUserMessage(event: UserMessageEvent): Promise<void> {
    return this.tracked(this.trackUserMessageInner(event));
  }

  trackAssistantMessage(event: AssistantMessageEvent): Promise<void> {
    return this.tracked(this.trackAssistantMessageInner(event));
  }

  /** 登记在途任务；返回原 promise，拒绝语义与直接调用保持一致。 */
  private tracked(p: Promise<void>): Promise<void> {
    this.inflight.add(p);
    void p.catch(() => {}).finally(() => { this.inflight.delete(p); });
    return p;
  }

  private async trackToolCallInner(event: ToolCallEvent): Promise<void> {
    const { name, arguments: argsJson } = event.data;
    
    // Parse arguments JSON string
    let args: any = {};
    try {
      args = JSON.parse(argsJson || '{}');
    } catch {
      args = {};
    }
    
    const category = this.resolveCategory(name);
    const isWrite = WRITE_TOOLS.has(name);
    const entity = this.extractEntity(name, args);

    if (!entity) return;

    const heartbeat: WakaTimeHeartbeat = {
      entity,
      type: name === 'bash' || name === 'pwsh' ? 'app' : 'file',
      category,
      time: Date.now() / 1000,
      project: await this.resolveProject(),
      project_root_count: await this.resolveProjectRootCount(),
      branch: await this.resolveBranch(),
      language: await this.resolveLanguage(entity, name),
      dependencies: await this.resolveDependencies(),
      is_write: isWrite,
    };

    if (isWrite) {
      const diff = await this.calculateDiff(name, args, entity);
      if (diff) {
        heartbeat.lines = diff.lines;
        heartbeat.line_additions = diff.lineAdditions;
        heartbeat.line_deletions = diff.lineDeletions;
      }
    }

    // Merge with existing heartbeat for same entity within 5 seconds
    const existing = this.pending.get(entity);
    if (existing && (heartbeat.time - existing.time) < 5) {
      Object.assign(existing, heartbeat);
      existing.time = heartbeat.time;
    } else {
      this.pending.set(entity, heartbeat);
    }
  }

  private async trackUserMessageInner(event: UserMessageEvent): Promise<void> {
    // DSH 0.2.0+: content 是 content blocks 数组 [{type:'text', text:'...'}, ...]
    // 旧版本: content 可能是纯字符串
    const raw = event?.data?.content;
    let textLen = 0;
    if (typeof raw === 'string') {
      textLen = raw.length;
    } else if (Array.isArray(raw)) {
      for (const block of raw) {
        if (block?.type === 'text' && typeof block.text === 'string') {
          textLen += block.text.length;
        }
      }
    }
    this.lastPromptLength = textLen > 0 ? textLen : undefined;
    const heartbeat: WakaTimeHeartbeat = {
      entity: `dsh-session-${this.session.id}`,
      type: 'app',
      // 类别一律小写，与 TOOL_CATEGORY_MAP（types.ts）及 WakaTime 其他类别保持一致；
      // WakaTime 服务端负责展示层归一化。
      category: 'communicating',
      time: Date.now() / 1000,
      project: await this.resolveProject(),
      is_write: false,
    };
    this.pending.set(`user-${Date.now()}`, heartbeat);
  }

  private async trackAssistantMessageInner(event: AssistantMessageEvent): Promise<void> {
    const usage = event?.data?.usage;
    const heartbeat: WakaTimeHeartbeat = {
      entity: `dsh-session-${this.session.id}`,
      type: 'app',
      // WakaTime 为 GenAI 活动提供的专用类别，驱动其 AI Coding 面板统计。
      // 小写与 TOOL_CATEGORY_MAP 及其余类别统一（WakaTime 服务端做展示层归一化）。
      category: 'ai coding',
      time: Date.now() / 1000,
      project: await this.resolveProject(),
      is_write: false,
      ai_session: String(this.session.id),
    };
    if (usage && typeof usage.inputTokens === 'number') {
      heartbeat.ai_input_tokens = usage.inputTokens;
    }
    if (usage && typeof usage.outputTokens === 'number') {
      heartbeat.ai_output_tokens = usage.outputTokens;
    }
    if (this.lastPromptLength != null) {
      heartbeat.ai_prompt_length = this.lastPromptLength;
      this.lastPromptLength = undefined;
    }
    this.pending.set(`assistant-${Date.now()}`, heartbeat);
  }

  getPending(): WakaTimeHeartbeat[] {
    return Array.from(this.pending.values());
  }

  clearPending(): void {
    this.pending.clear();
  }

  private resolveCategory(toolName: string): string {
    if (!toolName) return 'coding';
    if (toolName.startsWith(MCP_DEBUGGING_PREFIX)) {
      return 'debugging';
    }
    return TOOL_CATEGORY_MAP[toolName] || 'coding';
  }

  private extractEntity(toolName: string, args: any): string | null {
    if (!args) return null;
    if (toolName === 'bash' || toolName === 'pwsh') {
      return args.command || null;
    }
    if (args.file_path) return args.file_path;
    if (args.path) return args.path;
    if (args.target_file) return args.target_file;
    if (args.entity) return args.entity;
    return null;
  }

  private async resolveProject(): Promise<string> {
    if (this.config.project_name) return this.config.project_name;
    const cwd = this.session.header?.cwd || process.cwd();
    return await resolveProject(cwd);
  }

  private async resolveProjectRootCount(): Promise<number> {
    const cwd = this.session.header?.cwd || process.cwd();
    return await resolveProjectRootCount(cwd);
  }

  private async resolveBranch(): Promise<string> {
    const cwd = this.session.header?.cwd || process.cwd();
    return await resolveBranch(cwd);
  }

  private async resolveLanguage(entity: string, toolName: string): Promise<string> {
    if (this.config.language) return this.config.language;
    if (toolName === 'bash' || toolName === 'pwsh') return 'Shell';
    return resolveLanguage(entity);
  }

  private async resolveDependencies(): Promise<string[]> {
    const cwd = this.session.header?.cwd || process.cwd();
    return await resolveDependencies(cwd);
  }

  private async calculateDiff(toolName: string, args: any, entity: string): Promise<DiffResult | null> {
    if (!args) return null;
    if (toolName === 'write') {
      return calculateWriteDiff(args.content || '');
    }
    if (toolName === 'edit') {
      return calculateEditDiff(args.old_string || '', args.new_string || '');
    }
    return null;
  }
}
