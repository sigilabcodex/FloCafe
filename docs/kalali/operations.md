# Kalali operations goals

This page records operator-first design criteria for changes in the Kalali fork. It distinguishes those goals from behavior implemented by FloCafe today.

## Operator-first design

Design for staff working at the counter, in the kitchen, in production, and across shift transitions. Prefer fast, understandable operations on tablets and computers, clear states, explicit actions, progressive adoption, and recovery after interruption. Do not turn routine work into long administrative forms when a smaller interaction preserves the required data and controls.

Interfaces may simplify a workflow, but the backend remains responsible for validation, permissions, transactions, and audit attribution.

## Represent what happened

Operational records should preserve material differences between plan and outcome, including short yield, interruption, unavailable ingredients, changed orders, waste, and work carried into another shift. Do not hide a discrepancy with a silent adjustment. Record actual values and a reason where the underlying workflow requires them.

These are design criteria. They do not claim that every FloCafe screen currently has draft, pause, handover-note, or recovery controls.

## Demand, production, WIP, and handover

For future workflow changes, use this sequence as a way to reason about the work:

**Demand → planning → production → work in process (WIP) → delivery or handover.**

Keep each stage understandable to the operator. Make pending work and interruptions visible when the feature supports them, and allow the next authorized person to understand what remains. Do not add a planning engine, resource scheduler, or time-estimation system unless a validated operating need requires it.

FloCafe's production service already supports production orders, configured process steps, and terminal states. The sequence above is a design lens; it does not assert that demand forecasting, cross-shift notes, or every handover state is implemented.

No SKOSS-specific feature or workflow is documented here. The repository contains no source material that would support claims about SKOSS behavior; these criteria are stated as Kalali goals only.
