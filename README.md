# dsh-maestro-supervisor

Supervisor for DSH Web resilience — **Phase 1 Guard & Report + Phase 3 Auto-Resume & Auto-Reload**.

Runs **outside** the `pnpm → sh → node` tree (systemd daemon) to survive tree crashes, plus **inside** `dsh web` as a host+client Cordis plugin to auto-resume interrupted sessions and auto-reload the browser after restart.

- **Daemon:** Polls `:3080` every 3s, keeps last-known-good (LKG) snapshots (`~/.dsh/.supervisor/lkg/`, `rotate 3`, `sha256` verify, `df` >500MB guard), auto-rollbacks on crash (`debounce 60s`, `flock` lock), writes `report-<ts>.md` (health + `git diff` + log tail), and notifies via Telegram (loose, never blocks).
- **Host plugin:** `runAutoResume()` 8s after boot — `findInterrupted` (tail 100) + `findDanglingOpenTurns` (full scan for recent sessions) within `autoResumeWithin` (default 5m) → `agents.resume({resumeSessionId, agentOptions: {provider,model}})` recovered from `request/context` → `followup('continue')`. Loopback RPC `POST /dsh-maestro-supervisor-resume/{scan,resume}` (authority `loopback`) for the daemon (`resumeViaRpc`).
- **Client plugin:** Hybrid auto-reload — `fetch HEAD /` polling 1s on `offline`/`WebSocket close`/`visibilitychange` → `200` → `location.reload()`. Served as `window.__ModuleLoader__.load` bundle at `/plugins/@ddtcorex/dsh-maestro-supervisor/client.js` via `dsh.client`.

## Install

### 1. Build

```bash
pnpm --dir packages/dsh-maestro-supervisor install
pnpm --dir packages/dsh-maestro-supervisor build   # tsc host + tsc client + node scripts/build-client.mjs → lib/ + lib/client.js
pnpm --dir packages/dsh-maestro-supervisor verify  # tsc --noEmit host + client
pnpm --dir packages/dsh-maestro-supervisor test    # 82 tests
test -f packages/dsh-maestro-supervisor/lib/index.js
test -f packages/dsh-maestro-supervisor/lib/client.js
```

`pnpm build` is required after any `src/` change; `lib/` is committed. The client needs both `tsc` steps and the `build-client.mjs` wrapper — plain `tsc` alone leaves `lib/client.js` as a bare ES module and `dsh web` will fail with `exports no "./client" bundle`.

### 2. Add to DSH Web profile (host + client)

The package declares `dsh.client` (`platform: web`, `inject: ["@deepseek-ai/dsh-client-runtime"]`) so the browser half is auto-loaded — no extra `dsh.client` flag needed.

```bash
dsh plugin --profile web add @ddtcorex/dsh-maestro-supervisor
# or manually:
# edit ~/.dsh/profiles/web/package.json:
# "@ddtcorex/dsh-maestro-supervisor": "link:<workspace-root>/packages/dsh-maestro-supervisor"
pnpm --dir ~/.dsh/profiles/web install
ls -l ~/.dsh/profiles/web/node_modules/@ddtcorex/dsh-maestro-supervisor  # → .../packages/dsh-maestro-supervisor
```

**Pre-flight (required):** before adding to a live profile's `bundles`, dry-boot must pass:

```bash
DSH_HOME=$(mktemp -d) pnpm --dir deepseek-harness dsh web --port 0 &
# wait for "dsh web: http://127.0.0.1:<port>" and curl 200, then kill
# This catches load-time failures (missing lib/index.js, stale build, bad cordis.patch.yml)
# that no in-code try/catch can catch. See dsh-safe-web-update skill.
```

This exact failure class caused `dsh web` outages on 2026-08-27 (missing `lib/index.js`). See `AGENTS.md` Conventions.

### 3. Systemd daemon (optional, for crash detection outside the tree)

```bash
bash packages/dsh-maestro-supervisor/scripts/install-systemd.sh
systemctl --user daemon-reload
systemctl --user enable --now dsh-web-supervisor
systemctl --user status dsh-web-supervisor
journalctl --user -u dsh-web-supervisor -f
```

The template leaves `Environment=TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` commented — uncomment via `systemctl --user edit dsh-web-supervisor` if you want Telegram, otherwise it logs only.

