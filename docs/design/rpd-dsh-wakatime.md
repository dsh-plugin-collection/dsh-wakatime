# PRD：DSH WakaTime 编码时间追踪插件

---

## 1. 文档信息

| 项目 | 内容 |
|---|---|
| **产品代号** | dsh-wakatime |
| **目标版本** | v1.0.0 |
| **作者** | 待定 |
| **状态** | 草案 |
| **最后更新** | 2026-08-20 |

---

## 2. 背景与目标

### 2.1 问题描述

DSH（DeepSeek Harness）作为新兴 AI 编程平台，用户与 agent 的协作活动无法被 WakaTime 追踪。WakaTime 作为开发者最广泛使用的时间追踪服务（支持 VS Code、JetBrains、Vim 等数十种编辑器），目前没有任何 DSH 对接方案。

| 现有方案 | 平台 | 追踪 DSH 活动 | 外部同步 |
|---|---|---|---|
| WakaTime 编辑器插件 | VS Code / Vim / JetBrains 等 | ❌ 只监听编辑器事件 | ✅ wakatime.com |
| dsh-codetime | DSH | ✅ | ✅ codetime.dev（竞品） |
| dsh-timesheet | DSH | ❌ 仅本地报表 | ❌ |
| dsh-worktime-board | DSH | ❌ 仅本地统计 | ❌ |

**核心空白**：DSH 用户无法把 AI 辅助编程时间同步到 WakaTime 仪表盘。

### 2.2 产品目标

> 为 DSH 实现完整的 WakaTime 心跳上报，让 AI 辅助编程活动像普通编码一样精确地出现在 WakaTime 仪表盘中。追踪粒度：**文件级**（具体到 agent 操作的每个文件），而非 session 级。

### 2.3 核心用户场景

| 场景 | 说明 |
|---|---|
| **场景 1：日常编码统计** | 用户在 DSH 中与 agent 协作编程，所有文件操作自动同步到 WakaTime |
| **场景 2：项目时间分配** | 用户查看 WakaTime 仪表盘，了解在各项目上花了多少时间（含 AI 协作） |
| **场景 3：语言分布** | 用户查看各编程语言的时间占比（含 AI 辅助编码） |
| **场景 4：分支时间** | 用户查看在各 Git 分支上的时间投入 |
| **场景 5：AI 编码占比** | 通过 `ai coding` 分类区分"纯手写编码"和"AI 辅助编码" |
| **场景 6：团队时间汇总** | 团队管理者通过 WakaTime 团队视图，了解成员在 DSH 中的活跃时间 |
| **场景 7：目标达成** | 设定每日编码目标，WakaTime 自动追踪 DSH 中的活动是否达标 |
| **场景 8：周报回顾** | WakaTime 自动发送周报，包含 DSH 中的编码活动 |

### 2.4 成功指标

| 指标 | 目标 |
|---|---|
| 安装量 | 上线 30 天内 200+ 安装 |
| 心跳成功率 | > 98%（网络正常时） |
| 用户配置成本 | < 2 分钟（拿到 API Key → 配置 → 看到数据） |
| 数据延迟 | < 5 分钟（从活动发生到 WakaTime 仪表盘可见） |
| 文件级追踪覆盖率 | > 95% 的工具调用被正确追踪 |

---

## 3. 功能需求

### 3.1 心跳字段完整映射

WakaTime 心跳支持 13 个字段，本插件全部利用（光标位置除外）：

| WakaTime 字段 | 类型 | 必填 | 插件填充方式 |
|---|---|---|---|
| `entity` | string | ✅ | 文件路径或 session ID |
| `type` | string enum | ✅ | `file`（固定） |
| `category` | string enum | ❌ | 根据工具类型推断（见 3.2） |
| `time` | float | ✅ | Unix 时间戳（毫秒精度） |
| `project` | string | ❌ | 从 `.git` 或 `package.json` 推断 |
| `project_root_count` | integer | ❌ | 计算 `.git` 到工作区根目录的深度 |
| `branch` | string | ❌ | `git branch --show-current` |
| `language` | string | ❌ | 从文件扩展名推断 |
| `dependencies` | string[] | ❌ | 从 `package.json`/`requirements.txt` 推断 |
| `lines` | integer | ❌ | 文件总行数 |
| `line_additions` | integer | ❌ | write/edit 后新增行数 |
| `line_deletions` | integer | ❌ | write/edit 后删除行数 |
| `lineno` | integer | ❌ | 不适用（DSH 无光标） |
| `cursorpos` | integer | ❌ | 不适用（DSH 无光标） |
| `is_write` | boolean | ❌ | write/edit → true, read → false |

