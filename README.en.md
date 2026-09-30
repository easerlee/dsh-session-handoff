# dsh-handoff

English | [中文](README.md)

A DSH plugin that **hands the current work off to a fresh session** once context pressure reaches a threshold.

Long sessions degrade near the end. DSH's built-in compaction compresses *in place* — it replaces the
original history with a summary. This plugin takes the other road: **open a new session and carry over a
reviewable handoff package**, leaving the old session untouched.

## Features

- **Triggered by real context pressure** — reads `surfaceTokens / contextWindow` from the
  `contextPressure` projection, not a guessed turn or message count.
- **The handoff package is extracted mechanically from the session itself** — files it touched, recent
  user messages, where the last assistant message stopped — and written to disk at
  `<workspace>/.dsh/handoff/<timestamp>-<session-id-suffix>.md`, so it can be reviewed and traced.
- **Two manual entry points** — the `handoff_now` tool in the desktop app (with a `dryRun` mode), and
  HTTP endpoints for the CLI / `dsh web`.
- **The old session is only renamed with ` [已交接]`** — never archived, never deleted.
- **Self-contained** — no companion plugin, no personal memory archive required.

## Install

A DSH plugin is just an npm package (`main` + `dsh.bundle.patch`) registered in an active profile.

1. Put this repo under DSH's own directory, e.g. `~/.dsh/plugins/dsh-handoff`
   (Windows: `C:\Users\<you>\.dsh\plugins\dsh-handoff`) — not inside the client install directory,
   which upgrades and reinstalls wipe.
2. In the active profile directory (Windows: `C:\Users\<you>\.dsh\profiles\<name>`):
   - `package.json`: add `"dsh-handoff": "file:/absolute/path/to/dsh-handoff"` to `dependencies`, and
     `"dsh-handoff"` to the `dsh.profile.bundles` array;
   - `cordis.patch.yml`: add the config block from **Configuration** below.
3. Run `pnpm install` in the profile directory so the `file:` dependency is linked in.
4. **Restart DSH** — the bundle list is read once at startup, and the same goes for any source change.

Nothing extra is needed on packaged builds (code lives inside `resources/app.asar`): the plugin resolves
`@deepseek-ai/*` through the harness entry point itself.

## Configuration

In the profile's `cordis.patch.yml`:

```yaml
- id: dsh-handoff
  config:
    enabled: true
    thresholdRatio: 0.85
    cooldownMs: 300000
    handoffDir: .dsh/handoff
    recentMessages: 14
    maxChars: 24000
    renameOldSuffix: " [已交接]"
    dryRun: false
```

| Key | Default | Description |
|---|---|---|
| `enabled` | `true` | When off, only the HTTP endpoints and the tool remain, no automatic handoff |
| `thresholdRatio` | `0.85` | Pressure ratio that triggers a handoff (0.85 = 85%) |
| `cooldownMs` | `300000` | Minimum gap between two handoffs of the same session |
| `handoffDir` | `.dsh/handoff` | Where packages are written (relative to the workspace; absolute works too) |
| `recentMessages` | `14` | How many recent user messages go into the package |
| `maxChars` | `24000` | Character cap for the package |
| `renameOldSuffix` | ` [已交接]` | Suffix appended to the old session's title |
| `dryRun` | `false` | **true = write the package only, create no session** (useful for a first check) |

⚠️ A patch `config` **replaces the whole block** — when overriding, repeat every key you don't want to change.

## Usage

### Desktop: the `handoff_now` tool (recommended)

> You: "hand this off and start a fresh session"
> Agent: calls `handoff_now` → returns the new session id / title / package path

To review the package first without creating a session:

```
handoff_now(dryRun: true)     # writes the package only — no new session, no rename
```

### CLI / `dsh web`: HTTP endpoints

```bash
# trigger manually (omit sessionId to use the most recent active session)
curl -X POST http://127.0.0.1:<port>/api/handoff/run \
  -H "content-type: application/json" \
  -d '{"reason":"manual switch"}'

# status and last result
curl http://127.0.0.1:<port>/api/handoff/status
```

On `dsh web` the `?token=` in the address bar is the credential. The desktop app has no address bar —
open DevTools and read it from `location.href`.

### Automatic

A handoff fires automatically once pressure reaches `thresholdRatio` and `cooldownMs` has elapsed — but
read the next section first.

## Relationship to compaction

With both enabled, the thresholds differ:

| | Threshold | Behaviour |
|---|---|---|
| `compaction-basic` | `0.6` | Compress in place, the session keeps going |
| `dsh-handoff` | `0.85` | Open a new session and hand off |

Compaction pushes pressure back below 0.6 first, so **the automatic handoff rarely ever fires**. That is
intentional: compaction handles the daily grind, handoff is the safety net plus a manual "fresh session"
button.

Want handoff to be the main mechanism? Set `compaction-basic` back to `disabled: true` and lower
`thresholdRatio` to `0.6`.

## Known limitations

1. **The UI does not switch for you** — the new session's id and title are returned; click over to it in
   the session list.
2. **The package is mechanically extracted, not model-summarised** — complex tasks may lose nuance.
3. The old session is renamed, not archived (intentional).

## Development

```powershell
# self-check: really runs apply, the registered handoff_now tool, the dryRun branch and package writing
$env:ELECTRON_RUN_AS_NODE=1
& "<DSH install dir>\DeepSeek Harness.exe" "<this repo>\selfcheck.mjs"
```

It has to run under the Electron runtime — packaged builds keep `@deepseek-ai/*` inside `app.asar`,
which plain node cannot resolve.

## License

MIT
