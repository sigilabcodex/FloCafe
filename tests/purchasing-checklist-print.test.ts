import assert from 'node:assert/strict';
import {
  buildShoppingChecklistHtml,
  type ShoppingChecklistLine,
} from '../frontend/src/lib/purchasing/shopping-checklist-print';

const lines: ShoppingChecklistLine[] = [
  {
    id: '1',
    supply_name: 'Harina de trigo',
    planned_quantity: 2.5,
    planned_unit: 'kg',
    status: 'pending',
    reference_price: '$45 / kg',
    planned_supplier: 'Molino Norte',
    planned_brand: 'Trigal',
  },
  {
    id: '2',
    supply_name: 'Leche entera',
    planned_quantity: 6,
    planned_unit: 'l',
    status: 'acquired',
    reference_price: '$29 / l',
  },
  {
    id: '3',
    supply_name: 'Sal fina para panificación con un nombre comercial muy largo',
    planned_quantity: 500,
    planned_unit: 'g',
    status: 'not_found',
  },
];
const defaults = {
  paperWidth: 58 as const,
  pendingOnly: false,
  showReferencePrices: false,
  showSupplierBrand: false,
  printedAt: new Date('2026-11-15T18:30:00.000Z'),
  timezone: 'America/Mexico_City',
  locale: 'es-MX',
};

const full = buildShoppingChecklistHtml('Compra semanal', 'list-abc12345', lines, defaults);
assert.match(full, /size:58mm auto/);
assert.match(full, /Kalali/);
assert.match(full, /Compra semanal/);
assert.match(full, /Harina de trigo/);
assert.match(full, /Leche entera/);
assert.match(full, /<span class="box">\[ \]<\/span>/);
assert.match(full, /2\.5 kg/);
assert.match(full, /500 g/);
assert.match(full, /3 · ABC12345/);
assert.match(full, /overflow-wrap:anywhere/);
assert.match(full, /color:#000/);
assert.doesNotMatch(full, /Molino Norte|Trigal|\$45/);

const pending = buildShoppingChecklistHtml('Compra semanal', 'list-abc12345', lines, {
  ...defaults,
  pendingOnly: true,
  showReferencePrices: true,
  showSupplierBrand: true,
});
assert.match(pending, /Harina de trigo/);
assert.doesNotMatch(pending, /Leche entera|Sal fina/);
assert.match(pending, /\$45 \/ kg/);
assert.match(pending, /Molino Norte/);
assert.match(pending, /Trigal/);
assert.match(pending, /1 · ABC12345/);

const wide = buildShoppingChecklistHtml('Vacía', 'empty', [], { ...defaults, paperWidth: 80 });
assert.match(wide, /size:80mm auto/);
assert.match(wide, /No items/);
assert.match(wide, /<div>0 · EMPTY<\/div>/);

const escaped = buildShoppingChecklistHtml(
  '<script>alert(1)</script>',
  'a',
  [{ ...lines[0], supply_name: '<b>Malta & café</b>' }],
  defaults,
);
assert.match(escaped, /&lt;script&gt;/);
assert.match(escaped, /&lt;b&gt;Malta &amp; café&lt;\/b&gt;/);
assert.doesNotMatch(escaped, /<script>|<b>Malta/);

console.log(
  'Purchasing checklist renderer: synthetic content, filtering, visibility, escaping, and both paper widths passed.',
);
