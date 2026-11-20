import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveLanguage } from '../src/language.js';
import { resolveProject, resolveBranch, resolveProjectRootCount, resolveDependencies, readWakatimeCfgApiKey, readWakatimeCfgProxy, maskApiKey, clearResolveCaches } from '../src/project.js';
import { resolveProxy, resolveProxyUrl, shouldUseProxy, PROXY_NONE, maskProxyUrl } from '../src/wakatime.js';
import { calculateWriteDiff, calculateEditDiff } from '../src/diff.js';
import { clampEntity, clampField } from '../src/types.js';
import { classifyShellCommand, firstRealCommand } from '../src/category.js';
import { CONFIG_DEFAULTS, normalizeConfig, normalizeDocument, plainValue } from '../src/config-value.js';
import type { Config } from '../src/index.js';
import { FileTracker } from '../src/tracker.js';
import { secretSlotSet, SETTINGS_NAMESPACE_CANDIDATES } from '../src/client/mirror.js';
import type { MirrorSnapshotLike } from '../src/client/mirror.js';
import { booleanField, numberField, textField } from '../src/client/field-specs.js';
import { wkDicts } from '../src/client/strings.js';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('language.ts', () => {
  describe('resolveLanguage', () => {
    it('should resolve TypeScript from .ts', () => {
      expect(resolveLanguage('file.ts')).toBe('TypeScript');
    });

    it('should resolve TypeScript from .tsx', () => {
      expect(resolveLanguage('file.tsx')).toBe('TypeScript');
    });

    it('should resolve JavaScript from .js', () => {
      expect(resolveLanguage('file.js')).toBe('JavaScript');
    });

    it('should resolve Python from .py', () => {
      expect(resolveLanguage('file.py')).toBe('Python');
    });

    it('should resolve Go from .go', () => {
      expect(resolveLanguage('file.go')).toBe('Go');
    });

    it('should resolve Rust from .rs', () => {
      expect(resolveLanguage('file.rs')).toBe('Rust');
    });

    it('should resolve Java from .java', () => {
      expect(resolveLanguage('file.java')).toBe('Java');
    });

    it('should resolve C++ from .cpp', () => {
      expect(resolveLanguage('file.cpp')).toBe('C++');
    });

    it('should resolve C from .c', () => {
      expect(resolveLanguage('file.c')).toBe('C');
    });

    it('should resolve JSON from .json', () => {
      expect(resolveLanguage('file.json')).toBe('JSON');
    });

    it('should resolve Shell from .sh', () => {
      expect(resolveLanguage('file.sh')).toBe('Shell');
    });

    it('should resolve Unknown for unknown extension', () => {
      expect(resolveLanguage('file.unknown')).toBe('Unknown');
    });

    it('should resolve Unknown for no extension', () => {
      expect(resolveLanguage('Makefile')).toBe('Unknown');
    });
  });
});

describe('diff.ts', () => {
  describe('calculateWriteDiff', () => {
    it('should calculate diff for new file', () => {
      const result = calculateWriteDiff('line1\nline2\nline3');
      expect(result).toEqual({
        lines: 3,
        lineAdditions: 3,
        lineDeletions: 0,
      });
    });

    it('should handle empty content', () => {
      const result = calculateWriteDiff('');
      expect(result).toEqual({
        lines: 1,
        lineAdditions: 1,
        lineDeletions: 0,
      });
    });

    it('should return null for large files', () => {
      const largeContent = 'line\n'.repeat(10001);
      const result = calculateWriteDiff(largeContent);
      expect(result).toBeNull();
    });
  });

  describe('calculateEditDiff', () => {
    it('should calculate diff for edit with additions', () => {
      const result = calculateEditDiff('old line', 'new line\nanother line');
      expect(result).toEqual({
        lines: 2,
        lineAdditions: 1,
        lineDeletions: 0,
      });
    });

    it('should calculate diff for edit with deletions', () => {
      const result = calculateEditDiff('old line\nanother old', 'new line');
      expect(result).toEqual({
        lines: 1,
        lineAdditions: 0,
        lineDeletions: 1,
      });
    });

    it('should calculate diff for same line count', () => {
      const result = calculateEditDiff('old line', 'new line');
      expect(result).toEqual({
        lines: 1,
        lineAdditions: 0,
        lineDeletions: 0,
      });
    });

    it('should return null for large result', () => {
      const oldContent = 'old\n';
      const newContent = 'new\n'.repeat(10001);
      const result = calculateEditDiff(oldContent, newContent);
      expect(result).toBeNull();
    });
  });
});

