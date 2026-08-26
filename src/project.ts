import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';

const execAsync = promisify(exec);

/** 单次 git 子进程的超时（毫秒）：挂起的 git/文件系统不能无限拖住在途追踪与 flush。 */
const GIT_TIMEOUT_MS = 5_000;
/**
 * 推断结果缓存时长：项目名/分支/依赖在一次会话内几乎不变，
 * 无需每个工具调用都 spawn git 子进程。
 */
const RESOLVE_CACHE_TTL_MS = 60_000;

/**
 * 异步推断结果缓存：按 key 做 TTL 缓存 + 在途去重。
 * 同一 cwd 的并发调用共享同一次探测；探测失败产生的兜底值也会被缓存，
 * 避免非 git 目录的每个心跳都白白 spawn 三次 git。
 */
class ResolveCache<T> {
  private values = new Map<string, { value: T; expiresAt: number }>();
  private inflight = new Map<string, Promise<T>>();

  resolve(key: string, compute: () => Promise<T>): Promise<T> {
    const hit = this.values.get(key);
    if (hit && hit.expiresAt > Date.now()) return Promise.resolve(hit.value);

    const pending = this.inflight.get(key);
    if (pending) return pending;

    const task = compute()
      .then((value) => {
        this.values.set(key, { value, expiresAt: Date.now() + RESOLVE_CACHE_TTL_MS });
        return value;
      })
      .finally(() => {
        this.inflight.delete(key);
      });
    this.inflight.set(key, task);
    return task;
  }

  clear(): void {
    this.values.clear();
    this.inflight.clear();
  }
}

const projectNames = new ResolveCache<string>();
const branchNames = new ResolveCache<string>();
const rootCounts = new ResolveCache<number>();
const dependencyLists = new ResolveCache<string[]>();

/** 清空全部推断缓存（测试或需要强制刷新时使用）。 */
export function clearResolveCaches(): void {
  projectNames.clear();
  branchNames.clear();
  rootCounts.clear();
  dependencyLists.clear();
}

async function resolveProjectUncached(cwd: string): Promise<string> {
  try {
    const { stdout: remoteUrl } = await execAsync('git remote get-url --push origin', { cwd, timeout: GIT_TIMEOUT_MS });
    const url = remoteUrl.trim();
    if (url) {
      const match = url.match(/\/([^/]+?)(?:\.git)?$/);
      if (match) return match[1];
    }
  } catch {
    // Git remote not available
  }

  try {
    const { stdout: toplevel } = await execAsync('git rev-parse --show-toplevel', { cwd, timeout: GIT_TIMEOUT_MS });
    // basename（win32 实现）同时接受 / 与 \，兼容 Windows 下 git 的路径输出
    const dir = toplevel.trim();
    if (dir) return basename(dir) || 'unknown';
  } catch {
    // Git not available
  }

  const packageJsonPath = join(cwd, 'package.json');
  if (existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(await readFile(packageJsonPath, 'utf-8'));
      if (pkg.name) return pkg.name;
    } catch {
      // Invalid package.json
    }
  }

  return basename(cwd) || 'unknown';
}

/**
 * 解析项目名（带 TTL 缓存）
 * Priority:
 * 1. User configured project_name（由调用方 tracker 处理）
 * 2. git remote get-url --push origin
 * 3. git rev-parse --show-toplevel (directory name)
 * 4. package.json name field
 * 5. Current working directory name
 */
export function resolveProject(cwd: string): Promise<string> {
  return projectNames.resolve(cwd, () => resolveProjectUncached(cwd));
}

