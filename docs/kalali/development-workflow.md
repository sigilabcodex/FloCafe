# Kalali development workflow

This page describes the fork's Git, test, migration, and upstream practices. It does not authorize a remote write or a deployment.

## Branches and remotes

- `origin` is `https://github.com/sigilabcodex/FloCafe.git`.
- `upstream` is `https://github.com/FreeOpenSourcePOS/FloCafe.git`.
- Keep `main` as the upstream reference. Do not develop on it.
- Use `kalali/integration` for the fork's stable integration branch and `kalali/feature/<tema>` for task branches.
- Start feature work from the approved integration point. Preserve experimental branches and shared history.
- Inspect status, remotes, ancestry, changed paths, and sensitive files before a merge or publication.
- Never use force push or destructive reset/rebase on shared work. Push only when the task explicitly authorizes it and only the named branch.

Keep upstream contributions separate from Kalali-specific configuration. Propose reusable changes in a focused pull request only when separately requested.

## Tests and builds

Use Node.js 22 or later compatible with the locked dependencies. The initial integration build was validated with Node 22.23; Node 20 and some earlier Node 22 releases may fail with this dependency set.

Use isolated synthetic databases under temporary directories. Confirm test helper paths and never use FloCafe Demo or a live store database. Tests that trigger a native rebuild must not be run against an operational installation. Inspect `postinstall` and runner behavior before installing or rebuilding dependencies.

Run the focused test suites for changed behavior. For production and inventory work, consider production lifecycle/API/process tests, recipe-order lifecycle, supplies, inventory ledger, restore, authorization, and migration upgrade tests. Wire each new `tests/*.test.*` suite into scripts reachable from `pretest` or `test`, then run `npm run test:script-coverage`.

For E2E tests, use `npm run test:e2e:browser` from the repository root; Playwright configuration lives in `frontend/`.

For docs, run `npm run docs:check` and `git diff --check`. For frontend, run `npm run lint` and `npm run build:frontend`. For backend, run `npm run lint` and `npm run build`. Add `npm run i18n:check` when translations or message types change. Report blocked or skipped checks as such.

## Database migrations

SQLite is operational data. Never run experimental migrations against real data. Use fresh synthetic databases and populated upgrade fixtures, and check schema integrity, foreign keys, ledger balances, and preserved rows.

Migrations 126–128 add the Kalali production schema. Before extending them, compare against the current upstream registry and any deployed Kalali history. Do not renumber or rewrite a migration that may have shipped; use a forward migration after evaluating compatibility. Read [`docs/architecture/data-and-migrations.md`](../architecture/data-and-migrations.md) for FloCafe's migration and recovery contract.

## Upstream compatibility

Before syncing upstream, fetch and inspect the remote commits and changed paths. Review overlapping API, permission, UI, translation, and schema contracts. Keep FloCafe's offline operation, backend authority, role-based authorization, data safety, and recovery invariants; see [`docs/reference/product-invariants.md`](../reference/product-invariants.md). Verify behavior from current code and tests rather than assuming old documentation or branch history is current.