### 3.2 DSH 工具 → WakaTime category 映射

DSH 的每种工具调用映射到 WakaTime 的活动分类：

| DSH 工具名 | WakaTime category | `is_write` | 说明 |
|---|---|---|---|
| `write` | `coding` | `true` | AI 写入新文件 |
| `edit` | `coding` | `true` | AI 编辑现有文件 |
| `read` | `browsing` | `false` | AI 读取文件 |
| `bash` | `building` | `false` | AI 执行命令 |
| `pwsh` | `building` | `false` | AI 执行 PowerShell |
| `grep` | `browsing` | `false` | AI 搜索代码 |
| `glob` | `browsing` | `false` | AI 搜索文件 |
| `web_search` | `researching` | `false` | AI 搜索网络 |
| `mcp__codegraph__codegraph_explore` | `code reviewing` | `false` | AI 探索代码图谱 |
| `mcp__langfuse__*` | `debugging` | `false` | AI 查询可观测性 |
| `subagent` / `subagent_fork` | `coding` | `false` | AI 委托子 agent |
| `workflow` | `coding` | `false` | AI 执行工作流 |
| `todo_write` | `coding` | `false` | AI 更新任务列表 |
| `ask_user_question` | `communicating` | `false` | AI 询问用户 |
| `skill` | `learning` | `false` | AI 加载技能 |
| `其他` | `coding` | `false` | 默认分类 |

### 3.3 心跳载荷示例

**场景：AI 编辑了 main.ts 文件**

```json
{
  "entity": "/home/user/workspace/my-project/src/main.ts",
  "type": "file",
  "category": "coding",
  "time": 1724150400.500,
  "project": "my-project",
  "project_root_count": 3,
  "branch": "main",
  "language": "TypeScript",
  "dependencies": ["express", "react"],
  "lines": 245,
  "line_additions": 12,
  "line_deletions": 3,
  "is_write": true
}
```

**场景：AI 执行了 bash 命令**

```json
{
  "entity": "npm run build",
  "type": "app",
  "category": "building",
  "time": 1724150401.000,
  "project": "my-project",
  "language": "Shell",
  "is_write": false
}
```

**场景：AI 读取了配置文件**

```json
{
  "entity": "/home/user/workspace/my-project/package.json",
  "type": "file",
  "category": "browsing",
  "time": 1724150402.000,
  "project": "my-project",
  "language": "JSON",
  "is_write": false
}
```

### 3.4 心跳合并与批量发送策略

**问题**：一个回合可能包含多次工具调用（read → edit → bash），每次都发心跳太频繁。

**策略**：

```
┌─────────────────────────────────────────────────────────────┐
│                    心跳合并策略                               │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  1. 同一文件 5 秒内的多次操作 → 合并为最新一条               │
│     (read + edit + read → 保留 edit，更新 time 为最后一次)    │
│                                                             │
│  2. 批量发送条件（任一触发即发送）：                          │
│     a. 心跳数量 ≥ 25 条（WakaTime 上限）                     │
│     b. agent 进入 idle 状态                                  │
│     c. 定时器触发（默认 120 秒）                             │
│                                                             │
│  3. 网络失败 → 本地缓存（最多 100 条），下次成功时补发        │
│                                                             │
│  4. 进程退出 → 发送剩余心跳（graceful shutdown）              │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 3.5 文件行级统计计算

对于 `write` 和 `edit` 操作：

| 字段 | 计算方式 |
|---|---|
| `lines` | 操作完成后文件的总行数（`wc -l` 或 read 文件后 count） |
| `line_additions` | diff 统计的新增行数 |
| `line_deletions` | diff 统计的删除行数 |

**实现方式**：
1. `write`：操作前读取文件（如果存在）→ 操作后读取文件 → 计算 diff
2. `edit`：`old_string` vs `new_string` 的行数差
3. 如果文件是新建的 → `line_additions = lines`，`line_deletions = 0`

### 3.6 项目推断逻辑

```
优先级从高到低：

1. 用户手动配置 project_name（最高优先级）
2. 从 .git 目录推断
   a. git remote get-url --push origin → 提取项目名
   b. 无 remote → git rev-parse --show-toplevel → 取目录名
