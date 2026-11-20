import { WakaTimeHeartbeat, TOOL_CATEGORY_MAP, WRITE_TOOLS, MCP_DEBUGGING_PREFIX, DiffResult, clampEntity, clampField, HEARTBEAT_FIELD_LIMITS } from './types.js';
import { classifyShellCommand } from './category.js';
import { resolveLanguage } from './language.js';
import { resolveProject, resolveBranch, resolveProjectRootCount, resolveDependencies } from './project.js';
import { calculateWriteDiff, calculateEditDiff } from './diff.js';
import { currentUserAgent } from './user-agent.js';
import type { Session } from '@deepseek-ai/dsh-session';

// DSH session event types (from @deepseek-ai/dsh-session)
// session/event passes the event object with { type, data } wrapper
interface ToolCallEvent {
  type: 'tool/call';
  /**
   * 事件自身的 epoch 毫秒时间戳（`SessionEvent.time`，宿主在 append 时写入）。
   * 追踪用的时间必须取它，而不是处理时的 Date.now()：异步派发/队列积压会让
   * 处理时刻晚于发生时刻，用后者会把心跳推到错误的时段上。
   */
  time?: number;
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
  /** 见 {@link ToolCallEvent.time}。 */
  time?: number;
  data: {
    /** DSH 0.2.0+ content 是 content blocks 数组；旧版本可能是纯字符串。 */
    content: string | Array<{ type: string; text?: string; [k: string]: unknown }>;
  };
}

/**
 * @deepseek-ai/dsh-llm TokenUsage 的结构子集（避免引入未声明依赖）。
 *
 * 分量是**互斥**的（见宿主 `dsh-llm/lib/types/types.d.ts` 的 TokenUsage 注释）：
 * `inputTokens` 只是「未命中的输入」，缓存命中单独记在 `cacheReadTokens` /
 * `cacheWriteTokens`，计费输入 = 三者之和。只读 `inputTokens` 会系统性低估，
 * 而长上下文会话里缓存命中占绝大多数（实测某会话 cacheRead 占 98%+）。
 */
interface TokenUsageLike {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

interface AssistantMessageEvent {
  type: 'assistant/message';
  /** 见 {@link ToolCallEvent.time}。 */
  time?: number;
  data: {
    turn: number;
    step: number;
    message: {
      content: string;
      /**
       * 消息来源。宿主 `dsh-llm` 的 `ModelMessageSource` 形状为
       * `{ kind: 'model', provider, model }`——模型 id 就在这里。WakaTime 没有
       * `ai_model` 心跳字段，Models 面板靠解析 UA 里的模型 token 得到归属，
       * 归一化见 `user-agent.ts` 的 aiModelToken。
       */
      source?: {
        kind?: string;
        provider?: string;
        model?: string;
      };
    };
    usage?: TokenUsageLike;
  };
}

/** shell 类心跳缺省的 app entity（设置留空时回退到这里）。 */
export const DEFAULT_APP_ENTITY = 'Terminal';

/** FileTracker 需要的配置切片；传入共享的 runtime 配置对象即获得实时更新。 */
export interface TrackerConfig {
  /** 覆盖自动检测的项目名 */
  project_name?: string;
  /** 覆盖自动检测的语言 */
  language?: string;
  /**
   * shell 心跳（`type: 'app'`）的 entity —— 应用名。
   * 空白/未设置时回退 {@link DEFAULT_APP_ENTITY}：entity 空串会被服务端逐条 400
   * 拒收，而把整条命令原文当 entity 又不符合 app 类型的语义（见 index.ts 的 app_entity）。
   */
  app_entity?: string;
}

export class FileTracker {
  private session: Session;
  private config: TrackerConfig;
  private pending: Map<string, WakaTimeHeartbeat> = new Map();
  /** 在途的追踪任务：flush 前须等齐，否则迟到的条目会滞留到下一个周期。 */
  private inflight: Set<Promise<void>> = new Set();
  /** 最近一条用户消息的字符数，随下一条 assistant 心跳作为 ai_prompt_length 上报。 */
  private lastPromptLength?: number;
  /**
   * 最近一次模型调用所用的模型 id（`message.source.model`），用于 UA 里的模型 token。
   *
   * 为什么缓存而不是每条去读：user message / tool call 心跳也需要 UA，而那些事件
   * 不携带模型身份；缓存最近一次即可近似「当前会话正在用的模型」。模型切换后
   * 下一条 assistant 心跳即更新。
   */
  private lastModelId?: string;

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
    
    const category = this.resolveCategory(name, name === 'bash' || name === 'pwsh' ? String(args.command ?? '') : undefined);
    const isWrite = WRITE_TOOLS.has(name);
    const entity = this.extractEntity(name, args);

    if (!entity) return;

