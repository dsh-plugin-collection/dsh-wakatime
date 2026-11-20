/**
 * User-Agent 构造与 AI 模型 token 归一化。
 *
 * WakaTime 侧有三个面板**不是**由心跳字段直接驱动的，而是从 `user_agent`
 * 字符串里解析出来的（官方 `wakatime-cli` 的 `pkg/ai/ai.go` 与
 * `pkg/heartbeat/heartbeat.go` 的 `UserAgent`）：
 *
 *  - **Editors**：括号后的第一个 product token；
 *  - **Operating Systems**：`(...)` 括号段里的 `OS-core-platform`；
 *  - **Models / AI Coding**：UA 里的**模型 token**（心跳结构里根本没有
 *    `ai_model` 字段，只有 `ai_line_changes` 等 7 个 AI 字段）。
 *
 * 早先本插件发的是 `dsh/1.0.0 dsh-wakatime/1.0.0`——没有括号段，也没有模型
 * token，于是 Operating Systems 落到 `Unknown OS`、Models 面板永远空白
 * （Editors 反而正常，因为第一个 product 被当作 editor 了）。
 *
 * 本模块按官方模板补齐：
 *
 * ```
 * wakatime/<ver> (<OS>-<core>-<platform>) <runtime> <editor> [<model-token>]
 * ```
 *
 * `wakatime/` 前缀是硬要求：官方 `splitUserAgent()` 只在串以 `wakatime/`
 * 开头时才把前半段当 header（含 OS 括号），否则整串都当 products，OS 段
 * 就解析不出来。
 *
 * @module dsh-wakatime/user-agent
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { release } from 'node:os';

/**
 * 官方 UA 模板里的 OS 名。
 *
 * 取值来自本账号 `user_agents` 端点里 50 条官方 CLI 的真实样本，括号段一律
 * `(linux-<内核>-<arch>)`——**小写**，不是 `Linux`。这一项直接决定 Operating
 * Systems 面板的归类键，大小写不一致会多出一个新条目而不是并入已有归类。
 */
function osName(platform: NodeJS.Platform): string {
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'darwin';
  return 'linux';
}

/**
 * 官方括号段第三项（platform/arch）的写法。
 *
 * 官方 CLI 写 `x86_64`；Node 的 `process.arch` 是 `x64`，直接塞进去会变成
 * `x64` 这个陌生值，和官方条目分家。这里按官方词汇表映射。
 */
function archName(arch: string): string {
  if (arch === 'x64') return 'x86_64';
  if (arch === 'arm64') return 'aarch64';
  if (arch === 'ia32') return 'i686';
  return arch;
}

/**
 * 模型 token 归一化 —— 逐条移植官方 `aiModelUserAgentToken`。
 *
 * 服务端靠这个 token 把心跳归到某个 model family（`claude/3-5-sonnet-…`、
 * `gpt/4o` 等）。规则比想象的挑剔，例如：
 *
 *  - `deepseek-v4.1-flash-eco` → `deepseek/4.1-flash-eco`
 *  - `gpt-4o`                   → `gpt/4o`
 *  - `claude-3-5-sonnet-…`      → `claude/3-5-sonnet-…`
 *  - `dsh-opendesign-go`        → `''`（无数字段 → 识别不出，宁可不发）
 *
 * 空串必须**不**拼进 UA：发出一个识别不出的 token 只会污染 user_agents
 * 表，而不会点亮任何面板。
 *
 * @param model - 宿主提供的模型 id（`message.source.model`）。
 * @param complexity - 可选复杂度后缀（本插件不采集，留空）。
 * @returns 归一化后的 token；识别不出时返回空串。
 */
