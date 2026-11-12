# FloCafe / Kalali agent guide

FloCafe is an offline-first Electron POS. This fork is maintained by Kalali.

## Repository map

- `main/`: Electron, Express APIs, SQLite, printing, and services.
- `frontend/`: Next.js and React UI. Desktop builds use static export.
- `shared/`: contracts shared by backend and frontend.
- `tests/`: unit, integration, migration, and browser tests.
- `docs/`: supported system contracts and contributor procedures.

Read [`docs/README.md`](docs/README.md) for canonical documentation and [`DOCUMENTATION.md`](DOCUMENTATION.md) before changing docs.

## Invariants

- Core POS work (orders, billing, KDS, printing) works offline; optional network integrations fail gracefully.
- Preserve customer data through upgrades. Never reset, truncate, or drop a user database as a migration shortcut.
- Keep UI language, store regional settings, and tax/compliance behavior separate.
- Store timestamps using FloCafe conventions; use the configured store timezone for business-local display and reporting boundaries.
- Keep security, payment, and tax decisions backend-authoritative.
- Orders are not ownership-gated. A staff member with order access can see and act on any order. Gate pages and specific actions by permission; attribute writes to the authenticated actor. Never compare an order or item creator with the current user to hide or deny access. See [`product-invariants.md`](docs/reference/product-invariants.md) and [`roles-and-permissions.md`](docs/reference/roles-and-permissions.md).
- Keep backup recovery usable. Preserve authorization and confirmation, integrity/schema validation, a pre-restore recovery copy, forward migrations, and invalidation of transient sessions and pairing tokens. Prefer the selected backup as authoritative state.
- Reuse existing helpers and dependencies. Keep changes within the approved scope.

## Kalali guidance

These pages contain fork-specific operating goals and development procedures:

- [Operator-first workflow goals](docs/kalali/operations.md)
- [Inventory and production rules](docs/kalali/inventory-production.md)
- [Git, testing, migrations, and upstream workflow](docs/kalali/development-workflow.md)

Treat design goals as goals, not as claims about features that exist in FloCafe. Do not attribute undocumented behavior to SKOSS or copy its code, schema, persistence, or API contracts.

## Safety and scope

- Never include credentials, tokens, private keys, `.env` files, customer data, or backups in commits.
- Do not modify the Demo, real databases, packaged installations, Kalali Web Print, or external services unless the task explicitly authorizes it.
- Use isolated synthetic databases for tests. Confirm their effective paths before writing.
- Do not rebuild native dependencies unexpectedly. Inspect install scripts and obtain task-specific authorization before any rebuild that could affect an operational installation.
- Do not create, edit, close, label, or assign GitHub issues or pull requests unless explicitly asked.
- Do not commit, push, tag, merge, or publish unless the task explicitly authorizes that action.
- Preserve upstream history and license notices. Never force-push or destructively rewrite shared branches.

## Repository sharp edges

- In desktop mode (`NEXT_BUILD_MODE=desktop`), Next.js is statically exported. Put dynamic backend behavior in Express or Electron IPC, not Next.js API routes or server cookies.
- Ports `3001`, `3002`, and `3003` are held by the API, KDS, and Server App. `npm run clean` clears them when needed.
- Playwright configuration lives in `frontend/`; use `npm run test:e2e:browser` from the root.
- Counting assertions from `tests/helpers/test-setup.ts` only report. New suites should use throwing assertions and must be reachable from `pretest`/`test`; run `npm run test:script-coverage` after wiring them.
- Receipt width changes must pass `tests/receipt-column-oracle.test.ts`; regenerate its golden output only when the intended width change is approved.

## Common checks

Use Node.js 22 or later compatible with the repository. Run checks relevant to the change:

```sh
npm run lint
npm run build
npm run build:frontend
npm run i18n:check
npm run docs:check
npm run test:script-coverage
```

For database changes, also run fresh-database and upgrade-path tests. For production changes, run the focused production, inventory, permissions, and restore suites. Never report blocked or skipped checks as passing.
