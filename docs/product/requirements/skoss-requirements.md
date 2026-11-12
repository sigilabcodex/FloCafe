# Recovered SKOSS requirements

<!-- docs:policy-allow: handoff -->

This page records operational requirements recovered from SKOSS and SKOSSina. It is product
research, not a specification of FloCafe behavior. The source snapshot is
[SKOSS commit `ad91c54a453a196c55f52cacc121366b4c5736d0`](https://github.com/sigilabcodex/SKOSS/tree/ad91c54a453a196c55f52cacc121366b4c5736d0),
dated 2026-06-18. Requirements below retain their source status: approved direction, prototyped,
proposed, or deferred. A prototype does not establish operational completeness.

## Status vocabulary

| Status | Meaning |
| --- | --- |
| Approved direction | A product need or boundary stated as part of SKOSS's accepted product direction. It is not automatically approved for Kalali. |
| Prototyped | A user-facing or persisted slice exists in the cited SKOSS snapshot. Completeness and production readiness are not implied. |
| Proposed | A design or model is documented but is not established as implemented. |
| Deferred | SKOSS explicitly postpones the capability or excludes it from early scope. |
| Open | SKOSS leaves a business or product rule unanswered. |

## Requirements

| ID | Recovered need | SKOSS status | Source and evidence | Certainty |
| --- | --- | --- | --- | --- |
| SKR-01 | Start with a short activation and allow setup to continue after operators can begin work. | Prototyped | [README](https://github.com/sigilabcodex/SKOSS/blob/ad91c54a453a196c55f52cacc121366b4c5736d0/README.md), [bootstrap v2](https://github.com/sigilabcodex/SKOSS/blob/ad91c54a453a196c55f52cacc121366b4c5736d0/docs/bootstrap-v2-onboarding.md), [bootstrap v2 pull request](https://github.com/sigilabcodex/SKOSS/pull/63) | High |
| SKR-02 | Give sales, kitchen, shift lead, and admin role-shaped views while keeping one shared operational record. | Approved direction; partially prototyped | [workspaces](https://github.com/sigilabcodex/SKOSS/blob/ad91c54a453a196c55f52cacc121366b4c5736d0/docs/workspaces.md), [ADR 0003](https://github.com/sigilabcodex/SKOSS/blob/ad91c54a453a196c55f52cacc121366b4c5736d0/docs/adr/0003-admin-operator-plane-split.md) | High |
| SKR-03 | Capture customer context useful for repeat orders, fulfillment, and handoff without requiring a full CRM. | Approved direction; prototyped foundation | [customer memory](https://github.com/sigilabcodex/SKOSS/blob/ad91c54a453a196c55f52cacc121366b4c5736d0/docs/customer-memory.md) | High |
| SKR-04 | Capture ad hoc demand and distinguish it from generated recurring demand; preserve practical notes and production dates. | Approved direction; prototyped | [MVP v0](https://github.com/sigilabcodex/SKOSS/blob/ad91c54a453a196c55f52cacc121366b4c5736d0/docs/mvp-v0.md), [v0 technical spec](https://github.com/sigilabcodex/SKOSS/blob/ad91c54a453a196c55f52cacc121366b4c5736d0/docs/v0-technical-spec.md) | High |
| SKR-05 | Repeat customer orders and internal operational tasks; allow editing one occurrence, the series, or this and future occurrences. | Approved direction; order templates prototyped; task recurrence not verified as implemented | [recurring logic](https://github.com/sigilabcodex/SKOSS/blob/ad91c54a453a196c55f52cacc121366b4c5736d0/docs/recurring-logic.md), [guided onboarding pull request](https://github.com/sigilabcodex/SKOSS/pull/65) | High |
| SKR-06 | Maintain lightweight supplier, raw-material, and historical supplier-price context to support later recipes and cost decisions. | Approved foundation; narrow prototype; full procurement deferred | [operational data layer](https://github.com/sigilabcodex/SKOSS/blob/ad91c54a453a196c55f52cacc121366b4c5736d0/docs/operational-data-layer.md), [MWP status](https://github.com/sigilabcodex/SKOSS/blob/ad91c54a453a196c55f52cacc121366b4c5736d0/docs/mwp-stabilization-status.md) | High |
| SKR-07 | Define product, variant, recipe, and intermediate relationships incrementally rather than requiring a complete catalog before use. | Approved direction; partly prototyped; costing depth deferred | [progressive adoption](https://github.com/sigilabcodex/SKOSS/blob/ad91c54a453a196c55f52cacc121366b4c5736d0/docs/progressive-adoption.md), [operational data layer](https://github.com/sigilabcodex/SKOSS/blob/ad91c54a453a196c55f52cacc121366b4c5736d0/docs/operational-data-layer.md) | High |
| SKR-08 | Aggregate demand by production day and product/family, then translate demand into actionable production requirements. | Approved direction; basic production board prototyped | [production logic](https://github.com/sigilabcodex/SKOSS/blob/ad91c54a453a196c55f52cacc121366b4c5736d0/docs/production-logic.md), [roadmap](https://github.com/sigilabcodex/SKOSS/blob/ad91c54a453a196c55f52cacc121366b4c5736d0/docs/roadmap.md) | High |
| SKR-09 | Represent production batches and process stages with planned versus actual outcome. | Approved direction; batch depth and stage model remain incomplete/open | [MVP v0](https://github.com/sigilabcodex/SKOSS/blob/ad91c54a453a196c55f52cacc121366b4c5736d0/docs/mvp-v0.md), [production logic](https://github.com/sigilabcodex/SKOSS/blob/ad91c54a453a196c55f52cacc121366b4c5736d0/docs/production-logic.md), [open questions](https://github.com/sigilabcodex/SKOSS/blob/ad91c54a453a196c55f52cacc121366b4c5736d0/docs/open-questions.md) | High |
| SKR-10 | Account for WIP and ready output when deciding what work remains, with enough quantity and stage detail to support operators. | Approved direction; basic WIP prototyped; granularity open | [production logic](https://github.com/sigilabcodex/SKOSS/blob/ad91c54a453a196c55f52cacc121366b4c5736d0/docs/production-logic.md), [open questions](https://github.com/sigilabcodex/SKOSS/blob/ad91c54a453a196c55f52cacc121366b4c5736d0/docs/open-questions.md) | High |
| SKR-11 | Make unfinished, blocked, ready, and carried work visible at shift handoff, with notes and a usable paper summary. | Approved direction; basic handoff/WIP prototyped | [workspaces](https://github.com/sigilabcodex/SKOSS/blob/ad91c54a453a196c55f52cacc121366b4c5736d0/docs/workspaces.md), [printing](https://github.com/sigilabcodex/SKOSS/blob/ad91c54a453a196c55f52cacc121366b4c5736d0/docs/printing.md) | High |
| SKR-12 | Keep recurring internal tasks distinct from customer orders and production batches. | Approved direction; implementation not verified | [recurring logic](https://github.com/sigilabcodex/SKOSS/blob/ad91c54a453a196c55f52cacc121366b4c5736d0/docs/recurring-logic.md) | High |
| SKR-13 | Print order, production, WIP/handoff, and useful labels through a browser-first workflow; treat paper as part of operations. | Approved direction; browser-print prototype, hardware depth deferred | [printing](https://github.com/sigilabcodex/SKOSS/blob/ad91c54a453a196c55f52cacc121366b4c5736d0/docs/printing.md) | High |
| SKR-14 | Show due, overdue, and upcoming operational work without turning the timeline into a generic planning calendar. | Approved direction; timeline prototyped | [operational time surface](https://github.com/sigilabcodex/SKOSS/blob/ad91c54a453a196c55f52cacc121366b4c5736d0/docs/operational-time-surface.md) | High |
| SKR-15 | Provide a lightweight worker client across phone, tablet, desktop, and browser, with role-shaped attention. | Approved direction; web surfaces prototyped; PWA/packaging deferred | [README](https://github.com/sigilabcodex/SKOSS/blob/ad91c54a453a196c55f52cacc121366b4c5736d0/README.md), [modules](https://github.com/sigilabcodex/SKOSS/blob/ad91c54a453a196c55f52cacc121366b4c5736d0/docs/modules.md) | High |
| SKR-16 | Support practical hosting on a small server or LAN and degrade sensibly on network loss; do not claim full offline sync before it exists. | Approved direction; degraded/offline sync remains future work | [deployment modes](https://github.com/sigilabcodex/SKOSS/blob/ad91c54a453a196c55f52cacc121366b4c5736d0/docs/deployment-modes.md), [realtime/offline strategy](https://github.com/sigilabcodex/SKOSS/blob/ad91c54a453a196c55f52cacc121366b4c5736d0/docs/realtime-offline-strategy.md) | High |
| SKR-17 | Allow progressive adoption and later enrichment of draft customers, products, and freeform items. | Approved direction; partly prototyped | [progressive adoption](https://github.com/sigilabcodex/SKOSS/blob/ad91c54a453a196c55f52cacc121366b4c5736d0/docs/progressive-adoption.md), [order capture pull request](https://github.com/sigilabcodex/SKOSS/pull/61) | High |
| SKR-18 | Defer full procurement, accounting, broad analytics, mandatory SKU/barcode, delivery automation, messaging, and complex capacity scheduling until justified. | Explicitly deferred or non-goal | [README](https://github.com/sigilabcodex/SKOSS/blob/ad91c54a453a196c55f52cacc121366b4c5736d0/README.md), [future ideas](https://github.com/sigilabcodex/SKOSS/blob/ad91c54a453a196c55f52cacc121366b4c5736d0/docs/future-ideas.md), [capacity proposal](https://github.com/sigilabcodex/SKOSS/blob/ad91c54a453a196c55f52cacc121366b4c5736d0/docs/production-capacity-model.md) | High |

## Interpretation for Kalali

These requirements recover business needs, not SKOSS's schema or technical design. The FloCafe
mapping and verification state live in [implementation status](../implementation-status.md); the
Kalali workflows and acceptance scenarios live in [workflow requirements](kalali-workflows.md).
Unresolved operating rules live in [discovery questions](../discovery/open-questions.md).

The SKOSS sources are pinned to one public snapshot for traceability. Revisit them only when a
specific requirement changes or a new source provides materially different evidence.
