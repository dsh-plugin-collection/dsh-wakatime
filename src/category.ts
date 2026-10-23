/**
 * shell 命令 → WakaTime category 的判定。
 *
 * 为什么要单独成模块：此前 `bash` / `pwsh` 一律上报 `building`。用账号里
 * 已存的 5281 条 shell 心跳复盘，真正在构建的只有 **0.5%**，另外 52.8% 是
 * git/脚本类活动（应为 coding）、44.9% 是 ls/grep/sed 类文件检视（应为
 * browsing）——面板上的「构建时间」几乎全由查看文件堆出来。
 *
 * 类别取值只能用 WakaTime 的权威集合（wakatime-cli `pkg/heartbeat/category.go`）：
 * advising / ai coding / browsing / building / code reviewing / coding /
 * communicating / debugging / designing / indexing / learning / manual testing /
 * meeting / planning / researching / running tests / supporting / translating /
 * writing docs / writing tests。
 * 表里没有 `deployment`，也没有 `testing`——凭印象造词会让数据落进一个面板上
 * 无法聚合的类别。部署类工具因此按子命令拆进 browsing（看状态）与 building（
 * 执行变更）两档。
 *
 * 判定的第一原则：**只看裸子命令，不看后续参数。**
 * 反例（实测踩过）：`grep -n "timezone" test/backend/test_ema_tools.py` 里
 * 路径含 `test`，按「整条命令包含 test 就算测试」的规则会被判成 running tests，
 * 账号里因此凭空多出 411 条假测试记录。
 *
 * @module dsh-wakatime/category
 */

/** 兜底类别：认不出来的命令按编写活动计。 */
export const SHELL_DEFAULT_CATEGORY = 'coding';

/** 文件与状态检视类命令：读信息，不产出代码。 */
const INSPECT_TOOLS = new Set([
  'ls', 'll', 'cat', 'bat', 'head', 'tail', 'less', 'more', 'find', 'fd', 'locate',
  'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'sed', 'awk', 'jq', 'yq', 'cut', 'tr',
  'sort', 'uniq', 'wc', 'diff', 'coldiff', 'tree', 'stat', 'file', 'which', 'whereis',
  'type', 'pwd', 'env', 'printenv', 'echo', 'printf', 'du', 'df', 'lsblk', 'lsof',
  'ps', 'pgrep', 'top', 'htop', 'free', 'uptime', 'date', 'cal', 'id', 'whoami',
  'uname', 'ip', 'ifconfig', 'netstat', 'ss', 'curl', 'dig', 'nslookup', 'ping',
]);

/** 网络取数类：查资料而不是发请求做变更。 */
const RESEARCH_TOOLS = new Set(['curl', 'wget', 'http', 'dig', 'nslookup', 'ping', 'traceroute', 'host']);

/** 检视/测试类网络与平台子命令（跟着工具名一起判）。 */
const PLATFORM_INSPECT_SUBCOMMANDS = new Set([
  'get', 'describe', 'logs', 'top', 'ps', 'images', 'inspect', 'status', 'show',
  'list', 'ls', 'diff', 'plan', 'history', 'version', 'info', 'config', 'cat', 'stat',
]);

/** 执行变更的平台子命令：属于构建/发布动作。 */
const PLATFORM_MUTATE_SUBCOMMANDS = new Set([
  'apply', 'deploy', 'rollout', 'run', 'exec', 'up', 'scale', 'create', 'delete',
  'build', 'push', 'compose', 'install', 'uninstall', 'migrate', 'sync', 'cp',
]);

/** 平台/容器/发布类工具：类别由子命令决定。 */
const PLATFORM_TOOLS = new Set([
  'docker', 'podman', 'kubectl', 'k', 'helm', 'terraform', 'terragrunt', 'ansible',
  'ansible-playbook', 'vagrant', 'fly', 'heroku', 'vercel', 'netlify', 'wrangler',
  'rsync', 'scp', 'sftp', 'ssh', 'gh', 'aws', 'gcloud', 'az', 'systemctl', 'service',
]);

/** 版本控制类：改动代码库本身，算编写活动。 */
const VCS_TOOLS = new Set(['git', 'svn', 'hg', 'jj', 'tea']);

