# Kalali V4.3 catalog reconciliation

This page records a data-reconciliation proposal for the Kalali V4.3 master workbook. It is not an import specification approved for production and does not describe behavior already implemented by FloCafe. The workbook remains the source of catalog decisions; FloCafe's code and schema define the destination contracts. Re-run the checks in [Reproducible reconciliation](#reproducible-reconciliation) against the supplied workbook before preparing an import.

## Scope and handling

The reviewed source is `Kalali_V4_3_master_snapshot_2026-11-16.xlsx`, a read-only reference outside this repository. The Google Sheets source and the workbook were not edited. Quote amounts, contact details, credentials, demo databases, and operational databases do not belong in this document or a commit.

The existing isolated demo at `/tmp/flo-kalali-demo` was not regenerated. Its purchasing screenshots were inspected as visual references. The database, backup, and credential files in that directory were not opened.

## Workbook inventory

The workbook has 22 sheets. Counts below are populated rows after the field-header row when one exists; title and explanatory rows are not counted as records. Sheets without a normalized field row are described by their populated worksheet rows. They are inventory counts, not counts of approved or importable records.

| Sheet | Records / populated rows | Role and import reading |
| --- | ---: | --- |
| `Inicio` | 26 | Change and decision log. Preserve decisions and their evidence; not a runtime entity table. |
| `Menu V4` | 68 | Product catalog with `producto_id`, category, state, proposed channels, notes, and source traceability. Product identity is usable as an external key, but rows marked historical, candidate, or conditional must retain those states. |
| `Insumos` | 44 | Supply catalog with `insumo_id`, base and purchase units, conversion factor, cost state, and source. A blank conversion or cost is unknown, not zero. |
| `Precios insumo` | 45 | Price observations keyed by `precio_insumo_id`, linked by `insumo_id`; provider, date, pack quantity, amount, evidence, and status are separate fields. Many are blank pending evidence. Formulas calculate normalized cost and must not be read as approved values when no source observation exists. |
| `Preparaciones` | 15 | Intermediate preparations with `preparacion_id`, output unit, required yield, status, and usage. Several yields are explicitly to be measured; archived fused rows are not operational IDs. |
| `Recetas` | 81 | Product/preparation recipe records with `receta_id`, target, cost, state, and import state. All rows carry a `NO IMPORTAR` state, including historical and experimental records. |
| `Componentes` | 70 | Recipe-to-component bridge. `componente_id`, `receta_id`, and component reference are present, but all 70 rows have no base quantity or unit and are marked draft, historical, or candidate. |
| `Precios canal` | 272 | Current channel-price matrix and stated single source for channel pricing. Suggested values are formulas; approved prices are blank and notes disallow publication without costs and current terms. Do not publish or seed channel prices from this sheet. |
| `Fuentes` | 19 | Evidence registry. Retain `source_id` and source traceability in any staging data. Some cited material is unavailable or historical. |
| `FloCafe mapa` | 8 | Initial mapping proposals; its own validation column says destination fields still need confirmation. |
| `Canales y precios` | 140 | Explicitly historical V4.1 copy. Not a source of current channel prices. |
| `Modificadores` | 20 | Groups/options, product applicability, units, quantities, price status, and notes. Many are unportioned or unpriced. |
| `Proveedores` | 13 | Supplier and commercial presentation candidates. Most have no price; any public-price observation still needs its source and observation date before it is treated as current. The sheet may contain quote-sensitive details and should not be committed. |
| `Empaques` | 12 | Packaging compatibility and stock statements. Some quantities are estimates or explicitly require a physical count. Do not turn them into FloCafe stock balances. |
| `Pedidos y etapas` | 6 | Availability, channel, lead-time, and logistics constraints; not a product price source. |
| `Pendientes y pruebas` | 16 | Open validation actions. These remain explicit import gates, not data to coerce into defaults. |
| `Recetas históricas` | 17 | Legacy yields/costs and known contradictions. Keep for traceability; do not activate or use its costs as current. |
| `Recetario fuente` | 421 populated worksheet rows | Legacy recipe source layout rather than a normalized table. Its values require row-level interpretation and evidence before normalization. |
| `Fórmulas piloto` | 24 | Experimental recipe rows. Explicitly pilot material, not approved production recipes. |
| `FloCafe mapa adicional` | 9 | Additional field proposals and controls. Treat as design input pending code/schema verification. |
| `Cotización prioritaria` | 25 populated worksheet rows | Priority quote worklist. Keep source amounts and supplier evidence private; transfer only verified observations to controlled staging. |
| `Actualización 2026-11-16` | 20 populated worksheet rows | Change/update notes. Use for provenance and resolution history, not as an independent current catalog. |

