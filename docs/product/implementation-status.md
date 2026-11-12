# Product capability status

<!-- docs:policy-allow: handoff -->

This page maps SKOSS-derived needs to FloCafe upstream and the Kalali fork. Status describes
verified code paths, not the existence of a table, route, or component alone. The upstream
comparison uses the common base available in this checkout, `f5cf9d7e3d0eda5a2e7befaca8ac10381def9270`.
The Kalali changes in this checkout are compared with that base; this is a repository comparison,
not a claim about every upstream release.

## Status vocabulary

| Status | Meaning |
| --- | --- |
| Implemented | The cited flow is connected through its service/API and operational surface, with focused tests. |
| Partial | Useful pieces exist, but the user need is not met end to end or a required business rule is open. |
| Pending | No adequate operational flow is established in the inspected checkout. |
| Deferred | Intentionally outside the accepted scope until a need is confirmed. |
| Audit | Capability requires a focused end-to-end review before its status can be raised. |

## Capability matrix

| Capability | SKOSS evidence/status | FloCafe upstream at comparison base | Kalali fork in this checkout | Reuse, gap, and certainty |
| --- | --- | --- | --- | --- |
| Availability and safe operation | Offline/degraded hosting is direction; full sync is future work | Offline-first POS, orders, billing, KDS and printing; recovery and optional network boundaries documented | Inherits offline core; production code follows local API/SQLite | **Implemented** for core sale operation; verify Kalali station/network rehearsal. High certainty from [offline ADR](../decisions/0001-offline-first-core.md) and architecture docs |
| Setup and administration | Bootstrap/onboarding prototyped | Setup, staff, permissions and data tools exist | No separate Kalali onboarding system documented | **Partial** for opening workflow. Reuse setup/RBAC. Medium certainty |
| Catalog and variants | Basic product setup prototyped; advanced menu deferred | Product/category/variant and modifier flows are part of POS | Inventory UI has fork changes; production outputs can use supplies | **Implemented** for core catalog, **audit** for Kalali's required opening catalog. The SKOSS product setup pull-request scope was narrower than a complete POS catalog. High for code presence, medium for fit |
| Customers and light CRM | Customer screen/context prototyped | Customer CRUD/search, sales context and export | No CRM extension documented | **Implemented** for basic customer operations; do not duplicate. High |
| Orders, payments and fulfillment | Ad hoc/recurring orders prototyped; dispatch remains light | Full POS order, bill, payment, refunds and scheduled orders | Inherits upstream order/payment flows | **Implemented** for sale/order baseline; recurring bakery patterns remain **partial**. High |
| Inventory and ledger | Supplier/raw-material/price foundation; full procurement deferred | Supplies, stock movements, recipes and order-linked inventory behavior | `supplies` and `supply_movements` record receipt, count, adjustment, waste and recipe/production movements. Priced receives normalize units and update current WAC. | **Implemented** for supply stock and WAC; supplier attribution, purchase commitments and receiving reconciliation **pending**. A manual adjustment may change stock but is not a purchase receipt. High; see `main/services/supplies.ts` and `tests/supplies-service.test.ts` |
| Recipe and cost | Lightweight recipe foundation; costing depth deferred | Product recipes and recipe-linked stock depletion exist | Recipe snapshots use current supply WAC and preserve sale/production cost evidence | **Implemented** for current recipe/batch costing contracts; historical quote/observed prices and presentation-aware comparison **pending**. High; see [Kalali inventory/production](../kalali/inventory-production.md) |
| Offline purchasing and price history | SKR-06 approves a lightweight price foundation; SKR-16 leaves offline sync future work; SKR-18 defers full procurement | No purchase-list or supplier-price-history workflow | No supplier, brand, purchase-list, local capture/outbox, or idempotent price-sync service is established. Existing receive movements cannot distinguish quote, observation, confirmed purchase and physical receipt. | **Pending**; proposed stages C1-C6 are discovery and roadmap criteria, not implemented capability. This Kalali scope extends beyond SKOSS's deferred procurement boundary. High from repository search and current services |
| Daily demand plan | Aggregate demand by production date, adjust by WIP | Orders and reports exist; no SKOSS demand planner | Orders can be placed on production board; batches are created through a separate production workflow | **Pending** for a connected demand-to-plan flow. Reuse order/recipe/supply services. High |
| Batches and process steps | Basic production board/WIP prototyped; full batch semantics unclear | No Kalali batch-order service at comparison base | Production orders, process versions/steps, idempotent transitions, event audit, planned/actual yield and inventory movements added in migrations 126–128 | **Implemented** for batch lifecycle and steps; demand auto-generation remains **pending**. High: files and tests are Kalali-only in branch diff |
| WIP and intermediate goods | Basic WIP forms; granularity open | Supplies can represent intermediate stock; no generic SKOSS WIP | Production steps track batch progress; supplies track produced intermediates. No general cross-shift WIP ledger is established by these contracts | **Partial**. Reuse process snapshots and supply ledger; define separate WIP semantics before schema work. High |
| Recurring orders/tasks | Order recurrence prototyped; internal tasks are a requirement without verified implementation | Scheduled orders support one-time release scheduling, not full series recurrence | No recurring task extension documented | **Partial/pending**. Keep series generation distinct from scheduled release. High |
| Shift handoff | Shift logs, WIP and print view prototyped | Cash-session close/carryover exists but is not production handoff | Operator handover is documented as a Kalali goal; production service adds batch/event audit but no full shift-handoff feature | **Pending** as a connected kitchen workflow. Reuse actor, audit, production state and print. High |
| Printing | Browser print for order, production and handoff; thermal depth deferred | Semantic receipt/KOT/delivery-slip/label pipeline with multiple transports | No separate Kalali print stack documented | **Implemented** for existing artifacts; batch ticket or handoff summary may need a document kind. Audit exact format first. High |
| Operational reporting | Timeline prototyped; broad analytics deferred | Sales, inventory, cash, tax and daily reports | Production stock movements can feed inventory/reporting surfaces | **Partial** for demand/WIP/yield reporting. Reuse reports and ledger. High |
| SKOSSina / remote surfaces | Browser-first role-oriented worker surface prototyped; PWA future | POS, KDS and Server App already provide local/remote operational surfaces | No new client architecture added | **Redundant as a new app architecture**; **audit** usability on Kalali devices and roles. High |
| Import and progressive adoption | Draft-first and CSV adoption direction; CSV engine deferred in cited PRs | Import/export and backup/restore tools exist | No Kalali-specific import flow documented | **Partial**. Reuse supported import/restore contracts; do not assume SKOSS draft model. Medium |
| Delivery integrations and automation | Mostly deferred/future | Some optional integrations exist | No new Kalali procurement or delivery platform documented | **Deferred** until each business case and boundary is agreed. High |