3. 从 package.json 推断
   a. 有 name 字段 → 使用 name
4. 使用当前工作区目录名
```

### 3.7 分支推断逻辑

```
1. git branch --show-current → 获取当前分支
2. 如果失败 → 使用 "unknown"
```

### 3.8 语言推断逻辑

```
从文件扩展名映射：

.ts / .tsx → TypeScript
.js / .jsx → JavaScript
.py → Python
.go → Go
.rs → Rust
.java → Java
.kt → Kotlin
.swift → Swift
.cpp / .cc / .cxx → C++
.c → C
.h → C/C++
.rb → Ruby
.php → PHP
.scala → Scala
.html → HTML
.css → CSS
.scss / .sass → SCSS
.json → JSON
.yaml / .yml → YAML
.toml → TOML
.md → Markdown
.sh → Shell
.sql → SQL
```

### 3.9 依赖推断逻辑

```
从项目依赖文件推断：

1. package.json → dependencies + devDependencies 的 key 列表
2. requirements.txt → 所有包名
3. go.mod → require 行的包名
4. Cargo.toml → dependencies 的 key 列表
5. pom.xml → <dependency> 的 artifactId
```

### 3.10 心跳本地缓存

**场景**：网络中断时，心跳发送失败

**策略**：
1. 发送失败 → 写入本地缓存文件（`~/.dsh/wakatime/heartbeat-cache.jsonl`）
2. 网络恢复 → 读取缓存文件，批量发送
3. 发送成功 → 删除已发送的缓存条目
4. 缓存上限：100 条，超出时丢弃最早的

### 3.11 配置项

| 配置键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `api_key` | string | `""` | WakaTime API Key（必填） |
| `api_url` | string | `https://wakatime.com` | API 基地址（用于自托管） |
| `heartbeat_interval_ms` | number | `120000` | 心跳发送间隔（毫秒，60000–300000） |
| `project_name` | string | `""` | 手动覆盖项目名（空则自动推断） |
| `language` | string | `""` | 手动覆盖语言（空则自动推断） |
| `include_tool_calls` | boolean | `true` | 是否追踪工具调用 |
| `include_user_messages` | boolean | `false` | 是否追踪用户输入（低价值，默认关） |
| `include_assistant_messages` | boolean | `false` | 是否追踪 AI 回复（低价值，默认关） |
| `cache_heartbeats` | boolean | `true` | 是否本地缓存心跳（网络失败时） |
| `cache_limit` | number | `100` | 本地缓存上限（条数） |
| `debug` | boolean | `false` | 是否输出调试日志 |

### 3.12 配置来源优先级

```
1. cordis.patch.yml 中的 config 块（最高优先级）
2. 环境变量（WAKATIME_API_KEY）
3. ~/.wakatime.cfg 中的 api_key（WakaTime 标准配置）
4. 插件 schema 默认值（最低优先级）
```

---

## 4. 非功能需求

### 4.1 性能

| 指标 | 要求 |
|---|---|
| 心跳发送延迟 | < 100ms（本地 HTTP 请求） |
| 内存占用 | < 10MB（每 session） |
| CPU 占用 | 可忽略（仅在状态变更和定时器触发时工作） |
| 网络流量 | < 2KB/分钟（批量发送优化后） |
| 文件 diff 计算 | < 50ms（每文件） |

### 4.2 可靠性

| 场景 | 行为 |
|---|---|
| 网络中断 | 心跳写入本地缓存，下次成功时补发 |
| API 限流（429） | 自动退避，30 秒后重试 |
| API 认证失败（401） | 停止发送，日志警告，每 5 分钟重试 |
| 进程退出 | 发送剩余心跳 + 写入缓存（graceful shutdown） |
| 多 session | 每个 session 独立计时，互不干扰 |
| 缓存溢出 | 丢弃最早的缓存条目（FIFO） |

### 4.3 安全

| 项目 | 要求 |
|---|---|
| API Key 存储 | 不落盘，仅存在于进程内存和 cordis 配置 |
| 网络传输 | HTTPS only |
| 日志脱敏 | API Key 在日志中显示为 `waka_****最后4位` |
| 本地缓存 | 仅缓存心跳 payload，不缓存 API Key |
| 文件内容 | 不上传文件内容，只上传文件路径和统计信息 |

### 4.4 兼容性

