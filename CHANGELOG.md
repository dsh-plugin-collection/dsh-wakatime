# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。条目按*影响面*排序，不按提交顺序。

## [1.2.2] — 2026-11-20

### 修复

- **Models 面板显示的模型是错的（`Wakatime 100%`）**：1.2.1 把 UA 改成了官方模板
  `wakatime/<ver> (<OS>-…) …`，而 `user_agents` 端点返回的服务端解析结果显示，
  **只要 UA 以 `wakatime/<ver>` 开头，服务端就把 wakatime 自己当成模型**
  （`ai_model='Wakatime'`、`ai_model_version=<插件版本>`），后面真正的模型 token
  被忽略。这是 1.2.1 引入的回归——1.2.0 之前是空，1.2.1 变成了错误值，错误归因
  比空着更误导人。

  改用**模型 token 打头**的实测形状：

  ```
  deepseek/4.1-flash-eco dsh/0.2.2-rc.5 (linux-6.18.58-x86_64) node/24.22.0 dsh-wakatime/1.2.2
    → ai_model='DeepSeek'  ai_model_version='4.1-flash-eco'  editor='Dsh'
  ```

  模型识别不出时首位放 `dsh/<hostVer>`，实测服务端返回 `ai_model=None`
  （不再出现假归因）；宿主版本探测不到时用 `0.0.0` 占位——它必须占住首位，
  否则括号段会落到首位被当成模型名（实测 `ai_model='(linux-…)'`）。

  代价是没有 `wakatime/` 头。**OS 括号段实测仍被识别**（服务端对
  `(linux-…-x86_64)` 做子串匹配），但 `editor` 要靠末尾的
  `dsh-wakatime/<ver>` 才回落成 `Dsh`——该 token 不能省。

### 验证方式

服务端解析 UA 的代码不开源，但这轮找到了**可实测的通道**：`user_agents` 端点
（`last_seen_at` 是**写**路径产生的，插件 key 可读）会返回 `ai_model` /
`ai_model_version` / `editor` / `version`。据此把十几轮 UA 变体打进真实端点并读回
解析结果，才定位到「`wakatime/` 开头会被当模型」这条规则。前几版 README 里
「面板是否点亮无法验证」的说法就此作废。


## [1.2.1] — 2026-11-20

### 修复

- **`dsh/<ver>` 段在真实宿主进程里一直是缺的**：`detectHostVersion()` 里用了
  `require('node:fs')`，但本插件是 ESM（`package.json` 的 `"type": "module"`）。
  TypeScript 不报错、tsc 原样保留、vitest（vite 转译）里 `require` 恰好可用，
  178 个测试全绿，而宿主进程里 `typeof require === 'undefined'`——调用抛
  ReferenceError 被 catch 吞成空串，UA 静默少一段。生产证据：宿主发出的活心跳是
  `…node/24.22.0 deepseek/4.1-flash-eco`（无 `dsh/`），而同一版本的手工探针是
  `…deepseek/4.1-flash-eco dsh/0.2.2-rc.5`。现改为静态 `import`，并补两条回归守卫：
  一条静态扫描 `src/` 里不得出现 `require(` 调用，一条在**真 ESM 子进程**里跑
  构建产物断言 `dsh/<ver>` 非空。已实测把 `require` 塞回去会让守卫立刻变红。

## [1.2.0] — 2026-11-20

### 修复

- **Operating Systems 面板显示 `Unknown OS`**：UA 缺官方模板里的括号段。WakaTime 从
  `User-Agent` 解析 OS（`userAgentSystemEnd` 找不到 `(` 就返回 -1），旧 UA
  `dsh/1.0.0 dsh-wakatime/1.0.0` 没有括号，于是整段统计落到 `Unknown OS`。现按官方
  模板 `wakatime/<ver> (<OS>-<core>-<platform>) …` 生成，OS 名用**小写**、arch 用
  `x86_64` / `aarch64`——取值来自本账号 `user_agents` 端点里 50 条官方 CLI 的真实样本，
  大小写不一致会多出一个新条目而不是并入已有归类。
