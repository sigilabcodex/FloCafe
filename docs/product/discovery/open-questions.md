# Product discovery questions

<!-- docs:policy-allow: handoff -->

These questions require decisions from Kalali operators or owners. Product requirements do not
settle them, and no schema or technical architecture should be chosen before the business rule is
clear. Link a decision record when a question is resolved.

| ID | Open question | Why the answer matters | Evidence needed |
| --- | --- | --- | --- |
| KQ-01 | What is the production day for overnight work, and at what local time does its date roll over? | Demand grouping, due dates, reports and handoff depend on the same boundary. | Walk through a night bake and morning fulfillment with actual times. |
| KQ-02 | What minimum WIP detail is useful: batch, stage, quantity, expected readiness, or some combination? | Determines whether existing process steps suffice or operators need separately recorded WIP. | Observe interrupted dough/prep work and ask what the next shift must know. |
| KQ-03 | When is work an intermediate stock supply versus WIP attached to an active batch? | Prevents double-counting available stock and unfinished work. | Trace one intermediate from preparation through storage and later consumption. |
| KQ-04 | Which orders recur, how far ahead should occurrences be created, and how are exceptions and series edits handled? | Controls duplicate generation and what appears in the demand plan. | Collect real repeating customer orders and their exception examples. |
| KQ-05 | Which internal tasks recur, who owns them, and how are skipped, deferred or blocked tasks handled? | Internal production work is different from customer demand and may have its own audit needs. | List recurring routines by station/shift and current paper or verbal process. |
| KQ-06 | What is the minimum reliable shift handoff: notes, structured checklist, acknowledgment, or a hybrid? | Affects handoff speed, accountability and whether work is lost between shifts. | Rehearse outgoing/incoming shift with active batch, blocker and ready output. |
| KQ-07 | Which stock is available to promise or consume, and which is committed, quarantined, reserved or otherwise unavailable? | Existing stock balance does not automatically mean stock is available for a new order. | Review current reservation, spoilage and fulfillment practices. |
| KQ-08 | Does Kalali need supplier directory and quote history only, or purchase orders, receiving, invoices and reconciliation? | Full procurement is explicitly outside SKOSS's early scope and has material workflow/data cost. | Review purchasing records and who reconciles ordered versus received inputs. |
| KQ-09 | What quote and purchase-price history must be retained, and which cost should a recipe/batch use? | Cost reporting needs a stable historical cost rule. | Gather sample invoices/quotes, units and correction cases. |
| KQ-10 | Which work surfaces are needed at counter, bar, prep, oven, packing and shift lead? | FloCafe already has POS, KDS and Server App; a new client should not duplicate them without evidence. | Map device, network, printer and actions per station. |
| KQ-11 | Which roles can create, start, pause, complete, cancel, adjust yield, discard, receive stock and accept a handoff? | Permission boundaries need operational approval and must remain backend-enforced. | Review current staff roles with owners and each action's risk. |
| KQ-12 | Which printed artifacts are essential at opening: receipt, KOT, batch ticket, label, packing slip, handoff sheet? | Determines whether existing document kinds cover the workflow. | Test representative thermal widths and labels on the actual devices. |
| KQ-13 | What constitutes “opening ready,” who signs off, and what date/conditions govern the rehearsal? | The roadmap cannot define release readiness without an owner and acceptance evidence. | Name accountable owners and confirm a rehearsal scenario. |

Until resolved, keep implementation reversible and do not encode assumptions into migrations.