/** 测试运行器：命令名即足以判定。 */
const TEST_RUNNERS = new Set([
  'pytest', 'jest', 'vitest', 'mocha', 'karma', 'rspec', 'ctest', 'playwright',
  'cypress', 'jasmine', 'behave', 'phpunit', 'phpspec', 'xunit', 'nunit', 'dotnet-test',
]);

/** Lint / 格式化 / 类型检查：属于排障与质量活动。 */
const LINT_TOOLS = new Set([
  'eslint', 'prettier', 'biome', 'stylelint', 'ruff', 'flake8', 'pylint', 'mypy',
  'black', 'isort', 'bandit', 'clang-tidy', 'cppcheck', 'shellcheck', 'hadolint',
  'yamllint', 'markdownlint', 'gitleaks', 'semgrep', 'knip', 'cspell',
]);

/** 构建工具：类别主要由子命令决定，认不出时按 building 计。 */
const BUILD_TOOLS = new Set([
  'make', 'cmake', 'ninja', 'bazel', 'scons', 'meson', 'xcodebuild', 'msbuild',
  'gradle', 'mvn', 'cargo', 'rustup', 'go', 'dotnet', 'msbuild', 'tsc', 'esbuild',
  'rollup', 'vite', 'webpack', 'babel', 'turbo', 'nx', 'pnpm', 'npm', 'yarn', 'bun',
  'deno', 'pip', 'pip3', 'poetry', 'uv', 'conda', 'composer', 'bundle', 'mix',
  'cabal', 'stack', 'sbt', 'leiningen', 'gcc', 'g++', 'clang', 'clang++', 'javac', 'javap',
]);

/** 子命令 → 类别（构建工具与平台工具共用）。 */
const SUBCOMMAND_CATEGORY: Record<string, string> = {
  test: 'running tests',
  tests: 'running tests',
  t: 'running tests',
  check: 'debugging',
  typecheck: 'debugging',
  'type-check': 'debugging',
  lint: 'debugging',
  lintfix: 'debugging',
  fmt: 'debugging',
  format: 'debugging',
  fix: 'debugging',
  build: 'building',
  b: 'building',
  compile: 'building',
  bundle: 'building',
  clean: 'building',
  install: 'building',
  add: 'building',
  remove: 'building',
  uninstall: 'building',
  update: 'building',
  publish: 'building',
  release: 'building',
};

/**
 * 一行 shell 里的「第一个真实命令」。
 *
 * 依次剥掉：前导 `cd <dir> &&`、`export`/`set` 之类环境设置、按 `&&`/`;`/`||`/
 * `|`/换行切出的各段，以及 `sudo`/`time`/`timeout`/`nohup` 这类包装器。
 * DSH 的会话里绝大多数命令形如 `cd <repo> && pnpm test 2>&1 | tail -40`，
 * 不剥这几层就永远取到 `cd`。
 *
 * `npx` / `bunx` / `pnpx` / `yarn dlx` 也按包装器处理：它们是「就地执行某个
 * 工具」，真实动作在被包住的那个命令上（`npx vitest run` 是在跑测试，
 * 不是在「执行 npx」）。漏掉这一层会让临时前缀的一次性工具全部退化成 coding。
 *
 * @param command - 原始命令行。
 * @returns `[命令名, 第一个裸参数]`，取不到时命令名为空串。
 */