- **Models 面板一直空白**：WakaTime 的心跳结构里**没有** `ai_model` 字段（官方
  `pkg/heartbeat/heartbeat.go` 的 AI 字段只有 `ai_line_changes` / `ai_cached_input_tokens`
  / `ai_session` / `ai_subscription_plan` / `ai_input_tokens` / `ai_output_tokens` /
  `ai_prompt_length`），模型归属是服务端从 UA 解析出来的。旧 UA 里没有任何模型 token，
  所以面板永远空。现从宿主消息的 `message.source.model`（`ModelMessageSource`）读取模型 id，
  按官方 `aiModelUserAgentToken` 规则归一化后写进 UA：
  `deepseek-v4.1-flash-eco` → `deepseek/4.1-flash-eco`、`gpt-4o` → `gpt/4o`。
  识别不出 family 的（无版本号的 `dsh-opendesign-go`、`deepseek-chat`）该段直接省略，
  不发无效 token。
- **`ai_line_changes` 从未上报，发出的是不存在的字段**：旧实现给 write / edit 心跳塞
  `line_additions` / `line_deletions`，而官方心跳结构里没有这两个字段，服务端直接忽略，
  WakaTime 的 AI 行数统计因此一直缺数据。现改为官方字段 `ai_line_changes`
  （= 增行 + 删行），`lines` 保留。
- **`user_agent` 只发在 HTTP 头，没写进心跳**：批量上报时一个头无法区分不同会话、不同
  模型的条目。官方心跳结构有 `user_agent` JSON 字段，现逐条写入（`enqueue()` 统一打戳，
  三个构造点都不会漏），HTTP 头跟随本批第一条的 UA。

### 变更

- **UA 里的版本不再手写**：旧的 `dsh/1.0.0 dsh-wakatime/1.0.0` 是硬编码字面量，包已经
  发到 1.1.0 而它停在 1.0.0。现由 `build.mjs` 在 tsc 之后把 `package.json` 的版本注入
  `lib/user-agent.js`，宿主版本则从宿主进程入口路径探测（插件直接 `require`
  `@deepseek-ai/dsh/package.json` 会 `MODULE_NOT_FOUND`，能解析到的 `dsh-session` 只是
  插件自己的 devDependency，版本是错的）。两者都取不到时对应段省略，不填假版本。
- 新增 `src/user-agent.ts`（UA 构造 + 模型 token 归一化 + 宿主版本探测），
  178 个测试（新增 8 个：token 归一化、括号段形状、OS/arch 词汇、无效模型省略、
  宿主版本缺失回退、模型身份透传、逐条 UA 打戳）。

### 已验证

- 真实 `heartbeats.bulk` 上报返回 `201`，该 UA 已出现在 `user_agents` 端点（54 条中的
  最新一条）。
- 本地 mock 端点抓包确认：每条心跳的 `user_agent` 逐条存在，HTTP 头与载荷一致，
  `line_additions` / `line_deletions` 已消失，`ai_line_changes` 出现在 write 心跳上。

### 验证边界（1.2.2 已推翻部分结论）

- 当时写的是「面板是否点亮无法验证」。**1.2.2 找到了通道**：`user_agents` 端点可读，
  且返回服务端解析结果（`ai_model` / `editor`），据此才发现本版的 UA 形状会让服务端
  把 `wakatime` 当成模型——所以这一版其实是错的，修正见 1.2.2。
- 仍然读不到的：`operating_systems`、`editors`、`ai_models`、`machine_names`、
  `summaries`（403/404）。OS 与 Machines 两个面板的实际归属仍只能看面板。


## [1.1.0] — 2026-11-20

### 已知问题