    // 字符串字段逐个进服务端实测上限：超长会被逐条 400 拒掉，而批量接口外层
    // 仍是 202 —— 看不见也不重试；空串同样违规（校验是 "between 1 and N"），
    // 所以宁可不发这个字段，让 WakaTime 自己推断，也不要拖垮整条心跳。
    const project = clampField(await this.resolveProject(), HEARTBEAT_FIELD_LIMITS.project);
    const branch = clampField(await this.resolveBranch(), HEARTBEAT_FIELD_LIMITS.branch);
    const language = clampField(await this.resolveLanguage(entity, name), HEARTBEAT_FIELD_LIMITS.language);
    const dependencies = (await this.resolveDependencies())
      .map(dep => clampField(dep, HEARTBEAT_FIELD_LIMITS.dependency))
      .filter(dep => dep !== '');

    const heartbeat: WakaTimeHeartbeat = {
      entity,
      type: name === 'bash' || name === 'pwsh' ? 'app' : 'file',
      category,
      time: this.eventTime(event),
      project_root_count: await this.resolveProjectRootCount(),
      is_write: isWrite,
    };
    if (project) heartbeat.project = project;
    if (branch) heartbeat.branch = branch;
    if (language) heartbeat.language = language;
    if (dependencies.length > 0) heartbeat.dependencies = dependencies;

    if (isWrite) {
      const diff = await this.calculateDiff(name, args, entity);
      if (diff) {
        heartbeat.lines = diff.lines;
        // 官方字段是 `ai_line_changes`（GenAI 增删的行数），不是自造的
        // `line_additions` / `line_deletions`——后者在官方心跳结构里不存在，
        // 服务端直接忽略，WakaTime 的 AI 行数统计因此一直是空的。
        heartbeat.ai_line_changes = diff.lineAdditions + diff.lineDeletions;
      }
    }

    // 同 entity + 同 category 在 5 秒窗口内合并成一条（与 WakaTime 服务端的
    // 去重窗口一致）。缓冲键必须带上 category：shell 心跳现在共用同一个 entity
    // （应用名），若只按 entity 作键，5 秒内先后跑的 `pnpm test` 与 `ls` 会互相
    // 覆盖，最后只剩后一条的类别——一次跑测试的痕迹会被一条浏览抹掉。
    this.enqueue(heartbeat);
  }

