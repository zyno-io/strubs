<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, watch, nextTick } from 'vue';
import type { VolumeStatus, BlockDevice, StatusResponse } from '@strubs/server/http/mgmt';

// The SERVER's type, not a copy of it. The copy that used to live here had drifted -- it was missing
// `concurrency`, so the one place the UI reads it (the rebalance concurrency box) was a type error that nobody
// saw, because vue-tsc was aborting on a tsconfig deprecation before it checked anything.
import type { RebalanceStatus } from '@strubs/jobs/rebalance-job';

const volumes = ref<VolumeStatus[]>([]);
const blockDevices = ref<BlockDevice[]>([]);
const loading = ref<boolean>(true);
const error = ref<string | null>(null);
const showModal = ref<boolean>(false);
const selectedDevices = ref<Set<string>>(new Set());
const wipeDevices = ref<Set<string>>(new Set());
const creatingVolumes = ref<boolean>(false);

// Persisted UI preferences (survive reload). Read once on init, written by the
// watcher below. Kept tolerant of unavailable/throwing localStorage.
const SORT_BY_KEY = 'strubs.volumes.sortBy';
const VOLUMES_VIEW_KEY = 'strubs.volumes.view';

function loadPref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const stored = localStorage.getItem(key);
    if (stored && (allowed as readonly string[]).includes(stored)) return stored as T;
  } catch {
    // Ignore unavailable localStorage (private mode, etc.)
  }
  return fallback;
}

// Shared sort state driving BOTH the volumes table and the volumes grid view.
const sortBy = ref<'volumeLabel' | 'volumeId' | 'name' | 'path'>(
  loadPref(SORT_BY_KEY, ['volumeLabel', 'volumeId', 'name', 'path'] as const, 'volumeLabel')
);

// Which rendering of the volumes list is active: 'table' or 'grid' (the tiles).
// Both render the same unified row list (sortedStorageRows).
const volumesView = ref<'table' | 'grid'>(
  loadPref(VOLUMES_VIEW_KEY, ['table', 'grid'] as const, 'table')
);

// Persist the view/sort preferences whenever they change. (The active TAB lives in the URL now, not
// localStorage -- see parseHash/writeHash.)
watch([sortBy, volumesView], () => {
  try {
    localStorage.setItem(SORT_BY_KEY, sortBy.value);
    localStorage.setItem(VOLUMES_VIEW_KEY, volumesView.value);
  } catch {
    // Ignore persistence failures
  }
});

// Context menu state
const contextMenu = ref<{ x: number; y: number; volumeId: number | null }>({ x: 0, y: 0, volumeId: null });

// Identify-drive state: while the modal is open we re-POST /identify ~every second (heartbeat); the
// server stops the flashing ~3s after the last ping, so closing the tab or a lost "stop" self-heals.
const identifyDrive = ref<{ volumeId: number; device: string | null } | null>(null);
let identifyHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
const showEditLabelModal = ref<boolean>(false);
const editingVolumeId = ref<number | null>(null);
const editLabelValue = ref<string>('');
const savingLabel = ref<boolean>(false);
const showEditCommentModal = ref<boolean>(false);
const editingCommentVolumeId = ref<number | null>(null);
const editCommentValue = ref<string>('');
const savingComment = ref<boolean>(false);

// Determine API base URL based on environment
const getApiBaseUrl = (): string => {
  if (import.meta.env.DEV) {
    return ''; // Proxy handles this in dev
  }
  return ''; // Same origin in production
};

const apiBaseUrl = getApiBaseUrl();

// --- admin authentication ---
// The management API requires a session; the UI is served from the same (admin) origin, so the session
// cookie rides along automatically on same-origin fetches. We just gate the app behind a login screen.
const authChecked = ref<boolean>(false);   // have we asked the server yet?
const authenticated = ref<boolean>(false);
const loginPassword = ref<string>('');
const loginError = ref<string | null>(null);
const loginPending = ref<boolean>(false);

// Every API call goes through this: a 401 anywhere means the session expired, so drop back to login.
async function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, init);
  if (res.status === 401) {
    authenticated.value = false;
    authChecked.value = true;
    stopApp();   // session expired: tear down the live-refresh timers rather than poll behind the login screen
  }
  return res;
}

async function checkAuth(): Promise<void> {
  try {
    const res = await fetch(`${apiBaseUrl}/$/auth/status`);
    if (res.ok) authenticated.value = (await res.json()).authenticated === true;
  }
  catch { /* leave unauthenticated; the login screen will show */ }
  finally { authChecked.value = true; }
}