export function aiModelToken(model: string, complexity = ''): string {
  let m = model.trim().split(/\s+/).filter((s) => s !== '').join('-');
  m = m.replace(/^\/+|\/+$/g, '');
  if (m === '') return '';

  let cx = (complexity ?? '').trim().split(/\s+/).filter((s) => s !== '').join('-');
  cx = cx.replace(/^[-_/.]+|[-_/.]+$/g, '');
  if (cx !== '' && !m.toLowerCase().endsWith(`-${cx.toLowerCase()}`)) {
    m += `-${cx}`;
  }

  // 已经是 `product/version` 形状且 version 以数字开头：原样保留。
  const slash = m.indexOf('/');
  if (slash !== -1) {
    const product = m.slice(0, slash);
    const version = m.slice(slash + 1);
    if (product !== '' && version !== '' && /^[0-9]/.test(version)) {
      return `${product}/${version}`;
    }
  }

  // 否则取最后一个 `/` 之后的部分继续解析。
  if (slash !== -1) {
    const last = m.lastIndexOf('/');
    m = m.slice(last + 1).replace(/^[-_.]+|[-_.]+$/g, '');
  }

  const parts = m.split(/[-_]/).filter((p) => p !== '');
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]!;
    for (let j = 0; j < part.length; j += 1) {
      const ch = part[j]!;
      if (ch < '0' || ch > '9') continue;

      if (j === 0) {
        // 整个 segment 就是一个纯数字：前一个 segment 是 family，从数字起是版本。
        if (i === 0) return '';
        return `${parts[i - 1]}/${parts.slice(i).join('-')}`;
      }

      // 数字出现在 segment 中间：数字前是 family（`v` 要回退到上一个 segment），
      // 数字起连同后续 segment 是版本。
      let product = part.slice(0, j);
      if (product.toLowerCase() === 'v' && i > 0) product = parts[i - 1]!;
      let version = part.slice(j);
      if (i + 1 < parts.length) version += `-${parts.slice(i + 1).join('-')}`;
      return `${product}/${version}`;
    }
  }

  // 全文无数字：官方同样返回空（例如 `dsh-opendesign-go`）。
  return '';
}

/**
 * 探测宿主（dsh）版本，用于 UA 里的 `dsh/<ver>` 与 `wakatime/<ver>` 无关的那一段。
 *
 * 为什么要专门探测：插件**不能**直接 `require('@deepseek-ai/dsh/package.json')`
 * ——实测从插件运行位置解析该包会 `MODULE_NOT_FOUND`（两侧 node_modules 是
 * 不同的安装树），而解析到的 `dsh-session` 是**插件自己的 devDependency**
 * （0.2.1-rc.2），不是运行中的宿主（0.2.2-rc.5），拿它填 UA 会报错版本。
 *
 * 可靠来源是宿主进程自身的入口路径：`process.argv[1]` 指向 `.bin/dsh`，
 * 其 realpath 落在 `<install>/node_modules/@deepseek-ai/dsh/lib/bin.js`，
 * 向上找最近的 package.json 即宿主清单。取不到就回退空串（UA 里省略该段），
 * 绝不猜一个版本填进去。
 *
 * @returns 宿主版本（如 `0.2.2-rc.5`），探测失败返回空串。
 */
let hostVersionCache: string | undefined;

export function detectHostVersion(): string {
  if (hostVersionCache !== undefined) return hostVersionCache;
  hostVersionCache = detectHostVersionUncached();
  return hostVersionCache;
}