| 项目 | 要求 |
|---|---|
| DSH 版本 | 兼容当前 mainline（peer dependency 锁定） |
| WakaTime API | v1（稳定版） |
| 自托管 WakaTime | 支持（通过 `api_url` 配置） |
| 与其他插件 | 与 dsh-codetime 互斥（都是 telemetry backend） |
| 操作系统 | Windows / macOS / Linux 全支持 |

---

## 5. 技术架构

### 5.1 包结构

```
dsh-wakatime/
├── src/
│   ├── index.ts              # 插件入口：注册 + 监听事件
│   ├── wakatime.ts           # WakaTime HTTP 客户端
│   ├── tracker.ts            # 文件级追踪器
│   ├── project.ts            # 项目名推断
│   ├── language.ts           # 语言推断
│   ├── diff.ts               # 文件 diff 计算
│   ├── cache.ts              # 心跳本地缓存
│   ├── settings.ts           # 配置 schema 与注册
│   └── types.ts              # 类型定义
├── lib/                      # 编译产物
│   ├── index.js
│   ├── wakatime.js
│   ├── tracker.js
│   ├── project.js
│   ├── language.js
│   ├── diff.js
│   ├── cache.js
│   ├── settings.js
│   └── types.d.ts
├── cordis.patch.yml          # bundle patch
├── package.json
├── tsconfig.json
└── README.md
```

### 5.2 依赖关系

```
dsh-wakatime
    │
    ├── @deepseek-ai/cordis (peer)          ← Cordis 插件框架
    ├── @deepseek-ai/dsh-session (peer)     ← 会话事件类型
    ├── @deepseek-ai/dsh-agent (peer)       ← agent 状态事件
    └── @deepseek-ai/schemastery (peer)     ← 配置 schema
```

### 5.3 核心实现

#### 5.3.1 插件入口（index.ts）

```typescript
import type { Context } from '@deepseek-ai/cordis';
import type { Session } from '@deepseek-ai/dsh-session';
import Schema from '@deepseek-ai/schemastery';
import { WakaTimeClient } from './wakatime.js';
import { FileTracker } from './tracker.js';
import { HeartbeatCache } from './cache.js';
import { registerWakaTimeSettings } from './settings.js';

export const name = 'dsh-wakatime';
export const inject = ['sessions'];

export const Config = Schema.object({
  api_key: Schema.string().required(),
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

interface SessionState {
  tracker: FileTracker;
  timer: NodeJS.Timeout | null;
  pending: Map<string, WakaTimeHeartbeat>;
}

export function apply(ctx: Context, config: typeof Config.infer): void {
  const client = new WakaTimeClient(config);
  const cache = new HeartbeatCache(config);
  const states = new WeakMap<Session, SessionState>();

  ctx.inject(['settings'], (settingsCtx) => {
    registerWakaTimeSettings(settingsCtx, config);
  });

  const getOrCreateState = (session: Session): SessionState => {
    let state = states.get(session);
    if (!state) {
      state = { tracker: new FileTracker(session, config), timer: null, pending: new Map() };
      states.set(session, state);
    }
    return state;
  };

  const flushPending = async (session: Session): Promise<void> => {
    const state = states.get(session);
    if (!state || state.pending.size === 0) return;

    const heartbeats = Array.from(state.pending.values());
    state.pending.clear();

    try {
      const batchSize = 25;
      for (let i = 0; i < heartbeats.length; i += batchSize) {
        const batch = heartbeats.slice(i, i + batchSize);
        await client.sendHeartbeats(batch);
      }
    } catch (error) {
      if (config.debug) {
        ctx.logger.warn(`dsh-wakatime: flush failed, caching ${heartbeats.length} heartbeats`);
      }
      for (const hb of heartbeats) {
        await cache.append(hb);
      }
    }
  };

  const startHeartbeatTimer = (session: Session): void => {
    const state = getOrCreateState(session);
    if (state.timer) return;
    state.timer = setInterval(() => {
      void flushPending(session);
    }, config.heartbeat_interval_ms);
  };

  const stopHeartbeatTimer = (session: Session): void => {
    const state = states.get(session);
    if (state?.timer) {
      clearInterval(state.timer);
      state.timer = null;
    }
  };

  if (config.include_tool_calls) {
    ctx.on('session/event', (session, event) => {
      if (event.type === 'tool/call') {
        const state = getOrCreateState(session);
        state.tracker.trackToolCall(event);
      }
    });
  }

  if (config.include_user_messages) {
    ctx.on('session/event', (session, event) => {
      if (event.type === 'user/message') {
        const state = getOrCreateState(session);
        state.tracker.trackUserMessage(event);
      }
    });
  }

  if (config.include_assistant_messages) {
    ctx.on('session/event', (session, event) => {
      if (event.type === 'assistant/message') {
        const state = getOrCreateState(session);
        state.tracker.trackAssistantMessage(event);
      }
    });
  }

  ctx.on('agent/status', ({ session, status }) => {
    if (status === 'running') {
      startHeartbeatTimer(session);
    } else {
      stopHeartbeatTimer(session);
      void flushPending(session);
      void cache.flush(client);
    }
  });

  ctx.effect(() => () => {
    for (const [session] of states.entries()) {
      stopHeartbeatTimer(session);
      void flushPending(session);
    }
  });
}
```