async function login(): Promise<void> {
  loginError.value = null;
  loginPending.value = true;
  try {
    const res = await fetch(`${apiBaseUrl}/$/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: loginPassword.value })
    });
    if (res.status === 401) { loginError.value = 'Incorrect password'; return; }
    if (!res.ok) { loginError.value = `Login failed (HTTP ${res.status})`; return; }
    loginPassword.value = '';
    authenticated.value = true;
    startApp();
  }
  catch (err) {
    loginError.value = err instanceof Error ? err.message : 'Login failed';
  }
  finally {
    loginPending.value = false;
  }
}

async function logout(): Promise<void> {
  try { await fetch(`${apiBaseUrl}/$/session`, { method: 'DELETE' }); }
  catch { /* clearing local state below is what matters */ }
  authenticated.value = false;
  stopApp();
}

// Verify job state
// Verify defers to a running rebalance: the request is persisted and queued, not dropped.
interface VerifyStatusWaiting {
  waiting: boolean;
  waitingFor: 'rebalance' | null;
}
interface VerifyStatus extends VerifyStatusWaiting {
  running: boolean;
  startedAt: string | null;
  objectsVerified: number;
  errors: { total: number; volumes: Record<string, number> };
  concurrency: number;
  scope?: 'full' | 'targeted';
  volumeIds?: number[];
}
const verifyStatus = ref<VerifyStatus | null>(null);
const verifyActionPending = ref<boolean>(false);
const stopRequested = ref<boolean>(false);
let verifyPollTimer: ReturnType<typeof setInterval> | null = null;

// Rebalance: evens out fill across the pool by relocating slices off over-full drives onto under-full
// ones. bytesToMove is how far the pool still is from the balance point, so it doubles as progress.
const rebalanceStatus = ref<RebalanceStatus | null>(null);
const rebalancePending = ref<boolean>(false);
const concurrencyPending = ref<boolean>(false);

// Maintenance freeze: when frozen, verify/repair/drain/rebalance are all paused.
const maintenanceFrozen = ref<boolean | null>(null);
const freezePending = ref<boolean>(false);

// Several kinds of maintenance can be in flight, so the header just says whether ANY is — the detail
// lives in the panels below (and in the tooltip).
const maintenanceActivity = computed<string[]>(() => {
  const what: string[] = [];
  if (rebalanceStatus.value?.stopping) what.push('Stopping rebalance');
  else if (rebalanceStatus.value?.running) what.push('Rebalancing');
  if (verifyStatus.value?.running) what.push('Verifying');
  else if (verifyStatus.value?.waiting) what.push('Verify queued');
  if (volumes.value.some(v => v.isDraining)) what.push('Draining');
  return what;
});
const maintenanceActive = computed(() => maintenanceActivity.value.length > 0);

// Fraction of this run's work already done. bytesToMove shrinks as the job works, so moved/(moved+left)
// is a true progress figure — and it stays honest across a restart, since bytesToMove is recomputed
// from live volume fills rather than remembered.
const rebalanceProgress = computed<number>(() => {
  const s = rebalanceStatus.value;
  if (!s) return 0;
  const total = s.bytesMoved + s.bytesToMove;
  return total > 0 ? Math.min(1, s.bytesMoved / total) : (s.bytesToMove === 0 ? 1 : 0);
});

// Everything the rebalance declined to move, and why. Empty when the run is clean.
const rebalanceSkipped = computed<Array<{ label: string; count: number }>>(() => {
  const s = rebalanceStatus.value;
  if (!s) return [];
  return [
    { label: 'no target', count: s.noDest },
    { label: 'unrecoverable', count: s.unrecoverable },
    { label: 'source not freed', count: s.sourceDeleteFailed },
    { label: 'duplicate slice refs', count: s.duplicateRefs }
  ].filter(e => e.count > 0);
});

const rebalanceEta = computed<string>(() => {
  const secs = rebalanceStatus.value?.etaSeconds;
  if (secs == null || !isFinite(secs)) return '—';
  if (secs < 90) return `${Math.round(secs)}s`;
  if (secs < 5400) return `${Math.round(secs / 60)}m`;
  if (secs < 172800) return `${(secs / 3600).toFixed(1)}h`;
  return `${(secs / 86400).toFixed(1)}d`;
});

// Which size tier the job is shedding — it works biggest-objects-first.
const rebalanceTierLabel = computed<string>(() => {
  const min = rebalanceStatus.value?.currentMinObjectSize;
  if (min == null) return '—';
  return min > 0 ? `≥ ${formatBytes(min)}` : 'all sizes';
});

async function fetchRebalanceStatus(): Promise<void> {
  try {
    const res = await apiFetch(`${apiBaseUrl}/$/rebalance`);
    if (!res.ok) return;
    rebalanceStatus.value = await res.json();
  }
  catch { /* transient poll failure — keep the last known status */ }
}

// Retune how many slices relocate at once. A running rebalance re-reads this each batch, so the
// change lands without restarting anything — which is the point: the right value is only discoverable
// by watching a real rebalance move real data.
async function applyConcurrency(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const value = parseInt(input.value, 10);
  if (!Number.isInteger(value) || value < 1 || value > 64) {
    input.value = String(rebalanceStatus.value?.concurrency ?? '');
    error.value = 'Concurrency must be a whole number between 1 and 64';
    return;
  }
  concurrencyPending.value = true;
  try {
    const res = await apiFetch(`${apiBaseUrl}/$/rebalance`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ concurrency: value })
    });
    if (!res.ok) throw new Error(`Failed to set concurrency (HTTP ${res.status})`);
    await fetchRebalanceStatus();
  }
  catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to set concurrency';
    input.value = String(rebalanceStatus.value?.concurrency ?? '');
  }
  finally {
    concurrencyPending.value = false;
  }
}

// Start the rebalance, or cancel one in flight. Cancelling is safe at any point: a slice is only
// removed from its source after the copy is verified and the reference has been flipped.
async function toggleRebalance(): Promise<void> {
  const running = rebalanceStatus.value?.running === true;
  if (!running && !confirm(
    'Start a rebalance? This relocates slices off over-full drives onto under-full ones to even out '
    + 'fill. It moves data and can run for a long time. You can cancel it at any point.'
  )) return;

  rebalancePending.value = true;
  try {
    const res = await apiFetch(`${apiBaseUrl}/$/rebalance`, { method: running ? 'DELETE' : 'POST' });
    if (!res.ok) throw new Error(`Failed to ${running ? 'cancel' : 'start'} rebalance (HTTP ${res.status})`);
    await fetchRebalanceStatus();
  }
  catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to update rebalance';
  }
  finally {
    rebalancePending.value = false;
  }
}

interface StorageCounters {
  objectCount: number;
  logicalBytes: number;
  dataSliceCount: number;
  paritySliceCount: number;
  dataBytes: number;
  parityBytes: number;
  physicalBytes: number;
}

interface StorageStats {
  updatedAt: string | Date;
  system: StorageCounters & {
    unavailableObjectCount: number;
    unavailableLogicalBytes: number;
  };
  volumes: Record<string, StorageCounters>;
}

const storageStats = ref<StorageStats | null>(null);
let storageStatsPollTimer: ReturnType<typeof setInterval> | null = null;

async function fetchStorageStats(): Promise<void> {
  try {
    const res = await apiFetch(`${apiBaseUrl}/$/storage-stats`);
    if (!res.ok) return;
    storageStats.value = await res.json();
  } catch {
    // Ignore transient stats polling errors
  }
}

// RECOUNT. The per-volume statistics are a cache maintained by incremental deltas, and under live traffic those
// deltas drift. A full reconcile runs on a timer -- but until now there was no way to ASK for one, so an operator
// looking at a volume reporting "-16 files" had no move but to wait for the scheduler.
//
// It reads the object records and rewrites the derived counters. No disk is touched and no object is changed.
const statsBusy = ref(false);

async function recomputeStorageStats(): Promise<void> {
  statsBusy.value = true;
  try {
    const res = await apiFetch(`${apiBaseUrl}/$/storage-stats`, { method: 'POST' });
    if (!res.ok) throw new Error(`Failed to recompute storage statistics (HTTP ${res.status})`);
    storageStats.value = await res.json();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to recompute storage statistics';
  } finally {
    statsBusy.value = false;
  }
}

// Poll the maintenance-freeze state; tolerant of transient errors so polling continues.
async function fetchFreezeStatus(): Promise<void> {
  try {
    const res = await apiFetch(`${apiBaseUrl}/$/maintenance-freeze`);
    if (!res.ok) return;
    maintenanceFrozen.value = (await res.json()).frozen;
  } catch {
    // Ignore transient errors
  }
}

// Toggle the maintenance freeze. Unfreezing resumes drains, then verify + repair + rebalance;
// freezing pauses them. Confirm either way since it changes what the system is actively doing.
async function toggleFreeze(): Promise<void> {
  if (freezePending.value || maintenanceFrozen.value === null) return;
  const next = !maintenanceFrozen.value;
  const msg = next
    ? 'Freeze maintenance? This pauses verify, repair, drain, and rebalance.'
    : 'Unfreeze maintenance? This resumes drains, then verify, repair, and rebalance.';
  if (!confirm(msg)) return;
  freezePending.value = true;
  try {
    const res = await apiFetch(`${apiBaseUrl}/$/maintenance-freeze`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ frozen: next })
    });
    if (!res.ok) {
      error.value = `Failed to ${next ? 'freeze' : 'unfreeze'} (HTTP ${res.status})`;
      return;
    }
    maintenanceFrozen.value = (await res.json()).frozen;
    void fetchVerifyStatus();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to update maintenance freeze';
  } finally {
    freezePending.value = false;
  }
}

// Poll the verify job status; tolerant of transient errors so polling continues
async function fetchVerifyStatus(): Promise<void> {
  try {
    const res = await apiFetch(`${apiBaseUrl}/$/verify-volumes`);
    if (!res.ok) return;
    verifyStatus.value = await res.json();
    if (!verifyStatus.value?.running) stopRequested.value = false;
  } catch {
    // Ignore transient polling errors
  }
}

// Start a full verify run
async function startVerify(): Promise<void> {
  if (verifyActionPending.value) return;
  verifyActionPending.value = true;
  try {
    const res = await apiFetch(`${apiBaseUrl}/$/verify-volumes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    if (!res.ok) {
      let msg = `Failed to start verify (HTTP ${res.status})`;
      try {
        const text = await res.text();
        if (text) msg += `: ${text}`;
      } catch {
        // Ignore error reading response body
      }
      throw new Error(msg);
    }
    await fetchVerifyStatus();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to start verify';
  } finally {
    verifyActionPending.value = false;
  }
}

// Request the verify job to stop. The DELETE can be slow (or hang) while the
// job drains in-flight I/O, so we don't block the UI on it — status polling
// reflects the real running state. Button stays in "Stopping..." meanwhile.
async function stopVerify(): Promise<void> {
  if (stopRequested.value) return;
  if (!confirm('Stop the running verify job?')) return;
  stopRequested.value = true;
  apiFetch(`${apiBaseUrl}/$/verify-volumes`, { method: 'DELETE' }).catch(() => {});
}

// Format an ISO timestamp for display
function formatDateTime(iso: string | null): string {
  if (!iso) return 'N/A';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

// Per-volume verify error entries, sorted by descending count
const verifyVolumeErrors = computed<Array<{ volumeId: string; count: number }>>(() => {
  const volumes = verifyStatus.value?.errors?.volumes;
  if (!volumes) return [];
  return Object.entries(volumes)
    .map(([volumeId, count]) => ({ volumeId, count }))
    .filter(entry => entry.count > 0)
    .sort((a, b) => b.count - a.count);
});

const verifyScopeLabel = computed<string>(() => {
  if (verifyStatus.value?.scope === 'targeted' && (verifyStatus.value.volumeIds?.length ?? 0) > 0)
    return 'Targeted';
  return 'Full scrub';
});

const verifyTargetVolumes = computed<Array<{ id: number; label: string }>>(() => {
  const ids = verifyStatus.value?.volumeIds ?? [];
  return ids.map(id => {
    const volume = volumes.value.find(candidate => candidate.id === id);
    const suffix = volume?.label ? ` (${volume.label})` : '';
    return { id, label: `vol ${id}${suffix}` };
  });
});

// Derive a short device name (e.g. "sda") from a block path like "/dev/sda1"
function deviceNameFromBlockPath(blockPath: string | null): string | null {
  if (!blockPath) return null;
  return blockPath.replace(/^\/dev\//, '');
}

type StorageVolumeRow = {
  // Unique row key (volumes keyed by id, unassigned drives by device path)
  key: string;
  // Volume id, or null for an unassigned (non-volumed) physical drive
  id: number | null;
  groupLabel: string | null;
  // Hardware-derived bus group (physical enclosure/HBA), present on volumes and
  // unassigned drives alike; used to slot unassigned drives next to their siblings
  busGroup: number | null;
  color: string;
  device: string | null;
  // Underlying sysfs path of the backing block device, when known (used for the
  // "path" sort and as a tile detail). Null for offline/diskless volumes.
  sysfsPath: string | null;
  // True when the row is a physical drive not assigned to any volume
  unassigned: boolean;
  // The live volume record (null for unassigned drives). Carries the flags the
  // grid/table need to show and the action handlers need to mutate (isReadOnly,
  // isEnabled, SMART, verify errors, etc.).
  volume: VolumeStatus | null;
  // The matching block device, when one is present (null for offline volumes).
  blockDevice: BlockDevice | null;
  // vendor/model/serial tooltip text, when identity info is available
  identityTitle: string | null;
  stats: StorageCounters;
  bytesTotal: number;
  bytesFree: number | null;
  usedFraction: number | null;
};

const EMPTY_STORAGE_COUNTERS: StorageCounters = {
  objectCount: 0,
  logicalBytes: 0,
  dataSliceCount: 0,
  paritySliceCount: 0,
  dataBytes: 0,
  parityBytes: 0,
  physicalBytes: 0
};

const EMPTY_STORAGE_SYSTEM_STATS: StorageStats['system'] = {
  ...EMPTY_STORAGE_COUNTERS,
  unavailableObjectCount: 0,
  unavailableLogicalBytes: 0
};

// Same reasoning as the per-volume counters: fill in any counter the snapshot omits.
const systemStats = computed<StorageStats['system'] | null>(() =>
  storageStats.value ? { ...EMPTY_STORAGE_SYSTEM_STATS, ...storageStats.value.system } : null
);

// Parse a "group.index" label (e.g. "3.3") into numeric [group, index] for sorting
function parseGroupIndex(label: string | null): [number, number] | null {
  if (!label) return null;
  const match = /^(\d+)\.(\d+)$/.exec(label.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2])];
}

// Build a vendor/model/serial tooltip string from a block device's identity fields
function deviceIdentityTitle(device: BlockDevice | undefined | null): string | null {
  if (!device) return null;
  const parts: string[] = [];
  if (device.vendor) parts.push(`Vendor: ${device.vendor}`);
  if (device.model) parts.push(`Model: ${device.model}`);
  if (device.serial) parts.push(`Serial: ${device.serial}`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

// Summed capacity of online, assigned volumes. A started volume is mounted,
// verified, and serving, which naturally excludes deleted/offline volumes.
const onlineAssignedCapacity = computed<number>(() =>
  volumes.value.filter(v => v.isStarted).reduce((sum, v) => sum + (v.bytesTotal || 0), 0)
);

const storageVolumeRows = computed<StorageVolumeRow[]>(() => {
  const statsByVolume = storageStats.value?.volumes ?? {};
  // Union of all configured volume ids and any volume id that only appears in
  // storage stats (e.g. deleted-but-still-referenced volumes that hold data but
  // are no longer in the live config). This way enabled-but-diskless volumes,
  // which carry no stats, still get a row.
  const volumeIds = new Set<number>();
  for (const volume of volumes.value) volumeIds.add(volume.id);
  for (const id of Object.keys(statsByVolume)) volumeIds.add(Number(id));

  const volumeRows: StorageVolumeRow[] = [...volumeIds].map(volumeId => {
    // Spread over the zeroed defaults rather than trusting the payload: a counter that
    // was zero when the volume's stats subdocument was first written may be absent
    // entirely, and an absent counter means zero.
    const stats = { ...EMPTY_STORAGE_COUNTERS, ...statsByVolume[volumeId] };
    const volume = volumes.value.find(candidate => candidate.id === volumeId) ?? null;
    // group.index physical label (e.g. "3.3"), kept separate from the numeric id
    const groupLabel = volume?.label ?? null;
    // Reuse the same per-volume status color as the Block Devices table
    const color = getVolumeBackgroundColor(volume);
    // Prefer the matching block device's short name (sda, sdb); fall back to the volume's block path
    const blockDevice = blockDevices.value.find(bd => bd.volumeId === volumeId);
    const device = blockDevice?.name ?? deviceNameFromBlockPath(volume?.blockPath ?? null);
    const bytesTotal = volume?.bytesTotal ?? 0;
    const bytesFree = volume?.bytesFree ?? null;
    const usedFraction =
      bytesTotal > 0 && bytesFree !== null
        ? Math.min(1, Math.max(0, (bytesTotal - bytesFree) / bytesTotal))
        : null;
    return {
      key: `vol-${volumeId}`,
      id: volumeId,
      groupLabel,
      busGroup: volume?.busGroup ?? blockDevice?.busGroup ?? null,
      color,
      device,
      sysfsPath: blockDevice?.sysfsPath ?? null,
      unassigned: false,
      volume,
      blockDevice: blockDevice ?? null,
      identityTitle: deviceIdentityTitle(blockDevice),
      stats,
      bytesTotal,
      bytesFree,
      usedFraction
    };
  });

  // Unassigned (non-volumed) physical drives: block devices with no volume
  // assignment. These hold no slices, so their stats are zeroed. They have no
  // human-assigned "group.index" label (that's set per volume), but they DO carry
  // the same hardware-derived busGroup as the volumes, so we can slot them next to
  // their physical enclosure siblings instead of dumping them at the bottom.
  const unassignedRows: StorageVolumeRow[] = blockDevices.value
    .filter(bd => !bd.volumeId)
    .map(bd => ({
      key: `dev-${bd.path}`,
      id: null,
      // Backend-derived "group.bay" label (e.g. "3.2") for unassigned enclosure
      // drives, inferred from the labeled bridge sibling. When present, the
      // group.index sort below slots the drive inline with its labeled siblings;
      // when null, it falls back to busGroup placement after the labeled volumes.
      groupLabel: bd.derivedGroupLabel ?? null,
      busGroup: bd.busGroup ?? null,
      color: getVolumeBackgroundColor(null),
      device: bd.name,
      sysfsPath: bd.sysfsPath,
      unassigned: true,
      volume: null,
      blockDevice: bd,
      identityTitle: deviceIdentityTitle(bd),
      stats: EMPTY_STORAGE_COUNTERS,
      bytesTotal: bd.size,
      bytesFree: bd.size,
      usedFraction: bd.size > 0 ? 0 : null
    }));

  // Learn the busGroup -> label-group mapping from labeled volumes. busGroup tracks
  // the physical enclosure/HBA; the "group" part of a volume's manual label names
  // that same enclosure. So a drive sharing a bus group with a labeled volume
  // belongs to that label group, even though (being unassigned) it has no label.
  // The per-bay ".index" is NOT derivable from hardware, so unassigned drives sort
  // after the labeled volumes within their group rather than getting a fake index.
  const labelGroupByBus = new Map<number, number>();
  for (const row of volumeRows) {
    const parsed = parseGroupIndex(row.groupLabel);
    if (parsed && row.busGroup !== null && !labelGroupByBus.has(row.busGroup))
      labelGroupByBus.set(row.busGroup, parsed[0]);
  }

  // Unified sort key: [tier, group, index, deviceName, id].
  // tier 0 = placed within a known label group (labeled volumes + their unassigned
  // bus-group siblings); tier 1 = no label group derivable (a bus group with no
  // labeled volume), ordered by busGroup then device name after the grouped rows.
  const sortKey = (row: StorageVolumeRow): [number, number, number, string, number] => {
    const parsed = parseGroupIndex(row.groupLabel);
    if (parsed)
      return [0, parsed[0], parsed[1], row.device ?? '', row.id ?? 0];
    const mappedGroup = row.busGroup !== null ? labelGroupByBus.get(row.busGroup) : undefined;
    if (mappedGroup !== undefined)
      // Slot inline within the enclosure's group, after labeled volumes (index ∞)
      return [0, mappedGroup, Number.POSITIVE_INFINITY, row.device ?? '', row.id ?? 0];
    return [1, row.busGroup ?? Number.POSITIVE_INFINITY, 0, row.device ?? '', row.id ?? 0];
  };

  const rows = [...volumeRows, ...unassignedRows];
  rows.sort((a, b) => {
    const ka = sortKey(a);
    const kb = sortKey(b);
    for (let i = 0; i < ka.length; i++) {
      if (typeof ka[i] === 'string') {
        const cmp = (ka[i] as string).localeCompare(kb[i] as string);
        if (cmp !== 0) return cmp;
      } else if (ka[i] !== kb[i]) {
        return (ka[i] as number) - (kb[i] as number);
      }
    }
    return 0;
  });

  return rows;
});

// The unified volume rows ordered by the shared `sortBy`. Drives BOTH the table
// and the grid view so the two are genuinely two renderings of one sorted list.
// 'volumeLabel' keeps the careful group.index ordering computed above; the other
// modes re-sort, pushing rows without the sort field (unassigned/diskless) last.
const sortedStorageRows = computed<StorageVolumeRow[]>(() => {
  const rows = storageVolumeRows.value;
  if (sortBy.value === 'volumeLabel') return rows;

  const sorted = [...rows];
  sorted.sort((a, b) => {
    switch (sortBy.value) {
      case 'volumeId': {
        if (a.id !== null && b.id !== null) {
          if (a.id !== b.id) return a.id - b.id;
        } else if (a.id === null && b.id !== null) {
          return 1;
        } else if (a.id !== null && b.id === null) {
          return -1;
        }
        break;
      }
      case 'name': {
        const av = a.device ?? '';
        const bv = b.device ?? '';
        if (av !== bv) return av.localeCompare(bv);
        break;
      }
      case 'path': {
        const av = a.sysfsPath ?? '';
        const bv = b.sysfsPath ?? '';
        if (av === '' && bv !== '') return 1;
        if (av !== '' && bv === '') return -1;
        if (av !== bv) return av.localeCompare(bv);
        break;
      }
    }
    // Stable tiebreak so equal keys keep a deterministic order
    return a.key.localeCompare(b.key);
  });
  return sorted;
});

// Color band for a fullness bar based on how full the drive is
function fullnessClass(fraction: number): string {
  if (fraction >= 0.9) return 'fullness-critical';
  if (fraction >= 0.7) return 'fullness-warn';
  return 'fullness-ok';
}

// Tooltip text describing used / total capacity for a storage row
function fullnessTitle(row: StorageVolumeRow): string {
  if (row.bytesFree === null || row.bytesTotal <= 0) return 'Capacity unknown';
  const used = row.bytesTotal - row.bytesFree;
  return `${formatBytes(used)} used of ${formatBytes(row.bytesTotal)} (${formatBytes(row.bytesFree)} free)`;
}

// Fetch data from APIs
async function fetchData(): Promise<void> {
  try {
    loading.value = true;
    error.value = null;

    const [volumesRes, blockDevicesRes] = await Promise.all([
      apiFetch(`${apiBaseUrl}/$/volumes`),
      apiFetch(`${apiBaseUrl}/$/blockDevices?sort=sysfsPath`)
    ]);

    if (!volumesRes.ok || !blockDevicesRes.ok) {
      throw new Error('Failed to fetch data');
    }

    // Never show soft-deleted volumes, even if the API returns one (e.g. a live delete whose
    // in-memory flag hasn't propagated yet -- it only reliably drops out after a restart).
    volumes.value = (await volumesRes.json() as VolumeStatus[]).filter(v => !v.isDeleted);
    blockDevices.value = await blockDevicesRes.json();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Unknown error';
  } finally {
    loading.value = false;
  }
  void fetchStorageStats();
  void fetchEncryptionStatus();
}

// Refresh block devices by calling the reload endpoint
async function refreshDevices(): Promise<void> {
  try {
    loading.value = true;
    error.value = null;

    const [volumesRes, blockDevicesRes] = await Promise.all([
      apiFetch(`${apiBaseUrl}/$/volumes`),
      apiFetch(`${apiBaseUrl}/$/blockDevices/reload`, { method: 'POST' })
    ]);

    if (!volumesRes.ok || !blockDevicesRes.ok) {
      throw new Error('Failed to refresh data');
    }

    // Never show soft-deleted volumes, even if the API returns one (e.g. a live delete whose
    // in-memory flag hasn't propagated yet -- it only reliably drops out after a restart).
    volumes.value = (await volumesRes.json() as VolumeStatus[]).filter(v => !v.isDeleted);
    blockDevices.value = await blockDevicesRes.json();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Unknown error';
  } finally {
    loading.value = false;
  }
}

// Get block devices without volume IDs (available for provisioning)
const availableDevices = computed<BlockDevice[]>(() => {
  return blockDevices.value.filter(bd => !bd.volumeId);
});

// Check if a device has any mounted partitions
function hasMountedPartitions(device: BlockDevice): boolean {
  return device.children.some(child => child.mountpoint !== null);
}

// Check if a device can be created (either no partitions or wipe is checked)
function canCreateDevice(devicePath: string): boolean {
  const device = blockDevices.value.find(bd => bd.path === devicePath);
  if (!device) return false;

  // Don't allow if any partitions are mounted
  if (hasMountedPartitions(device)) return false;

  // If no partitions, always allow
  if (device.children.length === 0) return true;

  // If has partitions, require wipe to be checked
  return wipeDevices.value.has(devicePath);
}

// Check if all selected devices can be created
const canCreateVolumes = computed<boolean>(() => {
  if (selectedDevices.value.size === 0) return false;
  for (const devicePath of selectedDevices.value) {
    if (!canCreateDevice(devicePath)) return false;
  }
  return true;
});

// Get background color based on volume state
function getVolumeBackgroundColor(volume: VolumeStatus | null): string {
  if (!volume) return '#888888'; // darker gray for better contrast when faded
  if (!volume.isEnabled) return '#666666'; // darker gray for disabled
  if (volume.isReadOnly) return '#f9a825'; // dark yellow (better contrast)
  if (volume.isEnabled && !volume.isStarted) return '#f44336'; // red

  // Check for SMART errors or verify errors
  if (volume.isSmartHealthy === false || (volume.verifyErrors && hasVerifyErrors(volume.verifyErrors))) {
    return '#ff9800'; // orange for errors
  }

  return '#4caf50'; // green - healthy
}

// Check if verify errors object has any errors
function hasVerifyErrors(verifyErrors: unknown): boolean {
  if (!verifyErrors || typeof verifyErrors !== 'object') return false;
  const errors = verifyErrors as Record<string, number>;
  return Object.values(errors).some(count => count > 0);
}

// Get total verify error count
function getVerifyErrorCount(verifyErrors: unknown): number {
  if (!verifyErrors || typeof verifyErrors !== 'object') return 0;
  const errors = verifyErrors as Record<string, number>;
  return Object.values(errors).reduce((sum, count) => sum + count, 0);
}

// Format SMART status for display
function formatSmartStatus(volume: VolumeStatus | null): string {
  if (!volume) return 'N/A';
  if (volume.isSmartHealthy === null) return 'Not Supported';
  if (volume.isSmartHealthy === false) return 'FAILED';
  return 'Healthy';
}

// Format bytes to human readable
// `Math.log` of a negative number is NaN, and `sizes[NaN]` is undefined -- so a negative byte count used to
// render, literally, as "NaN undefined". Which is exactly what a drained volume showed, because the stats cache
// had drifted below zero (see StorageStatsTracker: an impossible count now heals itself).
//
// Handled here too, because a display that cannot render a number it is given is a display that hides the bug
// instead of showing it. A negative count is nonsense, but "-16 B" is nonsense you can READ.
function formatBytes(bytes: number): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—';
  if (bytes === 0) return '0 B';

  const sign = bytes < 0 ? '-' : '';
  const magnitude = Math.abs(bytes);

  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(Math.floor(Math.log(magnitude) / Math.log(k)), sizes.length - 1);
  return sign + (Math.round(magnitude / Math.pow(k, i) * 100) / 100) + ' ' + sizes[i];
}

// Toggle device selection
function toggleDeviceSelection(devicePath: string): void {
  if (selectedDevices.value.has(devicePath)) {
    selectedDevices.value.delete(devicePath);
    wipeDevices.value.delete(devicePath); // Also remove from wipe if deselected
  } else {
    selectedDevices.value.add(devicePath);
  }
}

// Toggle wipe option for a device
function toggleWipe(devicePath: string): void {
  if (wipeDevices.value.has(devicePath)) {
    wipeDevices.value.delete(devicePath);
  } else {
    wipeDevices.value.add(devicePath);
  }
}

// Open the add volume modal
function openModal(): void {
  selectedDevices.value.clear();
  wipeDevices.value.clear();
  showModal.value = true;
}

// Close the modal
function closeModal(): void {
  showModal.value = false;
}

// Create volumes for selected devices
async function createVolumes(): Promise<void> {
  if (selectedDevices.value.size === 0) return;

  creatingVolumes.value = true;
  const errors: string[] = [];

  try {
    for (const devicePath of selectedDevices.value) {
      try {
        const body: { blockPath: string; wipe?: number } = { blockPath: devicePath };

        if (wipeDevices.value.has(devicePath)) {
          body.wipe = Date.now();
        }

        const response = await apiFetch(`${apiBaseUrl}/$/volumes`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });

        if (!response.ok) {
          let errorText = `HTTP ${response.status}`;
          try {
            const text = await response.text();
            if (text) errorText += `: ${text}`;
          } catch {
            // Ignore error reading response body
          }
          errors.push(`${devicePath}: ${errorText}`);
        }
      } catch (err) {
        errors.push(`${devicePath}: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
    }

    if (errors.length > 0) {
      error.value = `Failed to create some volumes:\n${errors.join('\n')}`;
      // Don't close modal if there were errors
      return;
    }

    // Only refresh and close if all succeeded
    await refreshDevices();
    closeModal();
  } finally {
    creatingVolumes.value = false;
  }
}

// Resolve the volume the context menu is currently targeting
const contextMenuVolume = computed<VolumeStatus | null>(() => {
  if (contextMenu.value.volumeId === null) return null;
  return volumes.value.find(v => v.id === contextMenu.value.volumeId) ?? null;
});

const contextMenuEl = ref<HTMLElement | null>(null);

// Open the menu at the click point, then (once it has rendered and we know its real size) nudge it
// back inside the viewport so it never falls off the right or bottom edge.
function openContextMenuAt(x: number, y: number, volumeId: number): void {
  contextMenu.value = { x, y, volumeId };
  nextTick(() => {
    const el = contextMenuEl.value;
    if (!el) return;
    const margin = 8;
    const maxX = window.innerWidth - el.offsetWidth - margin;
    const maxY = window.innerHeight - el.offsetHeight - margin;
    const nx = Math.max(margin, Math.min(x, maxX));
    const ny = Math.max(margin, Math.min(y, maxY));
    if (nx !== x || ny !== y)
      contextMenu.value = { x: nx, y: ny, volumeId };
  });
}

// Show context menu on right-click
function showContextMenu(event: MouseEvent, volumeId: number): void {
  event.preventDefault();
  openContextMenuAt(event.clientX, event.clientY, volumeId);
}

// Hide context menu
function hideContextMenu(): void {
  contextMenu.value = { x: 0, y: 0, volumeId: null };
}

// Open edit label modal
function openEditLabelModal(): void {
  if (contextMenu.value.volumeId === null) return;
  const volume = volumes.value.find(v => v.id === contextMenu.value.volumeId);
  if (!volume) return;

  editingVolumeId.value = contextMenu.value.volumeId;
  editLabelValue.value = volume.label ?? '';
  showEditLabelModal.value = true;
  hideContextMenu();
}

// Close edit label modal
function closeEditLabelModal(): void {
  showEditLabelModal.value = false;
  editingVolumeId.value = null;
  editLabelValue.value = '';
}

// Save label
async function saveLabel(): Promise<void> {
  if (editingVolumeId.value === null || savingLabel.value) return;

  savingLabel.value = true;
  try {
    const response = await apiFetch(`${apiBaseUrl}/$/volumes/${editingVolumeId.value}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: editLabelValue.value || null })
    });

    if (!response.ok) {
      let errorMessage = `Failed to update label (HTTP ${response.status})`;
      try {
        const text = await response.text();
        if (text) errorMessage += `: ${text}`;
      } catch {
        // Ignore error reading response body
      }
      throw new Error(errorMessage);
    }

    await fetchData();
    closeEditLabelModal();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to update label';
  } finally {
    savingLabel.value = false;
  }
}

// Open edit comment modal
function openEditCommentModal(): void {
  if (contextMenu.value.volumeId === null) return;
  const volume = volumes.value.find(v => v.id === contextMenu.value.volumeId);
  if (!volume) return;

  editingCommentVolumeId.value = contextMenu.value.volumeId;
  editCommentValue.value = volume.comment ?? '';
  showEditCommentModal.value = true;
  hideContextMenu();
}

// Close edit comment modal
function closeEditCommentModal(): void {
  showEditCommentModal.value = false;
  editingCommentVolumeId.value = null;
  editCommentValue.value = '';
}

