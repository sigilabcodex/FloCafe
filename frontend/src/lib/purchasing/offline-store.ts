export type PurchasingUnit = 'each' | 'g' | 'kg' | 'ml' | 'l';
export type PurchasingStatus = 'pending' | 'acquired' | 'not_found';
export type PurchasingScope = { installationId: string; tenantId: number; userId: number };
export type OfflineLine = {
  id: string;
  supply_id: string;
  supply_name: string;
  base_unit: PurchasingUnit;
  planned_quantity: number;
  planned_unit: PurchasingUnit;
  planned_supplier: string | null;
  planned_brand: string | null;
  reference_price: number | null;
  reference_unit: PurchasingUnit | null;
  reference_observed_at: string | null;
  purchased_quantity: number;
  purchased_unit: PurchasingUnit | null;
  actual_supplier: string | null;
  actual_brand: string | null;
  actual_price: number | null;
  status: PurchasingStatus;
  version: number;
  syncState?: 'pending' | 'syncing' | 'conflict';
  localOperationId?: string;
};
export type OfflineList = {
  id: string;
  name: string;
  status: 'open' | 'closed';
  created_at: string;
  lines: OfflineLine[];
  line_count?: number;
};
export type AcquisitionPayload = {
  quantity?: number;
  unit?: PurchasingUnit;
  price?: number;
  supplier?: string | null;
  brand?: string | null;
};
export type OfflineOperation = {
  operationId: string;
  scopeKey: string;
  listId: string;
  lineId: string;
  sequence: number;
  idempotencyKey: string;
  expectedVersion: number;
  kind: 'acquire' | 'not_found';
  payload?: AcquisitionPayload;
  state: 'pending' | 'syncing' | 'conflict';
  createdAt: string;
  error?: 'network' | 'authorization' | 'server' | 'conflict';
  conflictList?: OfflineList | null;
};

type CachedRecord = { key: string; scopeKey: string; listId: string; list: OfflineList; cachedAt: string };
type ScopeRecord = { scopeKey: string; nextSequence: number; lockOwner?: string; lockExpiresAt?: number };

const DATABASE = 'flo-purchasing-offline-v1';
const VERSION = 1;
let databasePromise: Promise<IDBDatabase> | null = null;

export function getPurchasingScope(tenantId: number, userId: number): PurchasingScope {
  const installationId = typeof window === 'undefined' ? 'server' : window.location.origin;
  return { installationId, tenantId, userId };
}

export function scopeKey(scope: PurchasingScope): string {
  return JSON.stringify([scope.installationId, scope.tenantId, scope.userId]);
}

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('IndexedDB unavailable'));
  if (!databasePromise) {
    databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DATABASE, VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        const lists = db.createObjectStore('lists', { keyPath: 'key' });
        lists.createIndex('scopeKey', 'scopeKey', { unique: false });
        const operations = db.createObjectStore('operations', { keyPath: 'operationId' });
        operations.createIndex('scopeKey', 'scopeKey', { unique: false });
        operations.createIndex('scopeSequence', ['scopeKey', 'sequence'], { unique: true });
        const scopes = db.createObjectStore('scopes', { keyPath: 'scopeKey' });
        scopes.createIndex('installationId', 'installationId', { unique: false });
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
      request.onerror = () => reject(request.error || new Error('Could not open purchasing storage'));
      request.onblocked = () => reject(new Error('Purchasing storage upgrade is blocked'));
    }).catch((error) => {
      databasePromise = null;
      throw error;
    });
  }
  return databasePromise!;
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Purchasing storage request failed'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error || new Error('Purchasing storage transaction aborted'));
    transaction.onerror = () => reject(transaction.error || new Error('Purchasing storage transaction failed'));
  });
}

function lineKey(scope: PurchasingScope, listId: string): string {
  return `${scopeKey(scope)}:${listId}`;
}

export function convertPurchasingQuantity(value: number, from: PurchasingUnit, to: PurchasingUnit): number | null {
  const dimension: Record<PurchasingUnit, 'count' | 'mass' | 'volume'> = {
    each: 'count', g: 'mass', kg: 'mass', ml: 'volume', l: 'volume',
  };
  const factor: Record<PurchasingUnit, number> = { each: 1, g: 1, kg: 1000, ml: 1, l: 1000 };
  if (dimension[from] !== dimension[to]) return null;
  return value * factor[from] / factor[to];
}

