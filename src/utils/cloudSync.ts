export type CloudRefreshCallback = () => void | Promise<void>;

export interface CloudSyncCallbacks {
  transactions?: CloudRefreshCallback;
  heads?: CloudRefreshCallback;
  departments?: CloudRefreshCallback;
  locks?: CloudRefreshCallback;
  audit?: CloudRefreshCallback;
  activity?: CloudRefreshCallback;
  employees?: CloudRefreshCallback;
  salaries?: CloudRefreshCallback;
  loans?: CloudRefreshCallback;
  advances?: CloudRefreshCallback;
  fundSources?: CloudRefreshCallback;
  rentItems?: CloudRefreshCallback;
  rentPayments?: CloudRefreshCallback;
  /** Re-reads the signed-in account so a role change by an admin shows up without a reload. */
  me?: CloudRefreshCallback;
  fetchStatus?: () => Promise<unknown>;
  maintenance?: (state: { on: boolean; since?: number }) => void;
}

export function createCloudSyncRefreshers(callbacks: CloudSyncCallbacks) {
  let disposed = false;
  let inFlight: Promise<void> | null = null;

  async function invoke(callback?: CloudRefreshCallback): Promise<void> {
    if (!callback) return;
    try {
      await callback();
    } catch {}
  }

  function refreshAll(): Promise<void> {
    if (disposed) return Promise.resolve();
    if (inFlight) return inFlight;

    inFlight = (async () => {
      await Promise.all([
        invoke(callbacks.transactions),
        invoke(callbacks.heads),
        invoke(callbacks.departments),
        invoke(callbacks.locks),
        invoke(callbacks.audit),
        invoke(callbacks.activity),
        invoke(callbacks.employees),
        invoke(callbacks.salaries),
        invoke(callbacks.loans),
        invoke(callbacks.advances),
        invoke(callbacks.fundSources),
        invoke(callbacks.rentItems),
        invoke(callbacks.rentPayments),
        invoke(callbacks.me),
      ]);
      if (disposed || !callbacks.fetchStatus) return;
      try {
        const status = await callbacks.fetchStatus();
        if (disposed || !status || typeof status !== 'object') return;
        const maintenance = (status as { maintenance?: unknown }).maintenance;
        if (maintenance && typeof maintenance === 'object') {
          const state = maintenance as { on?: unknown; since?: unknown };
          callbacks.maintenance?.({
            on: Boolean(state.on),
            ...(typeof state.since === 'number' && Number.isFinite(state.since) ? { since: state.since } : {}),
          });
        }
      } catch {}
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  return {
    refreshAll,
    dispose() { disposed = true; },
  };
}