## IDs, relationships, and integrity findings

The workbook defines stable external references: `producto_id` (`KAL-*`), `insumo_id` (`ING-*`), `preparacion_id` (`PREP-*`), `receta_id` (`REC-*`), `componente_id` (`COMP-*`), `precio_insumo_id` (`PINS-*`), `source_id` (`SRC-*`), `proveedor_id` (`PROV-*`), and `modificador_id` (`MOD-*`). Keep these in explicit external-reference fields or a staging map. Do not replace FloCafe's internal primary keys with them indiscriminately.

Intended reference paths are:

```text
Menu V4.producto_id ─────────────┐
                               ├─ Recetas.producto_o_preparacion_id
Preparaciones.preparacion_id ──┘       │
                                       └─ Componentes.receta_id
Insumos.insumo_id ──────────────────────┐
Preparaciones.preparacion_id ────────────┼─ Componentes.componente_id_ref
Menu V4.producto_id ────────────────────┘
Insumos.insumo_id ───────────────────────── Precios insumo.insumo_id
Fuentes.source_id ───────────────────────── Source/evidence references
Menu V4.producto_id ───────────────────────── Precios canal.producto_id
```

Checks against the normalized sheets found no duplicate IDs across the nine entity ID columns listed above, no missing recipe-to-product/preparation references, no missing component-to-recipe references, and no component target that fails to match an ingredient, preparation, or product ID. This validates referential shape only; it does not validate whether a component association is semantically correct. Of 81 recipes, 58 have no component rows and 23 have at least one candidate component row. All 70 component rows lack both quantity and unit. All 81 recipes are marked `NO IMPORTAR`.

All 15 preparation records lack a numeric measured output yield. Of the 45 input-price rows, all lack at least one of supplier, date, pack quantity, price, or evidence. All 272 channel-price rows have no approved price. The supply sheet uses nine distinct unit labels: `kg`, `g`, `ml`, `L`, `pieza`, `paquete`, `Presentación por definir`, `Presentación por cotizar`, and `mL`. `pieza` can map to FloCafe `each` and case can be normalized for `L`/`mL`; the package/presentation labels have no conversion value and cannot map to a base unit without more evidence.

Specific data issues to resolve before import:

- The menu has multiple apparent identity collisions or aliases: `KAL-REP-006` and `KAL-REP-022` both describe orange loaf; `KAL-REP-001`/`KAL-REP-024` overlap on oat and chocolate cookies; `KAL-REP-002`/`KAL-REP-025` overlap on butter cookies; and `KAL-REP-004`/`KAL-REP-026` overlap on moka cookies. `KAL-REP-005` and `KAL-REP-020` also distinguish an individual brownie from a generic brownie. The workbook does not establish which are duplicate SKUs, separate presentations, or a deliberate later catalog revision. Do not merge or activate by matching name alone.
- `KAL-DES-001` has a provisional chilaquiles portion and conflicting historical component quantities/units. The source itself instructs staff to weigh the actual serving. The same caution applies to the green version.
- `PREP-SAL-ROJ` and `PREP-SAL-VER` use gram output units while notes say historical records used liters; yield must be measured and the unit choice confirmed. Poultry, broth, beans, cooked meats, and dough preparations also need measured net yields.
- Fused preparation records use `ARCH-*` identifiers and say they are not operational IDs. Keep them as provenance, not active supplies.
- Ingredient names such as “leche vegetal”, chocolate/cocoa, cheese blend, peppers, fruit pulp, and commercial mixes are intentionally underspecified. They need a selected product/brand or a documented equivalent before cost or purchase conversion is trusted.
- Purchase units include `paquete`, `Presentación por definir`, `pzas`, and mixed commercial packs. FloCafe's supply-unit set is `each`, `g`, `kg`, `ml`, and `l`; package conversion needs explicit evidence and cannot be inferred from the label.
- Legacy recipe yields conflict with the sum of their reported outputs in several rows. Historical costs are not current purchase prices and are not suitable for costing a current recipe.
- Price rows with missing provider, observation date, pack quantity, evidence, or approval remain incomplete. Absence of a price is not zero; formula output is not approval. Provisional, public lookup, historical, and confirmed acquisition prices must remain different provenance states.
- Packaging inventory statements include estimates and “count required” states. Recipes do not establish on-hand stock.