// Save comment
async function saveComment(): Promise<void> {
  if (editingCommentVolumeId.value === null || savingComment.value) return;

  savingComment.value = true;
  try {
    const response = await apiFetch(`${apiBaseUrl}/$/volumes/${editingCommentVolumeId.value}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ comment: editCommentValue.value || null })
    });

    if (!response.ok) {
      let errorMessage = `Failed to update comment (HTTP ${response.status})`;
      try {
        const text = await response.text();
        if (text) errorMessage += `: ${text}`;
      } catch {
        // Ignore error reading response body
      }
      throw new Error(errorMessage);
    }

    await fetchData();
    closeEditCommentModal();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to update comment';
  } finally {
    savingComment.value = false;
  }
}

// Enable or disable the volume targeted by the context menu
async function toggleVolumeEnabled(): Promise<void> {
  const volume = contextMenuVolume.value;
  if (volume === null) return;

  const volumeId = volume.id;
  const nextEnabled = !volume.isEnabled;
  hideContextMenu();

  if (!nextEnabled && !confirm(`Disable volume ${volumeId}? It will stop serving reads and writes.`)) {
    return;
  }

  try {
    const response = await apiFetch(`${apiBaseUrl}/$/volumes/${volumeId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isEnabled: nextEnabled })
    });

    if (!response.ok) {
      let errorMessage = `Failed to ${nextEnabled ? 'enable' : 'disable'} volume (HTTP ${response.status})`;
      try {
        const text = await response.text();
        if (text) errorMessage += `: ${text}`;
      } catch {
        // Ignore error reading response body
      }
      throw new Error(errorMessage);
    }

    await fetchData();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to update volume';
  }
}

// Toggle the read-only flag on the volume targeted by the context menu. PUTs the
// new flag to /$/volumes/{id} and refreshes. Available from both table and grid.
async function toggleVolumeReadOnly(): Promise<void> {
  const volume = contextMenuVolume.value;
  if (volume === null) return;

  const volumeId = volume.id;
  const nextReadOnly = !volume.isReadOnly;
  hideContextMenu();

  try {
    const response = await apiFetch(`${apiBaseUrl}/$/volumes/${volumeId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isReadOnly: nextReadOnly })
    });

    if (!response.ok) {
      let errorMessage = `Failed to ${nextReadOnly ? 'set' : 'clear'} read-only (HTTP ${response.status})`;
      try {
        const text = await response.text();
        if (text) errorMessage += `: ${text}`;
      } catch {
        // Ignore error reading response body
      }
      throw new Error(errorMessage);
    }

    await fetchData();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to update volume';
  }
}

// Drain the volume, or cancel an in-progress drain. Drain marks the drive read-only and
// reconstructs/relocates every slice it holds onto other healthy drives. Once drained the drive is
// empty + read-only; DELETING it is a separate, manual step. Cancel aborts the drain (already-relocated
// slices keep their new homes; the drive stays read-only until the operator clears it).
async function toggleVolumeDrain(): Promise<void> {
  const volume = contextMenuVolume.value;
  if (volume === null) return;

  const volumeId = volume.id;
  const cancelling = volume.isDraining;
  hideContextMenu();

  if (!cancelling && !confirm(`Drain volume ${volumeId}? It will be marked read-only and its slices reconstructed/relocated to other drives. This can take a while and moves data. Deleting the drive afterward is a separate, manual step.`)) {
    return;
  }

  try {
    const response = await apiFetch(`${apiBaseUrl}/$/volumes/${volumeId}/drain`, {
      method: cancelling ? 'DELETE' : 'POST'
    });

    if (!response.ok) {
      let errorMessage = `Failed to ${cancelling ? 'cancel drain' : 'drain'} (HTTP ${response.status})`;
      try {
        const text = await response.text();
        if (text) errorMessage += `: ${text}`;
      } catch {
        // Ignore error reading response body
      }
      throw new Error(errorMessage);
    }

    await fetchData();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to update drain';
  }
}

// ---------------------------------------------------------------------------------------------------
// ENCRYPTION (LUKS)
//
// PARTIAL ENCRYPTION IS PARTIAL PROTECTION. The one thing this UI must never do is imply the array is
// protected while any plaintext disk is still in it -- pulling that disk still leaks every slice on it.
// So we show the three states the API reports (encrypted / plaintext / unknown) and say plainly which
// disks would still leak.
// ---------------------------------------------------------------------------------------------------
const encryption = ref<StatusResponse['encryption'] | null>(null);
const encryptionBusy = ref(false);

const encryptionCoverage = computed(() => {
  const e = encryption.value;
  if (!e) return null;
  const total = e.encryptedVolumeIds.length + e.plaintextVolumeIds.length + e.unknownVolumeIds.length;
  return { total, encrypted: e.encryptedVolumeIds.length, plaintext: e.plaintextVolumeIds.length, unknown: e.unknownVolumeIds.length };
});

async function fetchEncryptionStatus(): Promise<void> {
  try {
    const res = await apiFetch(`${apiBaseUrl}/$/status`);
    if (!res.ok) return;
    encryption.value = (await res.json() as StatusResponse).encryption;
  } catch {
    // The banner simply doesn't render. Not worth failing the page over.
  }
}

// The fleet default for NEW disks. Changes NOTHING about the disks already in the array -- said out loud,
// because "turn on encryption" is exactly what an operator would expect to encrypt their data, and it does
// not.
async function setEncryptNewVolumes(value: boolean): Promise<void> {
  encryptionBusy.value = true;
  try {
    const res = await apiFetch(`${apiBaseUrl}/$/encryption/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ encryptNewVolumes: value })
    });
    if (!res.ok) throw new Error(`Failed to update (HTTP ${res.status})`);
    await fetchEncryptionStatus();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to update encryption setting';
  } finally {
    encryptionBusy.value = false;
  }
}

// SET OR CHANGE THE FLEET RECOVERY PASSPHRASE.
//
// This works because we hold the KEYFILE, and the keyfile opens every disk -- so the passphrase is not something
// we have to discover from the platters, it is something we WRITE to them. Changing it rewrites the second
// keyslot on every encrypted volume.
async function setRecoveryPassphrase(): Promise<void> {
  const existing = encryption.value?.hasRecoveryPassphrase;

  const current = existing
    ? prompt('Enter the CURRENT recovery passphrase.\n\nWithout it we will not change anything — an operator who '
      + 'cannot produce it is about to discover that the one in the safe is worthless, and better now than later.')
    : null;
  if (existing && !current) return;

  const next = prompt(
    existing
      ? `Enter the NEW recovery passphrase.\n\nIt will be written to all ${encryptionCoverage.value?.encrypted ?? 0} `
        + `encrypted disk(s). WRITE IT DOWN SOMEWHERE THAT IS NOT THIS MACHINE.`
      : 'Set the fleet recovery passphrase.\n\nIf the OS disk dies, this is the ONLY thing that can open these '
        + 'disks. WRITE IT DOWN SOMEWHERE THAT IS NOT THIS MACHINE. There is no undo.'
  );
  if (!next) return;

  encryptionBusy.value = true;
  try {
    const res = await apiFetch(`${apiBaseUrl}/$/encryption/passphrase`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passphrase: next, currentPassphrase: current ?? undefined })
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Failed to set the recovery passphrase (HTTP ${res.status})${text ? `: ${text}` : ''}`);
    }
    await fetchEncryptionStatus();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to set the recovery passphrase';
  } finally {
    encryptionBusy.value = false;
  }
}

// HAND THE PASSPHRASE BACK ONCE, so STRUBS can use it rather than merely recognise it.
//
// An array that recorded its passphrase before STRUBS kept a usable copy (or whose keyfile was restored from a
// different backup) holds a hash and nothing else -- it can check what you type and cannot encrypt a disk by
// itself. A hash does not run backwards, so the only way out is for the operator to say it one more time.
async function sealRecoveryPassphrase(): Promise<void> {
  const passphrase = prompt(
    'Enter the recovery passphrase you already set.\n\n'
    + 'It is checked against the one on record — a wrong one changes nothing — and then stored sealed with the '
    + 'keyfile, so STRUBS can encrypt disks without asking you again.\n\n'
    + 'No keyslot is touched. This is not a change of passphrase.'
  );
  if (!passphrase) return;

  encryptionBusy.value = true;
  try {
    const res = await apiFetch(`${apiBaseUrl}/$/encryption/seal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passphrase })
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Could not store the passphrase (HTTP ${res.status})${text ? `: ${text}` : ''}`);
    }
    await fetchEncryptionStatus();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to store the recovery passphrase';
  } finally {
    encryptionBusy.value = false;
  }
}

// PROVE THE RECOVERY PASSPHRASE STILL OPENS EVERY ENCRYPTED DISK.
//
// The keyfile makes the passphrase enforceable, so this is not the authority it once was -- but there is exactly
// one way for a disk to end up on the wrong passphrase that enforcement cannot prevent: it was ABSENT when the
// passphrase was last changed, and came back afterwards. Nothing else will ever notice, because STRUBS mounts
// with the keyfile and never touches that slot.
async function auditRecoveryPassphrase(): Promise<void> {
  const total = encryptionCoverage.value?.encrypted ?? 0;
  if (!total) return;

  // No prompt: we audit the passphrase THE FLEET RECORDS, which STRUBS holds sealed under the keyfile. Asking
  // the operator to type one would audit whatever they typed -- not what the array would actually tell them to
  // use on the day the OS disk dies. (This used to prompt and then throw the answer away, sending {}.)
  if (!confirm(
    `Check the recovery passphrase against all ${total} encrypted volume(s)?\n\n`
    + `This opens nothing and changes nothing — it asks each disk's LUKS header whether the passphrase still `
    + `fits. Takes about ${Math.ceil(total * 3)} seconds.`
  )) return;

  encryptionBusy.value = true;
  try {
    const res = await apiFetch(`${apiBaseUrl}/$/encryption/audit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Audit failed (HTTP ${res.status})${text ? `: ${text}` : ''}`);
    }
    await fetchEncryptionStatus();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to audit the recovery passphrase';
  } finally {
    encryptionBusy.value = false;
  }
}

// How long since the recovery passphrase was last PROVEN against the platters. Null = never, which on an
// encrypted fleet is the thing most worth saying.
const auditAgeDays = computed(() => {
  const at = encryption.value?.lastAudit?.checkedAt;
  if (!at) return null;
  return Math.floor((Date.now() - new Date(at).getTime()) / 86_400_000);
});

const auditIsStale = computed(() => {
  if (!encryptionCoverage.value?.encrypted) return false;   // nothing encrypted: nothing to prove
  const age = auditAgeDays.value;
  return age === null || age > 90;
});

// What a conversion is DOING right now, in words an operator can act on. It takes minutes -- the platter walk
// alone is ~90 seconds on the fullest disk in this array -- and a disabled button for two minutes is
// indistinguishable from a wedged system. The reasonable response to that (reload, click again, restart the
// service) is the worst thing you could do to a disk that is mid-wipe.
const CONVERSION_STEPS: Record<string, string> = {
  checking:    'Checking the volume is drained and safe to wipe',
  scanning:    'Scanning the platter for anything we must not destroy',
  wiping:      'Wiping the disk',
  encrypting:  'Writing the LUKS header and keyslots',
  formatting:  'Making the filesystem',
  registering: 'Bringing the volume back into service'
};

// A warning that lives behind a tab is a warning nobody sees. The dot is the only thing that reaches an
// operator who is looking at some other page -- so it has to fire for "you never set a passphrase" too, not
// just for the audit failures, because an array with no passphrase cannot be encrypted at all.
const encryptionAttentionReason = computed<string | null>(() => {
    const e = encryption.value;
    if (!e) return null;
    if (!e.hasRecoveryPassphrase) return 'No recovery passphrase is set';
    if (!e.passphraseUsable) return 'STRUBS cannot use the recorded recovery passphrase';
    if (e.lastAudit?.refused.length) return 'The recovery passphrase does not open every disk';
    if (e.lastAudit && !e.lastAudit.healthy) return 'The recovery passphrase could not be proven against every disk';
    if (auditIsStale.value) return 'The recovery passphrase has not been checked against the disks';
    return null;
});
const encryptionNeedsAttention = computed(() => encryptionAttentionReason.value !== null);

const conversion = computed(() => encryption.value?.conversion ?? null);

const conversionLabel = computed(() => {
  const c = conversion.value;
  if (!c) return '';

  const step = CONVERSION_STEPS[c.phase] ?? c.phase;

  // A COUNT, NOT A PERCENTAGE. We do not know how many files are on the platter until we have finished
  // walking it, so a percentage would be a number we made up. A rising count says "alive" without lying.
  return c.phase === 'scanning' && c.filesScanned
    ? `${step} — ${c.filesScanned.toLocaleString()} files so far`
    : step;
});

// Convert one volume to encrypted. This REBUILDS THE DISK:
async function encryptVolume(): Promise<void> {
  const volume = contextMenuVolume.value;
  if (volume === null) return;

  const volumeId = volume.id;
  hideContextMenu();

  // NOT ASKED FOR THE PASSPHRASE. STRUBS holds it, sealed under the keyfile, and it wrote these disks with it
  // in the first place -- re-typing it here guarded nothing and would have made an automatic provision (which
  // has no operator to ask) impossible. The server refuses if no passphrase has ever been set.
  if (!encryption.value?.hasRecoveryPassphrase) {
    error.value = 'Set a recovery passphrase before encrypting a disk — a volume with only the keyfile slot '
      + 'dies with the OS disk. Encryption tab → Set the recovery passphrase.';
    selectTab('encryption');
    return;
  }

  // Recorded, but not usable: STRUBS can check the passphrase and cannot produce it, so it cannot write the
  // keyslot. Send the operator to the one thing that fixes it rather than failing at the disk.
  if (!encryption.value.passphraseUsable) {
    error.value = 'STRUBS cannot use the recorded recovery passphrase — enter it once on the Encryption tab, '
      + 'and encryption will work without asking again.';
    selectTab('encryption');
    return;
  }

  if (!confirm(
    `Encrypt volume ${volumeId}?\n\n`
    + `This WIPES AND REBUILDS the disk as an encrypted volume. It only works on a volume that has already `
    + `been drained; the rebalance will refill it afterwards.\n\n`
    + `It is unlocked with the fleet recovery passphrase you already set.`
  )) return;

  encryptionBusy.value = true;

  // Poll while it runs, so the operator watches it work rather than watching nothing.
  const ticker = window.setInterval(() => void fetchEncryptionStatus(), 2000);

  try {
    const res = await apiFetch(`${apiBaseUrl}/$/volumes/${volumeId}/encrypt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Empty: STRUBS takes the passphrase from the seal. There is no `passphrase` here to send.
      body: JSON.stringify({})
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Failed to encrypt volume ${volumeId} (HTTP ${res.status})${text ? `: ${text}` : ''}`);
    }
    await fetchData();
    await fetchEncryptionStatus();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to encrypt volume';
  } finally {
    window.clearInterval(ticker);
    encryptionBusy.value = false;
    await fetchEncryptionStatus();
  }
}

// Identify a drive: flash its activity LED so the operator can find the physical bay. Opens a modal and
// heartbeats POST /identify every second; the server auto-stops ~3s after the last beat (self-heals a
// closed tab / lost cancel). Stop() closes the modal and sends an immediate DELETE.
async function openIdentify(): Promise<void> {
  const volume = contextMenuVolume.value;
  if (volume === null) return;
  const device = deviceNameFromBlockPath(volume.blockPath ?? null);
  hideContextMenu();
  identifyDrive.value = { volumeId: volume.id, device };
  await sendIdentifyBeat();
  if (identifyHeartbeatTimer !== null) clearInterval(identifyHeartbeatTimer);
  identifyHeartbeatTimer = setInterval(sendIdentifyBeat, 1000);
}

