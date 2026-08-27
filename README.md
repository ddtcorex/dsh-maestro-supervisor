# dsh-maestro-supervisor

Supervisor daemon for DSH Web resilience (Phase 1 — Guard & Report).

Outside the `pnpm → sh → node` tree. Polls `:3080`, manages LKG snapshots, auto-rollback, reports.