## FloCafe correspondence matrix

The classifications below describe a candidate mapping to the code and database schema, not an implemented importer. “Requires validation” applies even where a physical field exists.

| Master entity / fields | FloCafe destination | Classification | Conditions and gaps |
| --- | --- | --- | --- |
| Supplies: name, base unit, active state | `supplies` | Direct with validation | `supplies.base_unit` supports `each`, `g`, `kg`, `ml`, `l`. Retain external `insumo_id` in a mapping/reference field. Do not import an unknown price as zero or stock as a real count. |
| Purchase unit and conversion factor | Purchasing line `planned_unit`; current conversion helpers | Conversion documented / extension for packs | Mass and volume conversions are supported within their dimensions. Cross-dimension and package conversions are rejected or unavailable. A reusable presentation with pack label, base quantity, provider, brand, and effective dates needs a model extension. |
| Category / subcategory | `categories` and `products.category_id` | Conversion documented | Category rows need stable internal IDs and a mapping table. The current supply schema does not have a category field; supply families need an extension or should remain source metadata until that exists. |
| Products: name, description, category, active state | `products` | Direct with validation | Keep `producto_id` external. Product `price` is required and defaults to zero in schema; an unpriced product must remain disabled in a staging/demo flow and must never be presented as a zero-price approved sale item. |
| Variants and package/presentation choices | `product_variants` | Conversion documented / validation required | FloCafe variants have their own price, online price, optional cost, SKU, stock settings, and recipe links. Use only for genuine sellable size/presentation variants. Do not encode modifier combinations or duplicate historical SKUs as variants without an identity decision. |
| Recipes: product, yield, component supply, quantity, unit | `recipes`, `recipe_items` | Direct after data validation | One sale recipe belongs to a product and recipe items refer to supplies. Positive quantities and supported units are required. Preserve `receta_id` and component IDs as external references. No incomplete master recipe is ready for this mapping. |
| Nested preparations and batch yield | `prep_recipes`, production recipe/order model | Extension / conversion requiring validation | Production recipes make a prepared supply an intermediate, but the import must define supply identity, measured batch yield, loss, unit, version, and how the sale recipe consumes it. Avoid unbounded recursive recipe expansion. |
| Inventory stock and opening balance | `supplies.stock_quantity`, `supply_movements` | Do not import from master | The workbook does not establish a physical count. Create DEMO-only synthetic balances in an isolated demo seed if needed, with explicit provenance. Never infer balances from recipes or reported packaging. |
| Inventory movement history | `supply_movements` | Do not import as current movements | Historical recipe quantities or price observations are not stock movements. An authorized opening count needs a dated count and attributable actor in the target store. |
| Historical / confirmed input prices | `purchasing_price_observations` | Conversion documented with validation | FloCafe records acquisition observations with amount, observed quantity/unit, normalized cost, supplier, brand, effective/recorded timestamps, source, and actor. The master price row needs evidence, source ID, status, and date reconciled. Historical costs should retain a historical source classification and must not be relabeled as confirmed acquisition. |
| Supplier and brand master | Purchasing line text fields and price observations | Extension | FloCafe stores supplier/brand strings on a line/observation; it has no normalized supplier or brand master with IDs, contacts, terms, or provider-specific presentations. Keep master IDs externally and defer master-data UX until deduplication is decided. |
| Purchase list | `purchasing_lists`, `purchasing_list_lines` | Direct with conversion / extension for reusable template | Lists already reference existing supplies and include planned quantity/unit, supplier/brand, optional reference price, date/source, and acquisition status. The reviewed routes do not expose a reusable saved-template/clone contract. Distinguish base need from commercial pack count in an extension. |
| Modifiers: option, applicable products, dose, charge | `addon_groups`, `addons`, product links | Conversion with validation / extension | Option and group fit conceptually; import only after required/optional selection, combinability, dose, price, tax, and inventory deduction rules are agreed. A modifier's amount/unit and status are not all represented by an add-on price. |
| Prices by channel | `products.price`; variant `price` / `online_price` | Extension for channel matrix; do not import current values | Current schema has a general product price and a separate online price, not arbitrary per-channel prices/commission terms. The master matrix has no approved values. Do not map suggested/formula values into sale prices. |
| Approval, historical, pending, candidate, DEMO states | No complete catalog lifecycle field | Extension / validation required | `is_active` is not a substitute for the workbook's approval states. Preserve source state and review evidence in staging/import metadata; define explicit activation gates. |