- WakaTime 自 2026-10 起对**读端点**（`/users/current`、`/users/current/projects`、`/users/current/heartbeats`）使用插件 key 一律返回 `403 API Keys are only for plugins`。心跳**写**端点 `heartbeats.bulk` 不受影响。本插件的「项目名称」候选下拉因此移除。

### 其他

- **包名改回 `dsh-wakatime`**：11-16 统一改名时选了 `dsh-wakatime-plugin`，但该名
  自 2026-10-03 起已被另一位作者的插件占用（npm 0.5.2，`JularDepick`），我们不是
  maintainer，`npm publish` 会被直接拒绝。`dsh-wakatime` 是本仓库 2026-08-26 的初始
  包名，现仍 404 可用，故改回。同步了 `package.json` name / repository / homepage /
  bugs、`cordis.patch.yml` 的 id 与 name、client 身份回退字面量、测试夹具、两份 README、
  以及 profile 的依赖键 / `dsh.profile.bundles` / lockfile importer / 注册行 / 软链接。
  **已存配置不丢**：profile patch 的 `config` 块原地保留（api_key 等原值未动）。
- **仓库名同步为 `dsh-wakatime`**：GitHub（`dsh-plugin-collection/dsh-wakatime`）与
  Gitea（`dsh-plugins/dsh-wakatime`）均已改名，旧路径各自保留 301 / 重定向，已推出去
  的 clone 与链接不会失效。本地工作目录仍为 `dsh-wakatime-plugin`（改名会使正在运行的
  会话 cwd 与 change-ledger 绑定失效，故留待单独处理）。
- **重写了提交历史，清除工作邮箱与内网地址**：11 个提交的作者带的是工作邮箱
  （仓库本地 git identity 长期未改，每次提交都把它重新带进来），4 个 Gitea 合并
  提交的正文带内网 `Reviewed-on` 行。
  两者都已公开在 GitHub。仓库当时 0 fork / 0 star / 0 watcher，无外部依赖，故用
  `git filter-repo` 重写：作者统一为 `WuJiaoJue <103944313+WuJiaoJue@users.noreply.github.com>`，
  并删除正文里的内网 `Reviewed-on` 行。**文件内容无任何变化**（重写前后 tree 哈希相同），
  唯一代价是全部提交哈希改变、需要 force push；已推出去的旧 clone 需重新拉取。
  仓库本地 `user.name/email` 同时改为 GitHub 账号，杜绝再次引入。

### 修复

- **改名后 client entry 不激活（`duplicate factory registration`）**：11-16 的统一改名只覆盖了
  host 与 manifest，client 侧的工厂注册 id、`plugins.bundle.config` 槽位 key、`configForms`
  条目 id、settings 命名空间仍留在旧名 `dsh-wakatime`。web boot 以新包名加载 bundle、工厂却
  注册旧 id，invalidate 按包名清不掉旧工厂，二次执行即抛重复注册；宿主侧 `ENTRY_ID` 同病，
  会让 WebUI 保存的配置行被静默忽略。现改为**构建期从 `package.json` 注入包名**
  （`src/client/plugin-id.ts` + esbuild define），这组标识单一来源、不可能再各自漂移；
  并新增「身份一致性」守卫用例（包名 = host name = client PLUGIN_ID = bundle 注册 id）。

- **配置字段整片失效（会导致静默断流）**：标了 `.volatile()` 的字段由宿主以 `Object.freeze({ get })` 的 ref **对象**交付，旧代码当裸值用，导致
  `api_url` 拼出非法 URL（请求未发出）、`heartbeat_interval_ms` 被 Node 当成 1ms、
  `include_*=false` 恒为真、`project_name`/`language` 整个不发、`cache_limit` 永不裁剪。
  现在入口与设置文档层统一解包并按类型校验，不合格回退默认值并告警。
