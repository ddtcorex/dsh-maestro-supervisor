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

## Integration test

```bash
DSH_INTEGRATION=1 pnpm --dir packages/dsh-maestro-supervisor test -- tests/integration.test.ts
```
