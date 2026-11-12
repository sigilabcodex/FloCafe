# Kalali inventory and production rules

Use these rules when changing inventory, recipes, or production. Current behavior is summarized from FloCafe's production service, database migrations, and production tests; future design criteria are identified separately.

## Current production behavior

The production order lifecycle has `queued`, `in_progress`, `completed`, `cancelled`, and `abandoned` states. Creating a queued order does not reserve ingredient stock. Starting an order issues its recipe components and records `production_issue` movements. Completing it records the actual yield and credits the output supply with a `production_output` movement.

A queued order can be cancelled without inventory movements. Abandoning an in-progress order does not automatically restore the ingredients already issued. A production process can snapshot ordered steps with `operation`, `wait`, or `check` types. Step states are `pending`, `in_progress`, `completed`, `skipped`, and `blocked`; step transitions do not create inventory movements.

Creation and transitions use idempotency and audit events. Verify exact request, permission, and transition contracts in [`main/services/production.ts`](../../main/services/production.ts), [`main/routes/production.ts`](../../main/routes/production.ts), and the linked production tests before changing behavior.

## Inventory and cost integrity

- Make every stock movement attributable and consistent with the supply balance.
- Do not double-consume ingredients or double-credit finished output on retries.
- Apply balance changes and ledger writes transactionally.
- Preserve the production order's recipe/process snapshot for historical interpretation.
- Preserve applicable input costs with the order. Do not recalculate historical costs from current ingredient prices.
- Record actual yield separately from planned quantity.
- Define cancellation, abandonment, restoration, and waste behavior explicitly; do not imply that abandoning a batch restores issued ingredients.
- Treat a prepared supply as a materialized intermediate when a production recipe feeds a sale recipe. Avoid unbounded recursive recipe expansion.

Do not equate supply activity with product sale availability or channel availability. Keep physical stock, consumed stock, active status, and sale eligibility distinct wherever the product model exposes them.

## Migration contract

Kalali's production schema is introduced by migrations 126–128 in `main/db.ts`: production recipes/orders/events; additional movement types and terminal production states; then versioned processes, step snapshots, and step events. Migration 127 rebuilds `supply_movements` and `production_orders`, so any edit must preserve all existing columns, rows, references, and required indexes.

Before adding or changing a migration:

- Check the current migration registry and upstream history. Never assume upstream's version tail is unchanged.
- Do not renumber or edit a migration that may have shipped. Add a forward migration after evaluating deployed history.
- Test from an empty database and a populated prior schema in isolated temporary paths.
- Verify row preservation, ledger consistency, `integrity_check`, and `foreign_key_check`.

## Focused verification

Relevant suites include `npm run test:production-batches`, `npm run test:production-api`, `npm run test:production-processes`, `npm run test:recipe-order-lifecycle`, `npm run test:supplies-service`, `npm run test:inventory-ledger`, `npm run test:backup`, `npm run test:upgrade-path`, and `npm run test:authorization-permissions`. Choose suites based on the code path changed; do not run them against Demo or operational data.