To run without systemd (foreground, for debugging):

```bash
node packages/dsh-maestro-supervisor/lib/index.js daemon   # poll every 3s
node packages/dsh-maestro-supervisor/lib/index.js status
node packages/dsh-maestro-supervisor/lib/index.js logs --tail 50
```

## Configuration

All `autoResumeWithin` values are **minutes** when given as `number` (e.g. `5` → 5 minutes). Strings support `30s`/`5m`/`1h`. Precedence (highest first):

1. **Cordis config** (`cordis.patch.yml` `config:` or `apply(ctx, config)`) — explicit per-install.
2. **Env** `DSH_SUPERVISOR_AUTO_RESUME` / `DSH_SUPERVISOR_RESUME_WITHIN` (bare `5` in env → 5m for ergonomics).
3. **Supervisor config** `~/.dsh/.supervisor/config.json` (`autoResumeEnabled`, `autoResumeWithin`).
4. **Maestro settings** `~/.dsh/maestro/settings.json` (`domains.supervisor.*`).
5. **Default:** `true` / `5`.

| Key | Type | Default | Env | File | Notes |
|-----|------|---------|-----|------|-------|
| `autoResumeEnabled` | `boolean` | `true` | `DSH_SUPERVISOR_AUTO_RESUME` (`1`/`true`/`yes`/`on`/`enabled` vs `0`/`false`/`no`/…) | `config.json: autoResumeEnabled`, `settings.json: domains.supervisor.autoResumeEnabled` | `false` → notify only |
| `autoResumeWithin` | `number` (minutes) or `string` (`5m`) | `5` | `DSH_SUPERVISOR_RESUME_WITHIN` | `config.json: autoResumeWithin`, `settings.json: domains.supervisor.autoResumeWithin` | Window for `findInterrupted`/`findDangling` (mtime + `event.time`) |

Example `~/.dsh/.supervisor/config.json`:

```json
{
  "autoResumeWithin": 5,
  "autoResumeEnabled": true
}
```

## CLI

```bash
node packages/dsh-maestro-supervisor/lib/index.js --help
node packages/dsh-maestro-supervisor/lib/index.js status
node packages/dsh-maestro-supervisor/lib/index.js daemon   # poll 3s, debounce 60s
node packages/dsh-maestro-supervisor/lib/index.js logs --tail 50
node packages/dsh-maestro-supervisor/lib/index.js rollback --latest
```

## RPC (loopback only, `authority: loopback`)

```bash
# Scan (findInterrupted only, tail 100)
curl -s http://127.0.0.1:3080/dsh-maestro-supervisor-resume/scan -X POST \
  -H 'content-type: application/json' \
  -d '{"type":"client-request","rpcId":"r1","method":"scan","payload":{"withinMs":300000}}'
# → {"type":"server-response","rpcId":"r1","result":{"ok":true,"value":{"scanned":425,"interrupted":[]}}}

# Resume (re-attaches agent + followup continue, recovers provider/model)
curl -s http://127.0.0.1:3080/dsh-maestro-supervisor-resume/resume -X POST \
  -H 'content-type: application/json' \
  -d '{"type":"client-request","rpcId":"r2","method":"resume","payload":{"ids":["--example-project--/session-abc"]}}'
# → {"type":"server-response","rpcId":"r2","result":{"ok":true,"value":{"resumed":["--example-project--/session-abc"]}}}
# or {"ok":false,"error":{"code":"bad-request","message":"resume requires at least one session id"}}
```

The daemon uses `resumeViaRpc()` (`supervisor.ts:24`) which POSTs the same envelope to `http://127.0.0.1:3080/dsh-maestro-supervisor-resume/resume` with `fetch` and validates `server-response` + `rpcId` + `result.ok`.

## Auto-Resume Details

