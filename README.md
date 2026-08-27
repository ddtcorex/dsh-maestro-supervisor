# dsh-maestro-supervisor

Supervisor daemon for DSH Web resilience — Phase 1 Guard & Report.

Runs **outside** the `pnpm → sh → node` tree. Polls `:3080` every 3s, manages last-known-good (LKG) snapshots in `~/.dsh/.supervisor/lkg/`, auto-rollbacks on crash, and writes `report-<ts>.md` for the next session. Telegram via `dsh-maestro-notifier`.

## Install

```bash
pnpm --dir packages/dsh-maestro-supervisor install
pnpm --dir packages/dsh-maestro-supervisor build

# systemd (recommended)
bash packages/dsh-maestro-supervisor/scripts/install-systemd.sh
systemctl --user daemon-reload && systemctl --user enable --now dsh-web-supervisor

# or manual sidecar
setsid node packages/dsh-maestro-supervisor/lib/index.js daemon &
```

## CLI

```bash
node packages/dsh-maestro-supervisor/lib/index.js --help
node packages/dsh-maestro-supervisor/lib/index.js status
node packages/dsh-maestro-supervisor/lib/index.js daemon
```

Reports: `~/.dsh/.supervisor/reports/report-<ts>.md`, LKG: `~/.dsh/.supervisor/lkg/<ts>/`, failed: `~/.dsh/.supervisor/failed/<ts>/`

## Telegram

`src/host/notifier.ts` is loose by default: tries `import('@ddtcorex/dsh-maestro-notifier')`, then `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` env, then `console.log`. No hard dependency, daemon never blocks on Telegram.

- **Enable:** `systemctl --user edit dsh-web-supervisor` → uncomment `Environment=TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` in `systemd/dsh-web-supervisor.service.template` → `systemctl --user daemon-reload && systemctl --user restart dsh-web-supervisor`.
- **Hard mode (optional):** `package.json` add `"@ddtcorex/dsh-maestro-notifier": "workspace:^0.1.0"` + `pnpm-workspace.yaml` `packages: ["../dsh-maestro-notifier"]` — then `pnpm install` links it and every `notify()` hits the hard import.

See `AGENTS.md` §Dependency patterns for details and for interdependent Cordis plugins (A ↔ B) — never mutual `inject`, use shared lib C / one-way + events / isolate+RPC.

## Integration test

```bash
DSH_INTEGRATION=1 pnpm --dir packages/dsh-maestro-supervisor test -- tests/integration.test.ts
```