  /**
   * 入队（含 5 秒去重窗口），并在此处统一贴 `user_agent`。
   *
   * 为什么集中打戳：三类心跳（write 工具、用户消息、assistant 消息）都有自己的
   * 构造点，逐个贴容易漏一个；而 `user_agent` 必须**每条**都带——WakaTime 的
   * Editors / Operating Systems / Models 三个面板都从它解析。
   */
  private enqueue(heartbeat: WakaTimeHeartbeat): void {
    heartbeat.user_agent = currentUserAgent(this.lastModelId);
    const pendingKey = `${heartbeat.entity}\u0000${heartbeat.category ?? ''}`;
    const existing = this.pending.get(pendingKey);
    if (existing && (heartbeat.time - existing.time) < 5) {
      Object.assign(existing, heartbeat);
      existing.time = heartbeat.time;
    } else {
      this.pending.set(pendingKey, heartbeat);
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
    const time = this.eventTime(event);
    const project = await this.legalProject();
    const heartbeat: WakaTimeHeartbeat = {
      // 会话类心跳有意保留 `dsh-session-<id>` 作为 entity，不套用 app_entity：
      // 它的基数由会话数决定（有界、且是唯一能按会话下钻的维度），不像命令原文
      // 那样每次都产生新实体。要按会话聚合 AI 数据也有 ai_session 字段承载。
      entity: clampEntity(`dsh-session-${this.session.id}`),
      type: 'app',
      // 类别一律小写，与 TOOL_CATEGORY_MAP（types.ts）及 WakaTime 其他类别保持一致；
      // WakaTime 服务端负责展示层归一化。
      category: 'communicating',
      time,
      is_write: false,
    };
    if (project !== undefined) heartbeat.project = project;
    this.enqueue(heartbeat);
  }

  private async trackAssistantMessageInner(event: AssistantMessageEvent): Promise<void> {
    // 模型身份先记下：user message / tool call 心跳不携带模型，靠这个缓存近似
    // 「当前会话正在用的模型」；切换模型后下一条 assistant 心跳即更新。
    const modelId = event?.data?.message?.source?.model;
    if (typeof modelId === 'string' && modelId !== '') this.lastModelId = modelId;
    const usage = event?.data?.usage;
    const time = this.eventTime(event);
    const project = await this.legalProject();
    const heartbeat: WakaTimeHeartbeat = {
      entity: clampEntity(`dsh-session-${this.session.id}`),
      type: 'app',
      // WakaTime 为 GenAI 活动提供的专用类别，驱动其 AI Coding 面板统计。
      // 小写与 TOOL_CATEGORY_MAP 及其余类别统一（WakaTime 服务端做展示层归一化）。
      category: 'ai coding',
      time,
      is_write: false,
      ai_session: String(this.session.id),
    };
    if (project !== undefined) heartbeat.project = project;
    if (usage && typeof usage.inputTokens === 'number') {
      heartbeat.ai_input_tokens = usage.inputTokens;
    }
    if (usage && typeof usage.outputTokens === 'number') {
      heartbeat.ai_output_tokens = usage.outputTokens;
    }
    // 缓存命中单独上报：宿主的三个输入分量互斥，只发未命中那一个会把长上下文
    // 会话的用量低估两个数量级。注意这里只映射 cacheRead：cacheWrite 是「写入缓存」
    // 的那部分输入，WakaTime 没有对应字段，硬塞进 cached 会让两种量纲混在一起。
    if (usage && typeof usage.cacheReadTokens === 'number' && usage.cacheReadTokens > 0) {
      heartbeat.ai_cached_input_tokens = usage.cacheReadTokens;
    }
    if (this.lastPromptLength != null) {
      heartbeat.ai_prompt_length = this.lastPromptLength;
      this.lastPromptLength = undefined;
    }
    this.enqueue(heartbeat);
  }

  getPending(): WakaTimeHeartbeat[] {
    return Array.from(this.pending.values());
  }

  clearPending(): void {
    this.pending.clear();
  }

  private resolveCategory(toolName: string, shellCommand?: string): string {
    if (!toolName) return 'coding';
    if (toolName.startsWith(MCP_DEBUGGING_PREFIX)) {
      return 'debugging';
    }
    // shell 的类别由命令本身决定：一律记 building 会把 ls/grep 这类文件检视
    // 算成构建时间（实测占账号里 shell 心跳的 45%，真构建只占 0.5%）。
    // 类别取值域见 src/category.ts 顶部——只用 WakaTime 权威集合里的词。
    if (toolName === 'bash' || toolName === 'pwsh') {
      return classifyShellCommand(shellCommand ?? '');
    }
    return TOOL_CATEGORY_MAP[toolName] || 'coding';
  }

  private extractEntity(toolName: string, args: any): string | null {
    if (!args) return null;
    if (toolName === 'bash' || toolName === 'pwsh') {
      // 没有命令就不产生心跳；有命令时 entity 用「应用名」而非命令原文。
      // 依据：wakatime-cli 的 entity 类型定义里 AppType 注释是 "represents an app
      // entity"——app 的 entity 该是应用。此前塞整行命令等于声称「存在一个叫这串
      // 命令的应用」：实测 5281 条 shell 心跳散成 5158 个不同 entity（98.2% 只出现
      // 一次），既没有聚合价值，又随时可能撞 entity 的 2083 字符硬校验被逐条 400。
      // 命令在干什么改由 category 体现（见 category.ts）。
      if (!args.command) return null;
      return this.appEntity();
    }
    if (args.file_path) return clampEntity(String(args.file_path));
    if (args.path) return clampEntity(String(args.path));
    if (args.target_file) return clampEntity(String(args.target_file));
    if (args.entity) return clampEntity(String(args.entity));
    return null;
  }

  /**
   * shell 心跳的 entity：设置里的应用名。
   *
   * @returns 裁剪进 entity 上限后的应用名；设置为空白/未设置时回退
   *   {@link DEFAULT_APP_ENTITY}——entity 空串会被服务端逐条 400 拒收。
   */
  private appEntity(): string {
    return clampField(this.config.app_entity, HEARTBEAT_FIELD_LIMITS.entity) || DEFAULT_APP_ENTITY;
  }

  /**
   * 心跳时间（epoch 秒）。
   *
   * 优先取事件自带的时间戳：追踪是 fire-and-forget，事件从产生到被这里处理
   * 之间可能隔着队列积压与 git/依赖探测的 await，用 Date.now() 会把活动记到
   * 错误的时刻上（WakaTime 的时长是按相邻心跳间隔算的，时刻漂移直接污染统计）。
   * 宿主未提供 `time`（旧版本/测试构造的事件）时才退回处理时刻。
   *
   * @param event - 任意携带可选 `time`（epoch 毫秒）的会话事件。
   * @returns epoch 秒。
   */
  private eventTime(event: { time?: number }): number {
    return typeof event?.time === 'number' && event.time > 0 ? event.time / 1000 : Date.now() / 1000;
  }

  private async resolveProject(): Promise<string> {
    if (this.config.project_name) return this.config.project_name;
    const cwd = this.session.header?.cwd || process.cwd();
    return await resolveProject(cwd);
  }

  /**
   * 取一个可直接上报的项目名。
   *
   * @returns 裁剪进 project 字段上限的项目名；解析结果为空串时返回
   *   `undefined`——空串会被服务端逐条 400（"between 1 and 1024"），
   *   而不发这个字段则交给 WakaTime 自己推断。
   */
  private async legalProject(): Promise<string | undefined> {
    const project = clampField(await this.resolveProject(), HEARTBEAT_FIELD_LIMITS.project);
    return project === '' ? undefined : project;
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