#### 5.3.2 WakaTime HTTP 客户端（wakatime.ts）

```typescript
interface HeartbeatPayload {
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

export class WakaTimeClient {
  private apiKey: string;
  private baseUrl: string;
  private userAgent: string;

  constructor(config: { api_key: string; api_url: string }) {
    this.apiKey = config.api_key;
    this.baseUrl = `${config.api_url}/api/v1`;
    this.userAgent = `dsh/${DSH_VERSION} dsh-wakatime/${PLUGIN_VERSION}`;
  }

  async sendHeartbeat(payload: HeartbeatPayload): Promise<void> {
    await this.sendHeartbeats([payload]);
  }

  async sendHeartbeats(payloads: HeartbeatPayload[]): Promise<void> {
    const url = `${this.baseUrl}/users/current/heartbeats.bulk`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${btoa(this.apiKey + ':')}`,
        'Content-Type': 'application/json',
        'User-Agent': this.userAgent,
      },
      body: JSON.stringify(payloads),
    });

    if (response.status === 401) {
      throw new WakaTimeAuthError('WakaTime API Key 无效，请检查配置');
    }
    if (response.status === 429) {
      throw new WakaTimeRateLimitError('WakaTime API 限流，稍后重试');
    }
    if (!response.ok) {
      throw new WakaTimeError(`WakaTime API 错误: ${response.status}`);
    }
  }
}
```

#### 5.3.3 文件级追踪器（tracker.ts）

```typescript
export class FileTracker {
  private session: Session;
  private config: Config;
  private pending: Map<string, WakaTimeHeartbeat> = new Map();

  constructor(session: Session, config: Config) {
    this.session = session;
    this.config = config;
  }

  async trackToolCall(event: SessionEvent): Promise<void> {
    const { name, args } = event.data;
    const category = TOOL_CATEGORY_MAP[name] || 'coding';
    const isWrite = WRITE_TOOLS.has(name);
    const entity = this.extractEntity(name, args);

    if (!entity) return;

    const heartbeat: WakaTimeHeartbeat = {
      entity,
      type: name === 'bash' ? 'app' : 'file',
      category,
      time: Date.now() / 1000,
      project: await this.resolveProject(),
      branch: await this.resolveBranch(),
      language: await this.resolveLanguage(entity),
      is_write: isWrite,
    };

    if (isWrite) {
      const diff = await this.calculateDiff(name, args, entity);
      heartbeat.lines = diff.lines;
      heartbeat.line_additions = diff.lineAdditions;
      heartbeat.line_deletions = diff.lineDeletions;
    }

    const existing = this.pending.get(entity);
    if (existing) {
      Object.assign(existing, heartbeat);
      existing.time = heartbeat.time;
    } else {
      this.pending.set(entity, heartbeat);
    }
  }

  async trackUserMessage(event: SessionEvent): Promise<void> {
    const heartbeat: WakaTimeHeartbeat = {
      entity: `dsh-session-${this.session.id}`,
      type: 'app',
      category: 'communicating',
      time: Date.now() / 1000,
      project: await this.resolveProject(),
      is_write: false,
    };
    this.pending.set(`user-${Date.now()}`, heartbeat);
  }

  async trackAssistantMessage(event: SessionEvent): Promise<void> {
    const heartbeat: WakaTimeHeartbeat = {
      entity: `dsh-session-${this.session.id}`,
      type: 'app',
      category: 'communicating',
      time: Date.now() / 1000,
      project: await this.resolveProject(),
      is_write: false,
    };
    this.pending.set(`assistant-${Date.now()}`, heartbeat);
  }

  getPending(): WakaTimeHeartbeat[] {
    return Array.from(this.pending.values());
  }