describe('category.ts shell classification', () => {
  /**
   * WakaTime 权威类别集合（wakatime-cli pkg/heartbeat/category.go）。
   * 测试用它的目的不是复述文档，而是把「不许自造类别」变成断言：表里没有
   * `deployment`，也没有 `testing`（正确值是 `running tests`），落进陌生词
   * 的数据在面板上无法聚合。
   */
  const CANONICAL = new Set([
    'advising', 'ai coding', 'browsing', 'building', 'code reviewing', 'coding',
    'communicating', 'debugging', 'designing', 'indexing', 'learning',
    'manual testing', 'meeting', 'planning', 'researching', 'running tests',
    'supporting', 'translating', 'writing docs', 'writing tests',
  ]);

  const CASES: Array<[string, string]> = [
    // 构建工具的子命令决定类别，而不是命令名
    ['cd /repo && pnpm test 2>&1 | tail -40', 'running tests'],
    ['pnpm run build', 'building'],
    ['npm run typecheck', 'debugging'],
    ['cargo build --tests', 'building'],
    ['tsc -p tsconfig.json --noEmit', 'building'],
    ['make', 'building'],
    ['go vet ./...', 'building'],
    // 反例（实测踩过）：路径里含 test 不等于在跑测试
    ['grep -n "timezone" test/backend/api/test_ema_tools.py', 'browsing'],
    ['sed -n 1,40p test/helper/test_timezone_utils.py', 'browsing'],
    ['cat src/index.ts', 'browsing'],
    ['ls -la /tmp/x', 'browsing'],
    ['head -5 notes.md && tail -5 notes.md', 'browsing'],
    // 检视类优先于包装器与管道
    ['timeout 120 pytest -q', 'running tests'],
    ['sudo ruff check backend/app', 'debugging'],
    ['cd /a && cd /b && rg -l "TODO"', 'browsing'],
    // 版本控制与脚本
    ['git status --short', 'coding'],
    ['python3 - <<\'EOF\'\nprint(1)\nEOF', 'coding'],
    ['npx vitest run', 'running tests'],
    // npx 是一次性执行前缀：真实动作在被包住的工具上
    ['npx --yes vitest run', 'running tests'],
    ['npx playwright test', 'running tests'],
    ['npx tsc --noEmit', 'building'],
    ['npx eslint src/index.ts', 'debugging'],
    // 平台工具：看子命令，get/ps 是看状态，apply/build 是执行变更
    ['kubectl get deploy app -o yaml', 'browsing'],
    ['kubectl rollout restart deploy/app', 'building'],
    ['docker ps -a', 'browsing'],
    ['docker build -t app .', 'building'],
    ['terraform plan', 'browsing'],
    // 取数与未知
    ['curl -s -H "Authorization: token x" http://127.0.0.1:3080/api/x', 'researching'],
    ['some-unknown-tool --do-thing', 'coding'],
    ['', 'coding'],
  ];

  it.each(CASES)('classifies %s', (command, expected) => {
    expect(classifyShellCommand(command)).toBe(expected);
  });

  it('never emits a category outside the authoritative set', () => {
    for (const [command] of CASES) {
      expect(CANONICAL.has(classifyShellCommand(command))).toBe(true);
    }
  });

  describe('firstRealCommand', () => {
    it('peels cd / wrappers / pipes down to the real command', () => {
      expect(firstRealCommand('cd /repo && pnpm test 2>&1 | tail -40')).toEqual(['pnpm', 'test']);
      expect(firstRealCommand('export FOO=1 && npm run build')).toEqual(['npm', 'run']);
      expect(firstRealCommand('timeout 5 kubectl get pods')).toEqual(['kubectl', 'get']);
      expect(firstRealCommand('')).toEqual(['', '']);
    });

    it('peels the npx prefix without losing the wrapped command', () => {
      expect(firstRealCommand('npx --yes vitest run')).toEqual(['vitest', 'run']);
      expect(firstRealCommand('npx vitest@2 run')).toEqual(['vitest', 'run']);
      // 已知带空格取值的选项要连取值一起剥：`npx --package vitest x` 的真命令
      // 是 `x`，`vitest` 只是附带安装的包——把包名当命令会判错类别。
      expect(firstRealCommand('npx --package vitest x')).toEqual(['x', '']);
    });

    it('keeps the first bare argument only, never a path tail', () => {
      // 判定的全部依据来自这里：一旦把路径参数当子命令，test/*.py 就会被读成 test
      expect(firstRealCommand('grep -n foo test/a_test.py')).toEqual(['grep', '-n']);
    });
  });
});

