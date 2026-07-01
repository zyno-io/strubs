import { runtimeConfig } from './runtime-config';

// Persistent, DB-backed "maintenance freeze". When set, ALL automatic
// verification and repair is held off — both at process startup and at runtime —
// so nothing re-reads/acts on the recorded corruption state (verify jobs that
// re-read+record errors and stress disks; the repair worker that reconstructs+
// writes slices) while data is being evacuated. Because it lives in runtime
// config it survives a restart: on boot with the flag set, verify+repair stay
// off. Dependency-light (only runtime-config) to avoid import cycles.
const MAINTENANCE_FREEZE_KEY = 'maintenanceFreeze';

export async function isMaintenanceFrozen(): Promise<boolean> {
    try {
        return (await runtimeConfig.get(MAINTENANCE_FREEZE_KEY)) === true;
    }
    catch {
        // The flag is an opt-in safety override read from runtime config (which
        // is connected long before any verify/repair runs in production). If the
        // read fails we cannot positively confirm a freeze, so we report
        // not-frozen and let normal operation proceed rather than wedging the
        // whole system on an unreadable flag.
        return false;
    }
}

export async function setMaintenanceFrozen(value: boolean): Promise<void> {
    await runtimeConfig.set(MAINTENANCE_FREEZE_KEY, value === true);
}
