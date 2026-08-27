# AGENTS.md — dsh-maestro-supervisor

> `CLAUDE.md` at the repo root is a symlink to `AGENTS.md`. Claude Code follows the same rule set as Codex CLI. Only edit `AGENTS.md` — never edit `CLAUDE.md` directly or replace the symlink with a copy.

## Purpose

Supervisor daemon for DSH Web resilience — auto-detects crashes, rollbacks to last-known-good (LKG), and reports for the next session. Runs **outside** the `pnpm → sh → node` tree so it survives tree crashes.

Names by boundary: npm package = `@ddtcorex/dsh-maestro-supervisor`; binary = `dsh-web-supervisor`. The daemon itself is not a Cordis plugin — standalone daemon (Phase 1 Guard & Report of `docs/specs/2026-08-27-dsh-web-resilience-design.md`). The package also ships one deliberate in-tree Cordis plugin (auto-resume) as a permitted exception — see `## Conventions` below for the two non-negotiable conditions that exception is held to.

Part of the Maestro Harness suite. See spec for Phase 2 (loader isolation) and Phase 3 (autonomous debug agent + Telegram + session resume).

## Layout

- `src/host/index.ts` — CLI entry (`daemon|status|logs|rollback`)
- `src/host/cli.ts` — argument parsing and command dispatch
- `src/host/bin.ts` — daemon binary entry point (`dsh-web-supervisor`), wires `Supervisor` and starts the poll loop
- `src/host/paths.ts` — shared `~/.dsh/.supervisor/**` path helpers (LKG, failed, reports, lock, config)
- `src/host/supervisor.ts` — `Supervisor` class: poll loop, debounce (60s), rolling guard, LKG/failed/report/rollback/notify orchestration
- `src/host/snapshot.ts` — LKG store: `writeLKG`, `verifyLKG` (sha256), `rotateLKG(3)`, `writeFailed`; `df` guard and `manifest.json`
- `src/host/health-poller.ts` — `pollHealth()` with injectable `fetch/psAlive/logTail`; detects `ERR_MODULE_NOT_FOUND` / `assertChannel` / `unhandledRejection`
- `src/host/report.ts` — `writeReport()` → `~/.dsh/.supervisor/reports/report-<ts>.md` (health + git diff + log tail)
- `src/host/notifier.ts` — Telegram bridge via `dsh-maestro-notifier` (swallow errors, never block rollback)
- `src/host/debug-agent.ts` — Phase 3 autonomous debug agent, spawned on-demand only after an LKG rollback
- `src/host/resume.ts` — `findInterrupted()`: scans `~/.dsh/sessions/**` for sessions whose log ends in a `turn/end`+`interrupted` event, with an mtime pre-filter to skip decompressing `.zstd` logs outside the requested time window
- `src/host/plugin.ts` — in-tree Cordis plugin: `apply()`, `runAutoResume()`, `resumeInterrupted()` — the one deliberate exception to "daemon stays outside the tree" (see `## Conventions`)
- `lib/` — committed build output. Generated; do not hand-edit.
- `systemd/dsh-web-supervisor.service.template` — systemd user unit (`Restart=always`)
- `scripts/install-systemd.sh` — installs unit to `~/.config/systemd/user/`
- `tests/*.test.ts` — vitest suites (13 files, 66 tests + 1 integration skipped unless `DSH_INTEGRATION=1`)

## Development

Run from the repository root:

```sh
pnpm verify   # tsc --noEmit
pnpm test     # vitest run
pnpm build    # tsc -p tsconfig.json -> lib/
```

`pnpm build` is required after any source change; `lib/` is committed.

CLI:

```sh
node lib/index.js --help
node lib/index.js status
node lib/index.js daemon   # poll every 3s
DSH_INTEGRATION=1 pnpm test -- tests/integration.test.ts
```

## Git workflow

- Default branch `master`. No direct commits to `master` — use `feat/<topic>` / `fix/<topic>` and a PR against `ddtcorex/dsh-maestro-supervisor`.
- Conventional commits, imperative mood (`feat:`, `fix:`, `docs:`, `chore:`).
- One TDD task = one commit; never commit while `pnpm verify` is red.
- When the base moves, rebase the feature branch onto `origin/master`.

## Conventions

