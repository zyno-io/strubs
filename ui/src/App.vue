<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, watch, nextTick } from 'vue';
import type { VolumeStatus, BlockDevice } from '@strubs/server/http/mgmt';

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
const STORAGE_TAB_KEY = 'strubs.storage.tab';
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

// Active tab within the Storage panel
const storageTab = ref<'overview' | 'volumes'>(
  loadPref(STORAGE_TAB_KEY, ['overview', 'volumes'] as const, 'overview')
);

// Which rendering of the volumes list is active: 'table' or 'grid' (the tiles).
// Both render the same unified row list (sortedStorageRows).
const volumesView = ref<'table' | 'grid'>(
  loadPref(VOLUMES_VIEW_KEY, ['table', 'grid'] as const, 'table')
);

// Persist the view/tab/sort preferences whenever they change.
watch([sortBy, storageTab, volumesView], () => {
  try {
    localStorage.setItem(SORT_BY_KEY, sortBy.value);
    localStorage.setItem(STORAGE_TAB_KEY, storageTab.value);
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

// Verify job state
interface VerifyStatus {
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

// Maintenance freeze: when frozen, verify/repair/drain/rebalance are all paused.
const maintenanceFrozen = ref<boolean | null>(null);
const freezePending = ref<boolean>(false);

// The maintenance panel (verify + freeze) collapses when everything is nominal — nothing verifying and
// maintenance enabled (not frozen) — and auto-expands when a verify is running or maintenance is frozen.
const maintenanceCollapsed = ref<boolean>(true);
const maintenanceNominal = computed(() => !verifyStatus.value?.running && maintenanceFrozen.value === false);
watch(maintenanceNominal, nominal => { maintenanceCollapsed.value = nominal; }, { immediate: true });

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
    const res = await fetch(`${apiBaseUrl}/$/storage-stats`);
    if (!res.ok) return;
    storageStats.value = await res.json();
  } catch {
    // Ignore transient stats polling errors
  }
}

// Poll the maintenance-freeze state; tolerant of transient errors so polling continues.
async function fetchFreezeStatus(): Promise<void> {
  try {
    const res = await fetch(`${apiBaseUrl}/$/maintenance-freeze`);
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
    const res = await fetch(`${apiBaseUrl}/$/maintenance-freeze`, {
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
    const res = await fetch(`${apiBaseUrl}/$/verify-volumes`);
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
    const res = await fetch(`${apiBaseUrl}/$/verify-volumes`, {
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
  fetch(`${apiBaseUrl}/$/verify-volumes`, { method: 'DELETE' }).catch(() => {});
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
    const stats = statsByVolume[volumeId] ?? EMPTY_STORAGE_COUNTERS;
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
      fetch(`${apiBaseUrl}/$/volumes`),
      fetch(`${apiBaseUrl}/$/blockDevices?sort=sysfsPath`)
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
}

// Refresh block devices by calling the reload endpoint
async function refreshDevices(): Promise<void> {
  try {
    loading.value = true;
    error.value = null;

    const [volumesRes, blockDevicesRes] = await Promise.all([
      fetch(`${apiBaseUrl}/$/volumes`),
      fetch(`${apiBaseUrl}/$/blockDevices/reload`, { method: 'POST' })
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
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
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

        const response = await fetch(`${apiBaseUrl}/$/volumes`, {
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
    const response = await fetch(`${apiBaseUrl}/$/volumes/${editingVolumeId.value}`, {
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
    const response = await fetch(`${apiBaseUrl}/$/volumes/${editingCommentVolumeId.value}`, {
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
    const response = await fetch(`${apiBaseUrl}/$/volumes/${volumeId}`, {
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
    const response = await fetch(`${apiBaseUrl}/$/volumes/${volumeId}`, {
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
    const response = await fetch(`${apiBaseUrl}/$/volumes/${volumeId}/drain`, {
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
    const response = await fetch(`${apiBaseUrl}/$/volumes/${target.volumeId}/identify`, { method: 'POST' });
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
    void fetch(`${apiBaseUrl}/$/volumes/${target.volumeId}/identify`, { method: 'DELETE' }).catch(() => undefined);
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
    const response = await fetch(`${apiBaseUrl}/$/volumes/${volumeId}`, {
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

onMounted(() => {
  fetchData();
  fetchVerifyStatus();
  fetchStorageStats();
  fetchFreezeStatus();
  // Keep the verify panel + freeze state live without a manual refresh
  verifyPollTimer = setInterval(() => { fetchVerifyStatus(); fetchFreezeStatus(); }, 3000);
  storageStatsPollTimer = setInterval(fetchStorageStats, 10000);
  // Close context menu on click anywhere
  document.addEventListener('click', hideContextMenu);
});

onUnmounted(() => {
  if (verifyPollTimer !== null) clearInterval(verifyPollTimer);
  if (storageStatsPollTimer !== null) clearInterval(storageStatsPollTimer);
  if (identifyDrive.value !== null) stopIdentify(); // stop flashing if the view is torn down mid-identify
  document.removeEventListener('click', hideContextMenu);
});
</script>

<template>
  <div class="container">
    <header>
      <h1>STRUBS</h1>
    </header>

    <div class="controls">
      <button @click="refreshDevices" :disabled="loading" class="refresh-btn">
        {{ loading ? 'Loading...' : 'Refresh' }}
      </button>
      <button @click="openModal" :disabled="loading || availableDevices.length === 0" class="add-btn">
        + Add Volume
      </button>
    </div>

    <!-- Maintenance panel: verify status + freeze control. Collapsible; collapsed when all is nominal. -->
    <section class="section verify-panel">
      <div class="verify-header maintenance-summary" @click="maintenanceCollapsed = !maintenanceCollapsed">
        <div class="verify-title">
          <span class="collapse-chevron">{{ maintenanceCollapsed ? '▸' : '▾' }}</span>
          <h2>Maintenance</h2>
          <span
            class="verify-state"
            :class="verifyStatus?.running ? 'running' : 'idle'"
          >
            {{ verifyStatus?.running ? 'Verifying' : 'Idle' }}
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
        <div class="verify-actions" @click.stop>
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

      <template v-if="!maintenanceCollapsed">
      <div v-if="maintenanceFrozen === true" class="freeze-banner">
        Maintenance is <strong>frozen</strong> — verify, repair, drain, and rebalance are paused.
      </div>
      <div class="verify-subheader">
        <h3>Verify</h3>
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

    <section
      v-if="storageStats || volumes.length > 0 || blockDevices.length > 0"
      class="section storage-panel"
    >
      <div class="section-header">
        <h2>Storage</h2>
        <span v-if="storageStats" class="storage-updated">Updated {{ formatDateTime(String(storageStats.updatedAt)) }}</span>
      </div>
      <div class="storage-tabs" role="tablist">
        <button
          type="button"
          class="storage-tab"
          :class="{ active: storageTab === 'overview' }"
          @click="storageTab = 'overview'"
        >
          Overview
        </button>
        <button
          type="button"
          class="storage-tab"
          :class="{ active: storageTab === 'volumes' }"
          @click="storageTab = 'volumes'"
        >
          Volumes
        </button>
      </div>
      <div v-show="storageTab === 'overview'">
        <div v-if="storageStats" class="storage-stats">
          <div class="storage-stat">
            <span class="storage-stat-label">Files</span>
            <span class="storage-stat-value">{{ storageStats.system.objectCount.toLocaleString() }}</span>
          </div>
          <div class="storage-stat">
            <span class="storage-stat-label">Logical Data</span>
            <span class="storage-stat-value">{{ formatBytes(storageStats.system.logicalBytes) }}</span>
          </div>
          <div class="storage-stat">
            <span class="storage-stat-label">Data Slices</span>
            <span class="storage-stat-value">{{ formatBytes(storageStats.system.dataBytes) }}</span>
          </div>
          <div class="storage-stat">
            <span class="storage-stat-label">Parity Slices</span>
            <span class="storage-stat-value">{{ formatBytes(storageStats.system.parityBytes) }}</span>
          </div>
          <div class="storage-stat">
            <span class="storage-stat-label">Physical Total</span>
            <span class="storage-stat-value">{{ formatBytes(storageStats.system.physicalBytes) }}</span>
          </div>
          <div class="storage-stat">
            <span class="storage-stat-label">Total Capacity</span>
            <span class="storage-stat-value">{{ formatBytes(onlineAssignedCapacity) }}</span>
          </div>
          <div class="storage-stat">
            <span class="storage-stat-label">Unavailable</span>
            <span class="storage-stat-value" :class="{ 'error-text': storageStats.system.unavailableObjectCount > 0 }">
              {{ storageStats.system.unavailableObjectCount.toLocaleString() }} / {{ formatBytes(storageStats.system.unavailableLogicalBytes) }}
            </span>
          </div>
        </div>
        <p v-else class="storage-empty">Storage statistics are not available yet.</p>
      </div>
      <div v-show="storageTab === 'volumes'" class="volumes-view">
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
            <div class="device-header" :style="{ backgroundColor: entry.color }">
              <div class="device-name">
                <span v-if="entry.groupLabel" class="label-prefix">{{ entry.groupLabel }}</span>
                {{ entry.unassigned ? (entry.device ?? 'Drive') : ('Volume ' + entry.id) }}
              </div>
              <div class="header-badges">
                <button
                  v-if="entry.id !== null"
                  type="button"
                  class="tile-action-btn"
                  title="Volume actions"
                  @click.stop="openRowMenu($event, entry.id)"
                >⋮</button>
                <div v-if="entry.busGroup !== null" class="badge">Bus {{ entry.busGroup }}</div>
                <div class="badge">{{ formatBytes(entry.bytesTotal) }}</div>
                <div v-if="entry.volume?.isReadOnly" class="badge ro-badge">READ-ONLY</div>
                <div v-if="entry.volume?.isDraining" class="badge draining-badge">DRAINING</div>
                <div v-if="entry.volume && !entry.volume.isEnabled" class="badge offline-badge">DISABLED</div>
                <div v-else-if="entry.volume && !entry.blockDevice" class="badge offline-badge">OFFLINE</div>
                <div v-if="entry.unassigned" class="badge offline-badge">UNASSIGNED</div>
              </div>
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

    <div v-if="error" class="error">
      Error: {{ error }}
    </div>

    <div
      v-else-if="loading && !storageStats && volumes.length === 0 && blockDevices.length === 0"
      class="loading"
    >
      Loading...
    </div>

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
.container {
  width: 100%;
  margin: 0 auto;
  padding: 20px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
  box-sizing: border-box;
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
  background-color: #ffebee;
  color: #c62828;
  padding: 15px;
  border-radius: 4px;
  margin-bottom: 20px;
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

.device-header {
  padding: 15px 20px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  color: white;
  font-weight: 600;
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
</style>
