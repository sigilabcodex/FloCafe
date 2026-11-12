# Kalali operating workflows

<!-- docs:policy-allow: handoff -->

These scenarios turn product requirements into flows that can be rehearsed with operators. They
do not assert that every flow is implemented. FloCafe's verified capability boundaries are in
[implementation status](../implementation-status.md); unresolved business rules are in
[discovery questions](../discovery/open-questions.md).

## KWF-01: Open, sell, and recover

**Actors:** owner/manager, cashier, kitchen staff.

1. Configure store identity, language, currency/tax settings, staff and permissions.
2. Enter opening products, prices, variants and relevant recipes/supplies.
3. Create an order, take payment, send preparation work, and print the customer or kitchen
   document required by the station.
4. Continue core sale and kitchen work when internet access is unavailable.
5. Verify backup and restore procedures on an isolated copy.

**Acceptance:** payment and tax outcomes are backend-authoritative; the order is visible to staff
with order access; inventory changes are attributable; printing follows the configured device
path; core operation has no required cloud dependency; recovery preserves data. Existing FloCafe
contracts are in [order lifecycle](../../architecture/order-lifecycle.md), [offline-first ADR](../../decisions/0001-offline-first-core.md),
and [data and migrations](../../architecture/data-and-migrations.md).

## KWF-02: Counter order creates production demand

**Actors:** cashier and production lead.

1. Record a cafe sale or bakery order with product, variant, quantity, promised/production date,
   customer/destination context when relevant, and notes.
2. Include the order in the correct operational day and show changed or cancelled demand clearly.
3. Production lead reviews totals by product/family and compares them with ready stock and active
   work.
4. Lead decides which work becomes a production batch; the software does not silently reserve
   inventory or create duplicate batches.

**Acceptance:** grouped totals reconcile to eligible order lines; cancellation and edits update the
plan; local business date boundaries are explicit; creating a batch is idempotent and retains
recipe/process snapshots. The demand plan is a missing connection, not an assertion that the
existing POS lacks orders.

## KWF-03: Recurring bakery order and exception

**Actors:** order taker and production lead.

1. Define a recurring customer requirement (for example, weekday bread delivery).
2. Generate its occurrence for the planning horizon.
3. Skip, change or cancel one occurrence without corrupting the series; optionally revise future
   occurrences according to a confirmed rule.
4. Make the generated demand visible with source and customer context.

**Acceptance:** repeat generation produces no duplicates; one-off exception and series edits have
defined scope; generated demand can be traced to its template. Frequency, horizon, and editing
rules remain open. FloCafe scheduled orders cover scheduled release, not necessarily series
recurrence.

## KWF-04: Plan and execute a bakery batch

**Actors:** production lead and baker.

1. Review demand for a product or dough family.
2. Account for finished output and relevant intermediate stock.
3. Create a batch using the selected recipe/process version; preserve ingredient and process
   snapshots.
4. Start the batch, record process-step progress, and complete with actual yield.
5. Reconcile ingredient issues, output movements, waste/short yield and remaining demand.

**Acceptance:** retries cannot issue ingredients or credit output twice; planned quantity and actual
yield remain distinct; history retains the recipe/process used; stock movements reconcile with
balances. Kalali batch lifecycle and process steps are implemented. Demand aggregation, generic
WIP and some exception policies are not implied.

## KWF-05: Intermediate preparation and WIP

**Actors:** prep worker, baker and production lead.

1. Produce an intermediate such as dough or filling into a tracked supply.
2. Record in-process work that is not yet saleable stock separately from finished/intermediate
   stock, if operators need that distinction.
3. Carry remaining quantity and stage forward after interruption.
4. Consume intermediate output in a later batch or sale recipe where the existing model allows.

**Acceptance:** stock cannot be counted both as on-hand and in-process; quantity and unit remain
clear; consumption is traceable; a short yield or discard does not silently adjust the balance.
Which records belong in supply inventory and which belong in WIP is an open decision.

## KWF-06: Shift handover

**Actors:** outgoing and incoming shift leads.

1. Review active production orders, process-step state, WIP, ready output and due orders.
2. Record what remains, what is blocked, and what needs attention.
3. Print or display a concise handoff artifact when useful.
4. Incoming lead acknowledges or updates the carried work without losing the prior record.

**Acceptance:** next shift can identify owner/context, current stage, remaining amount and blocker;
notes do not replace structured batch state; prior handoff remains auditable. The minimum
acknowledgment flow and permissions are open.

## KWF-07: Recurring internal preparation

**Actors:** shift lead and kitchen staff.

1. Define recurring non-customer work such as starter feeding, filling preparation or station
   reset.
2. Surface the task for the correct day/shift and allow completion, skip, defer or blocker reason
   according to agreed rules.
3. Include unfinished tasks in the next handoff.

**Acceptance:** internal tasks remain distinct from customer orders and production batches; a
retry does not create duplicate task instances; completion does not mutate stock unless an
explicit stock-affecting workflow is defined. Requirement and recurrence rules need operator
validation.

## KWF-08: Purchase and price evidence

**Actors:** purchaser and inventory owner.

1. Record supplier and quotation/price context for an input.
2. If purchasing is in scope, record ordered and received quantities separately.
3. Reconcile received quantity into inventory with unit, date, supplier and source cost.
4. Preserve historical purchase evidence when a future quote changes.

**Acceptance:** quoted, ordered, received and on-hand quantities cannot be confused; ledger and
cost evidence are attributable and historical. FloCafe supply inventory does not by itself prove
that a purchase-order/quotation workflow exists. Scope remains open.