- **Deterministic, no LLM** — supervisor never calls a model; decisions are rule-based (`http !=200` → down, log pattern → error). Debug agent (Phase 3) is the LLM part and is spawned on-demand only after LKG rollback.
- **Daemon stays outside the tree** — the daemon (`bin.ts`/`supervisor.ts`/`snapshot.ts`/`health-poller.ts`, run via systemd) never adds a Cordis row or `cordis.patch.yml`; it must survive tree crashes. PID/port resolution via `ss -tlnp` + `resolve_tree()` like `dsh-safe-web-update`.
- **The auto-resume plugin (`plugin.ts`/`index.ts`) is the one deliberate exception** — it runs in-tree because it needs `sessions`/`connection`/`agents` context the daemon cannot reach. This is permitted only under two non-negotiable conditions:
  1. **`apply()` must never throw synchronously or let a rejected promise escape.** Every failure — expected or not — degrades to "auto-resume disabled for this boot," logged, never a crash. See `tests/plugin.test.ts` for the required coverage (a throwing `findInterrupted`, a throwing `resumeInterrupted`, a throwing RPC registration must all leave `apply()` non-throwing).
  2. **Before this package is ever added to a live profile's `bundles`** (e.g. `~/.dsh/profiles/web/package.json`), `pnpm build` must succeed AND a dry-boot on an ephemeral port with an isolated `DSH_HOME` must pass, per the `dsh-safe-web-update` skill. This is not optional guidance — it is the only defense against a *load-time* failure (a missing `lib/index.js`, a stale build), which no amount of in-code `try`/`catch` can catch. This exact failure class caused repeated `dsh web` outages on 2026-08-27 (see the workspace's `docs/reports/2026-08-27-dsh-web-outage-postmortem.md`).
- **Injectable deps for testability** — `pollHealth`, `writeLKG`, `rollback`, `notify` are constructor-injected; tests mock them, real daemon wires to `health-poller`/`snapshot`/`restart-dsh-web.sh --auto`.
- **Snapshot rotation** — keep 3 LKG, verify sha256 before promote, `df` >500MB guard.
- **Debounce + rolling guard** — at most 1 rollback per 60s, single `rollingBack` flag, `flock` on `~/.dsh/.supervisor/lock` for cross-process safety.
- **Never block on notifier** — Telegram failures are swallowed and retried.

## Dependency patterns

### Supervisor → Notifier (1-way, loose by default, hard optional)

- **Loose (recommended):** No `package.json` dependency. `notifier.ts` tries `import('@ddtcorex/dsh-maestro-notifier')` dynamically, then `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` env, then falls back to `console.log`. `systemd` template leaves `Environment=TELEGRAM_*` commented — uncomment if you want Telegram, otherwise daemon logs only and never blocks rollback. This keeps supervisor runnable when notifier is not installed.
- **Hard (workspace):** Add to `package.json` `"dependencies": {"@ddtcorex/dsh-maestro-notifier": "workspace:^0.1.0"}` and to `pnpm-workspace.yaml` `packages: [".", "../dsh-maestro-notifier"]` + `allowBuilds.esbuild: true`. Then `pnpm install` resolves the link and `defaultSend` hits the hard import on every call. Use only if you want a guaranteed Telegram path and accept the coupled publish order (notifier must be published before supervisor).

### Two Cordis plugins that need each other (A ↔ B)

Never `A inject: ['B']` and `B inject: ['A']` — Cordis will deadlock. Pick one:

1. **Extract shared lib C** (like `dsh-maestro-config-lib`): `C` provides `serviceC`, both `A` and `B` do `inject: ['serviceC']`, `C` injects nobody. Put `C` in `pnpm-workspace.yaml` `packages: ["../dsh-maestro-C"]` for both. This is the cleanest for true mutual data (e.g., `guard` ↔ `observe` sharing health).
2. **One-way + events:** `A` provides `serviceA`, `B` does `inject: ['serviceA']` and `ctx.emit('b:done', payload)`; `A` listens with `ctx.on('b:done', ...)`. No reverse inject, so no cycle.
3. **Isolate + RPC:** If they must stay separate, use `isolate` realms and a `/dsh-maestro-A` RPC channel instead of direct `inject`.

## Validation

- `pnpm verify` + `pnpm test` green before any success claim.
- `test -f lib/index.js` after build (like other host packages).
- For daemon changes, manual ephemeral check: `DSH_HOME=$(mktemp -d) pnpm --dir deepseek-harness dsh web --port 0` + corrupt `settings.json` → assert report + rollback within 10s.

## See Also

- Spec: `docs/specs/2026-08-27-dsh-web-resilience-design.md` (Maestro Harness workspace)
- Skill: `maestro-skills/skills/dsh-safe-web-update/` (guarded `restart-dsh-web.sh` with `dry_boot_and_verify()` and `--auto`)
- Plan: `docs/plans/2026-08-27-dsh-web-resilience-phase1.md`