export function firstRealCommand(command: string): [string, string] {
  const stripped = command.replace(/^(?:cd\s+\S+\s*(?:&&|;)\s*)+/i, '');
  for (const segment of stripped.split(/&&|\|\||;|\||\n/)) {
    let tokens = segment.trim().split(/\s+/);
    if (tokens.length === 0 || tokens[0] === '') continue;
    // 跳过环境设置与包装器，直到露出真命令
    while (tokens.length > 0) {
      const head = tokens[0]!;
      if (/^(sudo|env|time|timeout|nohup|nice|setsid|ionice|doas)$/.test(head)) {
        // 跳过选项本身（如 timeout 5）：丢掉第一个 token 后再丢掉一个纯数字/时长参数
        tokens = tokens.slice(1);
        if (tokens.length > 0 && /^[\d.]+[smhd]?$/.test(tokens[0]!)) tokens = tokens.slice(1);
        continue;
      }
      if (/^(npx|pnpx|bunx|dlx)$/.test(head)) {
        tokens = tokens.slice(1);
        // 剥掉 npx 自身的前缀：`--yes` / `-y` / `-p=x` 这类开关，`--package <包>`
        // 这类带空格取值的选项（取值一并剥掉），以及 `vitest@2` 这种带版本后缀的
        // 命令名。未知形式的选项一律停止剥离，把决定权交给默认类别而不是猜。
        while (tokens.length > 0) {
          const token = tokens[0]!;
          if (token.startsWith('-')) {
            // 已知带空格取值的选项：取值也要一起剥掉，否则会把包名当命令
            // （`npx --package vitest x` 的真命令是 `x`，`vitest` 只是附带安装的包）。
            if (/^(?:--package|--prefix|--registry|--cache|--node-arg|-c|-p)$/.test(token)) {
              tokens = tokens.slice(2);
              continue;
            }
            tokens = tokens.slice(1);
            continue;
          }
          // `npx vitest@2 run` 的命令名带版本后缀：剥掉 @version 而不是整颗丢掉，
          // 否则会拿着 `run` 当命令名，把一次跑测试读成 coding。
          const pinned = /^([\w.-]+)@[\w.~-]+$/.exec(token);
          if (pinned !== null) {
            tokens = [pinned[1]!, ...tokens.slice(1)];
            break;
          }
          break;
        }
        continue;
      }
      if (/^(cd|export|set|source|\.)$/.test(head)) {
        tokens = tokens.slice(2);
        continue;
      }
      if (head.startsWith('#')) break;
      break;
    }
    if (tokens.length === 0) continue;
    const name = tokens[0]!.split('/').pop() ?? tokens[0]!;
    if (name === '') continue;
    const firstArg = (tokens[1] ?? '').replace(/^[<>'"]+|[<>'"]+$/g, '');
    return [name, firstArg];
  }
  return ['', ''];
}

/**
 * 判定一条 shell 命令的 WakaTime category。
 *
 * @param command - 命令原文（`bash` / `pwsh` 工具调用的 `command` 参数）。
 * @returns 权威类别表内的类别字符串；认不出时为 {@link SHELL_DEFAULT_CATEGORY}。
 */
export function classifyShellCommand(command: string): string {
  const [name, sub] = firstRealCommand(typeof command === 'string' ? command : '');
  if (name === '') return SHELL_DEFAULT_CATEGORY;

  // 检视类优先于其它一切：它们既最常见，也最容易被参数里的路径词带偏。
  if (INSPECT_TOOLS.has(name)) {
    // curl/wget 这类既能读也能写（POST），只按「取数即研究」计。
    return RESEARCH_TOOLS.has(name) ? 'researching' : 'browsing';
  }
  if (RESEARCH_TOOLS.has(name)) return 'researching';
  if (VCS_TOOLS.has(name)) return 'coding';
  if (TEST_RUNNERS.has(name)) return 'running tests';
  if (LINT_TOOLS.has(name)) return 'debugging';

  if (PLATFORM_TOOLS.has(name)) {
    if (PLATFORM_INSPECT_SUBCOMMANDS.has(sub)) return 'browsing';
    if (PLATFORM_MUTATE_SUBCOMMANDS.has(sub)) return 'building';
    return SHELL_DEFAULT_CATEGORY;
  }

  if (BUILD_TOOLS.has(name)) {
    // 只看第一个裸子命令：后续参数往往是文件路径，含 `test`/`build` 字样不代表
    // 动作本身（例如 `cargo build --tests` 仍是构建，`pnpm test` 才是跑测试）。
    const mapped = SUBCOMMAND_CATEGORY[sub];
    if (mapped !== undefined) return mapped;
    // `pnpm run <script>` / `npm run <script>`：脚本名是唯一线索。
    if (sub === 'run' || sub === 'exec') {
      const script = command.match(/(?:run|exec)\s+([\w:._-]+)/)?.[1] ?? '';
      if (/^t$|test|spec|e2e/i.test(script)) return 'running tests';
      if (/lint|fmt|format|check|typecheck|audit/i.test(script)) return 'debugging';
      if (/build|bundle|compile|deploy|release|start|dev/i.test(script)) return 'building';
      return SHELL_DEFAULT_CATEGORY;
    }
    // `cargo`/`go`/`dotnet` 之外，构建工具裸跑（如 `tsc`、`make`）就是构建。
    return 'building';
  }

  // 解释器直接执行代码（含 heredoc 内联脚本）：按编写活动计。
  return SHELL_DEFAULT_CATEGORY;
}
