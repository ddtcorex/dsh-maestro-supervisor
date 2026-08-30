# Changelog

All notable changes to this project are documented in this file. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