async function resolveBranchUncached(cwd: string): Promise<string> {
  try {
    const { stdout } = await execAsync('git branch --show-current', { cwd, timeout: GIT_TIMEOUT_MS });
    return stdout.trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

/** 解析当前 git 分支（带 TTL 缓存） */
export function resolveBranch(cwd: string): Promise<string> {
  return branchNames.resolve(cwd, () => resolveBranchUncached(cwd));
}

async function resolveProjectRootCountUncached(cwd: string): Promise<number> {
  try {
    const { stdout } = await execAsync('git rev-parse --show-toplevel', { cwd, timeout: GIT_TIMEOUT_MS });
    const gitRoot = stdout.trim();
    if (!gitRoot) return 0;

    // path.relative 替代旧的字符串 replace：
    // 1. 避免「前缀恰好是别的目录名」时算错深度
    // 2. resolve 归一化分隔符，兼容 Windows 下 git 输出正斜杠而 cwd 是反斜杠
    const rel = relative(resolve(gitRoot), resolve(cwd));
    if (!rel) return 0;

    return rel.split(sep).filter(Boolean).length;
  } catch {
    return 0;
  }
}

/** 计算 .git 根到 cwd 的深度（带 TTL 缓存） */
export function resolveProjectRootCount(cwd: string): Promise<number> {
  return rootCounts.resolve(cwd, () => resolveProjectRootCountUncached(cwd));
}

async function readTextIfExists(path: string): Promise<string | null> {
  if (!existsSync(path)) return null;
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * 解析依赖列表（带 TTL 缓存；文件读取改为异步，不再阻塞事件循环）
 * Supports: package.json, requirements.txt, go.mod, Cargo.toml, pom.xml
 */
export async function resolveDependenciesUncached(cwd: string): Promise<string[]> {
  const deps: string[] = [];

  // package.json
  const packageJson = await readTextIfExists(join(cwd, 'package.json'));
  if (packageJson !== null) {
    try {
      const pkg = JSON.parse(packageJson);
      if (pkg.dependencies) deps.push(...Object.keys(pkg.dependencies));
      if (pkg.devDependencies) deps.push(...Object.keys(pkg.devDependencies));
    } catch {
      // Invalid package.json
    }
  }

  // requirements.txt
  const requirements = await readTextIfExists(join(cwd, 'requirements.txt'));
  if (requirements !== null) {
    for (const line of requirements.split('\n').filter(Boolean)) {
      const match = line.match(/^([a-zA-Z0-9_-]+)/);
      if (match) deps.push(match[1]);
    }
  }

  // go.mod
  const goMod = await readTextIfExists(join(cwd, 'go.mod'));
  if (goMod !== null) {
    let inRequireBlock = false;
    for (const line of goMod.split('\n')) {
      const trimmed = line.trim();
      // Skip require ( block start
      if (trimmed === 'require (') {
        inRequireBlock = true;
        continue;
      }
      if (inRequireBlock) {
        if (trimmed === ')') {
          inRequireBlock = false;
          continue;
        }
        // Extract package name from: github.com/gin-gonic/gin v1.9.0
        const match = trimmed.match(/^([^\s]+)/);
        if (match) deps.push(match[1]);
      } else {
        // Single line require: require github.com/foo/bar v1.0.0
        const match = trimmed.match(/^require\s+([^\s]+)/);
        if (match) deps.push(match[1]);
      }
    }
  }

  // Cargo.toml
  const cargoToml = await readTextIfExists(join(cwd, 'Cargo.toml'));
  if (cargoToml !== null) {
    let inDependencies = false;
    for (const line of cargoToml.split('\n')) {
      if (line.trim() === '[dependencies]') {
        inDependencies = true;
        continue;
      }
      if (line.trim().startsWith('[')) {
        inDependencies = false;
        continue;
      }
      if (inDependencies) {
        const match = line.match(/^([a-zA-Z0-9_-]+)\s*=/);
        if (match) deps.push(match[1]);
      }
    }
  }

  // pom.xml
  const pomXml = await readTextIfExists(join(cwd, 'pom.xml'));
  if (pomXml !== null) {
    const artifactIds = pomXml.match(/<artifactId>([^<]+)<\/artifactId>/g);
    if (artifactIds) {
      for (const artifact of artifactIds) {
        const match = artifact.match(/<artifactId>([^<]+)<\/artifactId>/);
        if (match) deps.push(match[1]);
      }
    }
  }

  return [...new Set(deps)];
}

/** 解析依赖（带 TTL 缓存） */
export function resolveDependencies(cwd: string): Promise<string[]> {
  return dependencyLists.resolve(cwd, () => resolveDependenciesUncached(cwd));
}

/**
 * Read API key from ~/.wakatime.cfg
 * Returns empty string if file doesn't exist or key not found
 */
export function readWakatimeCfgApiKey(): string {
  // os.homedir() 在 POSIX 下优先取 $HOME（测试可通过覆盖 HOME 重定向），
  // Windows 下取 USERPROFILE，替代旧的手工 env 拼接与不可展开的 '~'
  const cfgPath = join(homedir(), '.wakatime.cfg');
  if (!existsSync(cfgPath)) return '';

  try {
    const content = readFileSync(cfgPath, 'utf-8');
    for (const line of content.split('\n').filter(Boolean)) {
      const match = line.match(/api_key\s*=\s*(.+)/);
      if (match) return match[1].trim();
    }
  } catch {
    // Invalid config file
  }

  return '';
}

/**
 * Mask API key for logging: waka_****最后4位
 */
export function maskApiKey(apiKey: string): string {
  if (!apiKey || apiKey.length <= 4) return '****';
  return `waka_****${apiKey.slice(-4)}`;
}
