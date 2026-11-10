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
- **逐条可观测的批量上报** —— `heartbeats.bulk` 的契约是「外层恒 2xx + 逐条状态码」；插件逐条判定：4xx 校验失败视为永久失败（丢弃并告警，带服务端原因），429/5xx 回缓存重试。字符串字段按服务端硬上限预先裁剪（`entity` ≤ 2083，`project` / `branch` ≤ 1024；空串同样被服务端拒绝，这类字段整个不发）
- **安全的缓存冲刷** —— 并发冲刷串行化；只把【确实没落库】的心跳写回，已入库的一条都不重发，永久无效的不再占缓存名额
- **实时生效的设置** —— 所有 WebUI 设置即时生效：开关逐事件检查，心跳间隔变更原地重建定时器
- **本地缓存** —— 发送失败的心跳写入本地缓存，下次成功发送时自动重试；失败与丢弃一律告警并带原因，不再只在 debug 模式下打印
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
   - **Terminal App Name**：命令执行类心跳的 entity（应用名）；留空按 `Terminal` 上报
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
| `bash` / `pwsh` | 由命令本身判定，见下方「shell 类别判定」 | false |
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

### 四个版本敏感的接线点（0.2.2 仍成立）

| 接线点 | 规则 | 依据 |
|---|---|---|
| WebUI 槽位 `plugins.bundle.config` 的 key | 是**插件包名**（`package.json` 的 `name`），不是 settings 命名空间，也不是 profile 条目 id；key 不匹配则该 bundle 页面没有配置卡片 | 宿主 `dsh-client-ui-plugin-manager/lib/types/client/slot-contract.d.ts:149`（"keyed by the bundle's package name"），渲染处 `lib/client.js:2964` 传 `{ entryKey: pkg.name }` |
| `@deepseek-ai/dsh-client-ui-primitives` 的引用方式 | 必须保持 **external**，不能打进 `lib/client.js`：宿主 web 模块表常驻该 id，官方 client 包同样 `require("@deepseek-ai/dsh-client-ui-primitives")`；打进包会把整套图标复制一份 | 宿主 `dsh-web-frontend/dist/assets/index-*.js` 模块表含该 id；`dsh-client-ui-plugin-manager/lib/client.js:10`；本仓库 `build.mjs:28` |
| 设置页自动投影 | 依赖插件 Config 上的 `.volatile()`；投影逻辑在宿主 `dsh-app-boot`（把 `volatile` 写进 schema 的 `x-cordis`） | 本仓库 `src/index.ts`；宿主 `dsh-app-boot/lib/index.js` 的 `validateVolatilePlacement` 与投影分支 |
| `.volatile()` 字段交到插件手里是 **ref 对象**，不是值 | `apply()` 收到的每个 volatile 字段都是 `Object.freeze({ get: () => value, [write]: … })`；**必须解包后才能用**，`dsh-settings` 自己也是这么做的（`plainConfig`）。直接当值用会以多种方式静默失效：`api_url` 拼出非法 URL、`heartbeat_interval_ms` 被 Node 当 1ms、布尔恒真、字符串字段整个不发、`cache_limit` 比较恒 false。本插件统一在 `src/config-value.ts` 规范化，入口与文档层都过一遍 | 宿主 `cosmokit/lib/index.js` 的 `createVolatile` / `isVolatile`；`dsh-settings/lib/index.js` 的 `plainConfig`（`if (isVolatile(value)) return plainConfig(value.get())`）；0.2.1 与 0.2.2 两代实测一致 |

### 依赖与宿主版本漂移

| 事项 | 说明 |
|---|---|
| 包管理器只有 pnpm | 仓库只认 `pnpm-lock.yaml`（配套 `pnpm-workspace.yaml`），没有 `package-lock.json`；安装与锁文件更新一律走 pnpm |
| `typescript` 必须是显式 devDependency | `scripts.build` / `prepare` / `watch` 都调 `tsc`。11-10 之前它**根本不在 devDependencies 和 lockfile 里**（grep 命中 0），构建能成纯粹因为环境里恰好有个外来 tsc——换机器、干净 clone、或 `pnpm install --frozen-lockfile` 都会直接构建失败（`prepare` 在装依赖时就会炸）。现已声明 `typescript: ^5.9.0`（与同 workspace 的兄弟插件一致），构建脚本改用本地 `./node_modules/.bin/tsc` 而不是 `npx tsc`（`npx` 在缺失时会去装一个同名废弃包 `tsc@2.0.4`，报"这不是你要的 tsc"） |
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

