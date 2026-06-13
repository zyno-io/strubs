<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue';
import type { VolumeStatus, BlockDevice } from '@strubs/server/http/mgmt';

const volumes = ref<VolumeStatus[]>([]);
const blockDevices = ref<BlockDevice[]>([]);
const loading = ref<boolean>(true);
const error = ref<string | null>(null);
const showModal = ref<boolean>(false);
const selectedDevices = ref<Set<string>>(new Set());
const wipeDevices = ref<Set<string>>(new Set());
const creatingVolumes = ref<boolean>(false);
const sortBy = ref<'volumeLabel' | 'volumeId' | 'name' | 'path'>('volumeLabel');

// Context menu state
const contextMenu = ref<{ x: number; y: number; volumeId: number | null }>({ x: 0, y: 0, volumeId: null });
const showEditLabelModal = ref<boolean>(false);
const editingVolumeId = ref<number | null>(null);
const editLabelValue = ref<string>('');
const savingLabel = ref<boolean>(false);

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
}
const verifyStatus = ref<VerifyStatus | null>(null);
const verifyActionPending = ref<boolean>(false);
const stopRequested = ref<boolean>(false);
let verifyPollTimer: ReturnType<typeof setInterval> | null = null;

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

    volumes.value = await volumesRes.json();
    blockDevices.value = await blockDevicesRes.json();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Unknown error';
  } finally {
    loading.value = false;
  }
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

    volumes.value = await volumesRes.json();
    blockDevices.value = await blockDevicesRes.json();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Unknown error';
  } finally {
    loading.value = false;
  }
}

// Find matching volume for a block device
function findVolumeForBlockDevice(blockDevice: BlockDevice): VolumeStatus | null {
  if (!blockDevice.volumeId) return null;
  return volumes.value.find(v => v.id === blockDevice.volumeId) ?? null;
}

// Compute offline volumes (volumes without matching block devices)
const offlineVolumes = computed<VolumeStatus[]>(() => {
  const onlineVolumeIds = new Set(
    blockDevices.value
      .filter(bd => bd.volumeId)
      .map(bd => bd.volumeId!)
  );
  return volumes.value.filter(v => !onlineVolumeIds.has(v.id));
});

// Get block devices without volume IDs (available for provisioning)
const availableDevices = computed<BlockDevice[]>(() => {
  return blockDevices.value.filter(bd => !bd.volumeId);
});

// Sort block devices based on selected sort option
const sortedBlockDevices = computed<BlockDevice[]>(() => {
  const devices = [...blockDevices.value];

  return devices.sort((a, b) => {
    let aValue: string | number | null;
    let bValue: string | number | null;

    switch (sortBy.value) {
      case 'volumeLabel':
        aValue = a.volumeLabel ?? '';
        bValue = b.volumeLabel ?? '';
        break;
      case 'volumeId':
        aValue = a.volumeId ?? null;
        bValue = b.volumeId ?? null;
        // Special handling for volumeId: null values go to the end
        if (aValue === null && bValue === null) return 0;
        if (aValue === null) return 1;
        if (bValue === null) return -1;
        // Both have values, compare them
        if (aValue < bValue) return -1;
        if (aValue > bValue) return 1;
        return 0;
      case 'name':
        aValue = a.name;
        bValue = b.name;
        break;
      case 'path':
        aValue = a.sysfsPath;
        bValue = b.sysfsPath;
        break;
      default:
        return 0;
    }

    // Handle null/empty values - push them to the end
    const aIsEmpty = aValue === null || aValue === '' || (typeof aValue === 'number' && aValue < 0);
    const bIsEmpty = bValue === null || bValue === '' || (typeof bValue === 'number' && bValue < 0);
    if (aIsEmpty && !bIsEmpty) return 1;
    if (!aIsEmpty && bIsEmpty) return -1;

    // Compare values
    if (aValue < bValue) return -1;
    if (aValue > bValue) return 1;
    return 0;
  });
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

// Show context menu on right-click
function showContextMenu(event: MouseEvent, volumeId: number): void {
  event.preventDefault();
  contextMenu.value = { x: event.clientX, y: event.clientY, volumeId };
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
      throw new Error('Failed to delete volume');
    }

    await refreshDevices();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to delete volume';
  }
}

onMounted(() => {
  fetchData();
  fetchVerifyStatus();
  // Keep the verify panel live without a manual refresh
  verifyPollTimer = setInterval(fetchVerifyStatus, 3000);
  // Close context menu on click anywhere
  document.addEventListener('click', hideContextMenu);
});

