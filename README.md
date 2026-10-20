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
- **Safe cache flushes** — concurrent flushes are serialized; on partial failure only unsent heartbeats are written back (no duplicates, no data loss)
- **Live settings** — all WebUI settings take effect immediately: toggles are checked per event, heartbeat interval changes rebuild timers in place
- **Local caching** — caches failed heartbeats locally, retries on next successful send
- **WebUI configuration** — configure all settings from the WebUI settings panel (no need to edit config files)

## Compatibility

The plugin is a bridge between two systems: it runs **inside DSH** and speaks the **WakaTime API**.

| Side | Compatibility |
|---|---|
| **DSH (DeepSeek Harness)** | Runs as a DSH plugin on the web profile; the supported range is decided by `engines.dsh` in `package.json`, written as `>=0.1.7-rc.2 <0.2.0-0 \|\| >=0.2.0-rc.2 <0.3.0-0` (gate rules below); peer deps are ranges: `@deepseek-ai/dsh-agent` / `@deepseek-ai/dsh-session` `^0.1.1-rc.2 \|\| ^0.1.2-rc.1 \|\| ^0.1.5-rc.1 \|\| ^0.1.7-rc.2 \|\| ^0.2.0-rc.2`, `@deepseek-ai/dsh-client-ui-primitives` `^0.1.7-rc.2 \|\| ^0.2.0-rc.2`, `@deepseek-ai/cordis` `^4.0.1`, `@deepseek-ai/schemastery` `^3.18.1`; Node >= 22.19 (including 24+); Windows / macOS / Linux |
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

Peer ranges are still written as an **explicit generation list** (`^0.1.1-rc.2 || … || ^0.2.0-rc.2`) rather than a single `^0.2.0-rc.2` to cover the other comparison mode of node-semver, which excludes prereleases when `includePrerelease` is not set. Measured with the semver the host ships: `satisfies('0.2.1-rc.2', '^0.2.0-rc.2')` is false and `satisfies('0.1.2-rc.1', '^0.1.1-rc.2')` is false, while an explicit generation list holds under both comparison modes. **Add another entry whenever upstream ships a new rc generation.**

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
| `bash` / `pwsh` | `building` | false |
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

### Three version-sensitive wiring points (still true on 0.2.1)

| Wiring point | Rule | Source |
|---|---|---|
| Key of the `plugins.bundle.config` WebUI slot | The **plugin package name** (`name` in `package.json`), not the settings namespace and not the profile entry id; a mismatched key leaves the bundle page without its config card | Host `dsh-client-ui-plugin-manager/lib/types/client/slot-contract.d.ts:149` ("keyed by the bundle's package name"); the render site `lib/client.js:2964` passes `{ entryKey: pkg.name }` |
| How `@deepseek-ai/dsh-client-ui-primitives` is referenced | Must stay **external**, never bundled into `lib/client.js`: the host web module table keeps that id resident and official client packages do `require("@deepseek-ai/dsh-client-ui-primitives")`; bundling it copies the whole icon set | Host `dsh-web-frontend/dist/assets/index-*.js` module table contains the id; `dsh-client-ui-plugin-manager/lib/client.js:10`; this repo `build.mjs:28` |
| Automatic settings-page projection | Depends on `.volatile()` on the plugin's Config fields; on 0.2.1 the projection still lives in host `dsh-app-boot`, which writes `volatile` into the schema's `x-cordis` | This repo `src/index.ts:37-47`; host `dsh-app-boot/lib/index.js:2606` (`validateVolatilePlacement`) and the projection branch from `:2735` |

### Dependencies and host version drift

| Item | Note |
|---|---|
| Install with pnpm | The repo is driven by `pnpm-lock.yaml` + `pnpm-workspace.yaml`. The root `package-lock.json` is stale (verified contents: cordis 4.0.1, dsh-agent 0.1.1-rc.2, schemastery 3.18.1, plus the discontinued `@deepseek-ai/dsh-invariants` 0.1.1-rc.2), so installing with npm builds a tree that does not match the 0.2.1-rc.2 host this plugin is verified against |
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

1. Verify API Key is correct
2. Check network connectivity to WakaTime
3. Enable debug mode to see detailed logs
4. Check `~/.dsh/wakatime/heartbeat-cache.jsonl` for cached heartbeats

## License

MIT