describe('config-value.ts', () => {
  /** 复刻 cosmokit 的 volatile ref 形状（私有 write symbol 外部拿不到，鸭子类型即可）。 */
  const ref = (value: unknown) => {
    const write = Symbol('write');
    return Object.freeze({ get: () => value, [write]: () => {} });
  };

  describe('plainValue', () => {
    it('unwraps a volatile ref and nested refs', () => {
      expect(plainValue(ref('a'))).toBe('a');
      expect(plainValue(ref(ref(120000)))).toBe(120000);
    });

    it('passes ordinary values through untouched', () => {
      expect(plainValue('x')).toBe('x');
      expect(plainValue(undefined)).toBeUndefined();
      expect(plainValue({ a: 1 })).toEqual({ a: 1 });
    });

    it('gives up (returns undefined) when a ref’s get() throws', () => {
      expect(plainValue({ get: () => { throw new Error('host state'); } })).toBeUndefined();
    });
  });

  describe('normalizeConfig', () => {
    it('turns every volatile field into a usable bare value', () => {
      const { config, degraded } = normalizeConfig({
        api_key: ref('waka_x'),
        api_url: ref('https://wm.internal'),
        heartbeat_interval_ms: ref(90000),
        project_name: ref('p'),
        language: ref('TypeScript'),
        app_entity: ref('Terminal'),
        include_tool_calls: ref(true),
        include_user_messages: ref(false),
        include_assistant_messages: ref(true),
        cache_heartbeats: ref(false),
        cache_limit: ref(500),
        debug: ref(true),
      });
      expect(config.api_url).toBe('https://wm.internal');
      expect(config.heartbeat_interval_ms).toBe(90000);
      expect(config.include_user_messages).toBe(false);
      expect(config.cache_limit).toBe(500);
      expect(degraded).toEqual([]);
    });

    it('falls back to defaults and reports the shape for unusable values', () => {
      const { config, degraded } = normalizeConfig({
        api_url: { __jsExpr: 'x' },
        heartbeat_interval_ms: ref('120000'),
        include_user_messages: ref({ nested: true }),
        cache_limit: 999999,
      });
      expect(config.api_url).toBe(CONFIG_DEFAULTS.api_url);
      expect(config.heartbeat_interval_ms).toBe(CONFIG_DEFAULTS.heartbeat_interval_ms);
      expect(config.include_user_messages).toBe(CONFIG_DEFAULTS.include_user_messages);
      expect(config.cache_limit).toBe(CONFIG_DEFAULTS.cache_limit);
      const fields = degraded.map((d) => d.field).sort();
      expect(fields).toEqual(['api_url', 'cache_limit', 'heartbeat_interval_ms', 'include_user_messages']);
    });

    it('never lets a bogus api_url through (Invalid URL would kill every send)', () => {
      for (const bad of ['wakatime.com', 'ftp://x', 'not a url', '/api', '  ']) {
        const { config, degraded } = normalizeConfig({ api_url: bad });
        expect(config.api_url).toBe(CONFIG_DEFAULTS.api_url);
        expect(degraded.some((d) => d.field === 'api_url')).toBe(true);
      }
      // 带尾斜杠的合法值应被归一，且不算降级
      const ok = normalizeConfig({ api_url: 'https://wm.internal/' });
      expect(ok.config.api_url).toBe('https://wm.internal');
      expect(ok.degraded).toEqual([]);
    });

    it('reports shapes without leaking values', () => {
      const { degraded } = normalizeConfig({ api_key: ref({ secret: 'waka_LEAK' }) });
      const line = JSON.stringify(degraded);
      expect(line).not.toContain('waka_LEAK');
      expect(degraded.find((d) => d.field === 'api_key')?.shape).toContain('object');
    });
  });

  describe('normalizeDocument', () => {
    const current: Config = { ...CONFIG_DEFAULTS, api_key: 'waka_keep', api_url: 'https://keep.example' };

    it('only touches fields the document actually submitted', () => {
      const { partial } = normalizeDocument({ project_name: ref('newproj') }, current);
      expect(partial).toEqual({ project_name: 'newproj' });
    });

    it('keeps the current value when the submitted one is unusable', () => {
      const { partial, degraded } = normalizeDocument({ api_url: ref({}), debug: 'yes' }, current);
      expect(partial.api_url).toBeUndefined();
      expect(partial.debug).toBeUndefined();
      expect(degraded.map((d) => d.field).sort()).toEqual(['api_url', 'debug']);
    });

    it('treats an explicitly blank api_key as a real submission (clear, not absent)', () => {
      // 空串与字段缺席语义不同：缺席=没改，空串=用户主动清空。
      const { partial } = normalizeDocument({ api_key: '' }, current);
      expect(partial.api_key).toBe('');
    });
  });

  it('keeps CONFIG_DEFAULTS aligned with the exported schema', async () => {
    // Schema 的 .default() 取自这份常量，字段集合一旦漂移就有字段拿不到默认值
    // （新增字段忘了写默认 = 运行时 undefined，正是本次要根除的那类故障）。
    const { Config: SchemaConfig } = await import('../src/index.js');
    expect(Object.keys((SchemaConfig as any).dict ?? {}).sort()).toEqual(Object.keys(CONFIG_DEFAULTS).sort());
  });
});

