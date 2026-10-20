<p align="center">
  <img src="assets/logo.svg" width="128" alt="dsh-wakatime logo"/>
</p>

# dsh-wakatime

[English](./README.md) | 简体中文

DeepSeek Harness（DSH）的 WakaTime 心跳上报插件。

追踪你的 AI 辅助编码活动，并同步到你的 [WakaTime](https://wakatime.com) 面板。

> **说明**：本项目为社区集成，与 WakaTime 官方无隶属关系。

## 功能特性

- **文件级追踪** —— 每次工具调用（write、edit、read、bash、grep、glob 等）都会生成一条精确的 WakaTime 心跳
- **智能项目识别** —— 自动从 git、package.json 或目录名推断项目名
- **分支追踪** —— 上报当前工作的 git 分支
- **语言推断** —— 根据文件扩展名识别编程语言
- **行数统计** —— write/edit 操作上报新增/删除行数
- **AI token 上报** —— assistant 回复的心跳携带 `ai_input_tokens` / `ai_output_tokens` / `ai_prompt_length` / `ai_session`（WakaTime GenAI 指标）；需开启 **Track AI Messages** 才生效
- **心跳合并** —— 5 秒内对同一文件的连续操作自动合并
- **批量发送** —— 单次 HTTP 请求最多携带 25 条心跳（WakaTime 上限）
- **请求超时** —— 所有 HTTP 请求（10 秒）与 git 探测（5 秒）都有硬超时，挂起的端点永远不会阻塞冲刷
- **推断缓存** —— 项目名 / 分支 / 依赖按工作目录解析一次后缓存 60 秒，避免每次工具调用都拉起 git 进程
- **安全的缓存冲刷** —— 并发冲刷串行化；部分失败时只把未发送的心跳写回（不重复、不丢数据）
- **实时生效的设置** —— 所有 WebUI 设置即时生效：开关逐事件检查，心跳间隔变更原地重建定时器
- **本地缓存** —— 发送失败的心跳写入本地缓存，下次成功发送时自动重试
- **WebUI 配置** —— 全部设置可在 WebUI 设置面板中完成（无需手动编辑配置文件）

## 兼容性

本插件是两个系统之间的桥梁：运行在 **DSH 内部**，对接 **WakaTime API**。

| 端 | 兼容性 |
|---|---|
| **DSH（DeepSeek Harness）** | 以 DSH 插件形式运行于 web profile；支持区间由 `package.json` 的 `engines.dsh` 决定，写作 `>=0.1.7-rc.2 <0.2.0-0 \|\| >=0.2.0-rc.2 <0.3.0-0`（闸门规则见下）；peer 依赖写区间：`@deepseek-ai/dsh-agent` / `@deepseek-ai/dsh-session` `^0.1.1-rc.2 \|\| ^0.1.2-rc.1 \|\| ^0.1.5-rc.1 \|\| ^0.1.7-rc.2 \|\| ^0.2.0-rc.2 \|\| ^0.2.1-rc.2`，`@deepseek-ai/dsh-client-ui-primitives` `^0.1.7-rc.2 \|\| ^0.2.0-rc.2 \|\| ^0.2.1-rc.2`，`@deepseek-ai/cordis` `^4.0.1`，`@deepseek-ai/schemastery` `^3.18.1`；Node ≥ 22.19（含 24+）；Windows / macOS / Linux 全支持 |
| **WakaTime 云端** | 开箱即用对接 wakatime.com（心跳 API v1） |
| **自托管 WakaTime** | 通过 **API URL** 设置支持任意 WakaTime 兼容服务端 |
| **WakaTime 生态** | 自动读取标准 `~/.wakatime.cfg`，已有 API Key 无需重复配置 |
| **其他遥测插件** | 每个 DSH profile 只保留一个心跳后端，请勿与同类插件（如 codetime）同时启用 |

### 版本闸门与 peers 写法

闸门实现是宿主 `@deepseek-ai/dsh-app-boot/lib/index.js` 的 `evaluatePluginCompatibility`（第 311 行）：只读插件 `package.json`，不加载插件代码。

以下行号对应 `@deepseek-ai/dsh@0.2.1-rc.2` 的发布产物，仅作定位示意；核对以符号名为准（`evaluatePluginCompatibility` / `validateVolatilePlacement` / slot-contract 的 `plugins.bundle.config`）。

| 条件 | 宿主行为 | 代码位置 |
|---|---|---|
| 有 `engines.dsh` | **只比较这一个区间**，`peerDependencies` 被忽略 | `dsh-app-boot/lib/index.js:281-284` |
| 没有 `engines.dsh` | 每个 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 前缀的 peer 都要被运行版本满足；`@deepseek-ai/cordis`、`@deepseek-ai/schemastery` 等非该前缀的 peer 不参与判定 | `dsh-app-boot/lib/index.js:286-296` |
| 区间比较方式 | `semver.satisfies(运行版本, 区间, { includePrerelease: true })`，预发布版参与比较 | `dsh-app-boot/lib/index.js:277` |
| 判定不通过 | stderr 打印 `dsh: disabling profile plugin row "<条目>": Plugin <name>@<version> is incompatible with dsh <ver>: requirements …`，该条目被禁用；提示可用 `dsh plugin allow-version` 逐版本豁免 | `dsh-app-boot/lib/index.js:2308` 与 `:335` |

> **给插件作者的硬教训：peerDependencies 要写区间，不要写精确版本。** 宿主 0.2.1 一方包对 `@deepseek-ai/dsh-*` 的 peers 全部精确 pin 到同一版本（例：`@deepseek-ai/dsh-agent@0.2.1-rc.2` 的 dsh peers 全是 `0.2.1-rc.2`），插件照抄这种写法会在下一个 rc 上被闸门整片禁用。实证是本机 host 日志中的 `dsh: disabling profile plugin row "webhook-runtime"` 与 `dsh: disabling profile plugin row "webhook-github"` 记录：`@deepseek-ai/dsh-webhook@0.2.0-rc.2` 因 peers 写死 `"0.2.0-rc.2"`，在 dsh `0.2.1-rc.2` 下被逐行禁用，日志原文摘取 `Plugin @deepseek-ai/dsh-webhook@0.2.0-rc.2 is incompatible with dsh 0.2.1-rc.2: requirements {"@deepseek-ai/dsh-agent":"0.2.0-rc.2", "@deepseek-ai/dsh-invariants":"0.2.0-rc.2", …}`；本插件因写 `^0.2.0-rc.2`（在 `includePrerelease` 下覆盖 `0.2.1-rc.2`，精确匹配则不覆盖）而通过。

peer 区间写成**逐代枚举**（`^0.1.1-rc.2 || … || ^0.2.1-rc.2`）而不是单条区间，是为了兼顾 node-semver 的默认比较方式：不带 `includePrerelease` 时，带预发布的版本要求比较器里存在同一 `[major.minor.patch]` 元组的锚点。`^0.2.1-rc.2` 展开为 `>=0.2.1-rc.2 <0.3.0-0`，锚点元组只有 `0.2.1` 与 `0.3.0`，因此用宿主自带 semver 在默认语义下实测：`satisfies('0.2.1-rc.2', '^0.2.1-rc.2')` 为真、`satisfies('0.2.1', '^0.2.1-rc.2')` 为真、`satisfies('0.2.2-rc.1', '^0.2.1-rc.2')` 为假。

本次上游发布 `0.2.1-rc.2` 后，已按该规约在枚举中补入 `^0.2.1-rc.2`。这是**持续动作**：补一项只吃得住「该代 rc + 该代稳定版」，下一个 rc 代次仍需再补一项，任何单条区间都无法一次性向前覆盖未来的预发布代次。

影响面限于 npm。用 `npm pack` 产出的 tarball 安装（`file:` 指向目录时 npm 按 link 安装并跳过 `peerDependencies`，测不出结果）：在宿主 `0.2.1-rc.2` 下，枚举未补项时 `npm install` 以 `ERESOLVE` 失败（退出码 1），补入 `^0.2.1-rc.2` 后退出码 0；`pnpm install` 两种写法都是退出码 0，`pnpm peers check` 报 `No peer dependency issues found`，因为 pnpm 按范围交集判定而不走默认 satisfies。

自检（只读求值，不写入任何状态；需已安装 dsh，即 `command -v dsh` 有值）：

```bash
node -e 'const p=require("path"),{createRequire}=require("module");const s=createRequire(p.dirname(require.resolve("@deepseek-ai/dsh-app-boot",{paths:[process.argv[1]]})))("semver");const v="0.2.1-rc.2",r="^0.2.0-rc.2";console.log("gate includePrerelease:",s.satisfies(v,r,{includePrerelease:true}),"/ default semantics:",s.satisfies(v,r))' "$(command -v dsh)"
```

输出 `gate includePrerelease: true / default semantics: false`：同一个版本对同一个区间，在闸门比较方式（带 `includePrerelease`）下成立、在 node-semver 默认语义下不成立。

### 内核代次验证（2026-10-20 复核）

| DSH 内核 | 验证内容 | 结果 | 实测日期 |
|---|---|---|---|
| `0.1.1-rc.2` | host 入口链接、真实启动（headless）过插件阶段、真实启动（web）client bundle HTTP 200 | ✅ | 2026-09-07 |
| `0.1.2-rc.1` | host 入口链接、真实启动（headless）过插件阶段、真实启动（web）client bundle HTTP 200 | ✅ | 2026-09-07 |
| `0.2.1-rc.2` | `npx tsc --noEmit` 干净；`npx vitest run` 全部用例通过（unit + integration）；宿主兼容性闸门（`evaluatePluginCompatibility`）判 PASS | ✅ | 2026-10-20 |

两行 0.1.x 是历史实测记录：当前的 `engines.dsh` 区间不再覆盖 `0.1.1-rc.2` 与 `0.1.2-rc.1`（用宿主自带 semver 求值为假），这两个版本现在会被闸门拒绝，本插件不再声称支持。`0.2.1-rc.2` 这一行**只记录构建、测试与闸门三项**，真实启动（headless / web）在 0.2.x 上尚未验证。`peerDependencies` 的枚举里仍保留 `^0.1.1-rc.2` 与 `^0.1.2-rc.1` 两项，别把它读成功能承诺：声明了 `engines.dsh` 时 peers 整体不参与闸门判定，这两项的实际作用是让**安装期**解析得到满足。

本插件设置命名空间写作 `'wakatime' as SettingsNamespace`（type-only 导入），不使用 `settingsNamespace()` helper —— 它在 `0.1.2` 已被删除，运行时导入会让整个模块链接失败；格式校验两代都由 `ctx.settings.register()` 内部完成。`lib/client.js` 实测零内核导入，与代次无关。

## 安装

### 本地开发安装

```bash
# 在插件目录下执行
dsh plugin --profile web add /path/to/dsh-wakatime-plugin
```

### 从 Git 仓库安装

从内网 Gitea 安装：

```bash
# 从 Gitea 安装
dsh plugin --profile web add http://gitea.internal/dsh-plugins/dsh-wakatime-plugin.git

# 安装固定 commit（出于安全考虑推荐这种方式）
dsh plugin --profile web add http://gitea.internal/dsh-plugins/dsh-wakatime-plugin.git#<commit-sha>
```

或从 GitHub（或其他任意 git 托管平台）安装：

```bash
dsh plugin --profile web add github:your-username/dsh-wakatime-plugin
```

### 从源码构建

如果从 git 安装，需要先构建：

```bash
cd dsh-wakatime-plugin
pnpm install
pnpm build
```

或者添加一个 `prepare` 脚本，在 pnpm install 时自动构建：

```json
{
  "scripts": {
    "prepare": "tsc"
  }
}
```

## 配置

### WebUI 设置面板（推荐）

安装并重启 DSH 后：

1. 打开 WebUI
2. 进入 **Settings** → **WakaTime**
3. 配置以下选项：
   - **API Key**：你的 WakaTime API key（以密码框形式展示）
   - **API URL**：服务基础地址（用于自托管 WakaTime）
   - **Heartbeat Interval**：心跳发送间隔（60000–300000ms）
   - **Project Name**：覆盖自动识别的项目名
   - **Language**：覆盖自动识别的语言
   - **Track Tool Calls**：启用/禁用工具调用追踪
   - **Track User Messages**：启用/禁用用户消息追踪
   - **Track AI Messages**：启用/禁用 AI 消息追踪
   - **Cache Heartbeats**：启用/禁用本地缓存
   - **Cache Limit**：最大缓存心跳条数（10–1000）
   - **Debug Mode**：启用调试日志

所有设置即时生效（无需重启）。

### 其他配置方式

如果你更偏好配置文件：

**环境变量：**
```bash
export WAKATIME_API_KEY=sk-xxxxxxxxxxxx
```

**cordis.patch.yml：**
```yaml
- insert:
  - id: dsh-wakatime
    name: 'dsh-wakatime'
    config:
      api_key: sk-xxxxxxxxxxxx
      debug: true
```

**~/.wakatime.cfg（WakaTime 标准配置）：**
```ini
[settings]
api_key = sk-xxxxxxxxxxxx
```

### 配置优先级

1. WebUI 设置（最高优先级）
2. 环境变量 `WAKATIME_API_KEY`
3. `cordis.patch.yml` 配置
4. `~/.wakatime.cfg` 中的 api_key
5. 插件 schema 默认值（最低优先级）

## 类别映射

| DSH 工具 | WakaTime 类别 | is_write |
|---|---|---|
| `write` | `coding` | true |
| `edit` | `coding` | true |
| `read` | `browsing` | false |
| `bash` / `pwsh` | `building` | false |
| `grep` / `glob` | `browsing` | false |
| `web_search` | `researching` | false |
| `mcp__codegraph__codegraph_explore` | `code reviewing` | false |
| `mcp__langfuse__*` | `debugging` | false |
| `subagent` / `subagent_fork` | `coding` | false |
| `workflow` | `coding` | false |
| `todo_write` | `coding` | false |
| `ask_user_question` | `communicating` | false |
| 用户消息事件 | `communicating` | false |
| AI 回复事件 | `ai coding` | false |
| `skill` | `learning` | false |
| 其他 | `coding` | false |

## 架构

```
src/
├── index.ts      # 插件入口：注册事件监听与定时器
├── wakatime.ts   # WakaTime API HTTP 客户端
├── tracker.ts    # 文件级活动追踪器
├── project.ts    # 基于 git 的项目/分支推断
├── language.ts   # 按文件扩展名推断语言
├── diff.ts       # write/edit 的行数 diff 计算
├── cache.ts      # 本地心跳缓存（JSONL 文件）
├── settings.ts   # 配置 schema 与 WebUI 设置面板注册
└── types.ts      # 类型定义与常量
```

## 开发与打包

### 三个版本敏感的接线点（0.2.1 仍成立）

| 接线点 | 规则 | 依据 |
|---|---|---|
| WebUI 槽位 `plugins.bundle.config` 的 key | 是**插件包名**（`package.json` 的 `name`），不是 settings 命名空间，也不是 profile 条目 id；key 不匹配则该 bundle 页面没有配置卡片 | 宿主 `dsh-client-ui-plugin-manager/lib/types/client/slot-contract.d.ts:149`（"keyed by the bundle's package name"），渲染处 `lib/client.js:2964` 传 `{ entryKey: pkg.name }` |
| `@deepseek-ai/dsh-client-ui-primitives` 的引用方式 | 必须保持 **external**，不能打进 `lib/client.js`：宿主 web 模块表常驻该 id，官方 client 包同样 `require("@deepseek-ai/dsh-client-ui-primitives")`；打进包会把整套图标复制一份 | 宿主 `dsh-web-frontend/dist/assets/index-*.js` 模块表含该 id；`dsh-client-ui-plugin-manager/lib/client.js:10`；本仓库 `build.mjs:28` |
| 设置页自动投影 | 依赖插件 Config 上的 `.volatile()`；0.2.1 里投影逻辑仍在宿主 `dsh-app-boot`（把 `volatile` 写进 schema 的 `x-cordis`） | 本仓库 `src/index.ts:37-47`；宿主 `dsh-app-boot/lib/index.js:2606`（`validateVolatilePlacement`）与 `:2735` 起的投影分支 |

### 依赖与宿主版本漂移

| 事项 | 说明 |
|---|---|
| 包管理器只有 pnpm | 仓库只认 `pnpm-lock.yaml`（配套 `pnpm-workspace.yaml`），没有 `package-lock.json`；安装与锁文件更新一律走 pnpm |
| 开发期依赖精确钉版 | devDependencies 把 `@deepseek-ai/dsh-agent` / `@deepseek-ai/dsh-session` / `@deepseek-ai/dsh-settings` / `@deepseek-ai/dsh-client-ui-primitives` 全部钉到 `0.2.1-rc.2`（`@deepseek-ai/cordis` `^4.0.5`、`@deepseek-ai/schemastery` `^3.18.5` 仍为区间）。这只是开发期取值，不构成对外契约：运行时闸门只看 `engines.dsh`，对外区间是上面的 peer 列表。`@deepseek-ai/dsh-client-ui-primitives` 列为显式 devDependency 只为开发期解析，打包时仍必须保持 external（见上表） |
| 宿主一方包 peers 精确 pin | 0.2.1 起宿主各包对 `@deepseek-ai/dsh-*` 的 peers 全部精确 pin 到同一版本（`@deepseek-ai/cordis` 仍是 `~4.0.5` 区间）。这是宿主 monorepo 内部的做法，插件不要照抄，见上方「peers 要写区间」 |
| `@deepseek-ai/dsh-invariants` 已停更 | registry 末版为 `0.2.0-rc.2`，0.2.1-rc.2 的宿主包集合里没有这个包；devDependencies 里若残留它，升级后应移除 |
| 0.2.1 移除设置客户端的 memory 持久化模式 | `ConfigFormSnapshot` 不再有 `mode: 'host' \| 'memory'`；describe mirror 的 `SettingsMirrorSnapshot.status` 不再有 `'unavailable'`，只剩 `'idle' \| 'loading' \| 'ready'`；`ConfigFormController` 构造函数少一个 persistence 参数（现为 `ctx, spec, mirror, schema`）。依据：宿主 `dsh-client-ui-settings/lib/types/client/config-form-types.d.ts:6-29`、`settings-mirror.d.ts:21-31`、`config-form.d.ts:49`。插件代码不得读取 `snapshot.mode` |
| 写入返回受理结果（0.2.0 起的既有契约，非 0.2.1 新增） | `ConfigForm.set` / `unset` / `mutate` 返回 `Promise<boolean>`：`true` 为 Host 受理，`false` 为被拒绝或写入被跳过；传输失败仍会 reject。依据：`config-form-types.d.ts:49-70` |

## 常见问题

### 插件没有加载

1. 检查 `lib/` 目录是否存在且包含编译后的 JS 文件
2. 如果缺失，运行 `pnpm run build`
3. 查看 DSH 日志中的报错信息

### WebUI 中看不到设置项

1. 确认插件已加入 `package.json` 的 `bundles` 列表
2. 完全重启 DSH
3. 检查浏览器控制台是否有报错

### 心跳没有发送

1. 确认 API Key 正确
2. 检查到 WakaTime 的网络连通性
3. 开启 debug 模式查看详细日志
4. 检查 `~/.dsh/wakatime/heartbeat-cache.jsonl` 是否有缓存待发的心跳

## 许可证

MIT
