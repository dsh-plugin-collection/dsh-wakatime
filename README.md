<p align="center">
  <img src="assets/logo.svg" width="128" alt="dsh-wakatime logo"/>
</p>

# dsh-wakatime

English | [简体中文](./README.zh-CN.md)

WakaTime heartbeat reporting for DeepSeek Harness (DSH).

Track your AI-assisted coding activity and sync it to your [WakaTime](https://wakatime.com) dashboards.

> **Note**: This is a community integration and is not officially affiliated with WakaTime.

## Features

- **File-level tracking** — every tool call (write, edit, read, bash, grep, glob, etc.) generates a precise WakaTime heartbeat
- **Smart project detection** — auto-detects project name from git, package.json, or directory
- **Branch tracking** — reports which git branch you're working on
- **Language inference** — detects programming language from file extension
- **Line statistics** — reports additions/deletions for write/edit operations
- **AI token reporting** — attaches `ai_input_tokens` / `ai_output_tokens` / `ai_prompt_length` / `ai_session` to assistant heartbeats (WakaTime GenAI metrics); enable **Track AI Messages** to activate
- **Heartbeat merging** — coalesces rapid operations on the same file within 5 seconds
- **Batch sending** — sends up to 25 heartbeats per HTTP request (WakaTime limit)
- **Request timeouts** — every HTTP request (10s) and git probe (5s) has a hard timeout, so a hanging endpoint can never stall flushing
- **Inference caching** — project name / branch / dependencies are resolved once per working directory and cached for 60 seconds instead of spawning git on every tool call
- **Per-item visibility on batch sends** — `heartbeats.bulk` answers with an outer 2xx plus a status per heartbeat; the plugin inspects each one: 4xx validation failures are permanent (dropped, warned with the server's reason), 429/5xx go back to the cache for retry. String fields are pre-clamped to the server's hard limits (`entity` ≤ 2083, `project` / `branch` ≤ 1024; empty strings are rejected too, so such fields are simply omitted)
- **Safe cache flushes** — concurrent flushes are serialized; only heartbeats that provably did not land are written back — nothing already stored is re-sent, and permanently invalid entries no longer hold cache slots
- **Live settings** — all WebUI settings take effect immediately: toggles are checked per event, heartbeat interval changes rebuild timers in place
- **Local caching** — caches failed heartbeats locally, retries on next successful send; failures and drops are always warned with their reason, not only under debug mode
- **WebUI configuration** — configure all settings from the WebUI settings panel (no need to edit config files)

## Compatibility

The plugin is a bridge between two systems: it runs **inside DSH** and speaks the **WakaTime API**.

| Side | Compatibility |
|---|---|
| **DSH (DeepSeek Harness)** | Runs as a DSH plugin on the web profile; the supported range is decided by `engines.dsh` in `package.json`, written as `>=0.1.7-rc.2 <0.2.0-0 \|\| >=0.2.0-rc.2 <0.3.0-0` (gate rules below); peer deps are ranges: `@deepseek-ai/dsh-agent` / `@deepseek-ai/dsh-session` `^0.1.1-rc.2 \|\| ^0.1.2-rc.1 \|\| ^0.1.5-rc.1 \|\| ^0.1.7-rc.2 \|\| ^0.2.0-rc.2 \|\| ^0.2.1-rc.2`, `@deepseek-ai/dsh-client-ui-primitives` `^0.1.7-rc.2 \|\| ^0.2.0-rc.2 \|\| ^0.2.1-rc.2`, `@deepseek-ai/cordis` `^4.0.1`, `@deepseek-ai/schemastery` `^3.18.1`; Node >= 22.19 (including 24+); Windows / macOS / Linux |
| **WakaTime cloud** | Works with wakatime.com out of the box (Heartbeat API v1) |
| **Self-hosted WakaTime** | Supported via the **API URL** setting — any WakaTime-compatible server |
| **WakaTime ecosystem** | Reads the standard `~/.wakatime.cfg`, so an existing API key is picked up automatically |
| **Other telemetry plugins** | Use one heartbeat backend per DSH profile; don't enable alongside similar plugins (e.g. codetime) |

### Version gate and peer dep ranges

The gate is the host's `evaluatePluginCompatibility` in `@deepseek-ai/dsh-app-boot/lib/index.js` (line 311): it reads the plugin's `package.json` only, without loading plugin code.

The line numbers below refer to the published `@deepseek-ai/dsh@0.2.1-rc.2` artifacts and are locators only; verify against the symbol names (`evaluatePluginCompatibility` / `validateVolatilePlacement` / the slot-contract entry `plugins.bundle.config`).

| Condition | Host behavior | Code location |
|---|---|---|
| `engines.dsh` present | **Only that one range is compared**, `peerDependencies` are ignored | `dsh-app-boot/lib/index.js:281-284` |
| `engines.dsh` absent | Every peer prefixed `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` must be satisfied by the running version; peers outside that prefix (`@deepseek-ai/cordis`, `@deepseek-ai/schemastery`) do not participate | `dsh-app-boot/lib/index.js:286-296` |
| Range comparison | `semver.satisfies(runningVersion, range, { includePrerelease: true })`, so prereleases participate | `dsh-app-boot/lib/index.js:277` |
| Requirement unmet | stderr prints `dsh: disabling profile plugin row "<row>": Plugin <name>@<version> is incompatible with dsh <ver>: requirements …` and the row is disabled; the message names `dsh plugin allow-version` for an exact-version exemption | `dsh-app-boot/lib/index.js:2308` and `:335` |

> **Hard lesson for plugin authors: write peerDependencies as ranges, never as exact versions.** The host's own 0.2.1 packages pin every `@deepseek-ai/dsh-*` peer to one exact version (e.g. all dsh peers of `@deepseek-ai/dsh-agent@0.2.1-rc.2` are `0.2.1-rc.2`), and a plugin that copies that style gets disabled generation by generation. The evidence is the `dsh: disabling profile plugin row "webhook-runtime"` and `dsh: disabling profile plugin row "webhook-github"` records in this machine's host log: `@deepseek-ai/dsh-webhook@0.2.0-rc.2` pins its peers to `"0.2.0-rc.2"`, so on dsh `0.2.1-rc.2` each row is disabled, with the log reading `Plugin @deepseek-ai/dsh-webhook@0.2.0-rc.2 is incompatible with dsh 0.2.1-rc.2: requirements {"@deepseek-ai/dsh-agent":"0.2.0-rc.2", "@deepseek-ai/dsh-invariants":"0.2.0-rc.2", …}`; this plugin passes because it declares `^0.2.0-rc.2`, which covers `0.2.1-rc.2` under `includePrerelease` while an exact match does not.

Peer ranges are written as an **explicit generation list** (`^0.1.1-rc.2 || … || ^0.2.1-rc.2`) rather than a single range to cover node-semver's default comparison mode: without `includePrerelease`, a prerelease version needs a comparator carrying the same `[major.minor.patch]` tuple. `^0.2.1-rc.2` expands to `>=0.2.1-rc.2 <0.3.0-0`, whose only anchor tuples are `0.2.1` and `0.3.0`, so with the semver the host ships and default semantics `satisfies('0.2.1-rc.2', '^0.2.1-rc.2')` is true, `satisfies('0.2.1', '^0.2.1-rc.2')` is true, and `satisfies('0.2.2-rc.1', '^0.2.1-rc.2')` is false.

Upstream's `0.2.1-rc.2` release has been added to the list per this rule. It is a **standing action**: one added entry covers that generation's rc plus that generation's stable release, the next rc generation needs another entry, and no single range can cover future prerelease generations in advance.

The exposure is npm only. Installing from a tarball produced by `npm pack` (a `file:` reference to a directory is installed as a link and skips `peerDependencies`, so it measures nothing): against host `0.2.1-rc.2`, `npm install` fails with `ERESOLVE` (exit 1) while the list lacks the entry and exits 0 once `^0.2.1-rc.2` is added; `pnpm install` exits 0 either way and `pnpm peers check` reports `No peer dependency issues found`, because pnpm intersects ranges instead of using default satisfies.

Self-check (read-only evaluation, writes nothing; requires dsh installed, i.e. `command -v dsh` returns a path):

```bash
node -e 'const p=require("path"),{createRequire}=require("module");const s=createRequire(p.dirname(require.resolve("@deepseek-ai/dsh-app-boot",{paths:[process.argv[1]]})))("semver");const v="0.2.1-rc.2",r="^0.2.0-rc.2";console.log("gate includePrerelease:",s.satisfies(v,r,{includePrerelease:true}),"/ default semantics:",s.satisfies(v,r))' "$(command -v dsh)"
```

The output `gate includePrerelease: true / default semantics: false` shows one version against one range evaluating true under the gate's comparison (with `includePrerelease`) and false under node-semver defaults.

### Kernel generation verification (checked 2026-10-20)

| DSH kernel | What was verified | Result | Measured on |
|---|---|---|---|
| `0.1.1-rc.2` | host entry link, real boot (headless) past the plugin stage, real boot (web) client bundle HTTP 200 | ✅ | 2026-09-07 |
| `0.1.2-rc.1` | host entry link, real boot (headless) past the plugin stage, real boot (web) client bundle HTTP 200 | ✅ | 2026-09-07 |
| `0.2.1-rc.2` | `npx tsc --noEmit` clean; `npx vitest run` passing every test (unit + integration); host compatibility gate (`evaluatePluginCompatibility`) PASS | ✅ | 2026-10-20 |

The two 0.1.x rows are historical measurements: the current `engines.dsh` range no longer covers `0.1.1-rc.2` or `0.1.2-rc.1` (both evaluate to false with the semver the host ships), so those two versions are now rejected by the gate and this plugin no longer claims support for them. The `0.2.1-rc.2` row records build, tests, and the gate only; real boot (headless / web) has not been verified on 0.2.x. The `^0.1.1-rc.2` and `^0.1.2-rc.1` entries stay in the `peerDependencies` list, but they are not a support claim: once `engines.dsh` is declared, peers do not participate in the gate at all, and those two entries only keep install-time resolution satisfied.

The settings namespace is written as `'wakatime' as SettingsNamespace` (type-only import) instead of calling the `settingsNamespace()` helper - removed in `0.1.2`, where importing it at runtime makes the whole module fail to link. Format validation happens inside `ctx.settings.register()` on both generations. `lib/client.js` was measured to have zero kernel imports, so it is generation-independent.

## Installation

### Local Development Install

```bash
# From the plugin directory
dsh plugin --profile web add /path/to/dsh-wakatime-plugin
```

### Git Install

From the internal Gitea:

```bash
# Install from Gitea
dsh plugin --profile web add http://gitea.internal/dsh-plugins/dsh-wakatime-plugin.git

# Install a pinned commit (recommended for security)
dsh plugin --profile web add http://gitea.internal/dsh-plugins/dsh-wakatime-plugin.git#<commit-sha>
```

Or from GitHub (or any other git host):

```bash
dsh plugin --profile web add github:your-username/dsh-wakatime-plugin
```

### Build from Source

If installing from git, you need to build first:

```bash
cd dsh-wakatime-plugin
pnpm install
pnpm build
```

Or add a `prepare` script to auto-build on install:

```json
{
  "scripts": {
    "prepare": "tsc"
  }
}
```

## Configuration

### WebUI Settings Panel (Recommended)

After installing and restarting DSH:

1. Open the WebUI
2. Go to **Settings** → **WakaTime**
3. Configure:
   - **API Key**: Your WakaTime API key (shown as password field)
   - **API URL**: Base URL (for self-hosted WakaTime)
   - **Heartbeat Interval**: How often to send heartbeats (60000-300000ms)
   - **Project Name**: Override auto-detected project name
   - **Language**: Override auto-detected language
   - **Terminal App Name**: entity for command heartbeats (an app name); blank falls back to `Terminal`
   - **Track Tool Calls**: Enable/disable tool call tracking
   - **Track User Messages**: Enable/disable user message tracking
   - **Track AI Messages**: Enable/disable AI message tracking
   - **Cache Heartbeats**: Enable/disable local caching
   - **Cache Limit**: Maximum cached heartbeats (10-1000)
   - **Debug Mode**: Enable debug logging

All settings take effect immediately (no restart needed).

### Alternative Configuration Methods

If you prefer config files:

**Environment variable:**
```bash
export WAKATIME_API_KEY=sk-xxxxxxxxxxxx
```

**cordis.patch.yml:**
```yaml
- insert:
  - id: dsh-wakatime
    name: 'dsh-wakatime'
    config:
      api_key: sk-xxxxxxxxxxxx
      debug: true
```

**~/.wakatime.cfg (WakaTime standard config):**
```ini
[settings]
api_key = sk-xxxxxxxxxxxx
```

### Configuration Priority

1. WebUI settings (highest priority)
2. Environment variable `WAKATIME_API_KEY`
3. `cordis.patch.yml` config
4. `~/.wakatime.cfg` api_key
5. Plugin schema defaults (lowest priority)

## Category Mapping

| DSH Tool | WakaTime Category | is_write |
|---|---|---|
| `write` | `coding` | true |
| `edit` | `coding` | true |
| `read` | `browsing` | false |
| `bash` / `pwsh` | decided by the command itself — see “Shell category mapping” below | false |
| `grep` / `glob` | `browsing` | false |
| `web_search` | `researching` | false |
| `mcp__codegraph__codegraph_explore` | `code reviewing` | false |
| `mcp__langfuse__*` | `debugging` | false |
| `subagent` / `subagent_fork` | `coding` | false |
| `workflow` | `coding` | false |
| `todo_write` | `coding` | false |
| `ask_user_question` | `communicating` | false |
| user message event | `communicating` | false |
| assistant message event | `ai coding` | false |
| `skill` | `learning` | false |
| other | `coding` | false |

## Architecture

```
src/
├── index.ts      # Plugin entry: registers event listeners and timers
├── wakatime.ts   # HTTP client for WakaTime API
├── tracker.ts    # File-level activity tracker
├── project.ts    # Project/branch inference from git
├── language.ts   # Language inference from file extension
├── diff.ts       # Line diff calculation for write/edit
├── cache.ts      # Local heartbeat cache (JSONL file)
├── settings.ts   # Config schema and WebUI settings panel registration
└── types.ts      # Type definitions and constants
```

## Development and packaging

### Four version-sensitive wiring points (still true on 0.2.2)

| Wiring point | Rule | Source |
|---|---|---|
| Key of the `plugins.bundle.config` WebUI slot | The **plugin package name** (`name` in `package.json`), not the settings namespace and not the profile entry id; a mismatched key leaves the bundle page without its config card | Host `dsh-client-ui-plugin-manager/lib/types/client/slot-contract.d.ts:149` ("keyed by the bundle's package name"); the render site `lib/client.js:2964` passes `{ entryKey: pkg.name }` |
| How `@deepseek-ai/dsh-client-ui-primitives` is referenced | Must stay **external**, never bundled into `lib/client.js`: the host web module table keeps that id resident and official client packages do `require("@deepseek-ai/dsh-client-ui-primitives")`; bundling it copies the whole icon set | Host `dsh-web-frontend/dist/assets/index-*.js` module table contains the id; `dsh-client-ui-plugin-manager/lib/client.js:10`; this repo `build.mjs:28` |
| Automatic settings-page projection | Depends on `.volatile()` on the plugin's Config fields; the projection lives in host `dsh-app-boot`, which writes `volatile` into the schema's `x-cordis` | This repo `src/index.ts`; host `dsh-app-boot/lib/index.js` (`validateVolatilePlacement`) and its projection branch |
| `.volatile()` fields reach the plugin as **ref objects**, not values | Every volatile field handed to `apply()` is `Object.freeze({ get: () => value, [write]: … })`, so it **must be unwrapped before use** — the host's own `dsh-settings` does exactly that (`plainConfig`). Using it as a value fails in several ways at once: `api_url` builds an illegal URL, `heartbeat_interval_ms` is treated as 1 ms by Node, booleans become permanently truthy, string fields drop out of payloads, and `cache_limit` comparisons are always false. This plugin normalizes everything in `src/config-value.ts`, at both the entry and the settings-document layer | Host `cosmokit/lib/index.js` (`createVolatile` / `isVolatile`); `dsh-settings/lib/index.js` (`if (isVolatile(value)) return plainConfig(value.get())`); reproduced identically on 0.2.1 and 0.2.2 |

### Dependencies and host version drift

| Item | Note |
|---|---|
| pnpm is the only package manager | The repo ships `pnpm-lock.yaml` (with `pnpm-workspace.yaml`) and has no `package-lock.json`; install and refresh the lock with pnpm |
| `typescript` must be an explicit devDependency | `scripts.build` / `prepare` / `watch` all invoke `tsc`. Before 11-10 it was **in neither devDependencies nor the lockfile** (grep hit count 0): builds worked only because the environment happened to carry a foreign tsc, so a clean clone, another machine, or `pnpm install --frozen-lockfile` fails — and `prepare` fails during install itself. It is now declared as `typescript: ^5.9.0` (matching sibling plugins in this workspace), and the build runs the local `node_modules/.bin/tsc` instead of `npx tsc`. That substitution matters: with the dependency missing, npx quietly installs the deprecated same-named package `tsc@2.0.4`, which only prints "This is not the tsc command you are looking for" and leaves `lib/` in its previous state — a broken build environment disguised as a successful build |
| Development dependencies are exact pins | devDependencies pin `@deepseek-ai/dsh-agent` / `@deepseek-ai/dsh-session` / `@deepseek-ai/dsh-settings` / `@deepseek-ai/dsh-client-ui-primitives` all to `0.2.1-rc.2` (`@deepseek-ai/cordis` `^4.0.5` and `@deepseek-ai/schemastery` `^3.18.5` stay ranges). These are development-time values, not the published contract: the runtime gate reads `engines.dsh` only, and the outward contract is the peer list above. `@deepseek-ai/dsh-client-ui-primitives` is an explicit devDependency for development resolution only and must still stay external in the bundle (see the table above) |
| Host packages pin their own peers | From 0.2.1 every host package pins its `@deepseek-ai/dsh-*` peers to one exact version (`@deepseek-ai/cordis` stays a `~4.0.5` range). That is internal to the host monorepo; plugins must not copy it, see "write peerDependencies as ranges" above |
| `@deepseek-ai/dsh-invariants` is discontinued | Last published version is `0.2.0-rc.2` and the 0.2.1-rc.2 host package set has no such package; drop it from devDependencies after an upgrade if it lingers |
| 0.2.1 removes the memory persistence mode of the settings client | `ConfigFormSnapshot` no longer has `mode: 'host' \| 'memory'`; `SettingsMirrorSnapshot.status` on the describe mirror no longer has `'unavailable'`, leaving `'idle' \| 'loading' \| 'ready'`; `ConfigFormController` takes one less persistence parameter (now `ctx, spec, mirror, schema`). Sources: host `dsh-client-ui-settings/lib/types/client/config-form-types.d.ts:6-29`, `settings-mirror.d.ts:21-31`, `config-form.d.ts:49`. Plugin code must not read `snapshot.mode` |
| Writes report acceptance (existing contract since 0.2.0, not new in 0.2.1) | `ConfigForm.set` / `unset` / `mutate` return `Promise<boolean>`: `true` means the Host accepted, `false` means refusal or a skipped write; transport failures still reject. Source: `config-form-types.d.ts:49-70` |

## Troubleshooting

### Plugin not loading

1. Check that `lib/` directory exists and contains compiled JS files
2. Run `pnpm run build` if missing
3. Check DSH logs for errors

### Settings not showing in WebUI

1. Make sure the plugin is in the `bundles` list in `package.json`
2. Restart DSH completely
3. Check browser console for errors

### Heartbeats not sending

1. **Look at the local cache before the logs.** `~/.dsh/wakatime/heartbeat-cache.jsonl`
   is only written when sending fails and is drained when sending succeeds. If it keeps
   growing or sits pinned at the Cache Limit, sending is failing continuously — and the
   oldest heartbeats are being trimmed away, so that activity is already unrecoverable.
   A cache **far above** the Cache Limit is its own signal: `cache_limit` is not reaching
   the code as a number (see step 3).
2. **Read the warnings; debug is not required.** Failures are always warned with a reason,
   written to **both** the host logger and the console (this host does not forward
   `ctx.logger` to the captured stdout, so logger-only warnings are effectively no logs —
   that is exactly why two separate silent outages went unnoticed):
   `上报失败…` (transport / auth / rate limit), `N/M 条心跳被 WakaTime 逐条拒绝并已丢弃…`
   (invalid payload), `cache flush failed…` (the backfill cannot send either).
3. **After a host upgrade, look first for "配置字段不是可用值" warnings.** Fields marked
   `.volatile()` reach the plugin as cosmokit refs — `Object.freeze({ get, [write] })`,
   i.e. **objects** — and `src/config-value.ts` unwraps and type-checks every one of them,
   falling back to the schema default and warning with the field name and shape (never the
   value). Without that layer, a single upgrade breaks many things at once, all measured:
   `api_url` → illegal URL (the request is never even issued), `heartbeat_interval_ms` →
   `setInterval(fn, NaN)`, which Node coerces to a 1 ms delay (reproduced in isolation: 915 fires/s; the corresponding Node warning was never seen inside the host, so no CPU figure is attributed to it),
   `include_*=false` → truthy object (tracking you disabled keeps reporting),
   `project_name` / `language` → both fields silently dropped from payloads,
   `cache_limit` → the cache is never trimmed.
4. **Confirm this key actually works.** The "Project name" dropdown in the settings page
   uses the same key: empty candidates plus an `error` means a key or connectivity problem
   (`API Key 无效` = the server returned 401; `未配置 WakaTime API Key` = none of the three
   sources has a usable value). Resolution order is config layer → `WAKATIME_API_KEY` →
   `~/.wakatime.cfg`, and all three only accept a **non-empty string**: a wrong shape is
   ignored, falls through, and is warned with a shape summary.
5. **Check connectivity to WakaTime, and note the proxy precedence.** Outbound proxy is
   resolved as `HTTPS_PROXY` / `HTTP_PROXY` env vars → `proxy` under `[settings]` in
   `~/.wakatime.cfg` (the same source wakatime-cli uses); `NO_PROXY` accepts `*`, exact
   hosts and `.suffix` entries. Why the plugin reads the cfg at all: on this machine
   curl-direct, curl-via-proxy and node-direct were all 20/20 fine, yet the plugin
   intermittently failed with `fetch failed (cause: ETIMEDOUT)` — it was the only link on
   the box not using the proxy the user had configured. Network diagnostics now include
   the `cause` (ECONNRESET / ETIMEDOUT / ENOTFOUND …) instead of a bare `fetch failed`.
6. **If behaviour does not match the code, check the build fingerprint.** The log line
   `apply called; artifact mtime=… pid=…` says exactly which build this process loaded.
   Hot reload can leave old fibers still sending with pre-fix code — restart DSH fully.
7. **Payload lengths are hard-validated.** `entity` ≤ 2083, `project` / `branch` ≤ 1024,
   and empty strings are rejected as well. The plugin clamps before sending; a clamped
   `entity` ends with `...`. If per-item rejections still appear, some field is outside the
   clamping coverage — paste the server reason from the warning into an issue.
8. **A plugin key no longer reads your own data back.** Since 2026-10 WakaTime answers
   `/users/current`, `/users/current/projects` and `/users/current/heartbeats` with
   `403 API Keys are only for plugins, use your personal oauth token` while
   **`heartbeats.bulk` still accepts the plugin key**. Two consequences: the "Project name"
   dropdown stays empty (an upstream policy change, not an auth bug in this plugin), and a
   403 on a read endpoint must not be mistaken for a dead key — judge the key by the write
   endpoint or by this plugin's failure warnings.

### Shell category mapping

The category of a `bash` / `pwsh` call is now derived from the command itself
(`src/category.ts`) instead of being hardcoded to `building`. Replaying the 5290 shell
heartbeats already stored on the account gives this before/after:

| category | before | after |
|---|---|---|
| `building` | 100.0% | 1.3% |
| `coding` | — | 50.6% |
| `browsing` | — | 46.4% |
| `researching` | — | 0.8% |
| `running tests` | — | 0.5% |
| `debugging` | — | 0.3% |

i.e. 98.7% of what the dashboard reported as "building" was not building.

Rules and hard constraints:

- **Only the bare subcommand is inspected, never the trailing arguments.** The counter-example
  that motivated this: `grep -n foo test/a_test.py` — a path containing `test` used to be
  classified as running tests, inventing 411 fake test records in the account. File-inspection
  tools (`ls` / `cat` / `grep` / `sed` / `head` …) are unconditionally `browsing`.
- **Wrapper layers are peeled first**: a leading `cd <dir> &&`, `export`, `sudo` / `time` /
  `timeout`, and the one-shot `npx` / `bunx` prefix (including `--yes`, `--package <pkg>`,
  `vitest@2`). Without peeling, the most common DSH shape
  `cd repo && pnpm test | tail` always resolves to `cd`.
- **Only categories from the authoritative WakaTime set are emitted** (see
  `wakatime-cli` `pkg/heartbeat/category.go`): the list has no `deployment` and no `testing`
  (the correct value is `running tests`); an invented word cannot be aggregated by the
  dashboard. Platform tools like `docker` / `kubectl` are therefore split by subcommand into
  `browsing` (reading state) and `building` (making changes).
- Anything unrecognised falls back to `coding`.

### Entity for command heartbeats

A `bash` / `pwsh` heartbeat has `type: "app"`, and per wakatime-cli's own definition
(*"AppType represents an app entity"*) the entity of an app heartbeat should be **an
application name**, not a command line. Using the raw command made the 5281 shell
heartbeats on the account fan out into **5158 distinct entities, 98.2% of which appear
exactly once** — no aggregatable dimension, and a constant risk of tripping the 2083
character entity limit, which rejects such heartbeats per item.

The entity now comes from the "Terminal App Name" setting (default `Terminal`; e.g. set
it to `DSH`). Leaving it blank falls back to the default — an empty entity is rejected by
the server, so there is no path that sends one. What the command was doing is expressed by
`category`. Repeated calls inside the 5 second window are still merged, but the merge key is
`entity + category`: with a shared app name, a bare `entity` key would let a later `ls`
overwrite an earlier `pnpm test`.

User / assistant heartbeats **deliberately keep** `dsh-session-<id>` as their entity: its
cardinality is bounded by the number of sessions and it is the only dimension that drills
down per session (AI attribution additionally carries `ai_session`).

Remaining boundary: `language` for shell heartbeats is still `Shell`, and the entity shape
change cannot be retrofitted — cross-version comparisons on the entity axis will not line up.

## License

MIT