The relevant current schema is defined in [`main/db.ts`](../../main/db.ts): supplies and recipe tables in migration 88, product variants in the product schema/migrations, production preparations in migrations 126–128, and purchasing/price-observation tables in migration 129. Behavior is implemented in [`main/services/recipes.ts`](../../main/services/recipes.ts), [`main/services/production.ts`](../../main/services/production.ts), [`main/services/purchasing.ts`](../../main/services/purchasing.ts), and [`main/routes/purchasing.ts`](../../main/routes/purchasing.ts). These files, not the workbook's proposed FloCafe maps, are the destination contract.

## Candidate data for a realistic demo

Use a separate, reproducible staging dataset or seed for `/tmp/flo-kalali-demo`; do not write into the existing demo without a separate authorization. Every synthetic field must carry a visible `DEMO` marker and provenance in the seed manifest. Do not copy private quote amounts into repository fixtures.

| Subset | Candidate records | Readiness |
| --- | --- | --- |
| Coffee and drinks | Espresso `KAL-BEB-001`, cortado `KAL-BEB-003`, americano `KAL-BEB-004`, cappuccino `KAL-BEB-005`, latte `KAL-BEB-006`, moka `KAL-BEB-007`, café de olla `KAL-BEB-008`, chocolate `KAL-BEB-009`, tea `KAL-BEB-021`; supplies `ING-CAF`, `ING-LEC-ENT`, `ING-LEC-DES`, `ING-CHO`, `ING-AZU`, and water only when its use and unit are specified. | Menu rows marked regular provide catalog candidates. Recipe doses and commercial prices still need approval; use synthetic demo-only prices if a sale flow must be exercised. |
| Bread and baking | `KAL-PAN-001`, `KAL-PAN-003`, `KAL-PAN-004`, `KAL-PAN-006`, `KAL-PAN-007`; `ING-HAR-BLA`, `ING-HAR-INT`, `ING-LEV`, `ING-MANT`, `ING-AZU`, `ING-MAS-MAD`. | Product candidates are marked regular, but recipe yield conflicts and missing/current costs block production activation and real costing. |
| Dairy and shared ingredients | `ING-LEC-ENT`, `ING-LEC-DES`, `ING-QUES-FRE`, `ING-QUES-GR`, `ING-CRE`, `ING-MANT`, `ING-HUE`, `ING-CHO`, `ING-TOM`, `ING-CEB`, `ING-POL-ENT`, `ING-FRI`, `ING-CAF`. | Useful as a shared supply catalog. Brand/specification and unit cost remain pending where the master says so. Do not create opening quantities from recipe demand. |
| Molletes and chilaquiles | Molletes base `KAL-DES-007`; chilaquiles `KAL-DES-001` and `KAL-DES-002`; candidate components include bread, beans, tomato/tomatillo, chiles, onion, cheese, cream, and totopos. | Product identity may be staged, but recipe quantities are not importable. The chilaquiles source records conflicting quantities. Keep recipes disabled until measured and signed off. Do not create legacy chicken/chorizo SKUs where the master says they are modifier/history records. |
| Priority purchasing | Select the `Insumos` IDs explicitly named by `Cotización prioritaria` only after linking each worklist line to a single stable `insumo_id`. | Good for demonstrating list creation with existing supplies. Quote observations remain private and pending until provider, date, pack size, price, unit conversion, and evidence are complete. |