async function sendIdentifyBeat(): Promise<void> {
  const target = identifyDrive.value;
  if (target === null) return;
  try {
    const response = await apiFetch(`${apiBaseUrl}/$/volumes/${target.volumeId}/identify`, { method: 'POST' });
    if (!response.ok) {
      let message = `Failed to identify drive (HTTP ${response.status})`;
      try { const text = await response.text(); if (text) message += `: ${text}`; } catch { /* ignore */ }
      throw new Error(message);
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to identify drive';
    stopIdentify(); // don't keep beating a failing endpoint
  }
}

function stopIdentify(): void {
  const target = identifyDrive.value;
  if (identifyHeartbeatTimer !== null) { clearInterval(identifyHeartbeatTimer); identifyHeartbeatTimer = null; }
  identifyDrive.value = null;
  // Best-effort immediate stop; even if it doesn't land, the server's TTL stops the reads within ~3s.
  if (target !== null)
    void apiFetch(`${apiBaseUrl}/$/volumes/${target.volumeId}/identify`, { method: 'DELETE' }).catch(() => undefined);
}

// Set the shared sort field (used by the clickable table headers)
function setSort(field: 'volumeLabel' | 'volumeId' | 'name' | 'path'): void {
  sortBy.value = field;
}

// Open the volume action menu for a row via a left-click on its action button.
// Mirrors the right-click context menu the grid tiles use. `.stop` on the caller
// prevents the document click handler from immediately closing the menu.
function openRowMenu(event: MouseEvent, volumeId: number): void {
  openContextMenuAt(event.clientX, event.clientY, volumeId);
}

// Delete volume with confirmation
async function deleteVolume(): Promise<void> {
  if (contextMenu.value.volumeId === null) return;

  const volumeId = contextMenu.value.volumeId;
  hideContextMenu();

  if (!confirm('Are you sure you want to delete this volume? This action cannot be undone.')) {
    return;
  }

  if (!confirm('This will permanently delete the volume. Are you absolutely sure?')) {
    return;
  }

  try {
    const response = await apiFetch(`${apiBaseUrl}/$/volumes/${volumeId}`, {
      method: 'DELETE'
    });

    if (!response.ok) {
      let errorMessage = `Failed to delete volume (HTTP ${response.status})`;
      try {
        const text = await response.text();
        if (text) errorMessage += `: ${text}`; // e.g. "drain it first" when the drive still holds live slices
      } catch {
        // Ignore error reading response body
      }
      throw new Error(errorMessage);
    }

    await refreshDevices();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to delete volume';
  }
}

// ---- Top-level tabs, each with its own route ----
//
// The tab (and, inside Buckets, the browsed path) lives in the URL hash, so a refresh puts you back
// where you were. The path is never trusted on the way back in: it is re-traversed against the server,
// so a deep link to a since-deleted folder resolves to "gone" rather than silently landing somewhere
// else that now occupies part of the chain.
type MainTab = 'overview' | 'maintenance' | 'volumes' | 'encryption' | 'buckets' | 'credentials';
const MAIN_TABS: MainTab[] = ['overview', 'maintenance', 'volumes', 'encryption', 'buckets', 'credentials'];
const activeTab = ref<MainTab>('overview');

function parseHash(): { tab: MainTab; path: string } {
  const raw = window.location.hash.replace(/^#\/?/, '');
  const [tab = '', ...rest] = raw.split('/');
  const known = (MAIN_TABS as string[]).includes(tab) ? (tab as MainTab) : 'overview';
  let path = '';
  try { path = rest.filter(Boolean).map(decodeURIComponent).join('/'); }
  catch { path = ''; }   // a malformed %-escape must not wedge the app
  return { tab: known, path };
}

function writeHash(tab: MainTab, path = ''): void {
  const suffix = path ? '/' + path.split('/').map(encodeURIComponent).join('/') : '';
  const next = `#/${tab}${suffix}`;
  if (window.location.hash !== next)
    window.location.hash = next;
}

function selectTab(tab: MainTab): void {
  // An error from the Volumes tab has nothing to say about Buckets. It used to scroll out of sight on its own;
  // now that it is pinned, leaving it up would follow the operator around the whole app.
  error.value = null;
  activeTab.value = tab;
  writeHash(tab, tab === 'buckets' ? browsePath.value : '');
  if (tab === 'buckets' && !buckets.value.length) void fetchBuckets();
  if (tab === 'credentials' && !credentials.value.length) void fetchCredentials();
  if (tab === 'encryption') void fetchEncryptionStatus();
}

// ---- Buckets & Access (Phase 4 UI over the dark bucket-auth model) ----
type BucketRow = {
  id: string;
  name: string;
  publicRead: boolean | null;
  publicWrite: boolean | null;
  // Null until the (expensive) stats aggregation comes back -- names and policy render immediately.
  objectCount: number | null;
  logicalBytes: number | null;
  activity: { anon: number; auth: number };
};

type BrowseEntry = {
  id: string;
  name: string;
  isContainer: boolean;
  isFile: boolean;
  size: number | null;
  mime: string | null;
};
type CredentialGrant = { bucket: string; read: boolean; write: boolean };
type CredentialRow = {
  accessKeyId: string;
  name: string;
  grants: CredentialGrant[];
  enabled: boolean;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
};

const buckets = ref<BucketRow[]>([]);
const credentials = ref<CredentialRow[]>([]);
const authEnforced = ref<boolean | null>(null);
// Separate errors per tab: they render on different tabs, so sharing one ref meant a credentials failure
// could appear on Buckets, and a successful bucket load could silently clear a credentials error.
const bucketError = ref<string | null>(null);
const credentialError = ref<string | null>(null);
const accessBusy = ref(false);
let accessPollTimer: ReturnType<typeof setInterval> | null = null;

// New-credential form.
const newCredName = ref('');
const newCredGrants = ref<CredentialGrant[]>([{ bucket: '*', read: true, write: false }]);
// A freshly-issued secret is shown ONCE; kept here until the operator dismisses it.
const issuedSecret = ref<{ accessKeyId: string; secret: string } | null>(null);

// Bucket names + policy + enforcement. Fast: the server deliberately leaves the object counts out of
// this, because computing them is a $group across every file in the array (~4s) and there is no reason
// to make the toggles wait on it.
async function fetchBuckets(): Promise<void> {
  try {
    const res = await apiFetch(`${apiBaseUrl}/$/buckets`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const statsById = new Map(buckets.value.map(b => [b.id, b]));   // keep counts we already have
    buckets.value = data.buckets.map((b: BucketRow) => ({
      ...b,
      objectCount: statsById.get(b.id)?.objectCount ?? null,
      logicalBytes: statsById.get(b.id)?.logicalBytes ?? null
    }));
    authEnforced.value = data.enforced;
    bucketError.value = null;
  }
  catch (err) {
    bucketError.value = err instanceof Error ? err.message : 'Failed to load buckets';
  }
}

// The expensive half, fetched separately and merged in when it lands. Cached server-side.
const bucketStatsLoading = ref(false);
async function fetchBucketStats(): Promise<void> {
  bucketStatsLoading.value = true;
  try {
    const res = await apiFetch(`${apiBaseUrl}/$/buckets/stats`);
    if (!res.ok) return;
    const { stats } = await res.json();
    const byId = new Map<string, { objectCount: number; logicalBytes: number }>(
      stats.map((s: { bucketId: string; objectCount: number; logicalBytes: number }) => [s.bucketId, s])
    );
    for (const b of buckets.value) {
      const s = byId.get(b.id);
      b.objectCount = s?.objectCount ?? 0;
      b.logicalBytes = s?.logicalBytes ?? 0;
    }
  }
  catch { /* counts are cosmetic; a failure must not blank the bucket list */ }
  finally { bucketStatsLoading.value = false; }
}

async function fetchCredentials(): Promise<void> {
  try {
    const res = await apiFetch(`${apiBaseUrl}/$/credentials`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    credentials.value = (await res.json()).credentials;
    credentialError.value = null;
  }
  catch (err) {
    credentialError.value = err instanceof Error ? err.message : 'Failed to load credentials';
  }
}

// ---- Bucket content browser (file explorer) ----
const BROWSE_PAGE = 500;
const browsePath = ref('');                       // '' = the bucket list itself
const browseEntries = ref<BrowseEntry[]>([]);
const browseHasMore = ref(false);
const browseLoading = ref(false);
const browseError = ref<string | null>(null);
// Monotonic token: only the newest request may write the results. Clicking A then B, where A's response
// arrives last, would otherwise paint A's contents under B's breadcrumbs.
let browseRequest = 0;

const breadcrumbs = computed(() => {
  const parts = browsePath.value ? browsePath.value.split('/') : [];
  return parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join('/') }));
});

async function openPath(path: string): Promise<void> {
  bucketError.value = null;      // clear a stale "that path no longer exists" once you navigate again
  browsePath.value = path;
  writeHash('buckets', path);
  await loadBrowse();
}

async function loadBrowse(): Promise<void> {
  if (!browsePath.value) {                        // at the top: the bucket list is the view
    browseEntries.value = [];
    browseHasMore.value = false;
    return;
  }
  const token = ++browseRequest;
  const requestedPath = browsePath.value;
  browseLoading.value = true;
  browseError.value = null;
  try {
    const res = await apiFetch(
      `${apiBaseUrl}/$/browse?path=${encodeURIComponent(requestedPath)}&limit=${BROWSE_PAGE}`
    );
    if (token !== browseRequest) return;          // superseded by a newer navigation

    if (res.status === 404) {
      // The server re-traverses the whole chain from the database, so a 404 means this path genuinely no
      // longer exists. Fall back to the bucket list rather than showing the contents of whatever else now
      // sits at that name -- and say so on the LIST view, because the browse view we'd have shown the
      // message in is the very thing we're leaving.
      bucketError.value = `That path no longer exists: /${requestedPath}`;
      browseEntries.value = [];
      browsePath.value = '';
      writeHash('buckets', '');
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    browseEntries.value = data.entries;
    browseHasMore.value = data.hasMore;
  }
  catch (err) {
    if (token !== browseRequest) return;
    browseError.value = err instanceof Error ? err.message : 'Failed to browse';
    browseEntries.value = [];
  }
  finally {
    if (token === browseRequest) browseLoading.value = false;
  }
}

// Fetch the next page and append. Paged by the last NAME we hold, which is what the server orders by --
// so it stays correct (and index-backed) however large the folder is.
async function loadMoreBrowse(): Promise<void> {
  if (!browseHasMore.value || browseLoading.value) return;
  const after = browseEntries.value[browseEntries.value.length - 1]?.name;
  if (!after) return;

  const token = ++browseRequest;
  const requestedPath = browsePath.value;
  browseLoading.value = true;
  try {
    const res = await apiFetch(
      `${apiBaseUrl}/$/browse?path=${encodeURIComponent(requestedPath)}`
      + `&after=${encodeURIComponent(after)}&limit=${BROWSE_PAGE}`
    );
    if (token !== browseRequest || requestedPath !== browsePath.value) return;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    browseEntries.value = [...browseEntries.value, ...data.entries];
    browseHasMore.value = data.hasMore;
  }
  catch (err) {
    if (token !== browseRequest) return;
    browseError.value = err instanceof Error ? err.message : 'Failed to load more';
  }
  finally {
    if (token === browseRequest) browseLoading.value = false;
  }
}

// The object's URL on the OBJECT origin (plain HTTP, separate port) -- not the admin origin we're on.
function objectUrl(entryPath: string): string {
  return `http://${window.location.hostname}/${entryPath.split('/').map(encodeURIComponent).join('/')}`;
}

// Checkbox handler for the bucket policy toggles. publicWrite gets an explicit, visible confirmation
// (not just a tooltip) because it also grants anonymous DELETE. Reverts the checkbox on cancel/failure.
async function onPolicyToggle(bucket: BucketRow, field: 'publicRead' | 'publicWrite', event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const value = input.checked;
  if (field === 'publicWrite' && value) {
    if (!confirm(`Make bucket "${bucket.name}" publicly writable?\n\nThis ALSO allows anonymous DELETE — anyone could overwrite or delete any object in this bucket.`)) {
      input.checked = false;
      return;
    }
  }
  await setBucketPolicy(bucket, field, value);
  // Reflect the authoritative state: on failure setBucketPolicy left bucket[field] unchanged, so snap
  // the checkbox back to it.
  input.checked = bucket[field] === true;
}

async function setBucketPolicy(bucket: BucketRow, field: 'publicRead' | 'publicWrite', value: boolean): Promise<void> {
  accessBusy.value = true;
  try {
    const res = await apiFetch(`${apiBaseUrl}/$/buckets/${bucket.id}/policy`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [field]: value })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    bucket[field] = value;
  }
  catch (err) { bucketError.value = err instanceof Error ? err.message : 'Failed to update bucket policy'; }
  finally { accessBusy.value = false; }
}

function addNewGrant(): void {
  newCredGrants.value.push({ bucket: '*', read: true, write: false });
}
function removeNewGrant(index: number): void {
  newCredGrants.value.splice(index, 1);
}

async function createCredential(): Promise<void> {
  accessBusy.value = true;
  credentialError.value = null;
  try {
    const res = await apiFetch(`${apiBaseUrl}/$/credentials`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newCredName.value.trim() || 'unnamed', grants: newCredGrants.value })
    });
    if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
    issuedSecret.value = await res.json();          // shown once
    newCredName.value = '';
    newCredGrants.value = [{ bucket: '*', read: true, write: false }];
    await fetchCredentials();
  }
  catch (err) { credentialError.value = err instanceof Error ? err.message : 'Failed to create credential'; }
  finally { accessBusy.value = false; }
}