- **坏 key 静默断流**：`config.api_key` 形状不对（对象）时被当作有效值，`Authorization`
  变成 `base64("[object Object]:")`，服务端恒 401 并触发 5 分钟跳过发送；失败又只在
  debug 下打印。现在三层解析只接受非空字符串，并跳过该层继续回退。
- **逐条 400 静默丢数据**：`heartbeats.bulk` 外层恒 202，逐条失败此前完全不可见。
  现在解析逐条状态码：4xx 永久失败（丢弃并告警带原因），429/5xx 回缓存重试。
- **重复上报**：某批传输失败时，此前会把这批之前**已入库**的心跳也写回缓存，
  下次冲刷整批重发。现在只回写确实没落库的集合。
- **可重试的数据被当永久失败丢弃**：外层成功但逐条 429/5xx 时，可重试集合曾未回写缓存。
- **同文件读写互相覆盖**：pending 缓冲只以 entity 为键，5 秒内先 `edit` 后 `read`
  会让 read 把 edit 的 `category` / `is_write` / 行数覆盖掉。合并键改为 `entity + category`。
- **缓存超限无声删除**：以前按写入顺序裁掉最新 N 行之外的部分，且不留痕迹。
  现在按**时间**裁剪，并告警「最旧的 N 条已被丢弃（from → to）」。
- **构建产物残留**：`tsc` 不删除已消失源文件的产物，删掉的模块仍留在 `lib/` 里可被
  require。构建前清空 `lib/`。
- **构建环境坏了却伪装成成功**：`npx tsc` 在依赖缺失时会去装同名的废弃包 `tsc@2.0.4`
  并只打印一句话。改用本地 `node_modules/.bin/tsc`，缺失时非零退出。
- `typescript` 从来不在依赖列表里（构建能成纯属环境巧合），现声明为 devDependency。
- 网络错误丢失 `cause`：`TypeError: fetch failed` 无法区分 DNS/重置/证书/宿主改写。
  现在展开 `error.cause`，并透传原始错误对象。
- 心跳时间取的是**处理时刻**而非事件时间戳，会污染按时段统计的时长。

### 新增

- **代理设置**：设置页新增「代理地址」与「不走代理的地址」。优先级
  **设置页 → 环境变量 → `~/.wakatime.cfg` → 直连**，某层值非法时跳过并告警；
  `none`/`direct` 强制直连。启动日志会打印当前生效来源。
- **AI token 口径对齐**：新增上报 `ai_cached_input_tokens`（缓存命中的输入）。
  宿主的 `inputTokens` 只含未命中部分，此前长上下文会话被低估两个数量级。
- **shell 类别判定**：`bash`/`pwsh` 不再一律记为 `building`，改为按命令内容判定
  （`ls`/`grep` 记 `browsing`、`git` 记 `coding`、`pnpm test` 记 `running tests` 等）。
  实测账号内 98.7% 的「构建时间」并非构建。
- **命令心跳的 entity 可配置**：新增「终端应用名」（默认 `Terminal`），
  不再把整条命令原文当 entity（曾散成 5158 个实体）。
- 设置页「项目名称」/「语言」改为带候选的输入框（语言候选为内置常量）。

### 变更

- 上报失败、逐条拒绝、缓存丢弃一律告警并**同时写宿主日志与 console**（此前只在 debug 下打印）。
- 常态成功行只进宿主 logger，console 仅保留异常。
- `apply()` 打印构建产物指纹（artifact mtime + pid），用于确认热重载是否真的换入。

### 移除

- 「项目名称」远程候选下拉及其 host 代理路由（依赖的读端点已 403）。

## [1.0.0] — 初始版本

- WakaTime 心跳上报：工具调用、用户消息、assistant 消息
- 工具 → category 映射、文件语言推断、git 项目/分支探测、依赖清单
- 本地失败缓存与重试、并发冲刷串行化
- WebUI 设置页（api_key / api_url / 心跳间隔 / 各追踪开关 / 缓存 / 调试）
