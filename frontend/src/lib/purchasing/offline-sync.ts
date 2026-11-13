import api from '@/lib/api';
import {
  confirmOfflineOperation,
  getOfflineOperations,
  markOperationConflict,
  setOperationState,
  withPurchasingSyncLock,
  type OfflineList,
  type PurchasingScope,
} from './offline-store';

type SyncResult = { synchronized: number; reachable: boolean; busy: boolean };
const running = new Map<string, Promise<SyncResult>>();

function httpStatus(error: unknown): number | undefined {
  return (error as { response?: { status?: number } })?.response?.status;
}

async function synchronize(scope: PurchasingScope, onChange?: () => void): Promise<SyncResult> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return { synchronized: 0, reachable: false, busy: false };
  const result = await withPurchasingSyncLock(scope, async () => {
    let synchronized = 0;
    let reachable = true;
    const blockedLines = new Set<string>();
    const operations = await getOfflineOperations(scope);
    for (const operation of operations) {
      const lineKey = `${operation.listId}:${operation.lineId}`;
      if (operation.state === 'conflict') {
        blockedLines.add(lineKey);
        if (!operation.conflictList) {
          try {
            const { data } = await api.get(`/purchasing/lists/${encodeURIComponent(operation.listId)}`);
            await markOperationConflict(scope, operation.operationId, data.list as OfflineList);
            onChange?.();
          } catch {
            // Keep the conflict and the operator's intent until server state can be loaded.
          }
        }
        continue;
      }
      if (blockedLines.has(lineKey)) continue;
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        reachable = false;
        break;
      }
      // A previous tab may have closed after marking an operation as syncing.
      await setOperationState(scope, operation.operationId, 'syncing');
      onChange?.();
      try {
        let data: Record<string, unknown>;
        if (operation.kind === 'acquire') {
          const response = await api.post(`/purchasing/lines/${encodeURIComponent(operation.lineId)}/acquisitions`, {
            ...(operation.payload || {}),
            expected_version: operation.expectedVersion,
            idempotency_key: operation.idempotencyKey,
          });
          data = response.data;
        } else {
          const response = await api.post(`/purchasing/lines/${encodeURIComponent(operation.lineId)}/not-found`, {
            expected_version: operation.expectedVersion,
            idempotency_key: operation.idempotencyKey,
          });
          data = response.data;
        }
        await confirmOfflineOperation(scope, operation.operationId, data);
        synchronized += 1;
        onChange?.();
      } catch (error: unknown) {
        const status = httpStatus(error);
        if (status === 409) {
          let serverList: OfflineList | null = null;
          try {
            const { data } = await api.get(`/purchasing/lists/${encodeURIComponent(operation.listId)}`);
            serverList = data.list as OfflineList;
          } catch {
            reachable = typeof navigator === 'undefined' ? true : navigator.onLine;
          }
          await markOperationConflict(scope, operation.operationId, serverList);
          blockedLines.add(lineKey);
          onChange?.();
          continue;
        }
        const errorClass = status === 401 || status === 403 ? 'authorization' : status === undefined ? 'network' : 'server';
        await setOperationState(scope, operation.operationId, 'pending', errorClass);
        onChange?.();
        if (status === undefined || status === 401 || status === 403) {
          if (status === undefined) reachable = false;
          break;
        }
      }
    }
    return { synchronized, reachable, busy: false };
  });
  return result || { synchronized: 0, reachable: navigator.onLine, busy: true };
}

export function flushPurchasingOutbox(scope: PurchasingScope, onChange?: () => void): Promise<SyncResult> {
  const key = JSON.stringify([scope.installationId, scope.tenantId, String(scope.userId), scope.principalId]);
  const existing = running.get(key);
  if (existing) return existing;
  const job = synchronize(scope, onChange).finally(() => running.delete(key));
  running.set(key, job);
  return job;
}