function detectHostVersionUncached(): string {
  try {
    const entry = process.argv[1];
    if (typeof entry !== 'string' || entry === '') return '';
    // 本插件是 ESM（package.json `"type": "module"`）：这里**不能**写 `require`。
    // 实测踩过——TypeScript 不报错、tsc 原样保留、单测（vite 转译）也能过，
    // 但宿主进程里 `typeof require === 'undefined'`，调用直接抛 ReferenceError，
    // 被外层 catch 吞成空串：活心跳的 UA 里就少了 `dsh/<ver>` 这一段。
    // 顶部的静态 import 在 ESM 下才是有效的。
    let dir = dirname(realpathSync(entry));
    for (let depth = 0; depth < 8; depth += 1) {
      const manifest = join(dir, 'package.json');
      if (existsSync(manifest)) {
        const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
        if (typeof parsed === 'object' && parsed !== null) {
          const name = (parsed as { name?: unknown }).name;
          const version = (parsed as { version?: unknown }).version;
          if (typeof version === 'string' && version !== '' && typeof name === 'string' && name.startsWith('@deepseek-ai/dsh')) {
            return version;
          }
        }
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return '';
  } catch {
    return '';
  }
}

/**
 * 取本插件对外用的 User-Agent（每次调用都重新拼）。
 *
 * UA 里的模型 token 由调用方传入（心跳层持有「最近一次模型」缓存），这里不
 * 自己做状态管理——同一进程里不同会话的模型可能不同，缓存该由会话侧决定。
 *
 * @param model - 当前会话最近一次使用的模型 id；空/未知识别不出时 UA 不含模型段。
 */
export function currentUserAgent(model?: string): string {
  return buildUserAgent({
    hostVersion: detectHostVersion(),
    pluginVersion: pluginVersion(),
    ...(model === undefined ? {} : { model }),
  });
}

/** 构造 UA 所需的运行时信息；全部可注入，便于测试。 */
export interface UserAgentParts {
  /** 宿主版本（`dsh/<ver>` 中的版本）；空串表示探测失败，UA 中省略该段。 */
  hostVersion: string;
  /** 本插件版本。 */
  pluginVersion: string;
  /** 模型 id（可为空：识别不出时不拼 token）。 */
  model?: string;
  /** 复杂度后缀（一般留空）。 */
  complexity?: string;
  /** Node 运行时版本，默认取 `process.versions.node`。 */
  nodeVersion?: string;
  /** 平台，默认取 `process.platform`。 */
  platform?: NodeJS.Platform;
  /** CPU 架构，默认取 `process.arch`；会按官方词汇表映射（x64 → x86_64）。 */
  arch?: string;
  /** 内核版本，默认取 `os.release()`。 */
  kernelRelease?: string;
}

/**
 * 拼 User-Agent。
 *
 * 形状（**实测形状**，不是照抄官方模板，原因见下）：
 *
 * ```
 * <modelToken|dsh/0.0.0> dsh/<hostVer> (<OS>-<core>-<platform>) node/<ver> dsh-wakatime/<pluginVer>
 * ```
 *
 * ## 为什么不是官方模板
 *
 * 官方 `wakatime-cli` 的模板是 `wakatime/%s (%s-%s-%s) %s %s`，本插件最初也照抄了
 * 它。但 `user_agents` 端点会返回**服务端对每条 UA 的解析结果**（`ai_model` /
 * `ai_model_version` / `editor`），实测十几种变体后得到两条硬结论：
 *
 *  1. **UA 以 `wakatime/<ver>` 开头时，服务端把 wakatime 自己当成模型**：
 *     `ai_model='Wakatime'`、`ai_model_version=<插件版本>`，后面的模型 token 全被
 *     忽略。照抄官方模板必然得到这个结果——Models 面板显示的会是 `Wakatime`。
 *  2. **模型 token 放在首位才能被识别**：
 *     `deepseek/4.1-flash-eco dsh/<v> (linux-…) node/<v> dsh-wakatime/<v>`
 *     → `ai_model='DeepSeek'`、`ai_model_version='4.1-flash-eco'`、`editor='Dsh'`。
 *
 * 代价：没有 `wakatime/` 头，官方 `splitUserAgent` 切不出 header；但实测括号段
 * 仍被服务端识别（它对 `(linux-…-x86_64)` 做子串匹配），`editor` 则要靠在末尾
 * 放 `dsh-wakatime/<ver>` 才回落成 `Dsh`——所以末尾那个 token **不能省**。
 *
 * ## 无模型时
 *
 * 模型识别不出（如 `dsh-opendesign-go` 没有版本号）时，首位放 `dsh/<hostVer>`：
 * 宁可让这条心跳不计入任何模型，也不发一个解析不了的 token（那只会往
 * `user_agents` 表里灌垃圾条目）。宿主版本探测不到时用 `0.0.0` 占位——它必须
 * 占住首位（否则括号段会落到首位、被当成模型名），又明显不是真版本号。
 *
 * @param parts - 见 {@link UserAgentParts}。
 * @returns 单行 UA 字符串。
 */
export function buildUserAgent(parts: UserAgentParts): string {
  const platform = parts.platform ?? process.platform;
  const kernel = parts.kernelRelease ?? safeRelease();
  const nodeVersion = parts.nodeVersion ?? process.versions.node;
  const arch = archName(parts.arch ?? process.arch);
  const os = osName(platform);

  // 宿主版本探测不到时用 `0.0.0`：必须占住首 token 的位置（否则括号段会落到
  // 首位、被服务端当成模型名），同时它明显不是真实版本，不会冒充具体版本号。
  const host = parts.hostVersion === '' ? '0.0.0' : parts.hostVersion;

  const token = parts.model === undefined ? '' : aiModelToken(parts.model, parts.complexity ?? '');

  // ── 为什么模型在最前面、而不是官方那样跟在 `wakatime/` 头之后 ──
  //
  // 实测（`user_agents` 端点会返回服务端解析结果，见 1.2.2 的 CHANGELOG）：
  // 只要串以 `wakatime/<ver>` 开头，服务端就把**那个 wakatime 自己**当成模型
  // （`ai_model='Wakatime'`、`ai_model_version=<插件版本>`），后面的模型 token
  // 一律忽略。这正是面板里出现 `Wakatime 100%` 的原因。
  //
  // 把模型 token 提到首位则是实测可用的形状：
  //   deepseek/4.1-flash-eco dsh/0.2.2-rc.5 (linux-…) node/24.22.0 dsh-wakatime/1.2.2
  //     → ai_model='DeepSeek'  ai_model_version='4.1-flash-eco'  editor='Dsh'
  // 代价是丢了 `wakatime/` 头——官方 `splitUserAgent` 靠它切 header/products，
  // 没有它 OS 括号段理论上解析不到。**但实测括号段仍在**（服务端自己对
  // `(linux-…-x86_64)` 做子串识别），代价是 `editor` 字段要靠末尾的
  // `dsh-wakatime/<ver>` 才回落成 `Dsh`——所以这个 token 不能省。
  const head = token === '' ? `dsh/${host}` : `${token} dsh/${host}`;
  const system = `(${os}-${kernel}-${arch})`;
  const tail = `node/${nodeVersion} dsh-wakatime/${parts.pluginVersion}`;

  return `${head} ${system} ${tail}`;
}

/**
 * 构建期注入的本插件版本占位。
 *
 * `build.mjs` 在 tsc 之后把这一整行替换成 `package.json` 的真实版本字面量；
 * 源码里**绝不手写版本号**——UA 曾长期停在 `1.0.0`，而包已经发到 `1.1.0`，
 * 就是手写造成的脱钩。未注入时（vitest 直接跑源码）为 undefined。
 */
const INJECTED_PLUGIN_VERSION: string | undefined = undefined;

/** 取本插件版本：构建期注入值优先，未注入时回退 `0.0.0`（测试环境）。 */
export function pluginVersion(): string {
  return typeof INJECTED_PLUGIN_VERSION === 'string' && INJECTED_PLUGIN_VERSION !== ''
    ? INJECTED_PLUGIN_VERSION
    : '0.0.0';
}

/** `os.release()` 在极少数容器里会抛；UA 构造不能因此中断心跳。 */
function safeRelease(): string {
  try {
    return release() || 'unknown';
  } catch {
    return 'unknown';
  }
}