function updateFromOperation(line: OfflineLine, operation: OfflineOperation): OfflineLine {
  const result = { ...line, version: operation.expectedVersion + 1, syncState: operation.state, localOperationId: operation.operationId };
  if (operation.kind === 'not_found') return { ...result, status: 'not_found' };
  const payload = operation.payload || {};
  const quantity = payload.quantity ?? line.planned_quantity;
  const unit = payload.unit ?? line.planned_unit;
  const acquiredBase = convertPurchasingQuantity(quantity, unit, line.base_unit);
  const currentBase = convertPurchasingQuantity(line.purchased_quantity || 0, line.purchased_unit || line.base_unit, line.base_unit);
  const plannedBase = convertPurchasingQuantity(line.planned_quantity, line.planned_unit, line.base_unit);
  if (acquiredBase === null || currentBase === null || plannedBase === null) return result;
  return {
    ...result,
    purchased_quantity: currentBase + acquiredBase,
    purchased_unit: line.base_unit,
    actual_price: payload.price ?? line.reference_price,
    actual_supplier: payload.supplier === undefined ? line.planned_supplier : payload.supplier,
    actual_brand: payload.brand === undefined ? line.planned_brand : payload.brand,
    status: currentBase + acquiredBase >= plannedBase ? 'acquired' : 'pending',
  };
}

export function applyOfflineOperations(list: OfflineList, operations: OfflineOperation[]): OfflineList {
  const lines = list.lines.map((original) => {
    let line = { ...original };
    const lineOperations = operations.filter((item) => item.lineId === line.id).sort((a, b) => a.sequence - b.sequence);
    for (const operation of lineOperations) {
      line = updateFromOperation(line, operation);
    }
    const conflict = lineOperations.find((operation) => operation.state === 'conflict');
    if (conflict) line = { ...line, syncState: 'conflict', localOperationId: conflict.operationId };
    return line;
  });
  return { ...list, lines, line_count: list.line_count ?? lines.length };
}

export async function saveDownloadedList(scope: PurchasingScope, list: OfflineList): Promise<void> {
  const db = await openDatabase();
  const key = scopeKey(scope);
  const tx = db.transaction(['lists', 'operations'], 'readwrite');
  const opsPromise = requestValue(tx.objectStore('operations').index('scopeKey').getAll(key) as IDBRequest<OfflineOperation[]>);
  const ops = await opsPromise;
  if (!ops.some((operation) => operation.listId === list.id)) {
    tx.objectStore('lists').put({ key: lineKey(scope, list.id), scopeKey: key, list, listId: list.id, cachedAt: new Date().toISOString() } satisfies CachedRecord);
  }
  await transactionDone(tx);
}

export async function getOfflineList(scope: PurchasingScope, listId: string): Promise<{ list: OfflineList | null; operations: OfflineOperation[] }> {
  const db = await openDatabase();
  const tx = db.transaction(['lists', 'operations'], 'readonly');
  const recordRequest = requestValue(tx.objectStore('lists').get(lineKey(scope, listId)) as IDBRequest<CachedRecord | undefined>);
  const opsRequest = requestValue(tx.objectStore('operations').index('scopeKey').getAll(scopeKey(scope)) as IDBRequest<OfflineOperation[]>);
  const [record, allOperations] = await Promise.all([recordRequest, opsRequest]);
  await transactionDone(tx);
  const operations = allOperations.filter((item) => item.listId === listId).sort((a, b) => a.sequence - b.sequence);
  return { list: record ? applyOfflineOperations(record.list, operations) : null, operations };
}

