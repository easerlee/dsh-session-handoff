# dsh-session-handoff

English | [中文](README.md)

A DSH plugin that **hands the current work off to a fresh session** once context pressure reaches a threshold.

Long sessions degrade near the end. DSH's built-in compaction compresses *in place* — it replaces the
original history with a summary. This plugin takes the other road: **open a new session and carry over a
reviewable handoff package**, leaving the old session untouched.

- Triggered by **real context pressure**, or by **how many times this session has been compacted** — not a guessed turn count
- The package is **extracted mechanically from the session itself** (files it touched, recent messages,
  where the last message stopped) and written to disk for review
- `handoff_now` tool in the desktop app (with a `dryRun` mode) / HTTP endpoints for `dsh web` and the CLI
- The old session is **only renamed with ` [已交接]`** — never archived, never deleted

## Install

```bash
dsh plugin --profile <your profile> add dsh-session-handoff
```

Then **restart DSH** — the bundle list is read once at startup.

- The npm package is `dsh-session-handoff` (the name `dsh-handoff` was already taken by another plugin)
- The desktop profile is `desktop`, the web one is `web`; the command writes the package into the
  profile's `dependencies` *and* `dsh.profile.bundles`, so no manual file editing is needed
- If `dsh` is not on your PATH, use `resources\runtime\cli\bin\dsh.cmd` inside the install directory
- Without npm: `add github:easerlee/dsh-session-handoff` (same code, just pulled from the repo each time)

Check it is live (web / CLI):

```bash
curl "http://127.0.0.1:<port>/api/handoff/status"
# {"ok":true,...,"tool":"registered"}   ← "registered" means the handoff_now tool is registered too
```

## Usage

### Desktop: the `handoff_now` tool (recommended)

> You: "hand this off and start a fresh session"
> Agent: calls `handoff_now` → returns the new session id / title / package path

To review the package first without creating a session:

```
handoff_now(dryRun: true)     # writes the package only — no new session, no rename
```

### `dsh web` / CLI: HTTP endpoints

```bash
# trigger manually (omit sessionId to use the most recent active session)
curl -X POST http://127.0.0.1:<port>/api/handoff/run \
  -H "content-type: application/json" \
  -d '{"reason":"manual switch"}'

# status and last result
curl http://127.0.0.1:<port>/api/handoff/status
```

On `dsh web`, the `?token=` in the address bar is the credential (visit `/` once so the cookie is set —
API calls are rejected before that). The desktop app has no address bar; trigger it with the tool above.

### Automatic

A handoff fires once cooldownMs has elapsed and either condition holds:

- pressure has reached `thresholdRatio`
- **this session has been compacted `maxCompactions` times** (default 2)

The second one matters: compaction always pushes pressure back below its own threshold, so a
pressure-only trigger never gets its chance. How the two get along is below.

## Configuration

In the profile's `cordis.patch.yml`:

```yaml
- id: dsh-session-handoff
  config:
    enabled: true
    thresholdRatio: 0.85     # shipped default is 0.6; raise it when running with compaction
    maxCompactions: 2        # hand off after this many compactions of the session (0 = pressure only)
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
| `thresholdRatio` | `0.6` | Pressure ratio that triggers a handoff (0.6 = 60%); raise it when running alongside compaction, see below |
| `maxCompactions` | `2` | Hand off after this many compactions of the session (`0` = pressure only) |
| `cooldownMs` | `300000` | Minimum gap between two handoffs of the same session |
| `handoffDir` | `.dsh/handoff` | Where packages are written (relative to the workspace; absolute works too) |
| `recentMessages` | `14` | How many recent user messages go into the package |
| `maxChars` | `24000` | Character cap for the package |
| `renameOldSuffix` | ` [已交接]` | Suffix appended to the old session's title |
| `dryRun` | `false` | **true = write the package only, create no session** (useful for a first check) |

⚠️ A patch `config` **replaces the whole block** — when overriding, repeat every key you don't want to change.

## Relationship to compaction

With both enabled, the thresholds differ:

| | Threshold | Behaviour |
|---|---|---|
| `compaction-basic` | `0.6` (default) | Compress in place, the session keeps going |
| `dsh-session-handoff` | `0.85` (suggested, above compaction) | Open a new session and hand off |

The shipped default is `0.6` as well, the same as compaction's. With both enabled, compaction always
pushes pressure back below its own threshold first, so **a pressure-only trigger never gets its chance**.
The handoff therefore also watches the compaction count: once this session has been compacted
`maxCompactions` times (2 by default) it hands off — compaction handles the daily grind, and enough
compaction means it is time to move on.

Want handoff to be the main mechanism (pressure only, no compaction count)? Set `compaction-basic` back
to `disabled: true`, set `maxCompactions` to `0`, and keep `thresholdRatio` at the shipped default `0.6`.

## Known limitations

1. **The UI does not switch for you** — the new session's id and title are returned; click over to it in
   the session list
2. **The package is mechanically extracted, not model-summarised** — complex tasks may lose nuance
3. The old session is renamed, not archived (intentional)
4. The HTTP endpoints only act on sessions **live in that host process**: a freshly started instance with
   no session opened yet answers `没有可用会话（session 缺失）`

## License

MIT