按这个顺序查，能在十分钟内定位到原因（本插件曾因此静默断流一整周）：

1. **先看本地缓存，而不是先看日志。** `~/.dsh/wakatime/heartbeat-cache.jsonl`
   只有在发送失败时才写入，发送成功时会被排空。它**持续增长或长期顶在 Cache Limit
   上限**就说明发送在持续失败；此时越旧的心跳被挤掉得越多，那段活动已经不可恢复。
   （缓存**远超** Cache Limit 也是一个信号：说明 `cache_limit` 本身没被当成数字
   用到了——见第 3 步的配置降级。）
2. **读告警，不需要开 debug。** 失败一律无条件 warn 并带原因，且 **logger + console
   双写**（本宿主的 `ctx.logger` 不进 stdout/stderr 捕获文件，只走 logger 等于没有
   日志——这是本插件两次静默断流没人发现的直接原因）：
   `上报失败…`（传输/鉴权/限流）、`N/M 条心跳被 WakaTime 逐条拒绝并已丢弃…`
   （载荷不合法）、`cache flush failed…`（补发也发不出去）。
3. **升级宿主后先看有没有「配置字段不是可用值」这条告警。** 标了 `.volatile()` 的
   字段由 cosmokit 以 `Object.freeze({ get, [write] })` 的 **ref 对象**交给插件，
   插件侧统一在 `src/config-value.ts` 解包并逐类型校验；一旦某字段解不出可用值，
   会回退默认值/现值并列出字段名与形状（不含值）。为什么必须有这层：ref 直接当值用
   时，同一个升级会同时造成 `api_url` → 非法 URL（请求根本没发出）、
   `heartbeat_interval_ms` → `setInterval(fn, NaN)` 被 Node 当成 1ms（隔离进程里复现过
   1 秒 915 次；但**宿主日志里从未出现对应警告**，所以这里只断言 Node 的既定行为，
   不断言它必然在宿主内发生，也不把任何 CPU 数字归因给它——重启并规范化配置之后宿主
   CPU 仍在 240% 量级，说明瓶颈不在这里）、`include_*=false` → 对象恒 truthy（关掉的追踪照发）、
   `project_name`/`language` → 两个字段整个不发、`cache_limit` → 缓存永不裁剪。
4. **确认这把 key 真的可用。** 设置页「项目名称」下拉走的是同一把 key：
   候选为空且带 `error` 就是 key 或连通性问题（`API Key 无效` = 服务端回了 401；
   `未配置 WakaTime API Key` = 三层来源都没有可用值）。
   key 的取值顺序是配置层 → `WAKATIME_API_KEY` → `~/.wakatime.cfg`，
   三层都只接受**非空字符串**，形状不对会被忽略并继续回退，同时在告警里给出形状摘要。
5. **检查到 WakaTime 的网络连通性，并注意代理口径。** 出口代理的优先级是
   `HTTPS_PROXY` / `HTTP_PROXY` 环境变量 → `~/.wakatime.cfg` 的 `[settings] proxy`
   （与 wakatime-cli 同一个来源），`NO_PROXY` 支持 `*`、精确主机与 `.suffix` 写法。
   为什么插件要读 cfg：实测同一台机器上 curl 直连、curl 经代理、node 直连都 20/20 通，
   唯独插件间歇 `fetch failed（cause: ETIMEDOUT）`——因为它是同机上唯一不走代理的那条
   链路，而用户的代理本来就配在 cfg 里。诊断信息现在会带 `cause`（ECONNRESET /
   ETIMEDOUT / ENOTFOUND…），不再只有一句 `fetch failed`。
6. **怀疑「跑的不是你改的代码」时先确认构建指纹。** 日志里
   `apply called; artifact mtime=… pid=…` 直接回答这个进程载入了哪一次构建。
   热重载可能留下旧 fiber 继续以旧代码发送——行为与代码不一致时先完全重启 DSH。