Separate seed fields into four provenance classes: **confirmed master** (identity/state only, not a claim of operational approval), **provisional DEMO** (synthetic amount or stock, visibly labelled), **historical** (read-only provenance, never activated), and **pending/excluded** (not imported). The source has no verified stock balance. Do not activate any incomplete recipe or create a sale with unapproved commercial pricing.

## Purchasing and thermal checklist proposal

The purchasing screen already creates lists from existing supplies, captures a planned quantity/unit and optional supplier, brand, and reference price, records actual acquisition data, shows latest price date, and queues acquisition/not-found operations in an IndexedDB outbox for offline synchronization. The API persists acquisitions and price observations with idempotency, actor attribution, and correction history. Preserve these offline and audit properties.

The supplied mobile captures show a spacious list index and a long thermal checklist with repeated supplier, brand, and reference-price lines. The inventory mobile capture also shows a table whose rightmost unit-cost column is clipped at the viewport. Recommended small changes, in order:

1. **Save a habitual list.** Add a “save as reusable” action when a list is created or edited, then offer named templates for coffee, baking, dairy, and weekly produce. Templates should reference supply IDs, not copied names. An offline-created list must remain queued and sync as it does today; template edits can be synchronized separately.
2. **Separate need from package.** Keep planned need in the supply's base-compatible unit, and select a commercial presentation such as `1 bag × 5 kg` or `6 × 1 L`. Store pack label, base quantity per pack, supplier/brand, and effective interval. Show both the need and suggested pack count; preserve actual purchased quantity separately. Never infer a pack conversion from `paquete` alone.
3. **Show price provenance.** For each supply show amount, normalized unit cost, observed date, supplier, brand, and source/status. Label an unapproved master quote as pending; label demo values `DEMO`. Show “no price recorded” instead of zero. Keep the current reference and confirmed purchase observation visually distinct.
4. **Add useful grouping and order.** Allow sorting by supply name and grouping by a small curated purchasing family. The workbook has families but the current `supplies` model does not; store family metadata only after an explicit schema mapping. Allow users to pin a practical list order without changing stock semantics.
5. **Tighten mobile rows.** Replace each full-height card with a compact row showing item, needed amount, pack choice, and state. Put price provenance on a secondary expandable line; keep sync/conflict status and large acquisition action visible. The inventory table should switch to stacked fields or horizontal scroll with a visible cost label instead of clipping.
6. **Simplify purchase capture.** Offer a fast “received as planned” action when quantity, price, and supplier are known; open a short correction form only for changes. Keep required price validation when no reference exists, and retain partial receipt, not-found, conflict, and retry paths.
7. **Compact thermal output.** Keep the 58/80 mm choices and printer fallback. Print one checkbox and item/needed amount per primary line; use one compact secondary line for pack, supplier, and a dated reference price. Add pending-only and sort/group controls. Omit optional metadata when blank and shorten labels without dropping quantity/unit or price provenance. Test both ESC/POS and browser print with long Spanish names, Unicode, and width limits.

The observed printer builder is [`frontend/src/lib/purchasing/shopping-checklist-print.ts`](../../frontend/src/lib/purchasing/shopping-checklist-print.ts); its caller and options are in `frontend/src/app/(dashboard)/purchasing/page.tsx`. The outbox is in [`frontend/src/lib/purchasing/offline-store.ts`](../../frontend/src/lib/purchasing/offline-store.ts) and [`frontend/src/lib/purchasing/offline-sync.ts`](../../frontend/src/lib/purchasing/offline-sync.ts). This is a proposal only; C4 has not been implemented.

## Recommended model changes

Implement only after field mapping and business decisions are approved:

