'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import api, { createOperationReference } from '@/lib/api';
import { tenantCan } from '@/lib/permissions';
import { useAuthStore } from '@/store/auth';
import { flushPurchasingOutbox } from '@/lib/purchasing/offline-sync';
import {
  getOfflineList,
  getOfflineLists,
  getOfflineOperations,
  getPurchasingScope,
  queueOfflineOperation,
  resolveOfflineConflict,
  saveDownloadedList,
  type OfflineList,
  type OfflineOperation,
  type PurchasingScope,
} from '@/lib/purchasing/offline-store';
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
  syncState?: 'pending' | 'syncing' | 'conflict'; localOperationId?: string;
};
type ShoppingList = { id: string; name: string; status: 'open' | 'closed'; created_at: string; lines?: PurchasingLine[]; line_count?: number };
type DraftLine = {
  supply: Supply; quantity: string; unit: Unit; supplier: string; brand: string; referencePrice: string;
};

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
  const { currentTenant, user } = useAuthStore();
  const t = useTranslations('inventory');
  const tCommon = useTranslations('common');
  const tNav = useTranslations('nav');
  const fmt = useFormatCurrency();
  const fmtNum = useFormatNumber();
  const { formatDate } = useFormatDate();
  const canPurchase = tenantCan(currentTenant, 'supplies.manage');
  const scope = useMemo<PurchasingScope | null>(() => currentTenant && user
    ? getPurchasingScope(currentTenant.id, user.id)
    : null, [currentTenant, user]);
  const [lists, setLists] = useState<ShoppingList[]>([]);
  const [supplies, setSupplies] = useState<Supply[]>([]);
  const [latestPrices, setLatestPrices] = useState<Record<string, PriceObservation>>({});
  const [activeList, setActiveList] = useState<ShoppingList | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [storageError, setStorageError] = useState(false);
  const [serverReachable, setServerReachable] = useState(true);
  const [browserOnline, setBrowserOnline] = useState(typeof navigator === 'undefined' || navigator.onLine);
  const [operations, setOperations] = useState<OfflineOperation[]>([]);
  const [syncing, setSyncing] = useState(false);
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
  const activeListId = useRef<string | null>(null);
  const refreshLocal = useCallback(async (listId?: string) => {
    if (!scope) return;
    try {
      const [cachedLists, pending] = await Promise.all([getOfflineLists(scope), getOfflineOperations(scope)]);
      setLists(cachedLists as ShoppingList[]);
      setOperations(pending);
      setStorageError(false);
      if (listId) {
        const cached = await getOfflineList(scope, listId);
        if (cached.list) setActiveList(cached.list as ShoppingList);
      }
    } catch {
      setStorageError(true);
    }
  }, [scope]);

  const syncPending = useCallback(async (listId?: string) => {
    if (!scope || !browserOnline) return;
    setSyncing(true);
    try {
      const result = await flushPurchasingOutbox(scope);
      setServerReachable(result.reachable);
      await refreshLocal(listId || activeListId.current || undefined);
    } catch {
      setServerReachable(false);
      await refreshLocal(listId || activeListId.current || undefined);
    } finally {
      setSyncing(false);
    }
  }, [browserOnline, refreshLocal, scope]);

  const refreshLists = useCallback(async () => {
    if (!scope) return;
    const { data } = await api.get('/purchasing/lists');
    const remote = (data.lists || []) as ShoppingList[];
    const [cachedLists, pending] = await Promise.all([getOfflineLists(scope), getOfflineOperations(scope)]);
    const locallyPending = new Map(cachedLists.filter((item) => pending.some((op) => op.listId === item.id)).map((item) => [item.id, item]));
    setLists(remote.map((item) => locallyPending.get(item.id) || item).concat(cachedLists.filter((item) => !remote.some((serverList) => serverList.id === item.id))) as ShoppingList[]);
    setOperations(pending);
  }, [scope]);

  const openList = useCallback(async (listId: string) => {
    setActionError('');
    if (scope && browserOnline) {
      try {
        const { data } = await api.get(`/purchasing/lists/${encodeURIComponent(listId)}`);
        setServerReachable(true);
        await saveDownloadedList(scope, data.list as OfflineList);
      } catch {
        setServerReachable(false);
      }
    }
    try {
      const cached = scope ? await getOfflineList(scope, listId) : { list: null, operations: [] };
      if (cached.list) {
        activeListId.current = listId;
        setActiveList(cached.list as ShoppingList);
        setOperations(await getOfflineOperations(scope!));
      } else if (browserOnline && scope) {
        const { data } = await api.get(`/purchasing/lists/${encodeURIComponent(listId)}`);
        activeListId.current = listId;
        setActiveList(data.list);
        await saveDownloadedList(scope, data.list as OfflineList);
      } else {
        setActionError(t('listNotCached'));
      }
    } catch {
      setActionError(t('loadFailed'));
    }
  }, [browserOnline, scope, t]);

  const load = useCallback(async () => {
    if (!canPurchase) { setLoading(false); return; }
    setLoading(true);
    setLoadError('');
    let cachedLists: ShoppingList[] = [];
    if (scope) {
      try {
        cachedLists = await getOfflineLists(scope) as ShoppingList[];
        setLists(cachedLists);
        setOperations(await getOfflineOperations(scope));
        setStorageError(false);
      } catch { setStorageError(true); }
    }
    try {
      const [supplyResult, listResult, priceResult] = await Promise.allSettled([
        api.get('/supplies'), api.get('/purchasing/lists'), api.get('/purchasing/prices/latest'),
      ]);
      if (supplyResult.status === 'fulfilled') setSupplies(supplyResult.value.data.supplies || []);
      if (priceResult.status === 'fulfilled') setLatestPrices(Object.fromEntries((priceResult.value.data.observations || []).map((row: PriceObservation) => [row.supply_id, row])));
      if (listResult.status === 'fulfilled') {
        setServerReachable(true);
        const remote = (listResult.value.data.lists || []) as ShoppingList[];
        const pending = scope ? await getOfflineOperations(scope) : [];
        const cached = scope ? await getOfflineLists(scope) as ShoppingList[] : cachedLists;
        const localWithPending = new Map(cached.filter((item) => pending.some((op) => op.listId === item.id)).map((item) => [item.id, item]));
        setLists(remote.map((item) => localWithPending.get(item.id) || item).concat(cached.filter((item) => !remote.some((serverList) => serverList.id === item.id))) as ShoppingList[]);
        setOperations(pending);
      } else {
        setServerReachable(false);
        if (cachedLists.length === 0) setLoadError(t('loadFailed'));
      }
    } catch {
      setServerReachable(false);
      if (cachedLists.length === 0) setLoadError(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [canPurchase, scope, t]);

  // Fetching server state is the synchronization boundary for this connected view.
  // eslint-disable-next-line react/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    activeListId.current = null;
    // eslint-disable-next-line react/set-state-in-effect
    setActiveList(null);
    setOperations([]);
  }, [scope]);

  useEffect(() => {
    const handleOnline = () => { setBrowserOnline(true); setServerReachable(true); void load(); };
    const handleOffline = () => { setBrowserOnline(false); setServerReachable(false); };
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [load]);

  useEffect(() => {
    // eslint-disable-next-line react/set-state-in-effect
    if (scope && browserOnline) void syncPending();
  }, [browserOnline, scope, syncPending]);

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
      activeListId.current = data.list.id;
      setActiveList(data.list);
      if (scope) await saveDownloadedList(scope, data.list as OfflineList);
      try { await refreshLists(); } catch { setServerReachable(false); }
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
    if (!scope || !activeList) { setActionError(t('saveFailed')); return; }
    const operationId = createOperationReference();
    const idempotencyKey = createOperationReference();
    if (!operationId || !idempotencyKey) { setActionError(t('saveFailed')); return; }
    const payload = {
      ...(values?.quantity !== undefined && { quantity: values.quantity }),
      ...(values?.unit !== undefined && { unit: values.unit }),
      ...(values?.price !== undefined && { price: values.price }),
      ...(values?.supplier !== undefined && { supplier: values.supplier }),
      ...(values?.brand !== undefined && { brand: values.brand }),
    };
    setSavingLineId(line.id);
    setActionError('');
    try {
      await queueOfflineOperation({ scope, listId: activeList.id, lineId: line.id, kind: 'acquire', payload, operationId, idempotencyKey });
      setEditingLine(null);
      await refreshLocal(activeList.id);
      if (browserOnline) void syncPending(activeList.id);
    } catch {
      setActionError(storageError ? t('offlineStorageUnavailable') : t('saveFailed'));
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
    if (!scope || !activeList) { setActionError(t('saveFailed')); return; }
    const operationId = createOperationReference();
    const idempotencyKey = createOperationReference();
    if (!operationId || !idempotencyKey) { setActionError(t('saveFailed')); return; }
    setSavingLineId(line.id);
    setActionError('');
    try {
      await queueOfflineOperation({ scope, listId: activeList.id, lineId: line.id, kind: 'not_found', operationId, idempotencyKey });
      await refreshLocal(activeList.id);
      if (browserOnline) void syncPending(activeList.id);
    } catch {
      setActionError(storageError ? t('offlineStorageUnavailable') : t('saveFailed'));
    } finally { setSavingLineId(''); }
  };

  const handleConflictResolution = async (operation: OfflineOperation, resolution: 'retry' | 'discard') => {
    if (!scope) return;
    try {
      await resolveOfflineConflict(scope, operation.operationId, resolution);
      await refreshLocal(activeList?.id);
      if (resolution === 'retry' && browserOnline) void syncPending(activeList?.id);
    } catch {
      setActionError(t('saveFailed'));
    }
  };

  const lastPrices = latestPrices;
  const activeLines = (activeList?.lines || []).filter((line) => line.status === 'pending' || Boolean(line.syncState));
  const doneLines = (activeList?.lines || []).filter((line) => line.status !== 'pending' && !line.syncState);
  const visibleLines = showDone ? doneLines : activeLines;
  const pendingOperations = operations.filter((operation) => operation.state !== 'conflict');
  const conflictOperations = operations.filter((operation) => operation.state === 'conflict');
  const conflictRefreshNeeded = conflictOperations.some((operation) => !operation.conflictList);

  if (!canPurchase) return <div className="p-6 text-center text-muted-foreground">{t('noAccess')}</div>;

  return (
    <main className="mx-auto w-full max-w-5xl pb-24">
      <header className="mb-5 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          {activeList && <Button variant="ghost" size="icon" aria-label={tCommon('back')} className="size-11 shrink-0" onClick={() => { activeListId.current = null; setActiveList(null); setEditingLine(null); setActionError(''); }}><ArrowLeft className="size-5" /></Button>}
          <div className="min-w-0">
            <h1 className="truncate text-xl font-bold text-foreground sm:text-2xl">{activeList?.name || tNav('purchasing')}</h1>
            {!activeList && <p className="mt-1 text-sm text-muted-foreground">{t('shoppingLists')}</p>}
          </div>
        </div>
        {!activeList && !creating && <Button className="min-h-11 shrink-0" disabled={!browserOnline || !serverReachable} onClick={() => { setCreating(true); setActionError(''); }}><Plus className="me-1 size-4" />{t('newShoppingList')}</Button>}
      </header>

      <div role="status" aria-live="polite" className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Badge variant={conflictOperations.length ? 'destructive' : syncing ? 'secondary' : 'outline'}>
            {conflictOperations.length ? t('conflictNeedsReview') : syncing ? t('syncingNow') : !serverReachable || !browserOnline ? t('offlineMode') : t('syncedWithServer')}
          </Badge>
          {pendingOperations.length > 0 && <span className="text-muted-foreground">{t('pendingSyncCount', { count: pendingOperations.length })}</span>}
          {conflictOperations.length > 0 && <span className="text-destructive">{t('conflictNeedsReview')}: {conflictOperations.length}</span>}
          {storageError && <span className="text-destructive">{t('offlineStorageUnavailable')}</span>}
        </div>
        {(pendingOperations.length > 0 || conflictRefreshNeeded) && <Button size="sm" variant="outline" className="min-h-10" disabled={!browserOnline || syncing} onClick={() => void syncPending(activeList?.id)}>
          {syncing ? <LoaderCircle className="me-2 size-4 animate-spin" /> : null}{t('syncNow')}
        </Button>}
      </div>

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
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><Button variant="outline" className="min-h-11" onClick={() => { setCreating(false); setActionError(''); }}>{tCommon('cancel')}</Button><Button className="min-h-11" disabled={savingList || draftLines.length === 0 || !browserOnline || !serverReachable} onClick={() => void saveList()}>{savingList && <LoaderCircle className="me-2 size-4 animate-spin" />}{savingList ? tCommon('saving') : tCommon('create')}</Button></div>
        </section>
      ) : activeList ? (
        <section className="space-y-4">
          <div className="grid grid-cols-2 gap-2">
            <Button variant={!showDone ? 'default' : 'outline'} className="min-h-11 justify-between" onClick={() => { setShowDone(false); setEditingLine(null); }}>{tCommon('active')}<Badge variant="secondary">{activeLines.length}</Badge></Button>
            <Button variant={showDone ? 'default' : 'outline'} className="min-h-11 justify-between" onClick={() => { setShowDone(true); setEditingLine(null); }}>{tCommon('done')}<Badge variant="secondary">{doneLines.length}</Badge></Button>
          </div>
          {visibleLines.length === 0 ? <div className="rounded-xl border border-dashed border-border bg-card px-4 py-12 text-center text-sm text-muted-foreground">{t('emptyShoppingLists')}</div> : <div className="space-y-3">{visibleLines.map((line) => {
            const lastPrice = lastPrices[line.supply_id];
            const conflict = operations.find((operation) => operation.lineId === line.id && operation.listId === activeList.id && operation.state === 'conflict');
            const serverLine = conflict?.conflictList?.lines.find((item) => item.id === line.id);
            return <article key={line.id} className="rounded-xl border border-border bg-card p-4 shadow-sm sm:p-5">
              <div className="flex items-start justify-between gap-3"><div className="min-w-0"><h2 className="text-base font-semibold">{line.supply_name}</h2><p className="mt-1 text-sm text-muted-foreground">{t('plannedQuantity')}: {fmtNum(line.planned_quantity)} {line.planned_unit}</p>{line.purchased_quantity > 0 && <p className="mt-1 text-sm text-muted-foreground">{t('purchasedQuantity')}: {fmtNum(line.purchased_quantity)} {line.purchased_unit || line.base_unit}</p>}</div><div className="flex shrink-0 flex-col items-end gap-1"><Badge variant={line.syncState === 'conflict' ? 'destructive' : line.status === 'pending' ? 'outline' : 'secondary'}>{line.syncState === 'conflict' ? t('conflictNeedsReview') : line.status === 'pending' ? tCommon('active') : line.status === 'acquired' ? t('acquired') : t('markNotFound')}</Badge>{line.syncState && line.syncState !== 'conflict' && <span className="text-[11px] text-muted-foreground">{line.syncState === 'syncing' ? t('syncingNow') : t('savedOnDevice')}</span>}</div></div>
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">{line.reference_price !== null && <span>{t('referencePrice')}: {fmt(line.reference_price)} / {fmtNum(line.planned_quantity)} {line.planned_unit}{line.reference_observed_at ? ` · ${formatDate(line.reference_observed_at)}` : ''}</span>}{line.purchased_quantity > 0 && line.actual_price !== null && <span>{t('actualPrice')}: {fmt(line.actual_price)}</span>}{(line.actual_brand || line.planned_brand) && <span>{t('brand')}: {line.actual_brand || line.planned_brand}</span>}{(line.actual_supplier || line.planned_supplier) && <span>{t('supplier')}: {line.actual_supplier || line.planned_supplier}</span>}</div>
              {lastPrice && <p className="mt-2 text-xs text-muted-foreground">{t('lastPrice', { price: `${fmt(lastPrice.amount)} / ${fmtNum(lastPrice.observed_quantity)} ${lastPrice.unit}`, date: formatDate(lastPrice.effective_at) })}</p>}
              {conflict && <div className="mt-4 space-y-3 rounded-lg border border-destructive/40 bg-destructive/5 p-3 sm:p-4"><h3 className="font-semibold text-destructive">{t('conflictNeedsReview')}</h3><div className="grid gap-2 text-sm sm:grid-cols-2"><div><strong>{t('localIntent')}: </strong>{conflict.kind === 'not_found' ? t('markNotFound') : `${fmtNum(conflict.payload?.quantity ?? line.planned_quantity)} ${conflict.payload?.unit ?? line.planned_unit} · ${conflict.payload?.price !== undefined ? fmt(conflict.payload.price) : line.reference_price !== null ? fmt(line.reference_price) : '—'} · ${conflict.payload?.brand ?? line.actual_brand ?? line.planned_brand ?? ''} · ${conflict.payload?.supplier ?? line.actual_supplier ?? line.planned_supplier ?? ''}`}</div><div><strong>{t('serverCurrent')}: </strong>{serverLine ? `${serverLine.status} · v${serverLine.version} · ${fmtNum(serverLine.purchased_quantity)} ${serverLine.purchased_unit || serverLine.base_unit}` : t('syncingNow')}</div></div><div className="flex flex-col gap-2 sm:flex-row"><Button className="min-h-11 flex-1" disabled={!serverLine || syncing} onClick={() => void handleConflictResolution(conflict, 'retry')}>{t('retryOnLatest')}</Button><Button variant="outline" className="min-h-11" disabled={!serverLine || syncing} onClick={() => void handleConflictResolution(conflict, 'discard')}>{t('discardLocalChange')}</Button></div></div>}
              {line.status === 'pending' && <div className="mt-4 flex flex-col gap-2 sm:flex-row">{!showDone && <Button className="min-h-12 flex-1 text-base" disabled={savingLineId === line.id || storageError || line.syncState === 'conflict'} onClick={() => line.reference_price !== null && line.purchased_quantity === 0 ? void submitAcquisition(line) : startDetails(line)}>{savingLineId === line.id ? <LoaderCircle className="me-2 size-4 animate-spin" /> : <Check className="me-2 size-4" />}{t('markAcquired')}</Button>}<Button variant="outline" className="min-h-12" disabled={savingLineId === line.id || storageError || line.syncState === 'conflict'} onClick={() => startDetails(line)}>{tCommon('edit')}</Button>{!showDone && <Button variant="ghost" className="min-h-12" disabled={savingLineId === line.id || storageError || line.syncState === 'conflict'} onClick={() => void markNotFound(line)}><MoreHorizontal className="me-2 size-4" />{t('markNotFound')}</Button>}</div>}
              {editingLine?.id === line.id && <div className="mt-4 space-y-3 rounded-lg border border-primary/30 bg-background p-3 sm:p-4"><h3 className="font-semibold">{t('markAcquired')}</h3><div className="grid grid-cols-1 gap-3 sm:grid-cols-2"><label className="text-sm">{t('plannedQuantity')}<input autoFocus type="number" min="0.00000001" step="any" value={actualQuantity} onChange={(event) => setActualQuantity(event.target.value)} className="mt-1.5 h-11 w-full rounded-lg border border-border bg-background px-3 text-base" /></label><label className="text-sm">{t('baseUnit')}<select value={actualUnit} onChange={(event) => setActualUnit(event.target.value as Unit)} className="mt-1.5 h-11 w-full rounded-lg border border-border bg-background px-3 text-base">{UNITS.map((unit) => <option key={unit}>{unit}</option>)}</select></label><label className="text-sm">{t('actualPrice')}<input type="number" min="0" step="any" value={actualPrice} onChange={(event) => setActualPrice(event.target.value)} className="mt-1.5 h-11 w-full rounded-lg border border-border bg-background px-3 text-base" /></label><Field label={t('supplier')} value={actualSupplier} onChange={setActualSupplier} /><Field label={t('brand')} value={actualBrand} onChange={setActualBrand} /></div><div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><Button variant="outline" className="min-h-11" onClick={() => setEditingLine(null)}>{tCommon('cancel')}</Button><Button className="min-h-11" disabled={savingLineId === line.id || storageError} onClick={() => void confirmDetails()}>{savingLineId === line.id && <LoaderCircle className="me-2 size-4 animate-spin" />}{tCommon('save')}</Button></div></div>}
            </article>;
          })}</div>}
        </section>
      ) : loading ? <div className="flex justify-center py-16 text-muted-foreground"><LoaderCircle className="size-6 animate-spin" /></div> : lists.length === 0 ? <div className="rounded-xl border border-dashed border-border bg-card px-4 py-16 text-center"><ShoppingBasket className="mx-auto size-8 text-muted-foreground" /><p className="mt-3 text-sm text-muted-foreground">{serverReachable ? t('emptyShoppingLists') : t('offlineNoList')}</p><Button className="mt-4 min-h-11" disabled={!browserOnline || !serverReachable} onClick={() => setCreating(true)}><Plus className="me-1 size-4" />{t('newShoppingList')}</Button></div> : <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">{lists.map((list) => <ShoppingListCard key={list.id} name={list.name} lineCount={list.line_count || 0} lineCountLabel={t('shoppingLists')} createdAt={formatDate(list.created_at)} onSelect={() => void openList(list.id)} />)}</div>}
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
