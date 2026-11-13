'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import api, { createOperationReference } from '@/lib/api';
import { tenantCan } from '@/lib/permissions';
import { useAuthStore } from '@/store/auth';
import { useTranslations } from 'use-intl';
import { Plus, ArrowLeft, ShoppingBasket, Check, MoreHorizontal, LoaderCircle, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/button';
import { ShoppingListCard } from '@/components/purchasing/ShoppingListCard';
import { Badge } from '@/components/ui/badge';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { useFormatDate } from '@/hooks/useFormatDate';
import { useFormatNumber } from '@/hooks/useFormatNumber';

const UNITS = ['each', 'g', 'kg', 'ml', 'l'] as const;
type Unit = (typeof UNITS)[number];
type Supply = { id: string; name: string; base_unit: Unit; is_active: number };
type PriceObservation = {
  supply_id: string; amount: number; observed_quantity: number; unit: Unit; effective_at: string;
};
type PurchasingLine = {
  id: string; supply_id: string; supply_name: string; base_unit: Unit;
  planned_quantity: number; planned_unit: Unit; planned_supplier: string | null; planned_brand: string | null;
  reference_price: number | null; reference_unit: Unit | null; reference_observed_at: string | null;
  purchased_quantity: number; purchased_unit: Unit | null; actual_supplier: string | null; actual_brand: string | null;
  actual_price: number | null; status: 'pending' | 'acquired' | 'not_found'; version: number;
};
type ShoppingList = { id: string; name: string; status: 'open' | 'closed'; created_at: string; lines?: PurchasingLine[]; line_count?: number };
type DraftLine = {
  supply: Supply; quantity: string; unit: Unit; supplier: string; brand: string; referencePrice: string;
};
type Operation = { signature: string; key: string };

function convertQuantity(quantity: number, from: Unit, to: Unit): number | null {
  const dimensions: Record<Unit, 'count' | 'mass' | 'volume'> = {
    each: 'count', g: 'mass', kg: 'mass', ml: 'volume', l: 'volume',
  };
  const factors: Record<Unit, number> = { each: 1, g: 1, kg: 1000, ml: 1, l: 1000 };
  if (dimensions[from] !== dimensions[to]) return null;
  return (quantity * factors[from]) / factors[to];
}

function remainingQuantity(line: PurchasingLine): number {
  const planned = convertQuantity(line.planned_quantity, line.planned_unit, line.base_unit);
  if (planned === null) return line.planned_quantity;
  const remainingBase = Math.max(0, planned - Number(line.purchased_quantity || 0));
  return convertQuantity(remainingBase, line.base_unit, line.planned_unit) ?? line.planned_quantity;
}

export default function PurchasingPage() {
  const { currentTenant } = useAuthStore();
  const t = useTranslations('inventory');
  const tCommon = useTranslations('common');
  const tNav = useTranslations('nav');
  const fmt = useFormatCurrency();
  const fmtNum = useFormatNumber();
  const { formatDate } = useFormatDate();
  const canPurchase = tenantCan(currentTenant, 'supplies.manage');
  const [lists, setLists] = useState<ShoppingList[]>([]);
  const [supplies, setSupplies] = useState<Supply[]>([]);
  const [latestPrices, setLatestPrices] = useState<Record<string, PriceObservation>>({});
  const [activeList, setActiveList] = useState<ShoppingList | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [creating, setCreating] = useState(false);
  const [listName, setListName] = useState('');
  const [draftLines, setDraftLines] = useState<DraftLine[]>([]);
  const [selectedSupplyId, setSelectedSupplyId] = useState('');
  const [draftQuantity, setDraftQuantity] = useState('1');
  const [draftUnit, setDraftUnit] = useState<Unit>('each');
  const [savingList, setSavingList] = useState(false);
  const [savingLineId, setSavingLineId] = useState('');
  const [editingLine, setEditingLine] = useState<PurchasingLine | null>(null);
  const [actualQuantity, setActualQuantity] = useState('');
  const [actualUnit, setActualUnit] = useState<Unit>('each');
  const [actualPrice, setActualPrice] = useState('');
  const [actualSupplier, setActualSupplier] = useState('');
  const [actualBrand, setActualBrand] = useState('');
  const [showDone, setShowDone] = useState(false);
  const listOperationKey = useRef<string | null>(null);
  const lineOperations = useRef(new Map<string, Operation>());

  const refreshLists = useCallback(async () => {
    const { data } = await api.get('/purchasing/lists');
    setLists(data.lists || []);
  }, []);

  const openList = useCallback(async (listId: string) => {
    setActionError('');
    try {
      const { data } = await api.get(`/purchasing/lists/${encodeURIComponent(listId)}`);
      setActiveList(data.list);
    } catch {
      setActionError(t('loadFailed'));
    }
  }, [t]);

  const load = useCallback(async () => {
    if (!canPurchase) { setLoading(false); return; }
    setLoading(true);
    setLoadError('');
    try {
      const [supplyResponse, listResponse, priceResponse] = await Promise.all([
        api.get('/supplies'), api.get('/purchasing/lists'), api.get('/purchasing/prices/latest'),
      ]);
      setSupplies(supplyResponse.data.supplies || []);
      setLists(listResponse.data.lists || []);
      setLatestPrices(Object.fromEntries((priceResponse.data.observations || []).map((row: PriceObservation) => [row.supply_id, row])));
    } catch {
      setLoadError(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [canPurchase, t]);

  // Fetching server state is the synchronization boundary for this connected view.
  // eslint-disable-next-line react/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  const addDraftLine = () => {
    const supply = supplies.find((candidate) => candidate.id === selectedSupplyId);
    const quantity = Number(draftQuantity);
    if (!supply || !Number.isFinite(quantity) || quantity <= 0) return;
    if (draftLines.some((line) => line.supply.id === supply.id)) {
      toast.error(t('saveFailed'));
      return;
    }
    setDraftLines((current) => [...current, {
      supply, quantity: String(quantity), unit: draftUnit || supply.base_unit,
      supplier: '', brand: '', referencePrice: '',
    }]);
    setSelectedSupplyId('');
    setDraftQuantity('1');
    setDraftUnit('each');
  };

  const saveList = async () => {
    if (!listName.trim() || draftLines.length === 0) {
      setActionError(t('saveFailed'));
      return;
    }
    const key = listOperationKey.current || createOperationReference();
    if (!key) { setActionError(t('saveFailed')); return; }
    listOperationKey.current = key;
    setSavingList(true);
    setActionError('');
    try {
      const { data } = await api.post('/purchasing/lists', {
        idempotency_key: key,
        name: listName.trim(),
        lines: draftLines.map((line) => ({
          supply_id: line.supply.id,
          planned_quantity: Number(line.quantity),
          planned_unit: line.unit,
          ...(line.supplier.trim() && { supplier: line.supplier.trim() }),
          ...(line.brand.trim() && { brand: line.brand.trim() }),
          ...(line.referencePrice !== '' && { reference_price: Number(line.referencePrice), reference_unit: line.unit }),
        })),
      });
      listOperationKey.current = null;
      setCreating(false);
      setListName('');
      setDraftLines([]);
      setActiveList(data.list);
      await refreshLists();
    } catch (error: unknown) {
      setActionError(errorMessage(error, t('versionConflict'), t('saveFailed')));
    } finally { setSavingList(false); }
  };

  const startDetails = (line: PurchasingLine) => {
    setEditingLine(line);
    setActualQuantity(fmtNum(remainingQuantity(line)));
    setActualUnit(line.planned_unit);
    setActualPrice(line.purchased_quantity > 0 ? '' : line.reference_price === null ? '' : String(line.reference_price));
    setActualSupplier(line.actual_supplier ?? line.planned_supplier ?? '');
    setActualBrand(line.actual_brand ?? line.planned_brand ?? '');
    setActionError('');
  };

  const submitAcquisition = async (line: PurchasingLine, values?: {
    quantity?: number; unit?: Unit; price?: number; supplier?: string | null; brand?: string | null;
  }) => {
    const payload = {
      expected_version: line.version,
      ...(values?.quantity !== undefined && { quantity: values.quantity }),
      ...(values?.unit !== undefined && { unit: values.unit }),
      ...(values?.price !== undefined && { price: values.price }),
      ...(values?.supplier !== undefined && { supplier: values.supplier }),
      ...(values?.brand !== undefined && { brand: values.brand }),
    };
    const signature = JSON.stringify({ lineId: line.id, payload });
    const previous = lineOperations.current.get(line.id);
    const key = previous?.signature === signature ? previous.key : createOperationReference();
    if (!key) { setActionError(t('saveFailed')); return; }
    lineOperations.current.set(line.id, { signature, key });
    setSavingLineId(line.id);
    setActionError('');
    try {
      const { data } = await api.post(`/purchasing/lines/${encodeURIComponent(line.id)}/acquisitions`, {
        ...payload, idempotency_key: key,
      });
      lineOperations.current.delete(line.id);
      setEditingLine(null);
      setActiveList((current) => current ? {
        ...current,
        lines: current.lines?.map((item) => item.id === line.id ? {
          ...item,
          status: data.acquisition.status,
          purchased_quantity: data.acquisition.purchasedQuantity,
          purchased_unit: item.base_unit,
          version: data.acquisition.version,
          actual_price: values?.price ?? item.reference_price,
          actual_supplier: values?.supplier ?? item.planned_supplier,
          actual_brand: values?.brand ?? item.planned_brand,
        } : item),
      } : current);
      await refreshLists();
    } catch (error: unknown) {
      const code = (error as { response?: { data?: { code?: string }; status?: number } })?.response?.data?.code;
      if (code === 'price_required') {
        startDetails(line);
      } else if ((error as { response?: { status?: number } })?.response?.status === 409) {
        await openList(activeList!.id);
        setActionError(t('versionConflict'));
      } else {
        setActionError(t('saveFailed'));
      }
    } finally { setSavingLineId(''); }
  };

  const confirmDetails = async () => {
    if (!editingLine) return;
    const quantity = Number(actualQuantity);
    const price = Number(actualPrice);
    if (!Number.isFinite(quantity) || quantity <= 0 || actualPrice.trim() === '' || !Number.isFinite(price) || price < 0) {
      setActionError(t('saveFailed'));
      return;
    }
    await submitAcquisition(editingLine, {
      quantity, unit: actualUnit, price,
      supplier: actualSupplier.trim() || null, brand: actualBrand.trim() || null,
    });
  };

  const markNotFound = async (line: PurchasingLine) => {
    const signature = JSON.stringify({ action: 'not_found', lineId: line.id, version: line.version });
    const previous = lineOperations.current.get(line.id);
    const key = previous?.signature === signature ? previous.key : createOperationReference();
    if (!key) { setActionError(t('saveFailed')); return; }
    lineOperations.current.set(line.id, { signature, key });
    setSavingLineId(line.id);
    setActionError('');
    try {
      await api.post(`/purchasing/lines/${encodeURIComponent(line.id)}/not-found`, {
        expected_version: line.version, idempotency_key: key,
      });
      lineOperations.current.delete(line.id);
      setActiveList((current) => current ? {
        ...current, lines: current.lines?.map((item) => item.id === line.id ? { ...item, status: 'not_found', version: item.version + 1 } : item),
      } : current);
      await refreshLists();
    } catch (error: unknown) {
      if ((error as { response?: { status?: number } })?.response?.status === 409) {
        await openList(activeList!.id);
        setActionError(t('versionConflict'));
      } else setActionError(t('saveFailed'));
    } finally { setSavingLineId(''); }
  };

  const lastPrices = useMemo(() => latestPrices, [latestPrices]);
  const activeLines = (activeList?.lines || []).filter((line) => line.status === 'pending');
  const doneLines = (activeList?.lines || []).filter((line) => line.status !== 'pending');
  const visibleLines = showDone ? doneLines : activeLines;

  if (!canPurchase) return <div className="p-6 text-center text-muted-foreground">{t('noAccess')}</div>;

  return (
    <main className="mx-auto w-full max-w-5xl pb-24">
      <header className="mb-5 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          {activeList && <Button variant="ghost" size="icon" aria-label={tCommon('back')} className="size-11 shrink-0" onClick={() => { setActiveList(null); setEditingLine(null); setActionError(''); }}><ArrowLeft className="size-5" /></Button>}
          <div className="min-w-0">
            <h1 className="truncate text-xl font-bold text-foreground sm:text-2xl">{activeList?.name || tNav('purchasing')}</h1>
            {!activeList && <p className="mt-1 text-sm text-muted-foreground">{t('shoppingLists')}</p>}
          </div>
        </div>
        {!activeList && !creating && <Button className="min-h-11 shrink-0" onClick={() => { setCreating(true); setActionError(''); }}><Plus className="me-1 size-4" />{t('newShoppingList')}</Button>}
      </header>

      {actionError && <div role="alert" className="mb-4 flex items-start justify-between gap-3 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-3 text-sm text-destructive"><span>{actionError}</span><button type="button" className="rounded p-1" aria-label={tCommon('close')} onClick={() => setActionError('')}><X className="size-4" /></button></div>}
      {loadError && <div role="alert" className="mb-4 flex items-center justify-between rounded-lg border border-destructive/40 p-3 text-sm text-destructive"><span>{loadError}</span><Button size="sm" variant="outline" onClick={() => void load()}>{tCommon('update')}</Button></div>}

      {creating ? (
        <section className="space-y-4 rounded-xl border border-border bg-card p-4 sm:p-6">
          <div className="flex items-center justify-between gap-3"><h2 className="text-lg font-semibold">{t('newShoppingList')}</h2><Button variant="ghost" size="icon" className="size-11" aria-label={tCommon('close')} onClick={() => { setCreating(false); setActionError(''); }}><X className="size-5" /></Button></div>
          <label className="block text-sm font-medium">{tCommon('namePlaceholder')}<input autoFocus value={listName} onChange={(event) => setListName(event.target.value)} maxLength={200} className="mt-1.5 h-11 w-full rounded-lg border border-border bg-background px-3 text-base" /></label>
          <div className="rounded-lg border border-border p-3 sm:p-4">
            <h3 className="mb-3 text-sm font-semibold">{t('tabSupplies')}</h3>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_7rem_7rem_auto]">
              <select aria-label={t('supply')} value={selectedSupplyId} onChange={(event) => { const supply = supplies.find((item) => item.id === event.target.value); setSelectedSupplyId(event.target.value); if (supply) setDraftUnit(supply.base_unit); }} className="h-11 min-w-0 rounded-lg border border-border bg-background px-3 text-base">
                <option value="">{t('supply')}</option>{supplies.filter((supply) => !draftLines.some((line) => line.supply.id === supply.id)).map((supply) => <option key={supply.id} value={supply.id}>{supply.name} ({supply.base_unit})</option>)}
              </select>
              <input aria-label={t('plannedQuantity')} type="number" min="0.00000001" step="any" value={draftQuantity} onChange={(event) => setDraftQuantity(event.target.value)} className="h-11 rounded-lg border border-border bg-background px-3 text-base" />
              <select aria-label={t('baseUnit')} value={draftUnit} onChange={(event) => setDraftUnit(event.target.value as Unit)} className="h-11 rounded-lg border border-border bg-background px-3 text-base">{UNITS.map((unit) => <option key={unit} value={unit}>{unit}</option>)}</select>
              <Button type="button" variant="secondary" className="h-11" disabled={!selectedSupplyId} onClick={addDraftLine}><Plus className="me-1 size-4" />{tCommon('add')}</Button>
            </div>
            {draftLines.length > 0 && <ul className="mt-3 divide-y divide-border">{draftLines.map((line) => <li key={line.supply.id} className="flex items-center justify-between gap-3 py-2"><span className="min-w-0 truncate text-sm">{line.supply.name} · {fmtNum(Number(line.quantity))} {line.unit}</span><button type="button" className="rounded p-2 text-muted-foreground hover:text-destructive" aria-label={`${tCommon('remove')} ${line.supply.name}`} onClick={() => setDraftLines((items) => items.filter((item) => item.supply.id !== line.supply.id))}><X className="size-4" /></button></li>)}</ul>}
          </div>
          {draftLines.map((line) => <details key={`details-${line.supply.id}`} className="rounded-lg border border-border px-3 py-2"><summary className="min-h-8 cursor-pointer py-1 text-sm text-muted-foreground">{line.supply.name} · {tCommon('edit')}</summary><div className="grid grid-cols-1 gap-3 py-3 sm:grid-cols-3"><Field label={t('supplier')} value={line.supplier} onChange={(value) => setDraftLines((items) => items.map((item) => item.supply.id === line.supply.id ? { ...item, supplier: value } : item))} /><Field label={t('brand')} value={line.brand} onChange={(value) => setDraftLines((items) => items.map((item) => item.supply.id === line.supply.id ? { ...item, brand: value } : item))} /><label className="text-sm">{t('referencePrice')}<input type="number" min="0" step="any" value={line.referencePrice} onChange={(event) => setDraftLines((items) => items.map((item) => item.supply.id === line.supply.id ? { ...item, referencePrice: event.target.value } : item))} placeholder="" className="mt-1.5 h-11 w-full rounded-lg border border-border bg-background px-3 text-base" /></label></div></details>)}
          {actionError && <p role="alert" className="text-sm text-destructive">{actionError}</p>}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><Button variant="outline" className="min-h-11" onClick={() => { setCreating(false); setActionError(''); }}>{tCommon('cancel')}</Button><Button className="min-h-11" disabled={savingList || draftLines.length === 0} onClick={() => void saveList()}>{savingList && <LoaderCircle className="me-2 size-4 animate-spin" />}{savingList ? tCommon('saving') : tCommon('create')}</Button></div>
        </section>
      ) : activeList ? (
        <section className="space-y-4">
          <div className="grid grid-cols-2 gap-2">
            <Button variant={!showDone ? 'default' : 'outline'} className="min-h-11 justify-between" onClick={() => { setShowDone(false); setEditingLine(null); }}>{tCommon('active')}<Badge variant="secondary">{activeLines.length}</Badge></Button>
            <Button variant={showDone ? 'default' : 'outline'} className="min-h-11 justify-between" onClick={() => { setShowDone(true); setEditingLine(null); }}>{tCommon('done')}<Badge variant="secondary">{doneLines.length}</Badge></Button>
          </div>
          {visibleLines.length === 0 ? <div className="rounded-xl border border-dashed border-border bg-card px-4 py-12 text-center text-sm text-muted-foreground">{t('emptyShoppingLists')}</div> : <div className="space-y-3">{visibleLines.map((line) => {
            const lastPrice = lastPrices[line.supply_id];
            return <article key={line.id} className="rounded-xl border border-border bg-card p-4 shadow-sm sm:p-5">
              <div className="flex items-start justify-between gap-3"><div className="min-w-0"><h2 className="text-base font-semibold">{line.supply_name}</h2><p className="mt-1 text-sm text-muted-foreground">{t('plannedQuantity')}: {fmtNum(line.planned_quantity)} {line.planned_unit}</p>{line.purchased_quantity > 0 && <p className="mt-1 text-sm text-muted-foreground">{t('purchasedQuantity')}: {fmtNum(line.purchased_quantity)} {line.purchased_unit || line.base_unit}</p>}</div><Badge variant={line.status === 'pending' ? 'outline' : 'secondary'} className="shrink-0">{line.status === 'pending' ? tCommon('active') : line.status === 'acquired' ? t('acquired') : t('markNotFound')}</Badge></div>
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">{line.reference_price !== null && <span>{t('referencePrice')}: {fmt(line.reference_price)} / {fmtNum(line.planned_quantity)} {line.planned_unit}{line.reference_observed_at ? ` · ${formatDate(line.reference_observed_at)}` : ''}</span>}{line.purchased_quantity > 0 && line.actual_price !== null && <span>{t('actualPrice')}: {fmt(line.actual_price)}</span>}{(line.actual_brand || line.planned_brand) && <span>{t('brand')}: {line.actual_brand || line.planned_brand}</span>}{(line.actual_supplier || line.planned_supplier) && <span>{t('supplier')}: {line.actual_supplier || line.planned_supplier}</span>}</div>
              {lastPrice && <p className="mt-2 text-xs text-muted-foreground">{t('lastPrice', { price: `${fmt(lastPrice.amount)} / ${fmtNum(lastPrice.observed_quantity)} ${lastPrice.unit}`, date: formatDate(lastPrice.effective_at) })}</p>}
              {line.status === 'pending' && <div className="mt-4 flex flex-col gap-2 sm:flex-row">{!showDone && <Button className="min-h-12 flex-1 text-base" disabled={savingLineId === line.id} onClick={() => line.reference_price !== null && line.purchased_quantity === 0 ? void submitAcquisition(line) : startDetails(line)}>{savingLineId === line.id ? <LoaderCircle className="me-2 size-4 animate-spin" /> : <Check className="me-2 size-4" />}{t('markAcquired')}</Button>}<Button variant="outline" className="min-h-12" disabled={savingLineId === line.id} onClick={() => startDetails(line)}>{tCommon('edit')}</Button>{!showDone && <Button variant="ghost" className="min-h-12" disabled={savingLineId === line.id} onClick={() => void markNotFound(line)}><MoreHorizontal className="me-2 size-4" />{t('markNotFound')}</Button>}</div>}
              {editingLine?.id === line.id && <div className="mt-4 space-y-3 rounded-lg border border-primary/30 bg-background p-3 sm:p-4"><h3 className="font-semibold">{t('markAcquired')}</h3><div className="grid grid-cols-1 gap-3 sm:grid-cols-2"><label className="text-sm">{t('plannedQuantity')}<input autoFocus type="number" min="0.00000001" step="any" value={actualQuantity} onChange={(event) => setActualQuantity(event.target.value)} className="mt-1.5 h-11 w-full rounded-lg border border-border bg-background px-3 text-base" /></label><label className="text-sm">{t('baseUnit')}<select value={actualUnit} onChange={(event) => setActualUnit(event.target.value as Unit)} className="mt-1.5 h-11 w-full rounded-lg border border-border bg-background px-3 text-base">{UNITS.map((unit) => <option key={unit}>{unit}</option>)}</select></label><label className="text-sm">{t('actualPrice')}<input type="number" min="0" step="any" value={actualPrice} onChange={(event) => setActualPrice(event.target.value)} className="mt-1.5 h-11 w-full rounded-lg border border-border bg-background px-3 text-base" /></label><Field label={t('supplier')} value={actualSupplier} onChange={setActualSupplier} /><Field label={t('brand')} value={actualBrand} onChange={setActualBrand} /></div><div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><Button variant="outline" className="min-h-11" onClick={() => setEditingLine(null)}>{tCommon('cancel')}</Button><Button className="min-h-11" disabled={savingLineId === line.id} onClick={() => void confirmDetails()}>{savingLineId === line.id && <LoaderCircle className="me-2 size-4 animate-spin" />}{tCommon('save')}</Button></div></div>}
            </article>;
          })}</div>}
        </section>
      ) : loading ? <div className="flex justify-center py-16 text-muted-foreground"><LoaderCircle className="size-6 animate-spin" /></div> : lists.length === 0 ? <div className="rounded-xl border border-dashed border-border bg-card px-4 py-16 text-center"><ShoppingBasket className="mx-auto size-8 text-muted-foreground" /><p className="mt-3 text-sm text-muted-foreground">{t('emptyShoppingLists')}</p><Button className="mt-4 min-h-11" onClick={() => setCreating(true)}><Plus className="me-1 size-4" />{t('newShoppingList')}</Button></div> : <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">{lists.map((list) => <ShoppingListCard key={list.id} name={list.name} lineCount={list.line_count || 0} lineCountLabel={t('shoppingLists')} createdAt={formatDate(list.created_at)} onSelect={() => void openList(list.id)} />)}</div>}
    </main>
  );
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <label className="text-sm">{label}<input value={value} onChange={(event) => onChange(event.target.value)} maxLength={200} className="mt-1.5 h-11 w-full rounded-lg border border-border bg-background px-3 text-base" /></label>;
}

function errorMessage(error: unknown, conflict: string, fallback: string): string {
  const status = (error as { response?: { status?: number } })?.response?.status;
  return status === 409 ? conflict : fallback;
}