async function toggleCredentialEnabled(cred: CredentialRow): Promise<void> {
  accessBusy.value = true;
  try {
    const res = await apiFetch(`${apiBaseUrl}/$/credentials/${encodeURIComponent(cred.accessKeyId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !cred.enabled })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    cred.enabled = !cred.enabled;
  }
  catch (err) { credentialError.value = err instanceof Error ? err.message : 'Failed to update credential'; }
  finally { accessBusy.value = false; }
}

async function rotateCredential(cred: CredentialRow): Promise<void> {
  if (!confirm(`Rotate the secret for "${cred.name}"? The current secret stops working immediately.`)) return;
  accessBusy.value = true;
  try {
    const res = await apiFetch(`${apiBaseUrl}/$/credentials/${encodeURIComponent(cred.accessKeyId)}/rotate`, { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    issuedSecret.value = await res.json();          // new secret, shown once
  }
  catch (err) { credentialError.value = err instanceof Error ? err.message : 'Failed to rotate credential'; }
  finally { accessBusy.value = false; }
}

async function deleteCredential(cred: CredentialRow): Promise<void> {
  if (!confirm(`Delete credential "${cred.name}" (${cred.accessKeyId})? This cannot be undone.`)) return;
  accessBusy.value = true;
  try {
    const res = await apiFetch(`${apiBaseUrl}/$/credentials/${encodeURIComponent(cred.accessKeyId)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await fetchCredentials();
  }
  catch (err) { credentialError.value = err instanceof Error ? err.message : 'Failed to delete credential'; }
  finally { accessBusy.value = false; }
}

async function setAuthEnforced(value: boolean): Promise<void> {
  const msg = value
    ? 'Enable auth enforcement?\n\nThe object API is plain HTTP, so Basic credentials will cross the wire in CLEARTEXT. Only do this once the object API has TLS (or is on a trusted network). Anonymous access to non-public buckets will start being rejected immediately.'
    : 'Disable auth enforcement? The object API will accept all requests again.';
  if (!confirm(msg)) return;
  accessBusy.value = true;
  try {
    const res = await apiFetch(`${apiBaseUrl}/$/auth/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ authEnforced: value })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    authEnforced.value = (await res.json()).authEnforced;
  }
  catch (err) { bucketError.value = err instanceof Error ? err.message : 'Failed to update enforcement'; }
  finally { accessBusy.value = false; }
}

function copySecret(secret: string): void {
  void navigator.clipboard?.writeText(secret).catch(() => undefined);
}

// Load data and start the live-refresh timers. Called once authenticated (on mount if the session is
// already valid, or right after a successful login).
function startApp(): void {
  fetchData();
  fetchVerifyStatus();
  fetchStorageStats();
  fetchFreezeStatus();
  fetchRebalanceStatus();

  // Restore the tab (and browsed path) from the URL, then load what that tab needs.
  const { tab, path } = parseHash();
  activeTab.value = tab;
  browsePath.value = path;
  void fetchBuckets().then(() => {
    void fetchBucketStats();          // async: names/policy are already on screen
    if (browsePath.value) void loadBrowse();   // re-traverses; a dead path resets to the bucket list
  });
  void fetchCredentials();

  if (verifyPollTimer === null)
    verifyPollTimer = setInterval(() => { fetchVerifyStatus(); fetchFreezeStatus(); fetchRebalanceStatus(); }, 3000);
  if (storageStatsPollTimer === null)
    storageStatsPollTimer = setInterval(fetchStorageStats, 10000);
  // Slower poll: bucket activity counters and credential last-used don't need a 3s cadence, and the
  // counts are served from a server-side cache so this is cheap.
  if (accessPollTimer === null) {
    accessPollTimer = setInterval(() => {
      if (activeTab.value === 'buckets') { void fetchBuckets(); void fetchBucketStats(); }
      if (activeTab.value === 'credentials') void fetchCredentials();
    }, 15000);
  }
}

function stopApp(): void {
  if (verifyPollTimer !== null) { clearInterval(verifyPollTimer); verifyPollTimer = null; }
  if (storageStatsPollTimer !== null) { clearInterval(storageStatsPollTimer); storageStatsPollTimer = null; }
  if (accessPollTimer !== null) { clearInterval(accessPollTimer); accessPollTimer = null; }
}

// Back/forward buttons: follow the URL rather than fighting it.
function onHashChange(): void {
  const { tab, path } = parseHash();
  activeTab.value = tab;
  if (path !== browsePath.value) {
    browsePath.value = path;
    void loadBrowse();
  }
}

onMounted(async () => {
  document.addEventListener('click', hideContextMenu);
  window.addEventListener('hashchange', onHashChange);
  await checkAuth();
  if (authenticated.value)
    startApp();
});

onUnmounted(() => {
  stopApp();
  if (identifyDrive.value !== null) stopIdentify(); // stop flashing if the view is torn down mid-identify
  document.removeEventListener('click', hideContextMenu);
  window.removeEventListener('hashchange', onHashChange);
});
</script>

<template>
  <!-- Login gate: nothing renders until we know the auth state, then either the login card or the app. -->
  <div v-if="!authChecked" class="auth-loading">Loading…</div>

  <div v-else-if="!authenticated" class="login-screen">
    <form class="login-card" @submit.prevent="login">
      <h1>STRUBS</h1>
      <p class="login-sub">Administrator sign in</p>
      <input
        v-model="loginPassword"
        type="password"
        placeholder="Admin password"
        autocomplete="current-password"
        autofocus
        :disabled="loginPending"
      />
      <button type="submit" :disabled="loginPending || !loginPassword">
        {{ loginPending ? 'Signing in…' : 'Sign in' }}
      </button>
      <p v-if="loginError" class="login-error">{{ loginError }}</p>
    </form>
  </div>

  <div v-else class="container">
    <header>
      <h1>STRUBS</h1>
      <button @click="logout" class="logout-btn" title="Sign out">Sign out</button>
    </header>

    <!-- Top-level navigation. Each tab is its own route (#/volumes, #/buckets/photo/2024), so a refresh
         puts you back where you were. -->
    <nav class="main-tabs" role="tablist">
      <button
        v-for="tab in MAIN_TABS"
        :key="tab"
        type="button"
        class="main-tab"
        :class="{ active: activeTab === tab }"
        role="tab"
        :aria-selected="activeTab === tab"
        @click="selectTab(tab)"
      >
        {{ tab === 'overview' ? 'Overview'
         : tab === 'maintenance' ? 'Maintenance'
         : tab === 'volumes' ? 'Volumes'
         : tab === 'encryption' ? 'Encryption'
         : tab === 'buckets' ? 'Buckets'
         : 'Credentials' }}
        <span
          v-if="tab === 'maintenance' && maintenanceActive"
          class="tab-dot"
          title="Maintenance is running"
        >●</span>
        <span
          v-if="tab === 'encryption' && encryptionNeedsAttention"
          class="tab-dot warn"
          :title="encryptionAttentionReason ?? undefined"
        >●</span>
        <span
          v-if="tab === 'buckets' && authEnforced === false"
          class="tab-dot warn"
          title="The object API is unauthenticated"
        >●</span>
      </button>
    </nav>

    <!-- PINNED, NOT AT THE BOTTOM OF THE PAGE. It used to render after every section, which on the Volumes tab
         put it below thirty volume rows -- an error message you have to go looking for is not an error message. -->
    <div v-if="error" class="error">
      <span>Error: {{ error }}</span>
      <button type="button" class="error-dismiss" title="Dismiss" @click="error = null">&times;</button>
    </div>

    <!-- Everything below the tabs scrolls; the tabs and the error do not. -->
    <main class="tab-body">

    <!-- ===================== OVERVIEW ===================== -->
    <!-- Status at a glance: the maintenance BADGES (not its details -- those live on their own tab) and
         the storage figures. -->
    <section v-show="activeTab === 'overview'" class="section">
      <div class="section-header">
        <h2>Overview</h2>
        <span v-if="storageStats" class="storage-updated">Updated {{ formatDateTime(String(storageStats.updatedAt)) }}</span>
      </div>

      <div class="overview-badges">
        <span
          class="verify-state"
          :class="maintenanceActive ? 'running' : 'idle'"
          :title="maintenanceActivity.length ? maintenanceActivity.join(' · ') : 'Nothing running'"
        >
          Maintenance: {{ maintenanceActive ? 'Active' : 'Idle' }}
        </span>
        <span
          v-if="maintenanceFrozen !== null"
          class="freeze-pill"
          :class="maintenanceFrozen ? 'frozen' : 'active'"
        >
          {{ maintenanceFrozen ? '❄ Frozen' : '● Enabled' }}
        </span>
        <span v-if="maintenanceActivity.length" class="overview-activity">
          {{ maintenanceActivity.join(' · ') }}
        </span>
        <button type="button" class="access-mini-btn" @click="selectTab('maintenance')">Details →</button>
      </div>

      <div v-if="systemStats" class="storage-stats">
        <div class="storage-stat">
          <span class="storage-stat-label">Files</span>
          <span class="storage-stat-value">{{ systemStats.objectCount.toLocaleString() }}</span>
        </div>
        <div class="storage-stat">
          <span class="storage-stat-label">Logical Data</span>
          <span class="storage-stat-value">{{ formatBytes(systemStats.logicalBytes) }}</span>
        </div>
        <div class="storage-stat">
          <span class="storage-stat-label">Data Slices</span>
          <span class="storage-stat-value">{{ formatBytes(systemStats.dataBytes) }}</span>
        </div>
        <div class="storage-stat">
          <span class="storage-stat-label">Parity Slices</span>
          <span class="storage-stat-value">{{ formatBytes(systemStats.parityBytes) }}</span>
        </div>
        <div class="storage-stat">
          <span class="storage-stat-label">Physical Total</span>
          <span class="storage-stat-value">{{ formatBytes(systemStats.physicalBytes) }}</span>
        </div>
        <button
          type="button"
          class="access-mini-btn"
          :disabled="statsBusy"
          title="Recount from the object records. Reads only — no disk is touched, no object is changed."
          @click="recomputeStorageStats"
        >{{ statsBusy ? 'Recounting…' : 'Recount' }}</button>
        <div class="storage-stat">
          <span class="storage-stat-label">Total Capacity</span>
          <span class="storage-stat-value">{{ formatBytes(onlineAssignedCapacity) }}</span>
        </div>
        <div class="storage-stat">
          <span class="storage-stat-label">Unavailable</span>
          <span class="storage-stat-value" :class="{ 'error-text': systemStats.unavailableObjectCount > 0 }">
            {{ systemStats.unavailableObjectCount.toLocaleString() }} / {{ formatBytes(systemStats.unavailableLogicalBytes) }}
          </span>
        </div>
      </div>
      <p v-else class="storage-empty">Storage statistics are not available yet.</p>
    </section>

    <!-- ===================== MAINTENANCE ===================== -->
    <section v-show="activeTab === 'maintenance'" class="section verify-panel">
      <div class="verify-header maintenance-summary">
        <div class="verify-title">
          <h2>Maintenance</h2>
          <span
            class="verify-state"
            :class="maintenanceActive ? 'running' : 'idle'"
            :title="maintenanceActivity.length ? maintenanceActivity.join(' · ') : 'Nothing running'"
          >
            {{ maintenanceActive ? 'Active' : 'Idle' }}
          </span>
          <span
            v-if="maintenanceFrozen !== null"
            class="freeze-pill"
            :class="maintenanceFrozen ? 'frozen' : 'active'"
            :title="maintenanceFrozen ? 'Verify, repair, drain and rebalance are paused' : 'Verify, repair, drain and rebalance run automatically'"
          >
            {{ maintenanceFrozen ? '❄ Frozen' : '● Enabled' }}
          </span>
        </div>
        <div class="verify-actions">
          <button
            v-if="maintenanceFrozen !== null"
            @click="toggleFreeze"
            :disabled="freezePending"
            :class="maintenanceFrozen ? 'unfreeze-btn' : 'freeze-btn'"
          >
            {{ maintenanceFrozen
              ? (freezePending ? 'Unfreezing…' : 'Unfreeze')
              : (freezePending ? 'Freezing…' : 'Freeze') }}
          </button>
        </div>
      </div>

      <template v-if="true">
      <div v-if="maintenanceFrozen === true" class="freeze-banner">
        Maintenance is <strong>frozen</strong> — verify, repair, drain, and rebalance are paused.
      </div>
      <div class="verify-subheader">
        <h3>Rebalance</h3>
        <div class="verify-actions">
          <label class="concurrency-control" title="Slices relocated at once. Takes effect immediately, even mid-rebalance. Higher is faster on disks that can absorb the parallel I/O, but seek-bound drives thrash — raise it in small steps and watch the rate.">
            <span class="verify-stat-label">Concurrency</span>
            <input
              type="number"
              min="1"
              max="64"
              step="1"
              class="concurrency-input"
              :value="rebalanceStatus?.concurrency ?? ''"
              :disabled="concurrencyPending"
              @change="applyConcurrency($event)"
            />
          </label>
          <!--
            STOPPING IS NOT STOPPED, and the operator is watching.

            Cancelling stops the job taking NEW work immediately, but up to `concurrency` slice relocations are
            already in the air, and each is drained to a safe boundary: a slice is only unlinked from its source
            after the copy is fsynced and the database reference flipped. Interrupt that and you leave a
            duplicate, or a record pointing at a slice not yet fully on the platter.

            So for a while after the click the job is still running and the logs still scroll. Saying
            "Cancel Rebalance" through all of that makes the array look like it ignored you. It did not -- it is
            finishing what it had already started, which is the only safe thing it can do. Say THAT.
          -->
          <button
            @click="toggleRebalance"
            :disabled="rebalancePending || rebalanceStatus?.stopping === true || maintenanceFrozen === true"
            :class="rebalanceStatus?.running ? 'verify-stop-btn' : 'verify-start-btn'"
            :title="rebalanceStatus?.stopping === true
              ? 'Cancelled. Finishing the slice moves already in flight -- a slice is never left half-moved.'
              : maintenanceFrozen === true ? 'Paused by the maintenance freeze' : ''"
          >
            {{ rebalancePending
              ? 'Working...'
              : rebalanceStatus?.stopping ? 'Stopping...'
              : rebalanceStatus?.running ? 'Cancel Rebalance' : 'Start Rebalance' }}
          </button>
        </div>
      </div>

      <div v-if="rebalanceStatus?.running" class="rebalance-progress">
        <div class="rebalance-bar">
          <div class="rebalance-bar-fill" :style="{ width: `${(rebalanceProgress * 100).toFixed(1)}%` }"></div>
        </div>
        <span class="rebalance-progress-label">
          {{ formatBytes(rebalanceStatus.bytesMoved) }} moved,
          {{ formatBytes(rebalanceStatus.bytesToMove) }} to go
          ({{ (rebalanceProgress * 100).toFixed(1) }}%)
        </span>
      </div>

      <div class="verify-stats">
        <div class="verify-stat">
          <span class="verify-stat-label">Target Fill</span>
          <span class="verify-stat-value">
            {{ rebalanceStatus ? `${(rebalanceStatus.targetFill * 100).toFixed(1)}%` : '—' }}
          </span>
        </div>
        <div class="verify-stat">
          <span class="verify-stat-label">Left To Move</span>
          <span class="verify-stat-value">{{ rebalanceStatus ? formatBytes(rebalanceStatus.bytesToMove) : '—' }}</span>
        </div>
        <div class="verify-stat">
          <span class="verify-stat-label">Rate</span>
          <span class="verify-stat-value">
            {{ rebalanceStatus?.running ? `${formatBytes(rebalanceStatus.bytesPerSec)}/s` : '—' }}
          </span>
        </div>
        <div class="verify-stat">
          <span class="verify-stat-label">ETA</span>
          <span class="verify-stat-value">{{ rebalanceStatus?.running ? rebalanceEta : '—' }}</span>
        </div>
        <div class="verify-stat">
          <span class="verify-stat-label">Slices Moved</span>
          <span class="verify-stat-value">
            {{ (rebalanceStatus?.moves ?? 0).toLocaleString() }}
            <span v-if="rebalanceStatus" class="rebalance-submetric">
              ({{ rebalanceStatus.copied.toLocaleString() }} copied / {{ rebalanceStatus.reconstructed.toLocaleString() }} rebuilt)
            </span>
          </span>
        </div>
        <div class="verify-stat">
          <span class="verify-stat-label">Now Draining</span>
          <span class="verify-stat-value">
            {{ rebalanceStatus?.currentSourceVolumeId != null
              ? `vol ${rebalanceStatus.currentSourceVolumeId} · ${rebalanceTierLabel}`
              : '—' }}
          </span>
        </div>
      </div>

      <div v-if="rebalanceStatus && rebalanceStatus.sourceVolumeIds.length > 0" class="verify-targets">
        <span class="verify-stat-label">Over target:</span>
        <span
          v-for="id in rebalanceStatus.sourceVolumeIds"
          :key="id"
          class="verify-target-badge"
          :class="{ 'rebalance-active-source': id === rebalanceStatus.currentSourceVolumeId }"
        >
          vol {{ id }}
        </span>
      </div>
      <div v-if="rebalanceSkipped.length > 0" class="verify-volume-errors">
        <span class="verify-stat-label">Skipped:</span>
        <span v-for="entry in rebalanceSkipped" :key="entry.label" class="verify-volume-badge">
          {{ entry.count.toLocaleString() }} {{ entry.label }}
        </span>
      </div>
      <div class="verify-subheader">
        <!-- Grouped: the subheader is space-between, so a bare sibling would float to the middle. -->
        <div class="subheader-title">
          <h3>Verify</h3>
          <span v-if="verifyStatus?.waiting" class="verify-waiting-pill" title="A rebalance owns the disks; this run is queued and starts when it finishes">
            Waiting for rebalance
          </span>
        </div>
        <div class="verify-actions">
          <button
            @click="startVerify"
            :disabled="verifyStatus?.running || verifyActionPending"
            class="verify-start-btn"
          >
            {{ verifyActionPending ? 'Starting...' : 'Start Verify' }}
          </button>
          <button
            @click="stopVerify"
            :disabled="!verifyStatus?.running || stopRequested"
            class="verify-stop-btn"
          >
            {{ stopRequested ? 'Stopping...' : 'Stop' }}
          </button>
        </div>
      </div>
      <div class="verify-stats">
        <div class="verify-stat">
          <span class="verify-stat-label">Started</span>
          <span class="verify-stat-value">{{ formatDateTime(verifyStatus?.startedAt ?? null) }}</span>
        </div>
        <div class="verify-stat">
          <span class="verify-stat-label">Objects Verified</span>
          <span class="verify-stat-value">{{ (verifyStatus?.objectsVerified ?? 0).toLocaleString() }}</span>
        </div>
        <div class="verify-stat">
          <span class="verify-stat-label">Total Errors</span>
          <span class="verify-stat-value" :class="{ 'error-text': (verifyStatus?.errors?.total ?? 0) > 0 }">
            {{ (verifyStatus?.errors?.total ?? 0).toLocaleString() }}
          </span>
        </div>
        <div class="verify-stat">
          <span class="verify-stat-label">Concurrency</span>
          <span class="verify-stat-value">{{ verifyStatus?.concurrency ?? 0 }}</span>
        </div>
        <div class="verify-stat">
          <span class="verify-stat-label">Scope</span>
          <span class="verify-stat-value">{{ verifyScopeLabel }}</span>
        </div>
      </div>
      <div v-if="verifyTargetVolumes.length > 0" class="verify-targets">
        <span class="verify-stat-label">Target Volumes:</span>
        <span
          v-for="entry in verifyTargetVolumes"
          :key="entry.id"
          class="verify-target-badge"
        >
          {{ entry.label }}
        </span>
      </div>
      <div v-if="verifyVolumeErrors.length > 0" class="verify-volume-errors">
        <span class="verify-stat-label">Errors by volume:</span>
        <span
          v-for="entry in verifyVolumeErrors"
          :key="entry.volumeId"
          class="verify-volume-badge"
        >
          vol {{ entry.volumeId }}: {{ entry.count.toLocaleString() }}
        </span>
      </div>

      </template>
    </section>

    <!-- ===================== VOLUMES ===================== -->
    <section v-show="activeTab === 'volumes'" class="section storage-panel">
      <div class="section-header">
        <h2>Volumes</h2>
        <div class="controls">
          <button @click="refreshDevices" :disabled="loading" class="refresh-btn">
            {{ loading ? 'Loading...' : 'Refresh' }}
          </button>
          <button @click="openModal" :disabled="loading || availableDevices.length === 0" class="add-btn">
            + Add Volume
          </button>
        </div>
      </div>
      <!-- A CONVERSION IS RUNNING. It takes minutes and it wipes a disk. Say what it is doing, or a disabled
           button for two minutes looks exactly like a wedged system -- and the reasonable response to that
           (reload, click again, restart) is the worst thing you can do to a disk that is mid-wipe. -->
      <div v-if="conversion" class="access-banner warn conversion-banner">
        <span class="conversion-spinner" aria-hidden="true"></span>
        <span>
          <strong>Encrypting volume {{ conversion.volumeId }}.</strong>
          {{ conversionLabel }}.
          <em v-if="conversion.phase === 'scanning'">
            Nothing has been changed yet — this step exists to make sure nothing on the disk is worth keeping.
          </em>
          <em v-else>The disk is being rewritten. Do not pull it, and do not restart STRUBS.</em>
        </span>
      </div>

      <div class="volumes-view">
        <div class="volumes-toolbar">
          <div class="view-toggle" role="group" aria-label="Volumes view">
            <button
              type="button"
              class="view-toggle-btn"
              :class="{ active: volumesView === 'table' }"
              @click="volumesView = 'table'"
            >
              Table
            </button>
            <button
              type="button"
              class="view-toggle-btn"
              :class="{ active: volumesView === 'grid' }"
              @click="volumesView = 'grid'"
            >
              Grid
            </button>
          </div>
          <div class="sort-controls">
            <label for="volumes-sort" class="sort-label">Sort by:</label>
            <select id="volumes-sort" v-model="sortBy" class="sort-select">
              <option value="volumeLabel">Volume Label</option>
              <option value="volumeId">Volume ID</option>
              <option value="name">Device Name</option>
              <option value="path">Device Path</option>
            </select>
          </div>
        </div>

        <p v-if="sortedStorageRows.length === 0" class="volumes-empty">
          {{ loading ? 'Loading…' : 'No volumes or drives found.' }}
        </p>

        <!-- TABLE VIEW -->
        <div v-else-if="volumesView === 'table'" class="storage-table-wrap">
          <table class="storage-table">
            <thead>
              <tr>
                <th
                  class="sortable"
                  :class="{ 'sort-active': sortBy === 'volumeLabel' }"
                  @click="setSort('volumeLabel')"
                >
                  Volume<span v-if="sortBy === 'volumeLabel'" class="sort-arrow">▲</span>
                </th>
                <th
                  class="sortable"
                  :class="{ 'sort-active': sortBy === 'name' }"
                  @click="setSort('name')"
                >
                  Device<span v-if="sortBy === 'name'" class="sort-arrow">▲</span>
                </th>
                <th>Comment</th>
                <th>Status</th>
                <th>Files</th>
                <th>Data Slices</th>
                <th>Parity Slices</th>
                <th>Physical Total</th>
                <th>Capacity</th>
                <th>Fullness</th>
                <th class="actions-col"></th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="entry in sortedStorageRows"
                :key="entry.key"
                :class="{ 'storage-row-unassigned': entry.unassigned }"
                @contextmenu="entry.id !== null ? showContextMenu($event, entry.id) : null"
              >
                <td>
                  <div class="vol-id-cell">
                    <template v-if="!entry.unassigned">
                      <span class="vol-id-badge" :style="{ backgroundColor: entry.color }">{{ entry.id }}</span>
                      <span v-if="entry.groupLabel" class="vol-group-label">{{ entry.groupLabel }}</span>
                    </template>
                    <span v-else class="vol-unassigned-badge">unassigned</span>
                  </div>
                </td>
                <td class="device-cell" :title="entry.identityTitle ?? undefined">{{ entry.device ?? '—' }}</td>
                <td class="comment-cell" :title="entry.volume?.comment ?? undefined">
                  <span v-if="entry.volume?.comment" class="comment-text">{{ entry.volume.comment }}</span>
                  <span v-else class="state-muted">—</span>
                </td>
                <td>
                  <div class="status-cell">
                    <span v-if="entry.volume?.isReadOnly" class="state-badge ro" title="Read-only">RO</span>
                    <span v-if="entry.volume?.isEncrypted" class="state-badge encrypted" title="LUKS encrypted">🔒</span>
                    <span v-if="entry.volume?.isDraining" class="state-badge draining" title="Draining (draining slices to other drives)">Draining</span>
                    <span v-if="entry.volume && !entry.volume.isEnabled" class="state-badge disabled" title="Disabled">Disabled</span>
                    <span
                      v-else-if="entry.volume && !entry.blockDevice"
                      class="state-badge offline"
                      title="Volume has no online block device"
                    >Offline</span>
                    <span v-if="entry.volume?.isSmartHealthy === false" class="state-badge err" title="SMART failed">SMART</span>
                    <span
                      v-if="entry.volume && getVerifyErrorCount(entry.volume.verifyErrors) > 0"
                      class="state-badge err"
                      :title="getVerifyErrorCount(entry.volume.verifyErrors) + ' verify errors'"
                    >Errors</span>
                    <span v-if="!entry.volume" class="state-muted">—</span>
                  </div>
                </td>
                <td>{{ entry.stats.objectCount.toLocaleString() }}</td>
                <td>{{ entry.stats.dataSliceCount.toLocaleString() }}</td>
                <td>{{ entry.stats.paritySliceCount.toLocaleString() }}</td>
                <td>{{ formatBytes(entry.stats.physicalBytes) }}</td>
                <td>{{ entry.bytesTotal > 0 ? formatBytes(entry.bytesTotal) : '—' }}</td>
                <td class="fullness-cell">
                  <div v-if="entry.usedFraction !== null" class="fullness" :title="fullnessTitle(entry)">
                    <div class="fullness-bar" :class="fullnessClass(entry.usedFraction)">
                      <div class="fullness-fill" :style="{ width: (entry.usedFraction * 100).toFixed(1) + '%' }"></div>
                    </div>
                    <span class="fullness-label">{{ Math.round(entry.usedFraction * 100) }}%</span>
                  </div>
                  <span v-else class="fullness-unknown" title="Capacity unknown">—</span>
                </td>
                <td class="actions-col">
                  <button
                    v-if="entry.id !== null"
                    type="button"
                    class="row-action-btn"
                    title="Volume actions"
                    @click.stop="openRowMenu($event, entry.id)"
                  >⋮</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- GRID VIEW (tiles) -->
        <div v-else class="devices-list">
          <div
            v-for="entry in sortedStorageRows"
            :key="entry.key"
            class="device-card"
            :class="{ offline: entry.volume && !entry.blockDevice }"
            :style="{ opacity: entry.unassigned ? 0.6 : 1 }"
            @contextmenu="entry.id !== null ? showContextMenu($event, entry.id) : null"
          >
            <!-- Title and badges stack on the LEFT (badges under the name, so they never wrap around it);
                 the action button sits alone on the RIGHT, after them. -->
            <div class="device-header" :style="{ backgroundColor: entry.color }">
              <div class="device-head-main">
                <div class="device-name">
                  <span v-if="entry.groupLabel" class="label-prefix">{{ entry.groupLabel }}</span>
                  {{ entry.unassigned ? (entry.device ?? 'Drive') : ('Volume ' + entry.id) }}
                </div>
                <div class="device-badges">
                  <div v-if="entry.busGroup !== null" class="badge">Bus {{ entry.busGroup }}</div>
                  <div class="badge">{{ formatBytes(entry.bytesTotal) }}</div>
                  <div v-if="entry.volume?.isReadOnly" class="badge ro-badge">READ-ONLY</div>
                  <div v-if="entry.volume?.isEncrypted" class="badge encrypted-badge" title="LUKS encrypted">🔒 ENCRYPTED</div>
                  <div v-if="entry.volume?.isDraining" class="badge draining-badge">DRAINING</div>
                  <div v-if="entry.volume && !entry.volume.isEnabled" class="badge offline-badge">DISABLED</div>
                  <div v-else-if="entry.volume && !entry.blockDevice" class="badge offline-badge">OFFLINE</div>
                  <div v-if="entry.unassigned" class="badge offline-badge">UNASSIGNED</div>
                </div>
              </div>
              <button
                v-if="entry.id !== null"
                type="button"
                class="tile-action-btn"
                title="Volume actions"
                @click.stop="openRowMenu($event, entry.id)"
              >⋮</button>
            </div>
            <div class="device-body">
              <div class="device-info">
                <div class="info-row">
                  <span class="label">Device:</span>
                  <span class="value">{{ entry.device ?? 'N/A' }}</span>
                </div>
                <div class="info-row" v-if="!entry.unassigned">
                  <span class="label">Read Only:</span>
                  <span class="value">{{ entry.volume?.isReadOnly ? 'Yes' : 'No' }}</span>
                </div>
                <div class="info-row" v-if="entry.volume">
                  <span class="label">Enabled:</span>
                  <span class="value">{{ entry.volume.isEnabled ? 'Yes' : 'No' }}</span>
                </div>
                <div class="info-row" v-if="entry.volume">
                  <span class="label">SMART Status:</span>
                  <span class="value" :class="{ 'error-text': entry.volume.isSmartHealthy === false }">
                    {{ formatSmartStatus(entry.volume) }}
                  </span>
                </div>
                <div class="info-row" v-if="entry.volume && getVerifyErrorCount(entry.volume.verifyErrors) > 0">
                  <span class="label">Verify Errors:</span>
                  <span class="value error-text">{{ getVerifyErrorCount(entry.volume.verifyErrors) }}</span>
                </div>
                <div class="info-row" v-if="entry.blockDevice?.model ?? entry.volume?.deviceModel">
                  <span class="label">Model:</span>
                  <span class="value">{{ entry.blockDevice?.model ?? entry.volume?.deviceModel }}</span>
                </div>
                <div class="info-row" v-if="entry.blockDevice?.serial ?? entry.volume?.deviceSerial">
                  <span class="label">Serial:</span>
                  <span class="value">{{ entry.blockDevice?.serial ?? entry.volume?.deviceSerial }}</span>
                </div>
                <div class="info-row">
                  <span class="label">Files:</span>
                  <span class="value">{{ entry.stats.objectCount.toLocaleString() }}</span>
                </div>
                <div class="info-row" v-if="entry.usedFraction !== null">
                  <span class="label">Fullness:</span>
                  <span class="value">{{ Math.round(entry.usedFraction * 100) }}%</span>
                </div>
                <div class="info-row" v-if="entry.volume?.comment">
                  <span class="label">Comment:</span>
                  <span class="value comment-value" :title="entry.volume.comment">{{ entry.volume.comment }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- ===================== BUCKETS ===================== -->
    <!-- ===================== ENCRYPTION ===================== -->
    <!-- Its own tab, because it is a property of the FLEET, not of the volume list it used to sit on top of.
         Deliberately never says "protected" while a single plaintext disk remains: pulling that disk still
         leaks every slice on it, and a green tick here would be a lie. -->
    <section v-show="activeTab === 'encryption'" class="section access-panel">
      <div class="verify-header">
        <div class="verify-title">
          <h2>Encryption</h2>
          <span
            v-if="encryptionCoverage"
            class="verify-state"
            :class="encryptionCoverage.encrypted > 0 && encryptionCoverage.plaintext === 0 ? 'running' : 'idle'"
          >
            {{ encryptionCoverage.encrypted }} / {{ encryptionCoverage.total }} encrypted
          </span>
          <span v-if="encryptionCoverage?.unknown" class="access-hint">
            {{ encryptionCoverage.unknown }} disk(s) absent — encryption state unknown
          </span>
        </div>
      </div>

      <!-- THE ONE THING WE ACTUALLY WANT FROM THE OPERATOR. Not a nag: nothing here can be encrypted until it
           exists, and it is the only part of this that a dead OS disk cannot take away from you. -->
      <div v-if="encryption && !encryption.hasRecoveryPassphrase" class="access-banner secret banner-standalone">
        <div>
          <strong>Set a recovery passphrase — encryption starts here.</strong>
          STRUBS unlocks these disks by itself, with a keyfile on the OS disk, so this is not something you type
          at boot. It is the <em>only</em> thing that opens your data if that OS disk ever dies — and without it,
          losing the OS disk would lose every byte on every encrypted platter. That is why STRUBS will not
          encrypt a single disk until one is set.
        </div>
        <div class="secret-row">
          <button class="access-toggle-btn on" :disabled="encryptionBusy" @click="setRecoveryPassphrase">
            Set the recovery passphrase
          </button>
          <span class="access-hint">Then write it down somewhere that is not this machine. There is no reset.</span>
        </div>
      </div>

      <!-- RECORDED, BUT NOT USABLE. The array can recognise the passphrase and cannot produce it, so it cannot
           write a keyslot -- and nothing else in the UI would ever say so. -->
      <div
        v-if="encryption && encryption.hasRecoveryPassphrase && !encryption.passphraseUsable"
        class="access-banner warn banner-standalone"
      >
        <div>
          <strong>STRUBS cannot use the recovery passphrase it has on record.</strong>
          It holds a hash — enough to check the passphrase you type, not enough to write it onto a disk (a hash
          does not run backwards). This happens when the passphrase was set before STRUBS kept a usable copy, or
          when the keyfile was restored from a different backup. <em>No disk is at risk</em>, and the passphrase
          you wrote down is still the right one: encryption simply cannot proceed until STRUBS is given it once.
        </div>
        <div class="secret-row">
          <button class="access-toggle-btn on" :disabled="encryptionBusy" @click="sealRecoveryPassphrase">
            Enter it once
          </button>
          <span class="access-hint">Nothing is changed and no keyslot is touched. It is the same passphrase.</span>
        </div>
      </div>

      <div class="encryption-bar">
        <div class="access-enforce-row encryption-default">
          <div>
            <div class="access-subtitle">Encrypt new volumes</div>
            <div class="access-hint">
              Applies to disks added from now on. <em>It converts nothing that is already in the array</em> —
              use “Encrypt” on a drained volume for that.
            </div>
          </div>
          <button
            class="access-toggle-btn"
            :class="{ on: encryption?.encryptNewVolumes }"
            :disabled="encryptionBusy || !encryption"
            @click="setEncryptNewVolumes(!encryption?.encryptNewVolumes)"
          >
            {{ encryption?.encryptNewVolumes ? 'On' : 'Off' }}
          </button>
        </div>

        <div class="access-enforce-row encryption-default">
          <div>
            <div class="access-subtitle">Recovery passphrase</div>
            <div class="access-hint">
              The only thing that opens these disks if the OS disk dies. Changing it rewrites the keyslot on
              every encrypted volume, so <em>attach every disk before you change it</em>.
            </div>
          </div>
          <button class="access-toggle-btn" :disabled="encryptionBusy" @click="setRecoveryPassphrase">
            {{ encryption?.hasRecoveryPassphrase ? 'Change' : 'Set' }}
          </button>
        </div>

        <div v-if="encryptionCoverage && encryptionCoverage.encrypted > 0" class="access-enforce-row encryption-default">
          <div>
            <div class="access-subtitle">Prove it against the disks</div>
            <div class="access-hint">
              <template v-if="encryption?.lastAudit?.healthy">
                Last proven against all {{ encryption.lastAudit.total }} encrypted disk(s)
                {{ auditAgeDays === 0 ? 'today' : `${auditAgeDays} day(s) ago` }}.
              </template>
              <template v-else-if="auditAgeDays === null">
                <em>Never checked.</em> Nobody has confirmed these disks can actually be recovered.
              </template>
              <template v-else>Last checked {{ auditAgeDays }} day(s) ago.</template>
            </div>
          </div>
          <button
            class="access-toggle-btn"
            :class="{ on: encryption?.lastAudit?.healthy }"
            :disabled="encryptionBusy"
            @click="auditRecoveryPassphrase"
          >
            Check the disks
          </button>
        </div>
      </div>

      <div
        v-if="encryptionCoverage && encryptionCoverage.encrypted > 0 && encryptionCoverage.plaintext > 0"
        class="access-banner warn banner-standalone"
      >
        <strong>This array is partially encrypted.</strong>
        {{ encryptionCoverage.plaintext }} volume(s) are still plaintext — pulling any one of them exposes
        every slice it holds. Encryption protects a disk that leaves the building; it does nothing for the
        disks that haven't been converted.
      </div>

      <!-- THE WORST NEWS THIS PAGE CAN CARRY. Every disk mounts, every disk serves, the array looks perfect --
           and the passphrase in your safe opens only some of them. Nothing else in the system will ever notice,
           because STRUBS mounts with the keyfile and never touches the passphrase slot. -->
      <div
        v-if="encryption?.lastAudit && encryption.lastAudit.refused.length"
        class="access-banner error banner-standalone"
      >
        <strong>THE RECOVERY PASSPHRASE DOES NOT OPEN EVERY DISK.</strong>
        Volume{{ encryption.lastAudit.refused.length === 1 ? '' : 's' }}
        {{ encryption.lastAudit.refused.map(d => d.volumeId).join(', ') }}
        do not open with it — almost certainly because they were unplugged when the passphrase was last changed.
        If the keyfile is lost, those disks are lost with it.
        <strong>Set the passphrase again with every disk attached</strong>, and they will be rewritten.
      </div>

      <div
        v-else-if="encryption?.lastAudit && encryption.lastAudit.unreadable.length"
        class="access-banner warn banner-standalone"
      >
        <strong>Some encrypted disks could not be checked.</strong>
        The LUKS header on {{ encryption.lastAudit.unreadable.map(d => d.path).join(', ') }} would not read, so
        we cannot say whether the recovery passphrase still opens
        {{ encryption.lastAudit.unreadable.length === 1 ? 'it' : 'them' }}.
        That is a disk fault, not a passphrase fault — but it means those volumes' recoverability is unknown.
      </div>

      <!-- An encrypted disk we cannot identify is one the fleet-passphrase check cannot see -- which is how a
           fleet ends up split. The audit counts it as unhealthy; the UI must not then say "last checked today"
           and leave it at that. -->
      <!-- An audit that could not even ASK a disk cannot say the fleet is recoverable. An unplugged volume is
           the likeliest one to be wrong, because it is the one a rotation could not reach. -->
      <div
        v-else-if="encryption?.lastAudit && encryption.lastAudit.notChecked?.length"
        class="access-banner warn banner-standalone"
      >
        <strong>The passphrase was not checked against every disk.</strong>
        Volume{{ encryption.lastAudit.notChecked.length === 1 ? '' : 's' }}
        {{ encryption.lastAudit.notChecked.join(', ') }}
        {{ encryption.lastAudit.notChecked.length === 1 ? 'was' : 'were' }} not attached, so
        {{ encryption.lastAudit.notChecked.length === 1 ? 'it' : 'they' }} could not be asked — and an unplugged
        disk is the one most likely to have missed a passphrase change. Attach every disk and check again.
      </div>

      <div
        v-else-if="encryption?.lastAudit && encryption.lastAudit.unidentified.length"
        class="access-banner warn banner-standalone"
      >
        <strong>An encrypted disk here is not identifiable.</strong>
        {{ encryption.lastAudit.unidentified.join(', ') }}
        {{ encryption.lastAudit.unidentified.length === 1 ? 'is a LUKS container' : 'are LUKS containers' }}
        carrying no STRUBS nameplate, so we cannot tell whether
        {{ encryption.lastAudit.unidentified.length === 1 ? 'it belongs' : 'they belong' }} to this array.
        Encryption is blocked until {{ encryption.lastAudit.unidentified.length === 1 ? 'it is' : 'they are' }}
        identified or detached.
      </div>

      <div v-else-if="auditIsStale" class="access-banner warn banner-standalone">
        <strong>The recovery passphrase has {{ auditAgeDays === null ? 'never been' : 'not been' }} checked
        against the disks{{ auditAgeDays === null ? '' : ` in ${auditAgeDays} days` }}.</strong>
        STRUBS unlocks these disks with the keyfile, so a passphrase that has stopped working would not show up
        anywhere else — until the day you need it. Check it now.
      </div>
    </section>

    <section v-show="activeTab === 'buckets'" class="section access-panel">
      <div class="verify-header">
        <div class="verify-title">
          <h2>Buckets</h2>
          <span class="verify-state" :class="authEnforced ? 'running' : 'idle'">
            {{ authEnforced === null ? '—' : (authEnforced ? 'Enforced' : 'Open') }}
          </span>
        </div>
      </div>

      <div v-if="authEnforced === false" class="access-banner warn banner-standalone">
        <strong>The object API is unauthenticated.</strong>
        Every bucket is publicly readable and writable regardless of the policy toggles below —
        they take effect only once enforcement is enabled.
      </div>

      <!-- ---------- Bucket CONTENTS (file explorer) ---------- -->
      <div v-if="browsePath" class="access-body">
        <div class="browse-bar">
          <nav class="breadcrumbs" aria-label="Breadcrumb">
            <button type="button" class="crumb" @click="openPath('')">Buckets</button>
            <template v-for="(crumb, i) in breadcrumbs" :key="crumb.path">
              <span class="crumb-sep">/</span>
              <button
                type="button"
                class="crumb"
                :class="{ current: i === breadcrumbs.length - 1 }"
                @click="openPath(crumb.path)"
              >{{ crumb.name }}</button>
            </template>
          </nav>
          <span v-if="browseLoading" class="browse-status">Loading…</span>
        </div>

        <div v-if="browseError" class="access-banner error">{{ browseError }}</div>

        <table v-else class="access-table browse-table">
          <thead>
            <tr>
              <th>Name</th>
              <th class="num">Size</th>
              <th>Type</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="entry in browseEntries"
              :key="entry.id"
              :class="{ clickable: entry.isContainer }"
              @click="entry.isContainer && openPath(browsePath + '/' + entry.name)"
            >
              <td>
                <span class="entry-icon">{{ entry.isContainer ? '📁' : '📄' }}</span>
                <span :class="{ 'entry-folder': entry.isContainer }">{{ entry.name }}</span>
              </td>
              <td class="num">{{ entry.isFile && entry.size !== null ? formatBytes(entry.size) : '—' }}</td>
              <td class="entry-mime">{{ entry.isContainer ? 'folder' : (entry.mime || 'unknown') }}</td>
              <td class="access-actions">
                <a
                  v-if="entry.isFile"
                  class="access-mini-btn"
                  :href="objectUrl(browsePath + '/' + entry.name)"
                  target="_blank"
                  rel="noopener"
                  @click.stop
                >Open</a>
              </td>
            </tr>
            <tr v-if="!browseEntries.length && !browseLoading">
              <td colspan="4" class="access-empty">This folder is empty.</td>
            </tr>
          </tbody>
        </table>

        <div v-if="browseHasMore" class="browse-more">
          <button
            type="button"
            class="access-mini-btn"
            :disabled="browseLoading"
            @click="loadMoreBrowse"
          >{{ browseLoading ? 'Loading…' : 'Load more' }}</button>
          <span class="browse-count">{{ browseEntries.length.toLocaleString() }} shown</span>
        </div>
        <p v-else-if="browseEntries.length" class="browse-more">
          <span class="browse-count">{{ browseEntries.length.toLocaleString() }} entries</span>
        </p>
      </div>

      <!-- ---------- Bucket LIST ---------- -->
      <div v-else class="access-body">
        <!-- Also where a "that path no longer exists" message lands: the browse view it would otherwise
             have shown in is exactly the view we just left. -->
        <div v-if="bucketError" class="access-banner error">{{ bucketError }}</div>

        <!-- Enforcement switch -->
        <div class="access-subsection">
          <div class="access-enforce-row">
            <div>
              <div class="access-subtitle">Auth enforcement</div>
              <div class="access-hint">
                While off, all object requests are allowed (today's behaviour). Turning it on begins
                rejecting anonymous access to non-public buckets.
                <em>The object API is plain HTTP — Basic credentials cross the wire in cleartext.</em>
              </div>
            </div>
            <button
              class="access-toggle-btn"
              :class="{ on: authEnforced }"
              :disabled="accessBusy || authEnforced === null"
              @click="setAuthEnforced(!authEnforced)"
            >
              {{ authEnforced ? 'Enforced' : 'Enable enforcement' }}
            </button>
          </div>
        </div>

        <!-- Buckets -->
        <div class="access-subsection">
          <div class="access-subtitle">
            Buckets
            <span v-if="bucketStatsLoading" class="browse-status">counting…</span>
          </div>
          <table class="access-table">
            <thead>
              <tr>
                <th>Bucket</th>
                <th class="num">Objects</th>
                <th class="num">Size</th>
                <th>Public read</th>
                <th>Public write</th>
                <th class="num" title="Requests seen since the server last started">Anon / Auth</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="b in buckets" :key="b.id">
                <td>
                  <button type="button" class="bucket-link" @click="openPath(b.name)" title="Browse this bucket">
                    📁 {{ b.name }}
                  </button>
                </td>
                <!-- Counts arrive separately (a $group over every file); the names and toggles above do
                     not wait on them. -->
                <td class="num">{{ b.objectCount === null ? '…' : b.objectCount.toLocaleString() }}</td>
                <td class="num">{{ b.logicalBytes === null ? '…' : formatBytes(b.logicalBytes) }}</td>
                <td>
                  <label class="access-switch">
                    <input
                      type="checkbox"
                      :checked="b.publicRead === true"
                      :disabled="accessBusy"
                      @change="onPolicyToggle(b, 'publicRead', $event)"
                    />
                    <span>{{ b.publicRead === null ? 'unset' : (b.publicRead ? 'public' : 'private') }}</span>
                  </label>
                </td>
                <td>
                  <label class="access-switch" title="Public write also allows anonymous DELETE">
                    <input
                      type="checkbox"
                      :checked="b.publicWrite === true"
                      :disabled="accessBusy"
                      @change="onPolicyToggle(b, 'publicWrite', $event)"
                    />
                    <span :class="{ 'write-warn': b.publicWrite === true }">
                      {{ b.publicWrite === null ? 'unset' : (b.publicWrite ? 'public — incl. anon DELETE' : 'private') }}
                    </span>
                  </label>
                </td>
                <td class="num">{{ b.activity.anon.toLocaleString() }} / {{ b.activity.auth.toLocaleString() }}</td>
              </tr>
              <tr v-if="!buckets.length"><td colspan="6" class="access-empty">No buckets.</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>

    <!-- ===================== CREDENTIALS ===================== -->
    <section v-show="activeTab === 'credentials'" class="section access-panel">
      <div class="verify-header">
        <div class="verify-title">
          <h2>Credentials</h2>
        </div>
      </div>

      <div class="access-body">
        <div v-if="credentialError" class="access-banner error">{{ credentialError }}</div>

        <div class="access-subsection">
          <div class="access-hint">
            Object-API credentials (HTTP Basic). They take effect only while auth enforcement is on.
          </div>

          <!-- A newly-issued secret, shown once. -->
          <div v-if="issuedSecret" class="access-banner secret">
            <div><strong>Secret for {{ issuedSecret.accessKeyId }}</strong> — copy it now, it is not shown again.</div>
            <div class="secret-row">
              <code class="mono">{{ issuedSecret.secret }}</code>
              <button class="access-mini-btn" @click="copySecret(issuedSecret.secret)">Copy</button>
              <button class="access-mini-btn" @click="issuedSecret = null">Dismiss</button>
            </div>
          </div>

          <table class="access-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Access key</th>
                <th>Grants</th>
                <th>Last used</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="c in credentials" :key="c.accessKeyId" :class="{ disabled: !c.enabled }">
                <td>{{ c.name }}</td>
                <td class="mono">{{ c.accessKeyId }}</td>
                <td>
                  <span v-for="(g, gi) in c.grants" :key="gi" class="grant-pill">
                    {{ g.bucket }}:{{ g.read ? 'r' : '' }}{{ g.write ? 'w' : '' }}
                  </span>
                </td>
                <td>{{ formatDateTime(c.lastUsedAt) }}</td>
                <td class="access-actions">
                  <button class="access-mini-btn" :disabled="accessBusy" @click="toggleCredentialEnabled(c)">
                    {{ c.enabled ? 'Disable' : 'Enable' }}
                  </button>
                  <button class="access-mini-btn" :disabled="accessBusy" @click="rotateCredential(c)">Rotate</button>
                  <button class="access-mini-btn danger" :disabled="accessBusy" @click="deleteCredential(c)">Delete</button>
                </td>
              </tr>
              <tr v-if="!credentials.length"><td colspan="5" class="access-empty">No credentials.</td></tr>
            </tbody>
          </table>

          <!-- Create form -->
          <div class="access-create">
            <div class="access-subtitle small">New credential</div>
            <div class="access-create-row">
              <input v-model="newCredName" class="access-input" placeholder="Name (e.g. photo-app)" />
            </div>
            <div v-for="(g, gi) in newCredGrants" :key="gi" class="access-grant-row">
              <input v-model="g.bucket" class="access-input grant-bucket" placeholder="bucket or *" />
              <label class="access-switch"><input type="checkbox" v-model="g.read" /><span>read</span></label>
              <label class="access-switch"><input type="checkbox" v-model="g.write" /><span>write</span></label>
              <button class="access-mini-btn" :disabled="newCredGrants.length <= 1" @click="removeNewGrant(gi)">✕</button>
            </div>
            <div class="access-create-row">
              <button class="access-mini-btn" @click="addNewGrant">+ grant</button>
              <button class="access-btn primary" :disabled="accessBusy" @click="createCredential">Create credential</button>
            </div>
          </div>
        </div>
      </div>
    </section>

      <div
        v-if="!error && loading && !storageStats && volumes.length === 0 && blockDevices.length === 0"
        class="loading"
      >
        Loading...
      </div>
    </main>

    <!-- Add Volume Modal -->
    <div v-if="showModal" class="modal-overlay" @click="closeModal">
      <div class="modal" @click.stop>
        <div class="modal-header">
          <h2>Add Volume</h2>
          <button @click="closeModal" class="close-btn">&times;</button>
        </div>
        <div class="modal-body">
          <p v-if="availableDevices.length === 0" class="no-devices">
            No available devices without volumes.
          </p>
          <div v-else class="device-list">
            <div
              v-for="device in availableDevices"
              :key="device.path"
              class="modal-device-item"
            >
              <label class="device-checkbox" :class="{ 'disabled': hasMountedPartitions(device) }">
                <input
                  type="checkbox"
                  :checked="selectedDevices.has(device.path)"
                  @change="toggleDeviceSelection(device.path)"
                  :disabled="hasMountedPartitions(device)"
                />
                <div class="device-info-modal">
                  <div class="device-name-modal">{{ device.name }}</div>
                  <div class="device-details">
                    {{ device.path }} - {{ formatBytes(device.size) }}
                    <span v-if="device.model"> - {{ device.model }}</span>
                  </div>
                  <div v-if="hasMountedPartitions(device)" class="partition-error">
                    Cannot add: has mounted partition(s)
                  </div>
                  <div v-else-if="device.children.length > 0" class="partition-info">
                    Has {{ device.children.length }} partition(s) - wipe required
                  </div>
                </div>
              </label>
              <label
                v-if="device.children.length > 0 && selectedDevices.has(device.path)"
                class="wipe-checkbox"
              >
                <input
                  type="checkbox"
                  :checked="wipeDevices.has(device.path)"
                  @change="toggleWipe(device.path)"
                />
                <span class="wipe-label">Wipe</span>
              </label>
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button @click="closeModal" class="cancel-btn">Cancel</button>
          <button
            @click="createVolumes"
            :disabled="!canCreateVolumes || creatingVolumes"
            class="create-btn"
          >
            {{ creatingVolumes ? 'Creating...' : `Create ${selectedDevices.size} Volume${selectedDevices.size !== 1 ? 's' : ''}` }}
          </button>
        </div>
      </div>
    </div>

    <!-- Context Menu -->
    <div
      v-if="contextMenu.volumeId !== null"
      ref="contextMenuEl"
      class="context-menu"
      :style="{ top: `${contextMenu.y}px`, left: `${contextMenu.x}px` }"
      @click.stop
    >
      <div class="context-menu-item" @click="openEditLabelModal">Edit Label</div>
      <div class="context-menu-item" @click="openEditCommentModal">Edit Comment</div>
      <div
        v-if="contextMenuVolume"
        class="context-menu-item"
        @click="toggleVolumeReadOnly"
      >
        {{ contextMenuVolume.isReadOnly ? 'Clear Read-Only' : 'Set Read-Only' }}
      </div>
      <div
        v-if="contextMenuVolume"
        class="context-menu-item"
        @click="toggleVolumeEnabled"
      >
        {{ contextMenuVolume.isEnabled ? 'Disable' : 'Enable' }}
      </div>
      <div
        v-if="contextMenuVolume"
        class="context-menu-item"
        @click="toggleVolumeDrain"
      >
        {{ contextMenuVolume.isDraining ? 'Cancel Drain' : 'Drain (read-only + offload)' }}
      </div>
      <!-- Only offered on a plaintext volume: encrypting REBUILDS the disk, so the server refuses unless it
           has already been drained. Shown regardless, so the refusal explains itself rather than the action
           simply not being there. -->
      <div
        v-if="contextMenuVolume && !contextMenuVolume.isEncrypted"
        class="context-menu-item"
        @click="encryptVolume"
      >
        Encrypt (wipe + rebuild, drained only)
      </div>
      <div
        v-if="contextMenuVolume"
        class="context-menu-item"
        @click="openIdentify"
      >
        Identify (flash LED)
      </div>
      <div class="context-menu-item delete" @click="deleteVolume">Delete</div>
    </div>

    <!-- Identify Drive Modal: flashing LED indicator + stop -->
    <div v-if="identifyDrive !== null" class="modal-overlay" @click="stopIdentify">
      <div class="modal identify-modal" @click.stop style="max-width: 420px;">
        <div class="modal-header">
          <h2>Identify Drive</h2>
          <button @click="stopIdentify" class="close-btn">&times;</button>
        </div>
        <div class="modal-body">
          <div class="identify-status">
            <span class="identify-blink" aria-hidden="true"></span>
            <div>
              <div class="identify-line">
                Flashing volume <strong>{{ identifyDrive.volumeId }}</strong><span v-if="identifyDrive.device"> (<code>{{ identifyDrive.device }}</code>)</span>
              </div>
              <div class="identify-hint">Watch the drive bays for the flashing activity LED. Reads are read-only and stop automatically a few seconds after you close this.</div>
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button @click="stopIdentify" class="create-btn">Stop</button>
        </div>
      </div>
    </div>

    <!-- Edit Label Modal -->
    <div v-if="showEditLabelModal" class="modal-overlay" @click="closeEditLabelModal">
      <div class="modal" @click.stop style="max-width: 400px;">
        <div class="modal-header">
          <h2>Edit Label</h2>
          <button @click="closeEditLabelModal" class="close-btn">&times;</button>
        </div>
        <div class="modal-body">
          <label class="form-label">Volume Label</label>
          <input
            v-model="editLabelValue"
            type="text"
            class="form-input"
            placeholder="Enter label (optional)"
            @keyup.enter="saveLabel"
          />
        </div>
        <div class="modal-footer">
          <button @click="closeEditLabelModal" class="cancel-btn" :disabled="savingLabel">Cancel</button>
          <button @click="saveLabel" class="create-btn" :disabled="savingLabel">
            {{ savingLabel ? 'Saving...' : 'Save' }}
          </button>
        </div>
      </div>
    </div>

    <!-- Edit Comment Modal -->
    <div v-if="showEditCommentModal" class="modal-overlay" @click="closeEditCommentModal">
      <div class="modal" @click.stop style="max-width: 400px;">
        <div class="modal-header">
          <h2>Edit Comment</h2>
          <button @click="closeEditCommentModal" class="close-btn">&times;</button>
        </div>
        <div class="modal-body">
          <label class="form-label">Volume Comment</label>
          <textarea
            v-model="editCommentValue"
            class="form-input"
            rows="4"
            placeholder="Enter comment (optional)"
          ></textarea>
        </div>
        <div class="modal-footer">
          <button @click="closeEditCommentModal" class="cancel-btn" :disabled="savingComment">Cancel</button>
          <button @click="saveComment" class="create-btn" :disabled="savingComment">
            {{ savingComment ? 'Saving...' : 'Save' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.auth-loading {
  display: flex; align-items: center; justify-content: center;
  min-height: 60vh; color: #888; font-size: 15px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}

.login-screen {
  display: flex; align-items: center; justify-content: center;
  min-height: 80vh; padding: 20px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}
.login-card {
  display: flex; flex-direction: column; gap: 14px;
  width: 320px; max-width: 100%; padding: 32px;
  border: 1px solid #e0e0e0; border-radius: 10px;
  box-shadow: 0 2px 12px rgba(0,0,0,0.06); background: #fff;
}
.login-card h1 { margin: 0; font-size: 22px; text-align: center; }
.login-sub { margin: -6px 0 6px; text-align: center; color: #888; font-size: 13px; }
.login-card input {
  padding: 10px 12px; font-size: 15px;
  border: 1px solid #ccc; border-radius: 6px;
}
.login-card button {
  padding: 10px; font-size: 15px; font-weight: 600; color: #fff;
  background: #1565c0; border: none; border-radius: 6px; cursor: pointer;
}
.login-card button:disabled { opacity: 0.6; cursor: default; }
.login-error { margin: 0; color: #c62828; font-size: 13px; text-align: center; }

.logout-btn {
  padding: 6px 12px; font-size: 13px; font-weight: 600;
  color: #555; background: #f2f2f2; border: 1px solid #ddd;
  border-radius: 6px; cursor: pointer;
}
.logout-btn:hover { background: #e8e8e8; }

.container {
  /* The tab bar stays put and the page under it scrolls. dvh, not vh: on a phone the browser chrome slides away
     and 100vh is then taller than the screen, which hides the bottom of the scroller behind the URL bar. */
  height: 100dvh;
  overflow: hidden;
  display: flex;
  flex-direction: column;

  width: 100%;
  margin: 0 auto;
  padding: 20px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
  box-sizing: border-box;
}

/* min-height:0 is the whole trick. A flex item's default min-height is auto -- it refuses to shrink below its
   content -- so without this the body grows to fit the volume list, pushes the container past the viewport, and
   the WINDOW scrolls (taking the tabs with it) instead of this box. */
.tab-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
}

header, .main-tabs, .container > .error {
  flex: 0 0 auto;
}

header {
  margin-bottom: 15px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
}

h1 {
  font-size: 28px;
  font-weight: 600;
  margin: 0;
  color: #333;
}

h2 {
  font-size: 20px;
  font-weight: 600;
  margin-bottom: 15px;
  color: #555;
}

.controls {
  margin-bottom: 20px;
  display: flex;
  gap: 10px;
  justify-content: center;
}

.refresh-btn, .add-btn, .freeze-btn, .unfreeze-btn {
  padding: 6px 14px;
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;
}

.refresh-btn {
  background-color: #2196F3;
}

.refresh-btn:hover:not(:disabled) {
  background-color: #1976D2;
}

.refresh-btn:disabled, .add-btn:disabled, .freeze-btn:disabled, .unfreeze-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.add-btn {
  background-color: #4caf50;
}

.add-btn:hover:not(:disabled) {
  background-color: #45a049;
}

/* --- maintenance freeze --- */
.freeze-pill {
  font-size: 12px;
  font-weight: 600;
  padding: 3px 10px;
  border-radius: 999px;
  white-space: nowrap;
}
.freeze-pill.frozen {
  background-color: #e1f5fe;
  color: #0277bd;
  border: 1px solid #4fc3f7;
}
.freeze-pill.active {
  background-color: #e8f5e9;
  color: #2e7d32;
  border: 1px solid #81c784;
}
.freeze-banner {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 14px;
  margin-bottom: 15px;
  padding: 10px 16px;
  background-color: #e1f5fe;
  border: 1px solid #4fc3f7;
  border-radius: 6px;
  color: #01579b;
  font-size: 13px;
}
.freeze-btn {
  background-color: #ff9800;
}
.freeze-btn:hover:not(:disabled) {
  background-color: #f57c00;
}
.unfreeze-btn {
  background-color: #0288d1;
}
.unfreeze-btn:hover:not(:disabled) {
  background-color: #0277bd;
}

.section {
  margin-bottom: 40px;
  width: 100%;
}

.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 15px;
  flex-wrap: wrap;
  gap: 10px;
}

.section-header h2 {
  margin-bottom: 0;
}

.sort-controls {
  display: flex;
  align-items: center;
  gap: 8px;
}

.sort-label {
  font-size: 14px;
  font-weight: 500;
  color: #666;
}

.sort-select {
  padding: 6px 12px;
  border: 1px solid #ddd;
  border-radius: 4px;
  font-size: 14px;
  background-color: white;
  cursor: pointer;
  color: #333;
  font-family: inherit;
}

.sort-select:focus {
  outline: none;
  border-color: #2196F3;
}

.sort-select:hover {
  border-color: #bbb;
}

.error {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  background-color: #ffebee;
  color: #c62828;
  padding: 15px;
  border-radius: 4px;
  margin-bottom: 20px;
}

/* It is PINNED now -- it does not scroll away like it used to, so it needs a way out. */
.error-dismiss {
  flex: 0 0 auto;
  background: none;
  border: none;
  color: inherit;
  cursor: pointer;
  font-size: 22px;
  line-height: 1;
  padding: 0 4px;
  opacity: 0.6;
}

.error-dismiss:hover {
  opacity: 1;
}

.loading {
  text-align: center;
  padding: 40px;
  font-size: 18px;
  color: #666;
}

.devices-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 15px;
  width: 100%;
}

.device-card {
  border: 2px solid #ddd;
  border-radius: 8px;
  overflow: hidden;
  background-color: white;
  transition: opacity 0.3s, box-shadow 0.3s;
  min-width: 0;
}

.device-card:hover {
  box-shadow: 0 4px 8px rgba(0, 0, 0, 0.1);
}

.device-card.offline {
  border-style: dashed;
}

/* Title + badges stack on the left; the action button sits alone on the right, AFTER them. The badges
   previously shared a wrapping flex row with the title and the button, so a card with several badges
   wrapped into a mess. */
.device-header {
  padding: 15px 20px;
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  color: white;
  font-weight: 600;
}

.device-head-main {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;          /* let a long name ellipsize rather than push the button off */
}

.device-name {
  font-size: 18px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.label-prefix {
  background-color: rgba(255, 255, 255, 0.2);
  padding: 4px 10px;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 700;
}

.device-badges {
  display: flex;
  gap: 6px;
  align-items: center;
  flex-wrap: wrap;
}

.header-badges {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}

.badge {
  background-color: rgba(0, 0, 0, 0.3);
  padding: 4px 12px;
  border-radius: 12px;
  font-size: 12px;
  font-weight: 700;
}

.offline-badge {
  background-color: rgba(0, 0, 0, 0.5);
}

.device-body {
  padding: 20px;
}

.device-info {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.info-row {
  display: flex;
  justify-content: space-between;
  padding: 8px 0;
  border-bottom: 1px solid #f0f0f0;
}

.info-row .label {
  font-weight: 600;
  color: #666;
  margin-right: 10px;
}

.info-row .value {
  color: #333;
  text-align: right;
  word-break: break-word;
}

.info-row .value.small {
  font-size: 12px;
  font-family: monospace;
}

.error-text {
  color: #f44336;
  font-weight: 700;
}

/* Verify Panel */
.verify-panel {
  border: 1px solid #e0e0e0;
  border-radius: 8px;
  padding: 20px;
  background-color: #fafafa;
  box-sizing: border-box;
}

.verify-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 16px;
}

.maintenance-summary {
  cursor: pointer;
  user-select: none;
  margin-bottom: 0;
}

.collapse-chevron {
  font-size: 32px;
  line-height: 1;
  color: #666;
  width: 18px;
  display: inline-block;
}

.verify-subheader {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  margin: 14px 0 6px;
  padding-top: 12px;
  border-top: 1px solid #eee;
}

.verify-subheader h3 {
  margin: 0;
  font-size: 15px;
  color: #555;
}

/* Keeps a status pill hugging its heading instead of drifting into the middle of the
   space-between subheader. */
.subheader-title {
  display: flex;
  align-items: center;
  gap: 10px;
}

.verify-title {
  display: flex;
  align-items: center;
  gap: 12px;
}

.verify-title h2 {
  margin: 0;
}

.verify-state {
  padding: 3px 12px;
  border-radius: 12px;
  font-size: 12px;
  font-weight: 700;
  color: white;
}

.verify-state.running {
  background-color: #4caf50;
}

.verify-state.idle {
  background-color: #9e9e9e;
}

.verify-actions {
  display: flex;
  gap: 10px;
}

.verify-start-btn, .verify-stop-btn {
  padding: 6px 14px;
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;
}

.verify-start-btn {
  background-color: #4caf50;
}

.verify-start-btn:hover:not(:disabled) {
  background-color: #45a049;
}

.verify-stop-btn {
  background-color: #f44336;
}

.verify-stop-btn:hover:not(:disabled) {
  background-color: #d32f2f;
}

.verify-start-btn:disabled, .verify-stop-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.verify-stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 12px;
}

.verify-stat {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.verify-stat-label {
  font-size: 12px;
  font-weight: 600;
  color: #888;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.verify-stat-value {
  font-size: 16px;
  color: #333;
  font-weight: 600;
}

.verify-volume-errors {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid #eee;
}

.verify-targets {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid #eee;
}

.verify-target-badge {
  background-color: #e3f2fd;
  color: #1565c0;
  padding: 3px 10px;
  border-radius: 12px;
  font-size: 12px;
  font-weight: 600;
}

.verify-volume-badge {
  background-color: #ffebee;
  color: #c62828;
  padding: 3px 10px;
  border-radius: 12px;
  font-size: 12px;
  font-weight: 600;
}

/* Rebalance */
.concurrency-control {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-right: 4px;
}

.concurrency-input {
  width: 56px;
  padding: 4px 6px;
  border: 1px solid #ccc;
  border-radius: 4px;
  font-size: 13px;
  font-weight: 600;
  color: #333;
}

.concurrency-input:disabled {
  opacity: 0.6;
}

/* A verify held back until the rebalance releases the disks. */
.verify-waiting-pill {
  background-color: #fff3e0;
  color: #e65100;
  padding: 3px 10px;
  border-radius: 12px;
  font-size: 12px;
  font-weight: 600;
}

.rebalance-progress {
  margin-top: 16px;
}

.rebalance-bar {
  width: 100%;
  height: 8px;
  background-color: #eee;
  border-radius: 4px;
  overflow: hidden;
}

.rebalance-bar-fill {
  height: 100%;
  background-color: #1565c0;
  border-radius: 4px;
  transition: width 0.6s ease;
}

.rebalance-progress-label {
  display: block;
  margin-top: 6px;
  font-size: 12px;
  color: #666;
}

.rebalance-submetric {
  font-size: 12px;
  font-weight: 400;
  color: #888;
}

/* The source currently being drained, among the over-target volumes. */
.rebalance-active-source {
  background-color: #1565c0;
  color: #fff;
}

/* Storage Panel */
.storage-panel {
  border: 1px solid #e0e0e0;
  border-radius: 8px;
  padding: 20px;
  background-color: #fafafa;
  box-sizing: border-box;
}

.storage-updated {
  color: #777;
  font-size: 13px;
  font-weight: 500;
}

.storage-tabs {
  display: flex;
  gap: 4px;
  margin-bottom: 18px;
  border-bottom: 1px solid #e0e0e0;
}

.storage-tab {
  padding: 8px 16px;
  border: none;
  background: none;
  cursor: pointer;
  font-size: 14px;
  font-weight: 600;
  color: #888;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  font-family: inherit;
}

.storage-tab:hover {
  color: #555;
}

.storage-tab.active {
  color: #2196F3;
  border-bottom-color: #2196F3;
}

/* Volume id + group.index label cell */
.vol-id-cell {
  display: flex;
  align-items: center;
  gap: 8px;
}

.vol-id-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 28px;
  padding: 2px 8px;
  border-radius: 6px;
  color: white;
  font-weight: 700;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

.vol-group-label {
  background-color: #eceff1;
  color: #555;
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 12px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.vol-unassigned-badge {
  display: inline-flex;
  align-items: center;
  background-color: #eceff1;
  color: #888;
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

/* Non-volumed drives are visually muted and pinned to the bottom of the list */
.storage-table tr.storage-row-unassigned td {
  color: #999;
}

.storage-table tr.storage-row-unassigned td.device-cell {
  color: #999;
}

.storage-stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 12px;
}

.storage-stat {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.storage-stat-label {
  font-size: 12px;
  font-weight: 600;
  color: #888;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.storage-stat-value {
  font-size: 16px;
  color: #333;
  font-weight: 600;
}

.storage-table-wrap {
  overflow-x: auto;
  margin-top: 18px;
}

.storage-table {
  width: 100%;
  border-collapse: collapse;
  min-width: 860px;
}

.storage-table th,
.storage-table td {
  border-bottom: 1px solid #e8e8e8;
  padding: 10px 8px;
  text-align: right;
  white-space: nowrap;
}

.storage-table th:first-child,
.storage-table td:first-child {
  text-align: left;
}

.storage-table th {
  color: #666;
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.storage-table td {
  color: #333;
  font-size: 14px;
}

.storage-table td.device-cell {
  text-align: left;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  color: #555;
}

.storage-table td.comment-cell {
  text-align: left;
  max-width: 200px;
}

.comment-cell .comment-text {
  display: block;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #777;
  font-size: 13px;
}

.comment-value {
  display: inline-block;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: bottom;
}

.fullness-cell {
  min-width: 150px;
}

.fullness {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}

.fullness-bar {
  position: relative;
  flex: 1;
  max-width: 110px;
  height: 8px;
  background-color: #e8e8e8;
  border-radius: 4px;
  overflow: hidden;
}

.fullness-fill {
  height: 100%;
  border-radius: 4px;
  transition: width 0.3s ease;
}

.fullness-ok .fullness-fill {
  background-color: #2e9e5b;
}

.fullness-warn .fullness-fill {
  background-color: #d9a400;
}

.fullness-critical .fullness-fill {
  background-color: #d64545;
}

.fullness-label {
  min-width: 36px;
  text-align: right;
  font-variant-numeric: tabular-nums;
  color: #333;
}

.fullness-unknown {
  color: #999;
}

/* Volumes view: shared toolbar + view toggle */
.volumes-view {
  margin-top: 18px;
}

.volumes-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 12px;
}

.view-toggle {
  display: inline-flex;
  border: 1px solid #ddd;
  border-radius: 6px;
  overflow: hidden;
  background-color: white;
}

.view-toggle-btn {
  padding: 6px 16px;
  border: none;
  background: none;
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
  color: #666;
  font-family: inherit;
}

.view-toggle-btn + .view-toggle-btn {
  border-left: 1px solid #ddd;
}

.view-toggle-btn:hover {
  background-color: #f5f5f5;
}

.view-toggle-btn.active {
  background-color: #2196F3;
  color: white;
}

.volumes-empty,
.storage-empty {
  color: #888;
  font-size: 14px;
  padding: 16px 0;
}

/* Sortable table headers */
.storage-table th.sortable {
  cursor: pointer;
  user-select: none;
}

.storage-table th.sortable:hover {
  color: #2196F3;
}

.storage-table th.sort-active {
  color: #2196F3;
}

.sort-arrow {
  margin-left: 4px;
  font-size: 10px;
}

/* Status badges (table view) */
.status-cell {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  justify-content: flex-end;
}

.state-badge {
  padding: 2px 7px;
  border-radius: 10px;
  font-size: 11px;
  font-weight: 700;
  color: white;
  white-space: nowrap;
}

.state-badge.ro {
  background-color: #f9a825;
}

.state-badge.disabled {
  background-color: #757575;
}

.state-badge.offline {
  background-color: #f44336;
}

.state-badge.draining {
  background-color: #26a69a;
}

.state-badge.encrypted {
  background-color: #5c6bc0;
}

.state-badge.err {
  background-color: #ff9800;
}

.state-muted {
  color: #bbb;
}

/* Per-row / per-tile action buttons */
.actions-col {
  width: 36px;
  text-align: center !important;
}

.row-action-btn {
  border: none;
  background: none;
  cursor: pointer;
  font-size: 18px;
  line-height: 1;
  color: #888;
  padding: 2px 6px;
  border-radius: 4px;
  font-family: inherit;
}

.row-action-btn:hover {
  background-color: #f0f0f0;
  color: #333;
}

.tile-action-btn {
  border: none;
  background-color: rgba(0, 0, 0, 0.25);
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
  color: white;
  padding: 2px 8px;
  border-radius: 12px;
  font-weight: 700;
  font-family: inherit;
}

.tile-action-btn:hover {
  background-color: rgba(0, 0, 0, 0.45);
}

.ro-badge {
  background-color: rgba(0, 0, 0, 0.4);
}

.draining-badge {
  background-color: rgba(38, 166, 154, 0.85);
}

.encrypted-badge {
  background-color: rgba(92, 107, 192, 0.85);
}

/* --- encryption coverage bar (Volumes tab) --- */
.conversion-banner {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}

.conversion-spinner {
  flex: 0 0 auto;
  width: 14px;
  height: 14px;
  /* The track is the banner's own text colour, faded -- a white track would vanish into #fff8e1. */
  border: 2px solid rgba(122, 91, 0, 0.22);
  border-top-color: currentColor;
  border-radius: 50%;
  animation: conversion-spin 0.9s linear infinite;
}

@keyframes conversion-spin {
  to { transform: rotate(360deg); }
}

.encryption-bar {
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding: 16px;
  margin: 0 18px 12px;
  background-color: #fff;
  border: 1px solid #e0e0e0;
  border-radius: 6px;
}

/* Each control is its own full-width row: label and explanation on the left, the switch on the right. They
   used to wrap side-by-side because this bar sat above the volumes table and had to be short. It no longer does. */
.encryption-default {
  justify-content: space-between;
}

.encryption-default + .encryption-default {
  border-top: 1px solid #f0f0f0;
  padding-top: 18px;
}

/* Modal Styles */
.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: rgba(0, 0, 0, 0.7);
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: 1000;
}

.modal {
  background-color: white;
  border-radius: 8px;
  width: 90%;
  max-width: 600px;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
}

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 20px;
  border-bottom: 1px solid #e0e0e0;
}

.modal-header h2 {
  margin: 0;
  font-size: 20px;
}

.close-btn {
  background: none;
  border: none;
  font-size: 28px;
  cursor: pointer;
  color: #666;
  padding: 0;
  width: 30px;
  height: 30px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.close-btn:hover {
  color: #333;
}

.modal-body {
  padding: 20px;
  overflow-y: auto;
  flex: 1;
}

.no-devices {
  text-align: center;
  color: #666;
  padding: 20px;
}

.device-list {
  display: flex;
  flex-direction: column;
  gap: 15px;
}

.modal-device-item {
  border: 1px solid #ddd;
  border-radius: 6px;
  padding: 12px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.modal-device-item:hover {
  background-color: #f5f5f5;
}

.device-checkbox {
  display: flex;
  align-items: center;
  gap: 12px;
  cursor: pointer;
  flex: 1;
}

.device-checkbox.disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.device-checkbox input[type="checkbox"] {
  width: 18px;
  height: 18px;
  cursor: pointer;
}

.device-info-modal {
  flex: 1;
}

.device-name-modal {
  font-weight: 600;
  font-size: 16px;
  margin-bottom: 4px;
}

.device-details {
  font-size: 13px;
  color: #666;
}

.partition-info {
  font-size: 12px;
  color: #ff9800;
  margin-top: 4px;
  font-weight: 500;
}

.partition-error {
  font-size: 12px;
  color: #f44336;
  margin-top: 4px;
  font-weight: 600;
}

.wipe-checkbox {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  background-color: #fff3e0;
  border-radius: 4px;
  cursor: pointer;
  border: 1px solid #ff9800;
}

.wipe-checkbox input[type="checkbox"] {
  width: 16px;
  height: 16px;
  cursor: pointer;
}

.wipe-label {
  font-size: 12px;
  font-weight: 600;
  color: #ff9800;
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding: 20px;
  border-top: 1px solid #e0e0e0;
}

.identify-status {
  display: flex;
  align-items: flex-start;
  gap: 14px;
}

.identify-blink {
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
  margin-top: 2px;
  border-radius: 50%;
  background: #f44336;
  box-shadow: 0 0 8px 2px rgba(244, 67, 54, 0.7);
  animation: identify-blink 1s steps(1, end) infinite;
}

@keyframes identify-blink {
  50% { opacity: 0.15; box-shadow: none; }
}

.identify-line { font-size: 15px; }
.identify-line code { font-family: monospace; }

.identify-hint {
  margin-top: 6px;
  font-size: 12px;
  color: #888;
  line-height: 1.4;
}

.cancel-btn, .create-btn {
  padding: 10px 20px;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 14px;
  font-weight: 500;
}

.cancel-btn {
  background-color: #f5f5f5;
  color: #333;
}

.cancel-btn:hover {
  background-color: #e0e0e0;
}

.create-btn {
  background-color: #4caf50;
  color: white;
}

.create-btn:hover:not(:disabled) {
  background-color: #45a049;
}

.create-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

/* Context Menu */
.context-menu {
  position: fixed;
  background-color: white;
  border: 1px solid #ddd;
  border-radius: 4px;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.2);
  z-index: 2000;
  min-width: 150px;
}

.context-menu-item {
  padding: 10px 16px;
  cursor: pointer;
  font-size: 14px;
  color: #333;
}

.context-menu-item:hover {
  background-color: #f5f5f5;
}

.context-menu-item:first-child {
  border-radius: 4px 4px 0 0;
}

.context-menu-item:last-child {
  border-radius: 0 0 4px 4px;
}

.context-menu-item.delete {
  color: #f44336;
}

.context-menu-item.delete:hover {
  background-color: #ffebee;
}

/* Form Elements */
.form-label {
  display: block;
  margin-bottom: 8px;
  font-weight: 600;
  font-size: 14px;
  color: #333;
}

.form-input {
  width: 100%;
  padding: 10px;
  border: 1px solid #ddd;
  border-radius: 4px;
  font-size: 14px;
  font-family: inherit;
  box-sizing: border-box;
}

.form-input:focus {
  outline: none;
  border-color: #2196F3;
}

/* --- Top-level tabs --- */
.main-tabs {
  display: flex; gap: 4px; margin: 0 0 16px;
  border-bottom: 1px solid #e0e0e0; flex-wrap: wrap;
}
.main-tab {
  padding: 10px 18px; border: none; background: none; cursor: pointer;
  font-size: 14px; font-weight: 500; color: #666;
  border-bottom: 2px solid transparent; margin-bottom: -1px;
  display: inline-flex; align-items: center; gap: 6px;
}
.main-tab:hover { color: #333; }
.main-tab.active { color: #2196F3; border-bottom-color: #2196F3; font-weight: 600; }
.tab-dot { color: #43a047; font-size: 9px; line-height: 1; }
.tab-dot.warn { color: #f9a825; }

.overview-badges {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding: 12px 18px; border-bottom: 1px solid #f0f0f0;
}
.overview-activity { font-size: 12px; color: #777; }

/* --- Bucket content browser --- */
.browse-bar {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  flex-wrap: wrap; padding-bottom: 4px;
}
.breadcrumbs { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; font-size: 13px; }
.crumb {
  background: none; border: none; padding: 3px 6px; border-radius: 4px;
  color: #2196F3; cursor: pointer; font-size: 13px; font-family: inherit;
}
.crumb:hover { background: #eef3fb; }
.crumb.current { color: #333; font-weight: 600; cursor: default; }
.crumb.current:hover { background: none; }
.crumb-sep { color: #bbb; }
.browse-status { font-size: 12px; color: #999; font-weight: 400; margin-left: 8px; }
.browse-more { display: flex; align-items: center; gap: 10px; margin: 6px 0 0; }
.browse-count { font-size: 12px; color: #999; }

.browse-table tr.clickable { cursor: pointer; }
.browse-table tr.clickable:hover { background: #f7fbff; }
.entry-icon { margin-right: 8px; }
.entry-folder { font-weight: 600; }
.entry-mime { color: #888; font-size: 12px; }

.bucket-link {
  background: none; border: none; padding: 0; cursor: pointer;
  color: #2196F3; font-size: 13px; font-weight: 600; font-family: inherit;
}
.bucket-link:hover { text-decoration: underline; }

/* --- Buckets & Access panel --- */
.access-body { padding: 4px 18px 18px; display: flex; flex-direction: column; gap: 20px; }
.access-banner { padding: 10px 12px; border-radius: 6px; font-size: 13px; line-height: 1.45; }
.access-banner.warn { background: #fff8e1; border: 1px solid #ffe082; color: #7a5b00; }
.access-banner.error { background: #fdecea; border: 1px solid #f5c6cb; color: #a12622; }
.access-banner.secret { background: #e8f5e9; border: 1px solid #a5d6a7; color: #1b5e20; display: flex; flex-direction: column; gap: 8px; }
.access-banner.banner-standalone { margin: 0 18px 4px; }
.write-warn { color: #c62828; font-weight: 600; }
.secret-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.secret-row code { background: #fff; padding: 4px 8px; border-radius: 4px; border: 1px solid #c8e6c9; word-break: break-all; }

.access-subsection { display: flex; flex-direction: column; gap: 10px; }
.access-subtitle { font-size: 14px; font-weight: 600; color: #333; }
.access-subtitle.small { font-size: 13px; color: #555; }
.access-hint { font-size: 12px; color: #777; line-height: 1.5; max-width: 640px; }
.access-hint em { color: #a12622; font-style: normal; }

.access-enforce-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.access-toggle-btn {
  padding: 8px 16px; border-radius: 6px; border: 1px solid #ccc; background: #f5f5f5;
  cursor: pointer; font-size: 13px; font-weight: 600; white-space: nowrap;
}
.access-toggle-btn.on { background: #e53935; border-color: #e53935; color: #fff; }
.access-toggle-btn:disabled { opacity: 0.5; cursor: default; }

.access-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.access-table th, .access-table td { text-align: left; padding: 7px 10px; border-bottom: 1px solid #eee; }
.access-table th { color: #888; font-weight: 600; font-size: 12px; }
.access-table th.num, .access-table td.num { text-align: right; font-variant-numeric: tabular-nums; }
.access-table tr.disabled td { opacity: 0.5; }
.access-empty { color: #999; text-align: center; padding: 14px; }
.mono { font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace; font-size: 12px; }

.access-switch { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; font-size: 12px; color: #555; }
.grant-pill { display: inline-block; background: #eef3fb; color: #2c5aa0; border-radius: 4px; padding: 1px 6px; margin: 1px 3px 1px 0; font-size: 11px; font-family: ui-monospace, monospace; }

.access-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.access-mini-btn {
  padding: 4px 10px; border-radius: 5px; border: 1px solid #ccc; background: #fafafa;
  cursor: pointer; font-size: 12px;
}
.access-mini-btn:hover { background: #f0f0f0; }
.access-mini-btn.danger { color: #c62828; border-color: #ef9a9a; }
.access-mini-btn:disabled { opacity: 0.5; cursor: default; }

.access-create { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; padding-top: 12px; border-top: 1px dashed #e0e0e0; }
.access-create-row { display: flex; align-items: center; gap: 8px; }
.access-grant-row { display: flex; align-items: center; gap: 12px; }
.access-input { padding: 6px 9px; border: 1px solid #ccc; border-radius: 5px; font-size: 13px; }
.access-input.grant-bucket { width: 160px; }
.access-btn { padding: 7px 14px; border-radius: 6px; border: 1px solid #ccc; background: #f5f5f5; cursor: pointer; font-size: 13px; }
.access-btn.primary { background: #2196F3; border-color: #2196F3; color: #fff; font-weight: 600; }
.access-btn:disabled { opacity: 0.5; cursor: default; }
</style>