describe('types.ts field clamps', () => {
  describe('clampField', () => {
    it('truncates to the limit with an ellipsis marker', () => {
      const out = clampField('x'.repeat(3000), 1024);
      expect(out).toHaveLength(1024);
      expect(out.endsWith('...')).toBe(true);
    });

    it('trims and passes through values already within the limit', () => {
      expect(clampField('  apbot  ', 1024)).toBe('apbot');
    });

    it('treats blank input as absent (the server rejects empty strings)', () => {
      // 服务端校验是 "between 1 and N"：空串会连累整条心跳被逐条 400 拒掉。
      expect(clampField('   ', 1024)).toBe('');
      expect(clampField('', 2083)).toBe('');
    });

    it('treats non-strings as absent instead of stringifying them', () => {
      // loader 可能把未求值的 !!js 节点原样交来（对象）；`String(obj)` 会产出
      // "[object Object]" 这种看起来合法、实际是垃圾的字段值。
      expect(clampField({ a: 1 }, 1024)).toBe('');
      expect(clampField(undefined, 1024)).toBe('');
      expect(clampField(42, 1024)).toBe('');
    });
  });

  describe('clampEntity', () => {
    it('uses the entity limit (2083), not the general one', () => {
      expect(clampEntity('y'.repeat(4000))).toHaveLength(2083);
    });
  });
});