The Kalali Catalog Maestro V4.3 was not present in this checkout, so its fields, identifiers and
unit conventions have not been compared or mapped. Review the source before C2 finalizes the
identity and unit contract.

### Kalali production attribution

At the comparison point, `upstream/main` is the shared base. The Kalali branch adds
`main/services/production.ts`, `main/routes/production.ts`, production tables and migrations in
`main/db.ts`, production permissions, and focused API/lifecycle/process tests. Kalali production
therefore must not be described as an upstream capability. Detailed lifecycle and migration
contracts are documented in [Kalali inventory and production](../kalali/inventory-production.md).

### Persistence and architecture boundary

FloCafe uses SQLite. SKOSS's PostgreSQL/Drizzle transition and separate SKOSSina client direction
are not Kalali requirements. Any later data-model change must be justified by an approved business
requirement, fit FloCafe's migration and restore contracts, and preserve data through a forward
migration.

## Verification references

Use current behavior and focused suites as the source of truth before changing status:

- Orders, scheduled release, customers and catalog: [API reference](../reference/api.md),
  `tests/integration-order-lifecycle.test.ts`, `tests/issue-360-scheduled-orders.test.ts`,
  `tests/customer-auth.test.ts`.
- Supplies and stock: `main/services/supplies.ts`, `main/routes/supplies.ts`,
  `tests/inventory-ledger.test.ts`, `tests/supplies-service.test.ts`,
  `tests/ingredient-cost.test.ts`.
- Kalali production: `main/services/production.ts`, `main/routes/production.ts`,
  `tests/production-batches.test.ts`, `tests/production-api.test.ts`,
  `tests/production-processes.test.ts`, `tests/recipe-order-lifecycle.test.ts`.
- Printing: [printing architecture](../architecture/printing.md),
  `tests/print-document.test.ts`, `tests/receipt-printing.test.ts`,
  `tests/delivery-slip-printing.test.ts`.
- Recovery and upgrades: [data and migrations](../architecture/data-and-migrations.md),
  `tests/backup-restore-production.test.ts`, `tests/upgrade-path.test.ts`.