  clearPending(): void {
    this.pending.clear();
  }

  private extractEntity(toolName: string, args: any): string | null {
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
    return await resolveProject(this.session.cwd);
  }

  private async resolveBranch(): Promise<string> {
    return await resolveBranch(this.session.cwd);
  }

  private async resolveLanguage(entity: string): Promise<string> {
    if (this.config.language) return this.config.language;
    return await resolveLanguage(entity);
  }

  private async calculateDiff(toolName: string, args: any, entity: string): Promise<DiffResult> {
    if (toolName === 'write') {
      const lines = args.content.split('\n').length;
      return { lines, lineAdditions: lines, lineDeletions: 0 };
    }
    if (toolName === 'edit') {
      const oldLines = args.old_string.split('\n').length;
      const newLines = args.new_string.split('\n').length;
      return {
        lines: newLines,
        lineAdditions: Math.max(0, newLines - oldLines),
        lineDeletions: Math.max(0, oldLines - newLines),
      };
    }
    return { lines: 0, lineAdditions: 0, lineDeletions: 0 };
  }
}
```

#### 5.3.4 心跳本地缓存（cache.ts）

```typescript
import { appendFile, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

export class HeartbeatCache {
  private cachePath: string;
  private limit: number;

  constructor(config: { cache_limit: number }) {
    this.cachePath = join(process.env.HOME || '~', '.dsh', 'wakatime', 'heartbeat-cache.jsonl');
    this.limit = config.cache_limit;
  }

  async append(heartbeat: WakaTimeHeartbeat): Promise<void> {
    await mkdir(dirname(this.cachePath), { recursive: true });
    const line = JSON.stringify(heartbeat) + '\n';
    await appendFile(this.cachePath, line);
    await this.enforceLimit();
  }

  async flush(client: WakaTimeClient): Promise<void> {
    if (!existsSync(this.cachePath)) return;

    const content = await readFile(this.cachePath, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    if (lines.length === 0) return;

    const heartbeats = lines.map(l => JSON.parse(l));
    try {
      await client.sendHeartbeats(heartbeats);
      await writeFile(this.cachePath, '');
    } catch (error) {
      throw error;
    }
  }

  private async enforceLimit(): Promise<void> {
    if (!existsSync(this.cachePath)) return;
    const content = await readFile(this.cachePath, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    if (lines.length > this.limit) {
      const trimmed = lines.slice(-this.limit);
      await writeFile(this.cachePath, trimmed.join('\n') + '\n');
    }
  }
}
```

### 5.4 Cordis Patch

```yaml
# dsh-wakatime bundle patch
- insert:
    - id: dsh-wakatime
      name: 'dsh-wakatime'
      config:
        api_key: !!js process.env.WAKATIME_API_KEY || ''
        api_url: !!js process.env.WAKATIME_API_URL || 'https://wakatime.com'
        heartbeat_interval_ms: 120000
        project_name: ''
        language: ''
        include_tool_calls: true
        include_user_messages: false
        include_assistant_messages: false
        cache_heartbeats: true
        cache_limit: 100
        debug: false
```

---

## 6. 与现有插件对比

| 维度 | dsh-codetime | dsh-timesheet | dsh-worktime-board | **dsh-wakatime** |
|---|---|---|---|---|
| **外部同步** | ✅ codetime.dev | ❌ 仅本地 | ❌ 仅本地 | ✅ wakatime.com |
| **仪表盘** | ✅ CodeTime | ❌ 终端报表 | ✅ Web UI | ✅ WakaTime |
| **追踪粒度** | session 级 | session 级 | session 级 | **文件级** |
| **AI 编码分类** | ✅ | ❌ | ❌ | ✅ `ai coding` |
| **项目推断** | ✅ | ✅ | ✅ | ✅ |
| **分支追踪** | ✅ | ❌ | ❌ | ✅ |
| **语言推断** | ✅ | ❌ | ❌ | ✅ |
| **行级统计** | ❌ | ❌ | ❌ | ✅ |
| **依赖推断** | ❌ | ❌ | ❌ | ✅ |
| **心跳批量发送** | ❌ | ❌ | ❌ | ✅ |
| **心跳本地缓存** | ❌ | ❌ | ❌ | ✅ |
| **团队视图** | ✅ | ❌ | ❌ | ✅ |
| **目标设定** | ❌ | ❌ | ❌ | ✅ WakaTime 自带 |
| **周报邮件** | ❌ | ❌ | ❌ | ✅ WakaTime 自带 |
| **配置复杂度** | 低 | 低 | 中 | 低 |
| **依赖 WakaTime 账户** | ❌ | ❌ | ❌ | ✅ |

---

## 7. 版本规划

### v1.0.0（MVP — 完整功能）

| 功能 | 优先级 |
|---|---|
| 文件级心跳追踪（write/edit/read/bash/grep/glob） | P0 |
| 心跳字段完整映射（entity, type, category, time, project, branch, language, lines, line_additions, line_deletions, is_write） | P0 |
| 项目名自动推断（git / package.json / 目录名） | P0 |
| 分支名自动推断 | P0 |
| 语言自动推断（从文件扩展名） | P0 |
| 心跳批量发送（bulk API，最多 25 条） | P0 |
| 心跳合并策略（同一文件 5 秒内操作合并） | P0 |
| 心跳本地缓存（网络失败时补发） | P0 |
| 状态机（idle ↔ active 切换 + 定时器） | P0 |
| 错误处理（401/429/网络中断） | P0 |
| API Key 配置（环境变量 + cordis.patch.yml + ~/.wakatime.cfg） | P0 |
| 调试日志模式 | P1 |

### v1.1.0（增强）

| 功能 | 优先级 |
|---|---|
| WebUI 配置面板（Settings → WakaTime） | P1 |
| 依赖推断（package.json / requirements.txt / go.mod） | P1 |
| project_root_count 计算 | P1 |
| 用户消息追踪（可选） | P1 |
| AI 回复追踪（可选） | P1 |
| 自托管 WakaTime 支持 | P2 |

### v2.0.0（高级）

| 功能 | 优先级 |
|---|---|
| 统计 API 查询（在 DSH 中查看 WakaTime 统计） | P2 |
| 项目 API 查询（在 DSH 中查看 WakaTime 项目） | P2 |
| 心跳本地缓存持久化（重启后恢复） | P2 |
| 心跳发送失败重试策略优化（指数退避） | P3 |
| 心跳发送指标监控（成功率、延迟） | P3 |

---

## 8. 验收标准

### 8.1 功能验收

| 编号 | 场景 | 预期 |
|---|---|---|
| AC-01 | 配置有效 API Key，启动 DSH | 插件加载成功，日志显示 "dsh-wakatime: loaded" |
| AC-02 | AI 写入文件（write 工具） | 心跳 entity=文件路径, category=coding, is_write=true, line_additions=总行数 |
| AC-03 | AI 编辑文件（edit 工具） | 心跳 entity=文件路径, category=coding, is_write=true, line_additions/line_deletions 正确 |
| AC-04 | AI 读取文件（read 工具） | 心跳 entity=文件路径, category=browsing, is_write=false |
| AC-05 | AI 执行命令（bash 工具） | 心跳 entity=命令字符串, type=app, category=building |
| AC-06 | AI 搜索代码（grep/glob 工具） | 心跳 category=browsing |
| AC-07 | 项目名推断 | 正确识别 git 项目名 / package name / 目录名 |
| AC-08 | 分支名推断 | 正确识别当前 Git 分支 |
| AC-09 | 语言推断 | 正确识别文件语言（.ts → TypeScript, .py → Python 等） |
| AC-10 | 心跳批量发送 | 25 条心跳批量发送，只发一次 HTTP 请求 |
| AC-11 | 心跳合并 | 同一文件 5 秒内多次操作 → 合并为一条心跳 |
| AC-12 | agent idle 时发送剩余心跳 | 所有 pending 心跳被发送 |
| AC-13 | 网络中断 | 心跳写入本地缓存，不崩溃 |
| AC-14 | 网络恢复 | 缓存心跳被补发 |
| AC-15 | 进程退出 | 发送剩余心跳 + 写入缓存（graceful shutdown） |
| AC-16 | 多 session 同时活跃 | 每个 session 独立追踪，互不干扰 |
| AC-17 | 无 API Key 或 Key 无效 | 插件加载但不上报，日志警告 |
| AC-18 | 自托管 WakaTime | 通过 api_url 配置正常工作 |

### 8.2 性能验收

| 编号 | 场景 | 预期 |
|---|---|---|
| AC-20 | 连续使用 1 小时 | 内存增长 < 5MB，CPU 占用 < 0.1% |
| AC-21 | 网络延迟 200ms | 心跳发送不阻塞主进程 |
| AC-22 | 100 个 session 同时活跃 | 每个 session 独立运行，无串扰 |
| AC-23 | 文件 diff 计算 | < 50ms（每文件） |
| AC-24 | 心跳批量发送 | 25 条心跳 < 200ms |

### 8.3 兼容性验收

| 编号 | 场景 | 预期 |
|---|---|---|
| AC-30 | 与 dsh-codetime 同时安装 | 互斥提示，用户需二选一 |
| AC-31 | 与 dsh-suggest-ghost 同时安装 | 正常工作，互不干扰 |
| AC-32 | Windows 平台 | 正常工作 |
| AC-33 | macOS 平台 | 正常工作 |
| AC-34 | Linux 平台 | 正常工作 |

---

## 9. 风险与缓解

| 风险 | 概率 | 影响 | 缓解措施 |
|---|---|---|---|
| WakaTime API 变更 | 低 | 高 | 锁定 API v1，peer dependency 范围 |
| API Key 泄露 | 低 | 高 | 不落盘、日志脱敏、仅内存存储 |
| 心跳过于频繁被限流 | 中 | 中 | 批量发送 + 合并策略 + 429 自动退避 |
| 项目推断错误 | 中 | 低 | 允许手动覆盖 project_name |
| 与 dsh-codetime 冲突 | 高 | 中 | 文档说明互斥，安装时检测并提示 |
| 文件 diff 计算性能 | 低 | 中 | 限制大文件（> 10000 行）不计算 diff |
| 本地缓存磁盘占用 | 低 | 低 | 缓存上限 100 条，超出时 FIFO 丢弃 |

---

## 10. 术语表

| 术语 | 定义 |
|---|---|
| `heartbeat` | WakaTime 心跳，一次编码活动记录 |
| `entity` | 心跳关联的实体（文件路径、域名或应用） |
| `category` | 活动分类（coding / ai coding / building 等 18 种） |
| `project` | 项目名，用于在 WakaTime 中分组 |
| `session` | DSH 会话，一个持续的对话上下文 |
| `agent status` | agent 运行状态（running / idle） |
| `bulk` | 批量发送，一次 HTTP 请求发送多条心跳 |
| `cache` | 本地缓存，网络失败时暂存心跳 |
| `diff` | 文件差异，计算新增/删除行数 |

---

## 附录：WakaTime API 参考

### 心跳 API

```
POST /api/v1/users/current/heartbeats
Authorization: Basic base64(api_key:)
Content-Type: application/json

{
  "entity": "/path/to/file",
  "type": "file",
  "category": "coding",
  "time": 1724150400.000,
  "project": "my-project",
  "project_root_count": 3,
  "branch": "main",
  "language": "TypeScript",
  "dependencies": ["express", "react"],
  "lines": 245,
  "line_additions": 12,
  "line_deletions": 3,
  "is_write": true
}
```

### 批量心跳 API

```
POST /api/v1/users/current/heartbeats.bulk
Authorization: Basic base64(api_key:)
Content-Type: application/json

[
  { "entity": "file1.ts", "type": "file", "time": 1724150400.000, ... },
  { "entity": "file2.py", "type": "file", "time": 1724150401.000, ... },
  ...
]
```

### 响应码

| 状态码 | 含义 |
|---|---|
| 201 | 心跳创建成功 |
| 202 | 心跳已接受，异步处理 |
| 401 | API Key 无效 |
| 429 | 请求过于频繁 |
| 500 | 服务器错误 |

### 认证方式

WakaTime 支持两种认证：
1. **HTTP Basic Auth**：用户名 = API Key，密码留空
2. **Query String**：`?api_key=YOUR_API_KEY`（不推荐，安全性低）

本插件使用 HTTP Basic Auth。

### 活动分类完整列表

| 分类 | 说明 |
|---|---|
| `coding` | 编码 |
| `building` | 构建/编译 |
| `indexing` | 索引 |
| `debugging` | 调试 |
| `browsing` | 浏览/阅读 |
| `running tests` | 运行测试 |
| `writing tests` | 编写测试 |
| `manual testing` | 手动测试 |
| `code reviewing` | 代码审查 |
| `designing` | 设计 |
| `communicating` | 沟通 |
| `meeting` | 会议 |
| `learning` | 学习 |
| `researching` | 研究 |
| `writing docs` | 编写文档 |
| `ai coding` | AI 辅助编码 |