- **When:** `apply()` sets `setTimeout 8000` after boot, then `runAutoResume()` — only safe right after fresh boot when `dsh web` is sole owner (an open turn found then cannot belong to a still-running generation). `resumeInterrupted` additionally checks `agents.get(sessionId)` and skips if already live.
- **What:** `findInterrupted` (tail 100, looks for `turn/end` with `reason.kind === 'interrupted'` at `time` within window) + `findDanglingOpenTurns` (full scan for recent sessions, looks for `turn/start` without matching `turn/end` at `time` within window) → `merged = Set([...interrupted, ...dangling])` → `resumeInterrupted` for each id.
- **How:** `agents.get(sessionId)` if live → `followup('continue')`; else `sessionPersistence.load(sessionId)` → find `request/context` with `provider`/`model` → `agents.resume({resumeSessionId, agentOptions})` → `followup('continue')`. If `load` fails, still resumes without `agentOptions` (degrades). Returns `string[] resumed` and logs `sent continue trigger`.
- **Subagents:** `findDangling` does **full log scan** for recent sessions (mtime within window, 1-2 files) — not tail — because subagent `b6487e33` had its only `turn/start` at seq 6 at the very beginning of a 1906-line log, missed by `tail -100`. `findInterrupted` stays tail 100 (interrupted closer is always at tail). The mtime pre-filter keeps full scans cheap (previously 5.5s for 425 sessions without it).

## Auto-Reload Details (Hybrid)

- **Client** (`src/client/auto-reload.ts`, `lib/client.js` via `window.__ModuleLoader__.load`): `ctx.effect` hooks `WebSocket` (patches `window.WebSocket` to catch `close` for same-origin DSH ws), `offline`/`online`, `visibilitychange` → `setInterval(fetch HEAD / 1s)` when down → `200` → `location.reload()` (once, `reloading` guard). Also checks `HEAD /` on load in case the page was opened while down.
- **Host** (`supervisor.ts` `pollHealth` 3s + `notify`, `plugin.ts` `runAutoResume`): health check + restart + notify is the host half; together with client polling they cover manual, supervisor, and systemd restarts without `F5`. No extra host push channel needed — client polling is primary, host health is secondary; the `window.__ModuleLoader__` bundle is served at `/plugins/@ddtcorex/dsh-maestro-supervisor/client.js` via `ClientModuleRegistry` (`dsh.client` + `exports["./client"]`).

## Verification

