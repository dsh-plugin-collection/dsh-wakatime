# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。条目按*影响面*排序，不按提交顺序。

## [未发布]

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
