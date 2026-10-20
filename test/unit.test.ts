import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveLanguage } from '../src/language.js';
import { resolveProject, resolveBranch, resolveProjectRootCount, resolveDependencies, readWakatimeCfgApiKey, maskApiKey, clearResolveCaches } from '../src/project.js';
import { calculateWriteDiff, calculateEditDiff } from '../src/diff.js';
import { FileTracker } from '../src/tracker.js';
import { fieldLanded, saveFailureOf, secretSlotSet, writeAccepted, SETTINGS_NAMESPACE_CANDIDATES } from '../src/client/mirror.js';
import type { MirrorSnapshotLike } from '../src/client/mirror.js';
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

  describe('writeAccepted', () => {
    it('should unwrap both host shapes into the acceptance boolean', () => {
      // ConfigForm.set/unset/mutate 直接给 boolean（自 0.2.0 起，拒绝不抛异常）
      expect(writeAccepted(true)).toBe(true);
      expect(writeAccepted(false)).toBe(false);
      // 裸线 remote.settings.mutate 给 RemoteResult 信封，受理位在 ok 上
      expect(writeAccepted({ ok: true, value: { ns: 'dsh-wakatime', revision: 3 } })).toBe(true);
      expect(writeAccepted({ ok: false, error: { code: 'conflict' } })).toBe(false);
      // 非 true 的 ok 算未受理；无判别信息的 resolve（更老宿主用抛异常表达失败）算受理
      expect(writeAccepted({ ok: undefined })).toBe(false);
      expect(writeAccepted(undefined)).toBe(true);
    });
  });

  describe('saveFailureOf', () => {
    it('should keep acceptance and landing as two independent judgements', () => {
      expect(saveFailureOf(false, true)).toBe(null);
      // 受理了但回读没落地 → notLanded（既有判定，不被新判定覆盖）
      expect(saveFailureOf(false, false)).toBe('notLanded');
      // 被拒是更靠前的因；即使回读恰好显示一致也不谎报成功
      expect(saveFailureOf(true, false)).toBe('refused');
      expect(saveFailureOf(true, true)).toBe('refused');
    });
  });

  describe('fieldLanded', () => {
    it('should judge secrets solely by the mirror slot (wire redacts secret values)', () => {
      // 线路脱敏：value/user 里永远看不到密钥，但槽位 set=true 即落地
      expect(fieldLanded('api_key', 'secret', 'waka_key', {}, { api_key: '' }, true)).toBe(true);
      // 写入失败（镜像槽位仍 unset）即未落地，即使解析层残留旧值
      expect(fieldLanded('api_key', 'secret', 'waka_key', {}, { api_key: '' }, false)).toBe(false);
    });

    it('should compare against the user layer for plain fields', () => {
      expect(fieldLanded('debug', 'boolean', true, { debug: true }, { debug: true }, false)).toBe(true);
      expect(fieldLanded('debug', 'boolean', true, { debug: false }, { debug: false }, false)).toBe(false);
      expect(fieldLanded('heartbeat_interval_ms', 'number', 90000, { heartbeat_interval_ms: 90000 }, {}, false)).toBe(true);
    });

    it('should fall back to the resolved value when absent from the user layer', () => {
      expect(fieldLanded('api_url', 'text', 'https://wakatime.com', {}, { api_url: 'https://wakatime.com' }, false)).toBe(true);
      expect(fieldLanded('api_url', 'text', 'https://example.com', {}, { api_url: 'https://wakatime.com' }, false)).toBe(false);
    });
  });
});

describe('tracker.ts GenAI metrics', () => {
  const testDir = join(tmpdir(), 'dsh-wakatime-tracker-test-' + Date.now());
  let tracker: FileTracker;

  beforeEach(() => {
    clearResolveCaches();
    mkdirSync(testDir, { recursive: true });
    const session = { id: 'sess-abc123', header: { cwd: testDir } } as any;
    tracker = new FileTracker(session, {});
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should attach ai tokens and ai coding category on assistant message', async () => {
    await tracker.trackAssistantMessage({
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        message: { content: 'hello' },
        usage: { inputTokens: 120, outputTokens: 45 },
      },
    } as any);
    const pending = tracker.getPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].category).toBe('ai coding');
    expect(pending[0].ai_input_tokens).toBe(120);
    expect(pending[0].ai_output_tokens).toBe(45);
    expect(pending[0].ai_session).toBe('sess-abc123');
    // 未追踪用户消息时不应带 prompt 长度
    expect(pending[0].ai_prompt_length).toBeUndefined();
  });

  it('should carry user prompt length into the next assistant heartbeat', async () => {
    await tracker.trackUserMessage({ type: 'user/message', data: { content: '帮我看看这段代码' } } as any);
    await tracker.trackAssistantMessage({
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        message: { content: 'ok' },
        usage: { inputTokens: 10, outputTokens: 5 },
      },
    } as any);
    const pending = tracker.getPending();
    const assistant = pending.find((h) => h.category === 'ai coding');
    expect(assistant).toBeDefined();
    expect(assistant!.ai_prompt_length).toBe('帮我看看这段代码'.length);
  });

  it('should omit token fields when usage is missing', async () => {
    await tracker.trackAssistantMessage({
      type: 'assistant/message',
      data: { turn: 2, step: 1, message: { content: 'no usage' } },
    } as any);
    const pending = tracker.getPending();
    expect(pending[0].category).toBe('ai coding');
    expect(pending[0].ai_input_tokens).toBeUndefined();
    expect(pending[0].ai_output_tokens).toBeUndefined();
  });

  it('should keep communicating category for user messages', async () => {
    await tracker.trackUserMessage({ type: 'user/message', data: { content: 'hi' } } as any);
    const pending = tracker.getPending();
    expect(pending[0].category).toBe('communicating');
    expect(pending[0].entity).toBe('dsh-session-sess-abc123');
  });
});
