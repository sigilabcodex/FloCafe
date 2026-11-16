export type ShoppingChecklistLine = {
  id: string;
  supply_name: string;
  planned_quantity: number | string;
  planned_unit: string;
  status: 'pending' | 'acquired' | 'not_found';
  reference_price?: string | null;
  planned_supplier?: string | null;
  planned_brand?: string | null;
};

export type ShoppingChecklistOptions = {
  paperWidth: 58 | 80;
  pendingOnly: boolean;
  showReferencePrices: boolean;
  showSupplierBrand: boolean;
  printedAt?: Date;
  timezone?: string;
  locale?: string;
  labels?: { supplier: string; brand: string; reference: string };
};

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (char) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[char]!,
  );
}

function printDate(date: Date, locale?: string, timezone?: string): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
      ...(timezone ? { timeZone: timezone } : {}),
    }).format(date);
  } catch {
    return date.toLocaleString();
  }
}

/** Render a text-first, thermal-width checklist for FloCafe's existing browser print transport. */
export function buildShoppingChecklistHtml(
  name: string,
  listId: string,
  lines: ShoppingChecklistLine[],
  options: ShoppingChecklistOptions,
): string {
  const selected = options.pendingOnly ? lines.filter((line) => line.status === 'pending') : lines;
  const width = options.paperWidth;
  const labels = options.labels ?? { supplier: 'Supplier', brand: 'Brand', reference: 'Reference' };
  const items = selected.length
    ? selected
        .map((line) => {
          const details = [
            options.showSupplierBrand && line.planned_supplier
              ? `${labels.supplier}: ${line.planned_supplier}`
              : '',
            options.showSupplierBrand && line.planned_brand
              ? `${labels.brand}: ${line.planned_brand}`
              : '',
            options.showReferencePrices && line.reference_price != null
              ? `${labels.reference}: ${line.reference_price}`
              : '',
          ].filter(Boolean);
          return `<article class="item"><div class="item-row"><span class="box">[ ]</span><span class="name">${escapeHtml(line.supply_name)}</span></div><div class="quantity">${escapeHtml(line.planned_quantity)} ${escapeHtml(line.planned_unit)}</div>${details.map((detail) => `<div class="detail">${escapeHtml(detail)}</div>`).join('')}</article>`;
        })
        .join('')
    : '<p class="empty">No items</p>';
  const shortId = listId
    .replace(/[^a-z0-9]/gi, '')
    .slice(-8)
    .toUpperCase();

  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(name)}</title><style>
    @page{size:${width}mm auto;margin:0}*{box-sizing:border-box}html,body{margin:0;padding:0;background:#fff;color:#000}
    body{width:${width}mm;max-width:${width}mm;padding:3mm 3.5mm;font:12px/1.3 'Courier New',monospace;font-weight:600}
    header{text-align:center;border-bottom:1px dashed #000;padding:0 0 2.5mm;margin-bottom:2mm}h1{font-size:15px;line-height:1.2;margin:1mm 0;overflow-wrap:anywhere}
    .brand{font-size:14px;font-weight:700}.meta{font-size:10px;overflow-wrap:anywhere}.item{padding:2mm 0;border-bottom:1px dotted #777;break-inside:avoid;page-break-inside:avoid}
    .item-row{display:flex;align-items:flex-start;gap:2mm}.box{flex:0 0 auto;font-size:14px;line-height:1.1}.name{min-width:0;overflow-wrap:anywhere;word-break:normal}.quantity{margin:1mm 0 0 10mm;white-space:nowrap;font-weight:700}
    .detail{margin:1mm 0 0 10mm;font-size:10px;overflow-wrap:anywhere}.empty{text-align:center;padding:5mm 0}.footer{padding-top:2mm;text-align:center;font-size:10px}.notes{height:10mm;margin-top:2mm;border-bottom:1px solid #000}
    @media print{html,body{width:${width}mm!important;max-width:${width}mm!important;color:#000!important;background:#fff!important;-webkit-print-color-adjust:exact;print-color-adjust:exact}}
  </style></head><body><header><div class="brand">Kalali</div><h1>${escapeHtml(name)}</h1><div class="meta">${escapeHtml(printDate(options.printedAt ?? new Date(), options.locale, options.timezone))}</div></header>
  <main>${items}</main><footer class="footer"><div>${selected.length}${shortId ? ` · ${shortId}` : ''}</div><div class="notes"></div></footer></body></html>`;
}