```bash
# Build & unit
pnpm --dir packages/dsh-maestro-supervisor verify   # host + client
pnpm --dir packages/dsh-maestro-supervisor test     # 82 tests
test -f packages/dsh-maestro-supervisor/lib/index.js
test -f packages/dsh-maestro-supervisor/lib/client.js
curl -s http://127.0.0.1:3080/plugins/@ddtcorex/dsh-maestro-supervisor/client.js | grep -c "window.location.reload"  # 2

# Live
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3080/  # 200
curl -s http://127.0.0.1:3080/dsh-maestro-supervisor-resume/scan -X POST -H 'content-type: application/json' -d '{"type":"client-request","rpcId":"t","method":"scan","payload":{"withinMs":300000}}' | head -c 200
node --input-type=module -e "import {findDanglingOpenTurns} from './packages/dsh-maestro-supervisor/lib/resume.js'; console.log(await findDanglingOpenTurns(undefined,{withinMs:5*60*1000}))"
# Create a real dangling: pnpm --dir deepseek-harness dsh --profile headless "Run bash synchronously sleep 60" & sleep 4; kill $!; node -e "...findDangling..."  # should be 1
# After restart, it should have turn/end interrupted → continue → turn2
```

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Cannot find package '.../dsh-maestro-supervisor/index.js'` | `pnpm build` not run or `lib/` stale | `pnpm --dir packages/dsh-maestro-supervisor build && pnpm --dir ~/.dsh/profiles/web install` |
| `exports no "./client" bundle` / `client bundle not found` | Missing `lib/client.js` or `exports["./client"]` | `pnpm build` (runs `tsc` + `tsc -p tsconfig.client.json` + `node scripts/build-client.mjs`), check `package.json` `exports` and `dsh.client`, `test -f lib/client.js`, `curl .../client.js` |
| `EADDRINUSE ::3000` on `dsh web --port 0` | Old `MainThread` still holds `:3000`+`:3080` | `ss -tlnp | grep 3080` → pid, `kill <pid>` (same pid holds both), wait `ss` free. Never `pkill -f "dsh web"` — it kills the test shell. |
| `uses .jsonl but backend is zstd` | Hand-written `session.jsonl` while backend is `zstd` | Use `zstd -c plain.jsonl > session.jsonl.zstd` or `JsonlSessionPersistence` API. Never hand-write opposite encoding — `listArtifacts` checks every project dir on boot and one stray file blocks all of `dsh web`. |
| `first frame is not exactly one header line` | zstd without `type: session` header | Use `toHeaderLine` + `compressZstdFrame(header)` + `compressZstdFrame(body)` as in `encodeMaterialization`. |
| `findDangling` 0 but subagent still open | Tail window too small (before `63b7719`) | Fixed: `findDangling` now full-scans recent sessions (mtime within window). `findInterrupted` stays tail 100. |
| `resumed: []` or `RESUME FAILED` | `agents.resume` failed (no persistence, no provider/model) | Check `session.jsonl.zstd` exists and `zstd -d -c ... \| head -n 1` is valid header. `request/context` with `provider`/`model` is recovered — if missing, still resumes without `agentOptions`. |
| `RESUME SKIPPED` | No session within `autoResumeWithin` window | Increase `autoResumeWithin` to `10`/`"10m"`, check `config.json` and `DSH_SUPERVISOR_RESUME_WITHIN`, verify with `withinMs: 60*60*1000`. |
| Page does not reload after restart | `lib/client.js` not served or browser cache | `curl .../client.js | grep -c "window.location.reload"` → 2, hard refresh `Ctrl+Shift+R`, check `window.__ModuleLoader__` in console. Client polls `HEAD /` 1s on `offline`/`WS close`. |
| `dangling` found but `agents.get` says live | Session still live in current process (not a crash) | `findDangling` is only safe right after fresh boot when `dsh web` is sole owner. `resumeInterrupted` skips if `agents.get` is live — correct, wait for next boot. |

## Known Issues

- **Manual `session.jsonl` vs `zstd`:** One stray opposite-encoding file under `~/.dsh/sessions/` blocks the entire `workspace` `listArtifacts` on every boot (`encodingMismatch`). See Troubleshooting.
- **Tail vs full scan:** Before `63b7719`, `b6487e33` subagent missed because its only `turn/start` was at seq 6 at the very beginning of a 1906-line log. Fixed, but if you add a new scan variant, reuse `readSessionAllLines` with mtime pre-filter.
- **Port pair:** One `MainThread` holds `:3080`+`:3000`. Use `ss -tlnp` + `kill <pid>` for the one pid, not `pkill -f`.
- **Client bundling:** `lib/client.js` must be `window.__ModuleLoader__.load` wrapper via `scripts/build-client.mjs`, not bare `export`. Add new client files under `src/client/` and ensure `tsconfig.client.json` includes them, then `pnpm build`.
- **Config precedence:** `cordis.patch.yml` `config:` > env (`DSH_SUPERVISOR_RESUME_WITHIN` bare `5` → 5m) > `config.json` > `settings.json` > default. See `plugin.ts:71` and `supervisor.ts:82`.

## Development

```sh
pnpm --dir packages/dsh-maestro-supervisor verify
pnpm --dir packages/dsh-maestro-supervisor test
pnpm --dir packages/dsh-maestro-supervisor build
```

For daemon changes: `DSH_HOME=$(mktemp -d) pnpm --dir deepseek-harness dsh web --port 0` + corrupt `settings.json` → assert `report` + `rollback`.

## Telegram

Loose by default: `notifier.ts` tries `import('@ddtcorex/dsh-maestro-notifier')`, then `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` env, then `console.log`. Enable via `systemctl --user edit dsh-web-supervisor` → uncomment `Environment=TELEGRAM_*` → `daemon-reload` + `restart`.

Hard mode (optional): `package.json` add `"@ddtcorex/dsh-maestro-notifier": "workspace:^0.1.0"` + `pnpm-workspace.yaml` `packages: ["../dsh-maestro-notifier"]` → `pnpm install` links it.

## See Also

- Spec: `<workspace-root>/docs/specs/2026-08-27-dsh-web-resilience-design.md`
- Skill: `maestro-skills/skills/dsh-safe-web-update/` (`restart-dsh-web.sh` with `dry_boot_and_verify()` and `--auto`)
- Client bundling: `dsh-maestro-mobile` (`scripts/build-client.mjs` pattern)