describe('project.ts', () => {
  const testDir = join(tmpdir(), 'dsh-wakatime-test-' + Date.now());

  beforeEach(() => {
    // 推断结果带 60s TTL 缓存，且各用例复用同一 testDir 写不同文件，须先清缓存
    clearResolveCaches();
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('maskApiKey', () => {
    it('should mask API key correctly', () => {
      expect(maskApiKey('waka_1234567890abcdef')).toBe('waka_****cdef');
    });

    it('should handle short keys', () => {
      expect(maskApiKey('abcd')).toBe('****');
    });

    it('should handle empty string', () => {
      expect(maskApiKey('')).toBe('****');
    });

    it('should handle null/undefined', () => {
      expect(maskApiKey(null as any)).toBe('****');
      expect(maskApiKey(undefined as any)).toBe('****');
    });
  });

  describe('readWakatimeCfgProxy', () => {
    const withHome = (content: string | null, run: () => void): void => {
      const homeDir = join(tmpdir(), 'wakatime-proxy-home-' + Date.now() + '-' + Math.random().toString(36).slice(2));
      mkdirSync(homeDir, { recursive: true });
      if (content !== null) writeFileSync(join(homeDir, '.wakatime.cfg'), content);
      const originalHome = process.env.HOME;
      process.env.HOME = homeDir;
      try {
        run();
      } finally {
        process.env.HOME = originalHome;
        rmSync(homeDir, { recursive: true, force: true });
      }
    };

    it('reads the proxy the same way wakatime-cli does', () => {
      withHome('[settings]\nproxy = http://proxy.example:3128\n', () => {
        expect(readWakatimeCfgProxy()).toBe('http://proxy.example:3128');
      });
    });

    it('returns empty string when the key or the file is missing', () => {
      withHome('[settings]\napi_key = waka_test123\n', () => {
        expect(readWakatimeCfgProxy()).toBe('');
      });
      withHome(null, () => {
        expect(readWakatimeCfgProxy()).toBe('');
      });
    });

    it('is case-insensitive and tolerates spacing', () => {
      withHome('[Settings]\n  Proxy   =   http://p:1  \n', () => {
        expect(readWakatimeCfgProxy()).toBe('http://p:1');
      });
    });
  });
  describe('readWakatimeCfgApiKey', () => {
    it('should return empty string when file does not exist', () => {
      // Temporarily override HOME
      const originalHome = process.env.HOME;
      process.env.HOME = '/nonexistent';
      expect(readWakatimeCfgApiKey()).toBe('');
      process.env.HOME = originalHome;
    });

    it('should read API key from config file', () => {
      const homeDir = join(tmpdir(), 'wakatime-test-home-' + Date.now());
      mkdirSync(homeDir, { recursive: true });
      const cfgPath = join(homeDir, '.wakatime.cfg');
      writeFileSync(cfgPath, '[settings]\napi_key = waka_test123\n');

      const originalHome = process.env.HOME;
      process.env.HOME = homeDir;
      expect(readWakatimeCfgApiKey()).toBe('waka_test123');
      process.env.HOME = originalHome;

      rmSync(homeDir, { recursive: true, force: true });
    });
  });

  describe('resolveProject', () => {
    it('should fallback to directory name when no git', () => {
      const result = resolveProject(testDir);
      expect(result).toBeTruthy();
      expect(result).not.toBe('unknown');
    });
  });

  describe('resolveBranch', () => {
    it('should return unknown when no git', async () => {
      expect(await resolveBranch(testDir)).toBe('unknown');
    });
  });

  describe('resolveProjectRootCount', () => {
    it('should return 0 when no git', async () => {
      expect(await resolveProjectRootCount(testDir)).toBe(0);
    });
  });

  describe('resolveDependencies', () => {
    it('should resolve from package.json', async () => {
      const pkgPath = join(testDir, 'package.json');
      writeFileSync(pkgPath, JSON.stringify({
        name: 'test-project',
        dependencies: { express: '^4.0.0', react: '^18.0.0' },
        devDependencies: { typescript: '^5.0.0' },
      }));

      const deps = await resolveDependencies(testDir);
      expect(deps).toContain('express');
      expect(deps).toContain('react');
      expect(deps).toContain('typescript');
    });

    it('should resolve from requirements.txt', async () => {
      const reqPath = join(testDir, 'requirements.txt');
      writeFileSync(reqPath, 'flask==2.0.0\ndjango==4.0.0\n');

      const deps = await resolveDependencies(testDir);
      expect(deps).toContain('flask');
      expect(deps).toContain('django');
    });

    it('should resolve from go.mod', async () => {
      const goModPath = join(testDir, 'go.mod');
      writeFileSync(goModPath, `module test

go 1.21

require (
    github.com/gin-gonic/gin v1.9.0
    github.com/stretchr/testify v1.8.0
)`);

      const deps = await resolveDependencies(testDir);
      expect(deps).toContain('github.com/gin-gonic/gin');
      expect(deps).toContain('github.com/stretchr/testify');
    });

    it('should resolve from Cargo.toml', async () => {
      const cargoPath = join(testDir, 'Cargo.toml');
      writeFileSync(cargoPath, `[package]
name = "test"
version = "0.1.0"

[dependencies]
serde = "1.0"
tokio = "1.0"`);

      const deps = await resolveDependencies(testDir);
      expect(deps).toContain('serde');
      expect(deps).toContain('tokio');
    });

    it('should resolve from pom.xml', async () => {
      const pomPath = join(testDir, 'pom.xml');
      writeFileSync(pomPath, `<?xml version="1.0" encoding="UTF-8"?>
<project>
    <dependencies>
        <dependency>
            <groupId>org.springframework</groupId>
            <artifactId>spring-core</artifactId>
            <version>5.0.0</version>
        </dependency>
    </dependencies>
</project>`);

      const deps = await resolveDependencies(testDir);
      expect(deps).toContain('spring-core');
    });

    it('should return empty array when no dependency files', async () => {
      const deps = await resolveDependencies(testDir);
      expect(deps).toEqual([]);
    });

    it('should remove duplicates', async () => {
      const pkgPath = join(testDir, 'package.json');
      writeFileSync(pkgPath, JSON.stringify({
        dependencies: { lodash: '^4.0.0' },
        devDependencies: { lodash: '^4.0.0' },
      }));

      const deps = await resolveDependencies(testDir);
      expect(deps.filter(d => d === 'lodash').length).toBe(1);
    });
  });
});

describe('client/mirror.ts', () => {
  const mirrorView = (secrets: Array<{ path: string[]; set: boolean }>, ns = 'wakatime'): MirrorSnapshotLike => ({
    view: { namespaces: [{ ns, secrets }] },
  });

  describe('secretSlotSet', () => {
    it('should return true when the slot is set', () => {
      expect(secretSlotSet(mirrorView([{ path: ['api_key'], set: true }]), 'wakatime', 'api_key')).toBe(true);
    });

    it('should return false when the slot exists but is not set', () => {
      expect(secretSlotSet(mirrorView([{ path: ['api_key'], set: false }]), 'wakatime', 'api_key')).toBe(false);
    });

    it('should return false when the namespace does not match', () => {
      expect(secretSlotSet(mirrorView([{ path: ['api_key'], set: true }], 'other-ns'), 'wakatime', 'api_key')).toBe(false);
    });

    it('should return false without a held view or snapshot', () => {
      expect(secretSlotSet({ view: undefined }, 'wakatime', 'api_key')).toBe(false);
      expect(secretSlotSet(undefined, 'wakatime', 'api_key')).toBe(false);
    });

    it('should hit the 0.2.x row keyed by profile entry id when given candidates', () => {
      // 0.2.x 起 describe 镜像的行键 = 条目 id（dsh-wakatime），旧体系才是 wakatime。
      // 只写一个名字时，镜像即使接上了也查不到行 —— 指示灯依旧不亮。
      const snap: MirrorSnapshotLike = {
        view: { namespaces: [{ ns: 'dsh-wakatime', secrets: [{ path: ['api_key'], set: true }] }] },
      };
      expect(secretSlotSet(snap, 'wakatime', 'api_key')).toBe(false);
      expect(secretSlotSet(snap, SETTINGS_NAMESPACE_CANDIDATES, 'api_key')).toBe(true);
      // 首个命中的候选行即权威；无任何候选命中时仍是 false（不抛错）。
      const two: MirrorSnapshotLike = {
        view: {
          namespaces: [
            { ns: 'wakatime', secrets: [{ path: ['api_key'], set: false }] },
            { ns: 'dsh-wakatime', secrets: [{ path: ['api_key'], set: true }] },
          ],
        },
      };
      expect(secretSlotSet(two, ['wakatime', 'dsh-wakatime'], 'api_key')).toBe(false);
      expect(secretSlotSet(two, ['nope'], 'api_key')).toBe(false);
    });
  });



  describe('wkDicts', () => {
    it('should keep zh and en key sets identical', () => {
      // 类型层的映射类型已挡住漏键；这里挡住【运行时】才暴露的形态差异
      //（数组/对象嵌套，或有人绕过类型断言塞进不一致的字典）。
      expect(Object.keys(wkDicts.en).sort()).toEqual(Object.keys(wkDicts.zh).sort());
      expect(Object.keys(wkDicts.en.fields).sort()).toEqual(Object.keys(wkDicts.zh.fields).sort());
      expect(Object.keys(wkDicts.en.sections).sort()).toEqual(Object.keys(wkDicts.zh.sections).sort());
      // SettingsForm 外框文案必须齐备（官方 labels 五个键一个都不能缺）。
      for (const key of ['unavailable', 'readOnlyNote', 'saveFailed', 'save', 'saving'] as const) {
        expect(wkDicts.zh[key].length).toBeGreaterThan(0);
        expect(wkDicts.en[key].length).toBeGreaterThan(0);
      }
    });

  });

});

describe('client/field-specs.ts', () => {
  describe('textField', () => {
    it('should clear on blank draft and store the raw text otherwise', () => {
      const spec = textField('api_url');
      expect(spec.parse('')).toEqual({ kind: 'clear' });
      expect(spec.parse('   ')).toEqual({ kind: 'clear' });
      expect(spec.parse('https://example.com')).toEqual({ kind: 'set', value: 'https://example.com' });
      // 草稿保真：官方控件不改写用户输入（首尾空格照存）
      expect(spec.parse(' x ')).toEqual({ kind: 'set', value: ' x ' });
    });

    it('should format stored scalars for the draft, empty for absent', () => {
      const spec = textField('project_name');
      expect(spec.format(undefined)).toBe('');
      expect(spec.format(null)).toBe('');
      expect(spec.format('dsh')).toBe('dsh');
    });
  });

  describe('numberField', () => {
    const spec = numberField('heartbeat_interval_ms', 60000, 300000);

    it('should accept in-range integers and clear on blank', () => {
      expect(spec.parse('90000')).toEqual({ kind: 'set', value: 90000 });
      expect(spec.parse('60000')).toEqual({ kind: 'set', value: 60000 });
      expect(spec.parse('300000')).toEqual({ kind: 'set', value: 300000 });
      expect(spec.parse('')).toEqual({ kind: 'clear' });
    });

    it('should reject non-integers and out-of-range drafts (undefined blocks the save)', () => {
      expect(spec.parse('abc')).toBeUndefined();
      expect(spec.parse('1.5')).toBeUndefined();
      expect(spec.parse('59999')).toBeUndefined();
      expect(spec.parse('300001')).toBeUndefined();
    });

    it('should skip bounds when the field declares none', () => {
      const loose = numberField('cache_limit');
      expect(loose.parse('-42')).toEqual({ kind: 'set', value: -42 });
    });
  });

  describe('booleanField', () => {
    const spec = booleanField('debug');

    it('should treat only explicit true as on (absent/other values render off)', () => {
      expect(spec.format(true)).toBe('true');
      expect(spec.format('true')).toBe('true');
      expect(spec.format(undefined)).toBe('false');
      expect(spec.format(false)).toBe('false');
      expect(spec.format('anything-else')).toBe('false');
    });

    it('should round-trip the two switch literals and reject everything else', () => {
      expect(spec.parse('true')).toEqual({ kind: 'set', value: true });
      expect(spec.parse('false')).toEqual({ kind: 'set', value: false });
      // Switch 只会 stage 这两个字面量；手写的空串/其他值都是非法草稿
      expect(spec.parse('')).toBeUndefined();
      expect(spec.parse('1')).toBeUndefined();
    });
  });
});

describe('proxy resolution (wakatime.ts)', () => {
  describe('resolveProxy：设置页 > 环境变量 > cfg', () => {
    it('设置页的值优先级最高', () => {
      const r = resolveProxy({ HTTPS_PROXY: 'http://env:1' }, 'http://cfg:2', 'http://setting:3');
      expect(r.proxy).toBe('http://setting:3');
      expect(r.source).toBe('setting');
    });

    it('设置为空则依次回退环境变量、cfg、直连', () => {
      expect(resolveProxy({ HTTPS_PROXY: 'http://env:1' }, 'http://cfg:2', '').source).toBe('env');
      expect(resolveProxy({}, 'http://cfg:2', '   ').source).toBe('cfg');
      expect(resolveProxy({}, '', '').source).toBe('direct');
    });

    it('none / direct 表示强制直连，且不再往下回退', () => {
      // 应急手段：代理坏掉时在设置页填 none 就能立刻改直连，
      // 否则环境变量/cfg 会把它又“救”回代理。
      for (const value of [PROXY_NONE, 'direct', 'NONE', ' Direct ']) {
        const r = resolveProxy({ HTTPS_PROXY: 'http://env:1' }, 'http://cfg:2', value);
        expect(r.proxy).toBeNull();
        expect(r.source).toBe('none');
      }
    });

    it('设置页填了非法地址：跳过该层并报告，而不是静默失效', () => {
      // “配了代理却没生效”是排查里最费时间的一类，必须留下痕迹。
      const r = resolveProxy({}, 'http://cfg:2', 'proxy.example:3128');
      expect(r.proxy).toBe('http://cfg:2');
      expect(r.source).toBe('cfg');
      expect(r.ignored).toContain('proxy_url');
    });

    it('没有任何可用来源时直连，且非法层仍有告警', () => {
      const r = resolveProxy({}, '', 'not-a-url');
      expect(r.proxy).toBeNull();
      expect(r.source).toBe('direct');
      expect(r.ignored).toBeDefined();
    });

    it('只接受 http/https 代理', () => {
      expect(resolveProxy({}, '', 'ftp://x:1').proxy).toBeNull();
      expect(resolveProxy({}, '', 'socks5://x:1').proxy).toBeNull();
      expect(resolveProxy({}, '', 'https://proxy:8443').proxy).toBe('https://proxy:8443');
    });

    it('非字符串（如未解包的 volatile ref）当作没给', () => {
      expect(resolveProxy({}, 'http://cfg:2', { get: () => 'x' }).source).toBe('cfg');
    });
  });

  describe('resolveProxyUrl（薄封装）', () => {
    it('透传 resolveProxy 的结果', () => {
      expect(resolveProxyUrl({}, '', 'http://setting:3')).toBe('http://setting:3');
      expect(resolveProxyUrl({}, '', 'none')).toBeNull();
      expect(resolveProxyUrl({}, 'http://cfg:2')).toBe('http://cfg:2');
    });
  });

  describe('shouldUseProxy（NO_PROXY 语义）', () => {
    it('没有代理时一律不走', () => {
      expect(shouldUseProxy(null, 'wakatime.com', '')).toBe(false);
      expect(shouldUseProxy('', 'wakatime.com', '')).toBe(false);
    });

    it('支持 *、精确主机与后缀写法', () => {
      expect(shouldUseProxy('http://p:1', 'wakatime.com', '*')).toBe(false);
      expect(shouldUseProxy('http://p:1', 'wakatime.com', 'wakatime.com')).toBe(false);
      expect(shouldUseProxy('http://p:1', 'a.wakatime.com', '.wakatime.com')).toBe(false);
      expect(shouldUseProxy('http://p:1', 'a.wakatime.com', 'wakatime.com')).toBe(false);
      expect(shouldUseProxy('http://p:1', 'other.com', 'wakatime.com')).toBe(true);
    });

    it('忽略尾逗号产生的空项', () => {
      expect(shouldUseProxy('http://p:1', 'a.com', 'a.com,')).toBe(false);
      expect(shouldUseProxy('http://p:1', 'b.com', '')).toBe(true);
    });
  });
});

describe('代理凭据安全（wakatime.ts）', () => {
  describe('maskProxyUrl：日志里不得出现代理密码', () => {
    it('抹掉用户名与密码，保留主机与端口', () => {
      // 这一层存在的唯一理由：诊断日志是给人看的，会进日志文件、也会被贴进 issue。
      // 直接拼原始 URL 等于把密码写出去。
      const masked = maskProxyUrl('http://alice:S3cr3t@proxy.corp:8080');
      expect(masked).not.toContain('S3cr3t');
      expect(masked).not.toContain('alice');
      expect(masked).toContain('proxy.corp');
      expect(masked).toContain('8080');
    });

    it('只有用户名时也要抹掉', () => {
      expect(maskProxyUrl('http://user@proxy:3128')).not.toContain('user');
    });

    it('没有凭据时原样保留（排障需要看到实际代理）', () => {
      expect(maskProxyUrl('http://proxy:3128')).toContain('proxy:3128');
    });

    it('无法解析的地址不回显原文（原文里可能就有凭据）', () => {
      const masked = maskProxyUrl('alice:S3cr3t@bad url');
      expect(masked).not.toContain('S3cr3t');
    });

    it('null / 空串原样返回', () => {
      expect(maskProxyUrl(null)).toBeNull();
      expect(maskProxyUrl('')).toBe('');
    });
  });

  describe('describeProxy 输出必须是脱敏的', () => {
    it('带凭据的代理进日志前已被抹掉', async () => {
      const { WakaTimeClient } = await import('../src/wakatime.js');
      const client = new WakaTimeClient({
        api_key: 'k', api_url: 'https://wakatime.com',
        cfg_proxy: '', proxy_url: 'http://alice:S3cr3t@proxy.corp:8080',
      });
      const described = client.describeProxy();
      expect(described).not.toContain('S3cr3t');
      expect(described).toContain('proxy.corp');
    });
  });
});

describe('身份一致性（改名漂移守卫）', () => {
  // 11-16 改名只改了 host 与 manifest，client 工厂 id / 槽位 key / 条目 id /
  // settings 命名空间留在旧名 → web boot 报 duplicate factory registration、
  // client entry 不激活，且 WebUI 保存的行被宿主静默忽略。这组标识必须恒等于包名。
  it('package.json name = host name = client PLUGIN_ID = client bundle 注册 id', async () => {
    const { readFileSync, existsSync } = await import('node:fs');
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const host = await import('../src/index.js');
    const { PLUGIN_ID } = await import('../src/client/plugin-id.js');
    expect(host.name).toBe(pkg.name);
    expect(PLUGIN_ID).toBe(pkg.name);
    const bundle = new URL('../lib/client.js', import.meta.url);
    if (existsSync(bundle)) {
      const m = readFileSync(bundle, 'utf8').match(/__ModuleLoader__\.load\(\{\s*id:\s*("[^"]+")/);
      expect(m).not.toBeNull();
      expect(JSON.parse(m![1])).toBe(pkg.name);
    }
  });
});

describe('user-agent.ts', () => {
  // WakaTime 的 Editors / Operating Systems / Models 三个面板**都**从 UA 解析。
 // 早前我们发的是 `dsh/1.0.0 dsh-wakatime/1.0.0`：没有括号段 → Unknown OS，
 // 没有模型 token → Models 面板永远空白。这组用例锁住官方模板的形状。
  it('模型 token 归一化与官方 aiModelUserAgentToken 一致', async () => {
    const { aiModelToken } = await import('../src/user-agent.js');
    expect(aiModelToken('deepseek-v4.1-flash-eco')).toBe('deepseek/4.1-flash-eco');
    expect(aiModelToken('claude-3-5-sonnet-20241022')).toBe('claude/3-5-sonnet-20241022');
    expect(aiModelToken('gpt-4o')).toBe('gpt/4o');
    expect(aiModelToken('claude-code/2.1.45')).toBe('claude-code/2.1.45');
    expect(aiModelToken('gpt-5')).toBe('gpt/5');
    // 无数字段识别不出 family：必须返回空串，调用方据此不拼 token。
    expect(aiModelToken('dsh-opendesign-go')).toBe('');
    expect(aiModelToken('deepseek-chat')).toBe('');
    expect(aiModelToken('')).toBe('');
  });

  it('UA 以 wakatime/ 开头并带 (OS-...) 括号段（否则 OS 解析不出来）', async () => {
    const { buildUserAgent } = await import('../src/user-agent.js');
    const ua = buildUserAgent({
      hostVersion: '0.2.2-rc.5', pluginVersion: '1.2.0',
      model: 'deepseek-v4.1-flash-eco',
      kernelRelease: '6.8.0', nodeVersion: '24.22.0', platform: 'linux', arch: 'x64',
    });
    expect(ua.startsWith('wakatime/')).toBe(true);
    // OS 名小写、arch 用官方词汇（x86_64）——取自本账号 50 条官方 CLI UA 样本。
    expect(ua).toMatch(/^wakatime\/[^ ]+ \(linux-6\.8\.0-x86_64\) node\/24\.22\.0 /);
    expect(ua).toContain('deepseek/4.1-flash-eco');
    expect(ua).toContain('dsh/0.2.2-rc.5');
  });

  it('windows/macOS 的 OS 名与官方取值一致', async () => {
    const { buildUserAgent } = await import('../src/user-agent.js');
    const win = buildUserAgent({ hostVersion: 'x', pluginVersion: '1', platform: 'win32', kernelRelease: '10.0', nodeVersion: 'n', arch: 'x64' });
    expect(win).toContain('(windows-10.0-x86_64)');
    const mac = buildUserAgent({ hostVersion: 'x', pluginVersion: '1', platform: 'darwin', kernelRelease: '24.0', nodeVersion: 'n', arch: 'arm64' });
    expect(mac).toContain('(darwin-24.0-aarch64)');
  });

  it('识别不出的模型不拼进 UA（不污染 user_agents 表）', async () => {
    const { buildUserAgent } = await import('../src/user-agent.js');
    const ua = buildUserAgent({ hostVersion: 'h', pluginVersion: '1', model: 'dsh-opendesign-go', kernelRelease: 'k', nodeVersion: 'n', arch: 'x64' });
    expect(ua).toBe('wakatime/1 (linux-k-x86_64) node/n dsh/h');
  });

  it('探测不到宿主版本时省略 dsh 段，而不是编一个版本', async () => {
    const { buildUserAgent } = await import('../src/user-agent.js');
    const ua = buildUserAgent({ hostVersion: '', pluginVersion: '1', kernelRelease: 'k', nodeVersion: 'n', arch: 'x64' });
    expect(ua).toBe('wakatime/1 (linux-k-x86_64) node/n');
    expect(ua).not.toContain('dsh/');
  });

 it('宿主版本探测不返回空壳或插件自己的 devDependency 版本', async () => {
    const { detectHostVersion } = await import('../src/user-agent.js');
    const v = detectHostVersion();
    // 在 vitest 下 argv[1] 指向测试运行器 → 探测不到，返回空串（不回退到错的版本）。
    expect(typeof v).toBe('string');
    expect(v === '' || /^\d/.test(v)).toBe(true);
  });
});
