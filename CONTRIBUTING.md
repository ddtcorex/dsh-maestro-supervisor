# Contributing to dsh-maestro-supervisor

Thank you for contributing to **dsh-maestro-supervisor** (`@ddtcorex/dsh-maestro-supervisor`) — Supervisor for DSH Web resilience: standalone daemon (polls `:3080` every 3s, LKG snapshots, auto-rollback, reports) plus in-tree host plugin (auto-resume interrupted sessions) and client plugin (hybrid auto-reload), packaged as a Cordis plugin + `dsh-web-supervisor` binary.

## Getting Started

1. **Fork and clone** `github.com/ddtcorex/dsh-maestro-supervisor`.
2. Install dependencies (requires Node.js 22+, pnpm 11+):

   ```bash
   pnpm install
   ```

3. Build the Cordis plugin (TypeScript → `lib/` + `lib/client.js`):

   ```bash
   pnpm build        # tsc host + tsc client + node scripts/build-client.mjs -> lib/ + lib/client.js
   ```

4. Open the project in your editor. Host logic lives in `src/host/`, client auto-reload in `src/client/auto-reload.ts`, tests in `tests/`. `lib/` is committed build output — do not hand-edit. `lib/client.js` is the browser bundle (`window.__ModuleLoader__.load` wrapper).

## Superpowers 3-Phase Workflow (AGENTS.md)

Every change to this repository **MUST** follow the Superpowers skill workflow defined in `AGENTS.md`, in order:

1. **brainstorming** — explore intent, requirements, and design before writing code. Record the outcome in the PR description.
2. **writing-plans** — turn the approved design into a task-by-task plan with exact test and implementation sketches. Plans are transient working files — delete them once the batch ships.
3. **executing-plans** — implement task by task with strict **TDD**: write a failing test first, verify RED, implement, verify GREEN, then commit that task before starting the next. Do not commit while tests are red.

Do not skip ahead to implementation and do not bundle multiple TDD tasks into one commit during `executing-plans`. Describe durable outcomes in the PR body instead of committing dated spec/plan files.

## Branch Naming

Never commit directly to `master`. Start a feature branch per work session:

- `fix/<topic>` — bug fixes
- `feat/<topic>` — new features
- `docs/<topic>` — documentation-only changes

Rebase (not merge) when the base moves: `git fetch origin && git rebase origin/master`.

## Conventional Commits

All commit subjects **must** follow [Conventional Commits](https://www.conventionalcommits.org/) in imperative mood:

```
<type>(<scope>): <subject>

<body — why, not what>

Refs: #<issue>
```

- **Types (closed list):** `feat` `fix` `docs` `chore` `refactor` `perf` `test` `build` `ci` `revert`
- **Scope:** optional, without the `dsh-maestro-` prefix — e.g. `feat(supervisor):`, `fix(resume):`, `docs(readme):`
- **Subject:** imperative, lowercase first word, ≤ 72 chars, no trailing period
- **Body:** explain *why* and trade-offs when non-trivial
- **Breaking changes:** `feat!: <subject>` plus a `BREAKING CHANGE:` footer

One TDD task = one commit while executing a plan; squash at merge time if the history reads better squashed.

## Validation

Run these before opening a PR (match depth to risk):

```bash
pnpm verify      # tsc --noEmit host + tsc -p tsconfig.client.json --noEmit
pnpm test        # vitest run (13 files, 82 tests)
pnpm build       # tsc host + client && node scripts/build-client.mjs -> lib/ + lib/client.js
test -f lib/index.js && test -f lib/client.js && echo "build ok"
```

After touching the client bundle, verify on live DSH Web (`:3080`), not just curl/grep. Check the loopback RPC and auto-reload:

```bash
curl -s http://127.0.0.1:3080/dsh-maestro-supervisor-resume/scan -X POST -H 'content-type: application/json' -d '{"type":"client-request","rpcId":"t","method":"scan","payload":{"withinMs":300000}}' | head -c 200
curl -s http://127.0.0.1:3080/plugins/@ddtcorex/dsh-maestro-supervisor/client.js | grep -c "window.location.reload"  # 2
```

Do not claim verified/done/clean without having actually run the checks — be ready to paste exact command output in the PR.

## Pull Requests

1. Push your branch and open a PR into `master`.
2. Fill out `.github/PULL_REQUEST_TEMPLATE.md` (Summary, Why, Changes, Validation, Linked Issues).
3. Link the PR to the plan that produced it when the Superpowers workflow was used.
4. Ensure CI (`pnpm verify` / `pnpm test` / `pnpm build` via `dsh-maestro-ci`) is green.

## Package Visibility

This package is public (`"private": false`). Never set `"private": true` in `package.json`. Publishing uses `pnpm publish --access public`.

## Public Word Blacklist

This repo is public — never put private project/client names or host paths into source, tests, docs, or commit messages. The single source for blacklisted words is at the meta root `docs/PUBLIC_WORD_BLACKLIST.md` (not copied into this repo — that would publish the private names). Before pushing a public PR, run from the meta root:

```bash
node scripts/check-public-blacklist.mjs        # must be ✅ 0 hits
node scripts/check-public-blacklist.mjs --suggest  # review new suspects
```

Replace any hit with the placeholder from that doc (`example-project`, `<workspace-root>/...`, `example.test`).

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](./CODE_OF_CONDUCT.md). By participating, you agree to its terms.

## Questions or Security Reports

- General questions: open a GitHub Discussion or issue.
- Contact maintainer: [kaido4492@gmail.com](mailto:kaido4492@gmail.com)
- Security vulnerabilities: use GitHub's private advisory reporting at `https://github.com/ddtcorex/dsh-maestro-supervisor/security/advisories` — do not file a public issue.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](./LICENSE).
