# dsh-wakatime

English | [简体中文](./README.zh-CN.md)

WakaTime heartbeat reporting for DeepSeek Harness (DSH).

Track your AI-assisted coding activity and sync it to WakaTime dashboards.

## Features

- **File-level tracking** — every tool call (write, edit, read, bash, grep, glob, etc.) generates a precise WakaTime heartbeat
- **Smart project detection** — auto-detects project name from git, package.json, or directory
- **Branch tracking** — reports which git branch you're working on
- **Language inference** — detects programming language from file extension
- **Line statistics** — reports additions/deletions for write/edit operations
- **Heartbeat merging** — coalesces rapid operations on the same file within 5 seconds
- **Batch sending** — sends up to 25 heartbeats per HTTP request (WakaTime limit)
- **Request timeouts** — every HTTP request (10s) and git probe (5s) has a hard timeout, so a hanging endpoint can never stall flushing
- **Inference caching** — project name / branch / dependencies are resolved once per working directory and cached for 60 seconds instead of spawning git on every tool call
- **Safe cache flushes** — concurrent flushes are serialized; on partial failure only unsent heartbeats are written back (no duplicates, no data loss)
- **Live settings** — all WebUI settings take effect immediately: toggles are checked per event, heartbeat interval changes rebuild timers in place
- **Local caching** — caches failed heartbeats locally, retries on next successful send
- **WebUI configuration** — configure all settings from the WebUI settings panel (no need to edit config files)

## Installation

### Local Development Install

```bash
# From the plugin directory
dsh plugin --profile web add /path/to/dsh-wakatime-plugin
```

### GitHub Install

```bash
# Install from GitHub
dsh plugin --profile web add github:your-username/dsh-wakatime-plugin

# Install specific commit (recommended for security)
dsh plugin --profile web add github:your-username/dsh-wakatime-plugin#<commit-sha>
```

### Build from Source

If installing from git, you need to build first:

```bash
cd dsh-wakatime-plugin
npm install
npm run build
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

## Troubleshooting

### Plugin not loading

1. Check that `lib/` directory exists and contains compiled JS files
2. Run `npm run build` if missing
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