- Add an import/staging registry for `(source_system, source_entity, external_id)`, source workbook/version fingerprint, source row, source status, import batch, validation result, and internal target ID. Make external ID uniqueness scoped by source entity; keep it separate from FloCafe keys.
- Add an explicit approval lifecycle for product, recipe, component, price observation, and channel price records. Preserve pending, provisional, historical, and excluded states; activation should require the relevant validations.
- Add normalized supply family and optional supplier/brand identities only if staff need cross-list selection/reporting. Retain free-text acquisition snapshots for historical truth.
- Add purchase presentations linked to a supply, with pack description, base quantity, compatible unit, supplier/brand, price provenance, and effective dates. Validate dimensional conversions and pack quantities on the backend.
- Add reusable purchasing list templates that reference supplies and default quantities/presentations. Keep user-created purchase lists and outbox operations separate from templates.
- Only add a channel-price table if multiple channel prices and their approval/history are an actual requirement. Keep commission and fee assumptions separate from approved sell prices.
- For nested preparations, specify prepared-supply identity, recipe version, batch yield, waste/yield observations, and snapshot behavior before importing. FloCafe's production model should not flatten an unbounded graph.

## Reproducible reconciliation

The source workbook is intentionally not checked in. A future preparer should point a read-only validator at a private copy and produce a sanitized report containing counts, field names, ID/reference violations, missing quantity/unit counts, status counts, and a source hash. The validator must not emit quote amounts or contact data and must not write to the workbook. Do not export normalized data into operational paths.

The reviewed structural checks were:

1. Count populated records after each sheet's header, keeping title/instruction rows separate.
2. Check uniqueness of product, supply, preparation, recipe, component, input-price, source, supplier, and modifier IDs within their own entity.
3. Resolve recipe targets to a product or preparation; component recipe references to a recipe; component targets to a product, preparation, or ingredient; and input prices to an ingredient.
4. Validate unit tokens, conversion factors, positive recipe quantities, component completeness, preparation yields, and status/importability before staging.
5. Compare overlapping product identities and historical rows by ID and provenance, never by name alone.
6. Confirm each price has date, supplier, pack quantity/unit, evidence/source, and approval class. Keep a blank, formula, provisional value, historical cost, and confirmed acquisition as distinct states.
7. Generate an import preview with external IDs and internal-ID assignments, then require review before any write.

The normalized reference check found no duplicate IDs or dangling references in the checked sheets. It found 58 of 81 recipes without component rows, 70 of 70 component rows missing quantity and unit, 15 of 15 preparation records without a measured numeric yield, 45 of 45 input-price rows missing at least one required evidence field, and 272 of 272 channel rows without an approved price. All 81 recipes carry a `NO IMPORTAR` status. Those outcomes are not a pass for import; they establish that IDs alone are not sufficient readiness evidence.

<!-- docs:policy-allow: implementation-plan -->

## Implementation sequence

1. Agree on product identity collisions, preparation units/yields, modifier ownership, and which statuses mean approved.
2. Complete the supplier and purchase-presentation mapping, including conversion evidence and quote privacy handling.
3. Build a read-only validator and sanitized staging export with source-to-target external-ID mapping; review its preview against this matrix.
4. Implement lifecycle/traceability and presentation/template model changes with forward migrations and isolated fresh/upgrade database coverage.
5. Implement a repeatable, idempotent staging import that defaults products and recipes to inactive and writes no opening stock or unapproved price.
6. Populate an isolated DEMO dataset with visibly synthetic price/stock fields and run manual review before replacing fictitious demo records.
7. Improve purchasing templates, compact mobile rows, reference provenance display, quick acquisition capture, and thermal layout while retaining outbox retry/conflict behavior.
8. Only after separate approval, prepare an operational import plan with backup, dry-run diff, authorization, review, and recovery procedure. No operational import is authorized by this proposal.

## Next implementation mission

Implement a read-only V4.3 workbook validator and sanitized staging export first. It should preserve external IDs and source/status provenance, report duplicate and dangling references, distinguish confirmed/provisional/historical/pending/excluded records, and reject incomplete recipe components without inventing values. Follow it with an isolated DEMO seed that uses only selected catalog identities, marks synthetic prices and quantities as `DEMO`, leaves recipes inactive until approved, and never changes the existing demo database. Keep the purchasing UX work as a separate, focused mission after presentation and reusable-list behavior are agreed.