7. **载荷长度是硬校验。** `entity` ≤ 2083、`project` / `branch` ≤ 1024，
   空串同样被拒。插件会先裁剪再发，被裁剪过的 `entity` 以 `...` 结尾；
   仍然出现「逐条拒绝」告警时，说明有字段不在裁剪覆盖范围内，请把告警里的
   服务端原因贴到 issue 上。
8. **想直接用 API 回读自己的数据时，插件 key 已经不够了。** WakaTime 自 2026-10 起
   对读端点（`/users/current`、`/users/current/projects`、`/users/current/heartbeats`）
   使用插件 key 返回 `403 API Keys are only for plugins, use your personal oauth token`，
   而**写端点 `heartbeats.bulk` 仍接受插件 key**。两个后果：设置页「项目名称」下拉会
   一直是空的（上游策略变化，不是本插件的鉴权 bug）；排查时也别把这次 403 误读成
   key 失效——判断 key 是否可用，请用写端点或本插件的失败告警。

### shell 类别判定

`bash` / `pwsh` 的类别由命令本身决定（`src/category.ts`），不再一律记 `building`。
用账号里已存的 5290 条 shell 心跳复盘，改动前后的分布是：

| 类别 | 改动前 | 改动后 |
|---|---|---|
| `building` | 100.0% | 1.3% |
| `coding` | — | 50.6% |
| `browsing` | — | 46.4% |
| `researching` | — | 0.8% |
| `running tests` | — | 0.5% |
| `debugging` | — | 0.3% |

也就是说此前看到的「构建时间」里 98.7% 其实不是构建。

判定规则与几点硬约束：

- **只看裸子命令，不看后续参数。** 反例是 `grep -n foo test/a_test.py`——路径里
  含 `test` 曾被误判成跑测试（账号里凭空多出 411 条假测试记录）。文件检视类命令
  （`ls` / `cat` / `grep` / `sed` / `head` …）无条件算 `browsing`。
- **先剥包装层**：前导 `cd <dir> &&`、`export`、`sudo` / `time` / `timeout`、
  以及 `npx` / `bunx` 的一次性执行前缀（含 `--yes`、`--package <包>`、`vitest@2`
  这些形式），否则 DSH 会话里最常见的 `cd repo && pnpm test | tail` 永远取到 `cd`。
- **类别取值只用 WakaTime 权威集合**（见 `wakatime-cli` 的 `pkg/heartbeat/category.go`）：
  表里没有 `deployment`，也没有 `testing`（正确值是 `running tests`）；自造词在面板上
  无法聚合。`docker` / `kubectl` 这类平台工具因此按子命令拆成 `browsing`（看状态）
  与 `building`（执行变更）。
- 认不出来的命令按 `coding` 计。

### 命令心跳的 entity

`bash` / `pwsh` 心跳的 `type` 是 `app`。按 wakatime-cli 的定义（*"AppType represents
an app entity"*），app 类型的 entity 应该是**应用名**，不是命令行。此前把整行命令当
entity，实测 5281 条 shell 心跳散成 **5158 个不同 entity，其中 98.2% 只出现过一次**——
既没有聚合价值，又随时可能撞 entity 的 2083 字符硬校验被逐条 400 拒收。

现在它取设置项「终端应用名」，默认 `Terminal`，可填成 `DSH` 之类；留空回退默认值
（空 entity 会被服务端拒绝，不存在"发空值"这条路）。命令在做什么由 `category` 表达。
5 秒窗口内的重复调用仍会合并成一条，但合并键是 `entity + category`——否则同一应用名
下，一条 `ls` 会把 5 秒前的 `pnpm test` 覆盖掉。

用户消息 / AI 回复类心跳**有意保留** `dsh-session-<id>` 作为 entity：它的基数由会话数
决定（有界），且是唯一能按会话下钻的维度；AI 侧另有 `ai_session` 字段承载会话身份。

遗留边界：shell 心跳的 `language` 仍固定为 `Shell`；entity 形态一经改变无法回溯，
按 entity 维度的跨版本对比会断裂。

## 许可证

MIT
