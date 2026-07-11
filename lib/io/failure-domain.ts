import type { Volume } from './volume';

// A bus group is a failure domain: on external enclosures every disk in a group hangs off one
// bridge/PSU/cable, so the whole box can drop at once. With 4+2 erasure coding an object survives the
// loss of any 2 slices, so 3+ of its slices in ONE group means a single box outage takes it BELOW
// QUORUM — the disks are all fine and the data is still unreadable.
//
// The write planner already round-robins new writes across groups (planner.ts). Relocation must not
// quietly undo that: a drain or rebalance that only asks "which volume is emptiest?" will happily
// stack a third slice into a group that already holds two.
//
// Volumes with no group (unknown topology) are each treated as their own domain — pessimistically
// assuming they are independent is wrong, but they can't be reasoned about, so we don't let an unknown
// collapse every ungrouped disk into one bucket.

export function failureDomainOf(volume: Volume | undefined): string {
    if (!volume)
        return 'unknown';
    return volume.deviceGroup === null || volume.deviceGroup === undefined
        ? `ungrouped:${volume.id}`
        : `group:${volume.deviceGroup}`;
}

// How many of the object's slices already live in each failure domain, ignoring the slice that is
// about to move (it is leaving, so its current domain must not count against the destination choice).
export function domainLoadForObject(
    objectVolumeIds: Iterable<number>,
    movingFromVolumeId: number | null,
    getVolume: (id: number) => Volume | undefined
): Map<string, number> {
    const load = new Map<string, number>();
    for (const id of objectVolumeIds) {
        if (id === movingFromVolumeId)
            continue;
        const domain = failureDomainOf(getVolume(id));
        load.set(domain, (load.get(domain) ?? 0) + 1);
    }
    return load;
}

// Slices of this object already sitting in the candidate's failure domain. Relocation ranks by this
// FIRST and only then by free space: every candidate has already passed the caller's capacity/health
// filters, so preferring the least-crowded domain costs nothing and, applied over a whole drain or
// rebalance, actively pulls the fleet back toward surviving a box outage.
export function domainLoadFor(
    candidate: Volume,
    load: Map<string, number>
): number {
    return load.get(failureDomainOf(candidate)) ?? 0;
}