onUnmounted(() => {
  if (verifyPollTimer !== null) clearInterval(verifyPollTimer);
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

    <!-- Verify Job Panel -->
    <section class="section verify-panel">
      <div class="verify-header">
        <div class="verify-title">
          <h2>Verify</h2>
          <span
            class="verify-state"
            :class="verifyStatus?.running ? 'running' : 'idle'"
          >
            {{ verifyStatus?.running ? 'Running' : 'Idle' }}
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
    </section>

    <div v-if="error" class="error">
      Error: {{ error }}
    </div>

    <div v-else-if="!loading || blockDevices.length > 0">
      <!-- Block Devices Section -->
      <section class="section">
        <div class="section-header">
          <h2>Block Devices</h2>
          <div class="sort-controls">
            <label for="sort-select" class="sort-label">Sort by:</label>
            <select id="sort-select" v-model="sortBy" class="sort-select">
              <option value="volumeLabel">Volume Label</option>
              <option value="volumeId">Volume ID</option>
              <option value="name">Device Name</option>
              <option value="path">Device Path</option>
            </select>
          </div>
        </div>
        <div class="devices-list">
          <div
            v-for="device in sortedBlockDevices"
            :key="device.sysfsPath"
            class="device-card"
            :style="{ opacity: device.volumeId ? 1 : 0.5 }"
            @contextmenu="device.volumeId ? showContextMenu($event, device.volumeId) : null"
          >
            <div
              class="device-header"
              :style="{ backgroundColor: getVolumeBackgroundColor(findVolumeForBlockDevice(device)) }"
            >
              <div class="device-name">
                <span v-if="device.volumeLabel" class="label-prefix">{{ device.volumeLabel }}</span>
                {{ device.name }}
              </div>
              <div class="header-badges">
                <div v-if="device.busGroup !== null" class="badge">Bus {{ device.busGroup }}</div>
                <div class="badge">{{ formatBytes(device.size) }}</div>
              </div>
            </div>
            <div class="device-body">
              <div class="device-info">
                <div class="info-row">
                  <span class="label">Volume ID:</span>
                  <span class="value">{{ device.volumeId ?? 'N/A' }}</span>
                </div>
                <div class="info-row" v-if="findVolumeForBlockDevice(device)">
                  <span class="label">SMART Status:</span>
                  <span class="value" :class="{ 'error-text': findVolumeForBlockDevice(device)?.isSmartHealthy === false }">
                    {{ formatSmartStatus(findVolumeForBlockDevice(device)) }}
                  </span>
                </div>
                <div class="info-row" v-if="findVolumeForBlockDevice(device)?.verifyErrors && getVerifyErrorCount(findVolumeForBlockDevice(device)?.verifyErrors) > 0">
                  <span class="label">Verify Errors:</span>
                  <span class="value error-text">{{ getVerifyErrorCount(findVolumeForBlockDevice(device)?.verifyErrors) }}</span>
                </div>
                <div class="info-row">
                  <span class="label">Model:</span>
                  <span class="value">{{ device.model ?? 'N/A' }}</span>
                </div>
                <div class="info-row">
                  <span class="label">Vendor:</span>
                  <span class="value">{{ device.vendor ?? 'N/A' }}</span>
                </div>
                <div class="info-row">
                  <span class="label">Serial:</span>
                  <span class="value">{{ device.serial ?? 'N/A' }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- Offline Volumes Section -->
      <section class="section" v-if="offlineVolumes.length > 0">
        <h2>Offline Volumes</h2>
        <div class="devices-list">
          <div
            v-for="volume in offlineVolumes"
            :key="volume.id"
            class="device-card offline"
            @contextmenu="showContextMenu($event, volume.id)"
          >
            <div
              class="device-header"
              :style="{ backgroundColor: getVolumeBackgroundColor(volume) }"
            >
              <div class="device-name">
                <span v-if="volume.label" class="label-prefix">{{ volume.label }}</span>
                Volume {{ volume.id }}
              </div>
              <div class="header-badges">
                <div v-if="volume.busGroup !== null" class="badge">Bus {{ volume.busGroup }}</div>
                <div class="badge offline-badge">OFFLINE</div>
              </div>
            </div>
            <div class="device-body">
              <div class="device-info">
                <div class="info-row">
                  <span class="label">SMART Status:</span>
                  <span class="value" :class="{ 'error-text': volume.isSmartHealthy === false }">
                    {{ formatSmartStatus(volume) }}
                  </span>
                </div>
                <div class="info-row" v-if="volume.verifyErrors && getVerifyErrorCount(volume.verifyErrors) > 0">
                  <span class="label">Verify Errors:</span>
                  <span class="value error-text">{{ getVerifyErrorCount(volume.verifyErrors) }}</span>
                </div>
                <div class="info-row">
                  <span class="label">UUID:</span>
                  <span class="value small">{{ volume.uuid }}</span>
                </div>
                <div class="info-row">
                  <span class="label">Partition UUID:</span>
                  <span class="value small">{{ volume.partitionUuid ?? 'N/A' }}</span>
                </div>
                <div class="info-row">
                  <span class="label">Enabled:</span>
                  <span class="value">{{ volume.isEnabled ? 'Yes' : 'No' }}</span>
                </div>
                <div class="info-row">
                  <span class="label">Started:</span>
                  <span class="value">{{ volume.isStarted ? 'Yes' : 'No' }}</span>
                </div>
                <div class="info-row">
                  <span class="label">Read Only:</span>
                  <span class="value">{{ volume.isReadOnly ? 'Yes' : 'No' }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>

    <div v-else class="loading">
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
      class="context-menu"
      :style="{ top: `${contextMenu.y}px`, left: `${contextMenu.x}px` }"
      @click.stop
    >
      <div class="context-menu-item" @click="openEditLabelModal">Edit Label</div>
      <div
        v-if="contextMenuVolume"
        class="context-menu-item"
        @click="toggleVolumeEnabled"
      >
        {{ contextMenuVolume.isEnabled ? 'Disable' : 'Enable' }}
      </div>
      <div class="context-menu-item delete" @click="deleteVolume">Delete</div>
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
  text-align: center;
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

.refresh-btn, .add-btn {
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

.refresh-btn:disabled, .add-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.add-btn {
  background-color: #4caf50;
}

.add-btn:hover:not(:disabled) {
  background-color: #45a049;
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

.verify-title {
  display: flex;
  align-items: center;
  gap: 12px;
}

.verify-title h2 {
  margin-bottom: 0;
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

.verify-volume-badge {
  background-color: #ffebee;
  color: #c62828;
  padding: 3px 10px;
  border-radius: 12px;
  font-size: 12px;
  font-weight: 600;
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