export async function getOfflineLists(scope: PurchasingScope): Promise<OfflineList[]> {
  const db = await openDatabase();
  const tx = db.transaction(['lists', 'operations'], 'readonly');
  const recordsRequest = requestValue(tx.objectStore('lists').index('scopeKey').getAll(scopeKey(scope)) as IDBRequest<CachedRecord[]>);
  const operationsRequest = requestValue(tx.objectStore('operations').index('scopeKey').getAll(scopeKey(scope)) as IDBRequest<OfflineOperation[]>);
  const [records, operations] = await Promise.all([recordsRequest, operationsRequest]);
  await transactionDone(tx);
  return records.map(({ list }) => applyOfflineOperations(list, operations.filter((operation) => operation.listId === list.id)))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function getOfflineOperations(scope: PurchasingScope): Promise<OfflineOperation[]> {
  const db = await openDatabase();
  const tx = db.transaction('operations', 'readonly');
  const operations = await requestValue(tx.objectStore('operations').index('scopeKey').getAll(scopeKey(scope)) as IDBRequest<OfflineOperation[]>);
  await transactionDone(tx);
  return operations.sort((a, b) => a.sequence - b.sequence);
}

export async function queueOfflineOperation(input: {
  scope: PurchasingScope; listId: string; lineId: string; kind: OfflineOperation['kind'];
  payload?: AcquisitionPayload; operationId: string; idempotencyKey: string;
}): Promise<OfflineOperation> {
  const db = await openDatabase();
  const key = scopeKey(input.scope);
  const tx = db.transaction(['lists', 'operations', 'scopes'], 'readwrite');
  const listStore = tx.objectStore('lists');
  const operationsStore = tx.objectStore('operations');
  const scopesStore = tx.objectStore('scopes');
  const [record, allOperations, storedScope] = await Promise.all([
    requestValue(listStore.get(lineKey(input.scope, input.listId)) as IDBRequest<CachedRecord | undefined>),
    requestValue(operationsStore.index('scopeKey').getAll(key) as IDBRequest<OfflineOperation[]>),
    requestValue(scopesStore.get(key) as IDBRequest<ScopeRecord | undefined>),
  ]);
  if (!record) { tx.abort(); throw new Error('List is not available on this device'); }
  const priorLineOperations = allOperations.filter((operation) => operation.lineId === input.lineId).sort((a, b) => a.sequence - b.sequence);
  if (priorLineOperations.some((operation) => operation.state === 'conflict')) { tx.abort(); throw new Error('Resolve the existing line conflict before adding another operation'); }
  const view = applyOfflineOperations(record.list, priorLineOperations);
  const line = view.lines.find((item) => item.id === input.lineId);
  if (!line || line.status !== 'pending') { tx.abort(); throw new Error('Line is no longer pending'); }
  if (input.kind === 'acquire') {
    const quantity = input.payload?.quantity ?? line.planned_quantity;
    const unit = input.payload?.unit ?? line.planned_unit;
    if (convertPurchasingQuantity(quantity, unit, line.base_unit) === null) { tx.abort(); throw new Error('Incompatible presentation unit'); }
    const price = input.payload?.price ?? line.reference_price;
    if (price === null || price === undefined || !Number.isFinite(price) || price < 0) { tx.abort(); throw new Error('A price is required'); }
  }
  const sequence = (storedScope?.nextSequence || 1);
  const operation: OfflineOperation = {
    operationId: input.operationId, scopeKey: key, listId: input.listId, lineId: input.lineId,
    sequence, idempotencyKey: input.idempotencyKey, expectedVersion: line.version,
    kind: input.kind, ...(input.payload ? { payload: input.payload } : {}), state: 'pending', createdAt: new Date().toISOString(),
  };
  operationsStore.add(operation);
  scopesStore.put({ ...(storedScope || { scopeKey: key }), scopeKey: key, nextSequence: sequence + 1 } satisfies ScopeRecord);
  await transactionDone(tx);
  return operation;
}

export async function setOperationState(scope: PurchasingScope, operationId: string, state: OfflineOperation['state'], error?: OfflineOperation['error']): Promise<void> {
  const db = await openDatabase();
  const tx = db.transaction('operations', 'readwrite');
  const store = tx.objectStore('operations');
  const operation = await requestValue(store.get(operationId) as IDBRequest<OfflineOperation | undefined>);
  if (operation && operation.scopeKey === scopeKey(scope)) store.put({ ...operation, state, error });
  await transactionDone(tx);
}

export async function markOperationConflict(scope: PurchasingScope, operationId: string, conflictList: OfflineList | null): Promise<void> {
  const db = await openDatabase();
  const tx = db.transaction('operations', 'readwrite');
  const store = tx.objectStore('operations');
  const operation = await requestValue(store.get(operationId) as IDBRequest<OfflineOperation | undefined>);
  if (operation && operation.scopeKey === scopeKey(scope)) store.put({ ...operation, state: 'conflict', error: 'conflict', conflictList });
  await transactionDone(tx);
}

export async function confirmOfflineOperation(scope: PurchasingScope, operationId: string, serverResult: Record<string, unknown>): Promise<void> {
  const db = await openDatabase();
  const tx = db.transaction(['lists', 'operations'], 'readwrite');
  const lists = tx.objectStore('lists');
  const operations = tx.objectStore('operations');
  const operation = await requestValue(operations.get(operationId) as IDBRequest<OfflineOperation | undefined>);
  if (!operation || operation.scopeKey !== scopeKey(scope)) { await transactionDone(tx); return; }
  const record = await requestValue(lists.get(lineKey(scope, operation.listId)) as IDBRequest<CachedRecord | undefined>);
  if (record) {
    const lines = record.list.lines.map((line) => {
      if (line.id !== operation.lineId) return line;
      if (operation.kind === 'not_found') {
        const resultLine = serverResult.line as Partial<OfflineLine> | undefined;
        return { ...line, status: 'not_found' as const, version: resultLine?.version ?? operation.expectedVersion + 1 };
      }
      const result = serverResult.acquisition as { status?: PurchasingStatus; purchasedQuantity?: number; version?: number } | undefined;
      const payload = operation.payload || {};
      return {
        ...line,
        status: result?.status ?? line.status,
        purchased_quantity: result?.purchasedQuantity ?? line.purchased_quantity,
        purchased_unit: line.base_unit,
        actual_price: payload.price ?? line.reference_price,
        actual_supplier: payload.supplier === undefined ? line.planned_supplier : payload.supplier,
        actual_brand: payload.brand === undefined ? line.planned_brand : payload.brand,
        version: result?.version ?? operation.expectedVersion + 1,
        syncState: undefined,
        localOperationId: undefined,
      };
    });
    lists.put({ ...record, list: { ...record.list, lines }, cachedAt: new Date().toISOString() });
  }
  operations.delete(operationId);
  await transactionDone(tx);
}

export async function resolveOfflineConflict(scope: PurchasingScope, operationId: string, resolution: 'retry' | 'discard'): Promise<boolean> {
  const db = await openDatabase();
  const tx = db.transaction(['lists', 'operations'], 'readwrite');
  const lists = tx.objectStore('lists');
  const operations = tx.objectStore('operations');
  const op = await requestValue(operations.get(operationId) as IDBRequest<OfflineOperation | undefined>);
  if (!op || op.scopeKey !== scopeKey(scope) || op.state !== 'conflict' || !op.conflictList) { tx.abort(); throw new Error('Conflict data is not available yet'); }
  const currentLine = op.conflictList.lines.find((line) => line.id === op.lineId);
  if (!currentLine) { tx.abort(); throw new Error('Conflict line is missing from the server snapshot'); }
  const record = await requestValue(lists.get(lineKey(scope, op.listId)) as IDBRequest<CachedRecord | undefined>);
  if (!record) { tx.abort(); throw new Error('Cached list is unavailable'); }
  lists.put({ ...record, list: op.conflictList, cachedAt: new Date().toISOString() });
  const lineOperations = (await requestValue(operations.index('scopeKey').getAll(scopeKey(scope)) as IDBRequest<OfflineOperation[]>))
    .filter((item) => item.listId === op.listId && item.lineId === op.lineId && item.sequence >= op.sequence)
    .sort((a, b) => a.sequence - b.sequence);
  let expectedVersion = currentLine.version;
  for (const item of lineOperations) {
    if (item.operationId === operationId && resolution === 'discard') {
      operations.delete(item.operationId);
      continue;
    }
    operations.put({ ...item, expectedVersion, state: 'pending', error: undefined, conflictList: undefined });
    expectedVersion += 1;
  }
  await transactionDone(tx);
  return resolution === 'retry';
}

export async function withPurchasingSyncLock<T>(scope: PurchasingScope, work: () => Promise<T>): Promise<T | null> {
  const db = await openDatabase();
  const key = scopeKey(scope);
  const owner = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const timeoutAt = Date.now() + 15000;
  while (Date.now() < timeoutAt) {
    const tx = db.transaction('scopes', 'readwrite');
    const store = tx.objectStore('scopes');
    const existing = await requestValue(store.get(key) as IDBRequest<ScopeRecord | undefined>);
    if (!existing?.lockOwner || (existing.lockExpiresAt || 0) < Date.now()) {
      store.put({ ...(existing || { scopeKey: key, nextSequence: 1 }), lockOwner: owner, lockExpiresAt: Date.now() + 30000 });
      await transactionDone(tx);
      try { return await work(); } finally {
        const release = db.transaction('scopes', 'readwrite');
        const releaseStore = release.objectStore('scopes');
        const latest = await requestValue(releaseStore.get(key) as IDBRequest<ScopeRecord | undefined>);
        if (latest?.lockOwner === owner) releaseStore.put({ ...latest, lockOwner: undefined, lockExpiresAt: undefined });
        await transactionDone(release);
      }
    }
    await transactionDone(tx);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}
