# Changelog

## [0.7.9] - 2026-09-03

### Fixed

- **Resume route recovery via the handle seam** — route recovery called the
  removed `persistence.load(id)` API (gone since DSH's handle-based
  persistence seam in 0.1.2-rc.1), so `agentOptions` was always `undefined`
  and every resumed agent lost its provider/model, failing the next turn
  with `prompt variable "{{model}}" has no value for this assembly (section
  "deployment:persona")`. The route is now read through `open(id, 'read')` +
  `read(0)`, falling back to the first `request/context` line of the raw
  session log; skip-with-audit remains only for genuinely routeless sessions
  (#63).

## [0.7.8] - 2026-09-03

### Fixed

- **Configurable degraded/down thresholds** — high load (loadavg ~12 from docker +
  horizon) made the 3s health poll read short fetch stalls as degraded and
  self-restart dsh web needlessly. Health fetch timeout 12s→20s, poll interval
  3s→5s, down threshold 5→6, degraded threshold 3→5; all four are now readable
  from supervisor config (`intervalMs`, `downThreshold`, `degradedThreshold`,
  `pollTimeoutMs`) via `getEffective*` helpers, so tuning needs no code change
  (#61).


## [0.7.7] - 2026-09-03

### Fixed

- **Resume full-scan maxBuffer** — `findDanglingOpenTurns` dropped every session
  whose decompressed log exceeds execSync's 1MB default (real worker logs decode to
  8–23MB): `readSessionAllLines` threw ENOBUFS and the per-session catch silently
  skipped it, so a big session's open turn after restart was never detected (#59).

### Added

- **Durable out-of-band resume audit log** — the in-tree auto-resume now appends
  one JSONL entry per step to `~/.dsh/.supervisor/resume.log.jsonl` (mode 600):
  `scan` (scanned + ids), `no-agent`, `resume-failed` (error), `resumed` (intent vs
  idle prompt). `ctx.logger` never reached `dsh-web.log`, so `agents.resume`
  failures were previously invisible (#59).


## [0.7.6] - 2026-09-02

### Fixed

- **Skill symlink** — resolve the skill symlink before deriving PLUGIN_DIR (#57).


## [0.7.5] - 2026-09-02

### Fixed

- Daemon resume RPC now mints the `dsh-auth-*` session cookie first (parses the
  newest boot launch line from `~/.dsh/dsh-web.log`, trades the token on the raw
  webserver) before POSTing to `/dsh-maestro-supervisor-resume/resume`. On the
  local-pin-gate topology the RPC sits behind the browser-trust fence and 401s
  without the cookie (`RESUME FAILED`). Falls back to the old unauthenticated
  call when no boot token is readable.

## [0.7.4] - 2026-09-02

### Fixed

- `dsh-safe-restart` recipe now detects the local-pin-gate topology (3000/3080/3081/3082) and health-checks :3080 (200/401/303) with a :3082 raw-webserver fallback, instead of hard-failing "no listeners found" whenever :3080 was unbound (the 2026-09-02 outage shape).

All notable changes to this project are documented in this file. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.3] - 2026-09-01

### Added

- Session-log health scan (`session-health`): detects a session log whose first
  zstd frame is not exactly one header line, re-encodes the recoverable
  single-whole-file-frame layout back to canonical multi-frame (payload
  preserved byte-for-byte, `.corrupt-singleframe.bak` sidecar), and quarantines
  garbage. Wired as a non-fatal pre-flight in the `dsh-safe-restart` recipe,
  a loopback RPC (`/dsh-maestro-supervisor-session-health`), and the
  `maestro_session_health` host tool — one corrupt log can no longer brick the
  whole plugin-tree boot (2026-09-01 crash-loop incident).
- Resume core-tool probe (`resume-tools`): after an auto-resume, the plugin
  probes the resumed session's tool view for `bash`, logs
  `[supervisor] resumed <id>: bash=<bool> …`, and on loss notifies + injects a
  tool-inventory system message (the model stops calling the missing tool).
  `resumeCoreToolPolicy: 'warn' | 'park'` (default warn; park flags a manual
  reopen) + `maestro_resume_tool_health` RPC/tool.

### Changed

- **LLM auto-debug removed entirely**: the supervisor never calls a model.
  Rule-based `autoFixKnownPatterns` + dry-boot transient detection + attempt/
  cooldown gating are kept; failure `reason` strings are LLM-free.

### Fixed

- Session-health classifier is stack-safe on many-frame logs (bounded 64KiB
  first-frame probe) and skips whole-file decode for healthy first-frame logs
  (~17s vs ~6–8min for 843 session logs).

## [0.7.2] - 2026-09-01

### Fixed

- Self-kill guard matches the executed command surface, not raw text: quoted
  spans and heredoc bodies (including backslash-escaped quotes) are treated as
  data, so analysis scripts, echoes and node -e bodies that merely mention
  kill-family words are no longer denied. Real invocations (a kill-family verb
  at the command position, targeted restart patterns, pid-targeted kills of the
  dsh-web tree) stay denied, and a command that is JUST `kill <unrelated-pid>`
  stays allowed.

## [0.7.1] - 2026-09-01

### Fixed

- Declare `tools` in the host plugin's inject so `ctx.tools` resolves and `dsh_web_restart` actually registers at runtime (previously the registration threw silently inside the wrapped effect and agents could not find the tool).
- Auto-resume reads the durable restart-intent sidecar written by `dsh_web_restart` and resumes a self-restart caller with a contextual message ("you requested a dsh web restart … do NOT call dsh_web_restart again") instead of the generic TOOL_OUTCOME_UNKNOWN recovery prompt, then consumes the sidecar.
- Self-kill guard scopes `kill` denials to the dsh web process tree only (any-listener pid over-denial removed).
- `isPluginTreeChanged` also detects `cordis.patch.yml`-only edits.
- `restart-guards` tests are hermetic (homedir-mocked) — no longer contend with the live supervisor daemon's marker under parallel vitest.
- `dryBootVerify` reports EADDRINUSE collisions explicitly.

## [0.7.0] - 2026-09-01

### Added

- `dsh-safe-restart` skill shipped via `ctx.skills` provider — the single guidance surface for restarting/updating `dsh web` (in-session agents call `dsh_web_restart`; external agents/humans use the bundled systemd-aware `restart-dsh-web.sh` helper).
- `dsh_web_restart` tool: dry-boot gate (copies `profiles/web` into an ephemeral DSH_HOME and boots on a temp port), restart-request marker with caller session + reason, durable intent sidecar; never restarts in-tree.
- Supervisor daemon handles caller restart-requests: grace → `restartWeb()` → marker held until post-restart `health.up` → session scan; rollback debounce honored across the boot window.
- In-session self-kill guard: `tools/pre-execute` denies `systemctl` restart / `pkill` / own-pid `kill` of `dsh web`, pointing to `dsh_web_restart`.
- `StartLimitIntervalSec=60` + `StartLimitBurst=3` in the systemd unit template to stop crash loops.
- Post-restart session scan (zstd decode) reporting torn session logs.

### Changed

- LKG rollback no longer restores `sessions/` (append-only live truth wins).
- `isPluginTreeChanged` uses the snapshot `manifest.json` mtime baseline with an injectable stat reader (CI-deterministic).

### Fixed

- Skill provider object now carries its own `name` (`maestro-supervisor`) — without it every turn failed with `skill provider "undefined" returned skill ... for provider "maestro-supervisor"`.

## [0.6.8] - 2026-08-31

### Added

- Pass through `reasoningEffort` from supervisor config to the debug-agent LLM provider/model selection (`AI_REASONING_EFFORT` → `supervisor.model.reasoningEffort` → `review.model.reasoningEffort` → settings), closing the unified model picker gap.

### Fixed

- Stop false-positive rollback/restart caused by the overly broad `JSON`/`YAML` log matchers: benign log lines whose payload merely contained those substrings (e.g. maestro-sync status JSON listing `session.jsonl.zstd` / `settings.json` paths) were treated as boot errors, turning a healthy `HTTP 401` into a rollback + `dsh-web` restart. The health-poller now matches only specific parse/boot errors (`SyntaxError`, `YAMLParseError`, `ParseError`, …), with a regression test asserting JSON status logs stay healthy.

## [0.6.6] - 2026-08-30

### Fixed

- Suppress `http 404`/`fetch failed` within 30s of `ActiveEnterTimestamp` even without marker (via wall-clock check, VITEST-safe) to eliminate extra restart after manual `systemctl start`.
- Degraded (`http 200` + plugin log error) now auto-rolls back after 3 consecutive polls (~9s) and notifies `🔄 auto-restart — degraded: <reason>`; also handles `401` with log error as degraded → down.
- Increase `vitest` timeout to 10s for `plugin.test.ts` flaky `autoResumeWithin` case.

## [0.6.5] - 2026-08-30

### Fixed

- Single-owner restart 30s suppression (planned-restart marker + flock) to prevent 2–3 systemd restarts per 1 client request.
- Suppress `http 404`/`fetch failed` within 30s of `ActiveEnterTimestamp` even without marker to eliminate extra restart during boot.
- Degraded (`http 200` + plugin log error) now auto-rolls back after 3 consecutive polls (~9s) and notifies `🔄 auto-restart — degraded: <reason>`.

## [0.6.4] - 2026-08-28

### Added

- Read `supervisorModel` from `~/.dsh/maestro/settings.json` for the debug-agent LLM provider/model selection.

## [0.6.2] - 2026-08-28

### Fixed

- Prevent spurious auto-reload on normal WebSocket close — only reload when the server is actually down (`offline` / WS close for DSH origin + `HEAD /` confirms down).

## [0.6.1] - 2026-08-28

### Fixed

- Handle `EADDRINUSE` as down and kill stale pid before restart (resolve tree pid via `ss -tlnp`, single `MainThread` holds `:3000` + `:3080`).

## [0.6.0] - 2026-08-28

### Added

- Hybrid auto-reload (client `auto-reload.ts` polling `HEAD /` 1s on `offline`/WS-close + host health recovery).
- Subagent-aware dangling detection: `findDanglingOpenTurns` now does full scan for recent sessions (mtime pre-filter) instead of tail window — fixes missed `b6487e33` where `turn/start` was at seq 6 of a 1906-line log.

### Fixed

- Tail window increased for `findInterrupted` and `pollHealth` debounce/rolling guard hardening.

## [0.5.4] - 2026-08-27

### Fixed

- Enforce bounded snapshot retention (count/age/size) and dedupe LKG store.

## [0.5.3] - 2026-08-27

### Fixed

- Add `muse-spark` LLM provider support for the debug agent.

## [0.5.2] - 2026-08-27

### Added

- Support custom AI provider for the debug-agent LLM (`supervisorModel` / provider selection).

## [0.5.1] - 2026-08-27

### Fixed

- Correct `dryBoot` shell escaping for nested `bash -c` invocations.

## [0.5.0] - 2026-08-27

### Added

- Wire LLM debug-agent with systematic-debugging and supervisor `FIXED` handling (spawn on-demand after LKG rollback, max 3 attempts).

## [0.4.0] - 2026-08-27

### Added

- Debug-agent build scaffolding and `supervisorModel` wiring.

## [0.3.0] - 2026-08-27

### Added

- Phase 3 resume: `resumeInterrupted` + `agents.resume` + `followup('continue')` with provider/model recovery from `request/context`.

## [0.2.0] - 2026-08-27

### Added

- Phase 2 degraded handling and systemd service wiring for `dsh-web-supervisor.service`.

## [0.1.0] - 2026-08-27

### Added

- Initial release of `@ddtcorex/dsh-maestro-supervisor` — standalone daemon (`dsh-web-supervisor` binary, systemd unit), in-tree host plugin (`runAutoResume`, loopback RPC `/dsh-maestro-supervisor-resume`), and client plugin (`auto-reload.ts` via `window.__ModuleLoader__.load`). Polls `:3080` every 3s, LKG rotation (3), `sha256` verify, `df` guard, reports, Telegram notifier (loose).

[0.6.6]: https://github.com/ddtcorex/dsh-maestro-supervisor/releases/tag/v0.6.6
[0.6.5]: https://github.com/ddtcorex/dsh-maestro-supervisor/releases/tag/v0.6.5
[0.6.4]: https://github.com/ddtcorex/dsh-maestro-supervisor/releases/tag/v0.6.4
[0.6.2]: https://github.com/ddtcorex/dsh-maestro-supervisor/releases/tag/v0.6.2
[0.6.1]: https://github.com/ddtcorex/dsh-maestro-supervisor/releases/tag/v0.6.1
[0.6.0]: https://github.com/ddtcorex/dsh-maestro-supervisor/releases/tag/v0.6.0
[0.5.4]: https://github.com/ddtcorex/dsh-maestro-supervisor/releases/tag/v0.5.4
[0.5.3]: https://github.com/ddtcorex/dsh-maestro-supervisor/releases/tag/v0.5.3
[0.5.2]: https://github.com/ddtcorex/dsh-maestro-supervisor/releases/tag/v0.5.2
[0.5.1]: https://github.com/ddtcorex/dsh-maestro-supervisor/releases/tag/v0.5.1
[0.5.0]: https://github.com/ddtcorex/dsh-maestro-supervisor/releases/tag/v0.5.0
[0.4.0]: https://github.com/ddtcorex/dsh-maestro-supervisor/releases/tag/v0.4.0
[0.3.0]: https://github.com/ddtcorex/dsh-maestro-supervisor/releases/tag/v0.3.0
[0.2.0]: https://github.com/ddtcorex/dsh-maestro-supervisor/releases/tag/v0.2.0
[0.1.0]: https://github.com/ddtcorex/dsh-maestro-supervisor/releases/tag/v0.1.0
