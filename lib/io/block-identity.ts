import { listRawBlockDevices, type RawBlockDevice, type RawBlockDeviceChild } from './device-discovery';
import { HttpBadRequestError } from '../server/http/errors';
import { createLogger } from '../log';

const log = createLogger('block-identity');

// STABLE HANDLES FOR DISK OPERATIONS -- so a tool never opens a disk by a kernel name that could have been
// reassigned to a different spindle since we looked. See notes/dr-g-by-uuid-migration-plan.md.
//
// The rule the whole DR-G hardening comes down to: A PATH IS NOT AN IDENTITY. /dev/sdb is whatever the kernel
// most recently decided to call the thing in that slot, and on a hub full of USB disks that drop and come back,
// the thing in the slot changes. Every one of these helpers hands a tool something that resolves to the disk we
// MEAN, or to nothing -- never to a different disk.

// A cryptsetup device specifier that binds to the LUKS HEADER by its own uuid, resolved by libblkid at open
// time. Unlike a /dev/disk/by-uuid symlink it does not depend on udev having created (or updated) a node -- and
// on a disk swap the uuid simply no longer resolves, so the op fails closed rather than hitting a stranger.
//
// ⚠️ NOT SUFFICIENT ON ITS OWN: two attached headers can carry the same uuid (a dd'd clone), and then `UUID=`
// is ambiguous. Every write MUST assertExactlyOneLuksHeader() first.
export const luksHeaderSpecifier = (luksUuid: string): string => `UUID=${luksUuid}`;

// The udev by-partuuid node for a GPT partition. partuuid exists the instant `parted mkpart` writes the table,
// BEFORE any filesystem or LUKS header -- so it is the handle for the earliest partition-level writes
// (luksFormat on a fresh partition, a plaintext mkfs), where no fs/header uuid exists yet.
export const byPartUuidPath = (partUuid: string): string => `/dev/disk/by-partuuid/${partUuid}`;

// Walk every partition (at any depth) in the rack and count those whose blkid uuid matches. Used to prove a
// uuid names exactly one attached partition before we operate on it by uuid.
function countUuid(devices: RawBlockDevice[], uuid: string): number {
    let count = 0;
    const walk = (children: RawBlockDeviceChild[] | undefined): void => {
        for (const child of children ?? []) {
            if (child.uuid === uuid) count++;
            walk(child.children);
        }
    };
    for (const device of devices) walk(device.children);
    return count;
}

function countPartUuid(devices: RawBlockDevice[], partUuid: string): number {
    let count = 0;
    const walk = (children: RawBlockDeviceChild[] | undefined): void => {
        for (const child of children ?? []) {
            if (child.partuuid === partUuid) count++;
            walk(child.children);
        }
    };
    for (const device of devices) walk(device.children);
    return count;
}

// EXACTLY ONE, OR REFUSE. Zero means the disk we scanned is gone (a swap, an unplug) -- operating by that uuid
// would fail anyway, but we refuse LOUDLY rather than let a confusing ENOENT surface deep inside cryptsetup.
// Two means a clone is attached and `UUID=` is ambiguous -- writing a keyslot then could land on either header.
export async function assertExactlyOneLuksHeader(
    luksUuid: string, list: () => Promise<RawBlockDevice[]> = listRawBlockDevices
): Promise<void> {
    const count = countUuid(await list(), luksUuid);

    if (count === 1) return;

    if (count === 0)
        throw new HttpBadRequestError(
            `refusing to operate on LUKS header ${luksUuid}: no attached partition carries that uuid. The disk `
            + `was unplugged or swapped since it was scanned. Nothing has been done.`
        );

    throw new HttpBadRequestError(
        `refusing to operate on LUKS header ${luksUuid}: ${count} attached partitions carry that uuid, so `
        + `\`UUID=\` is ambiguous -- one of them is a clone. Detach the copy and try again. Nothing has been done.`
    );
}

// The by-partuuid handle, only once it is proven to name exactly one attached partition. A duplicate partuuid is
// a clone; a mkfs/luksFormat aimed at an ambiguous handle is a wrong-disk write.
export async function resolveUniquePartUuid(
    partUuid: string, list: () => Promise<RawBlockDevice[]> = listRawBlockDevices
): Promise<string> {
    const count = countPartUuid(await list(), partUuid);

    if (count === 1) return byPartUuidPath(partUuid);

    if (count === 0)
        throw new HttpBadRequestError(
            `refusing to operate on partition ${partUuid}: no attached partition carries that partuuid. It was `
            + `unplugged or swapped since it was scanned.`
        );

    throw new HttpBadRequestError(
        `refusing to operate on partition ${partUuid}: ${count} attached partitions carry that partuuid -- a `
        + `clone is attached. Detach the copy and try again.`
    );
}

// Diagnostics only: which kernel path a uuid currently resolves to. NEVER pass this to a destructive tool -- the
// path can change the instant after we read it, which is the entire reason this module exists. It is for log
// lines that help a human find the disk, and nothing else.
export async function currentPathForUuid(
    uuid: string, list: () => Promise<RawBlockDevice[]> = listRawBlockDevices
): Promise<string | null> {
    const devices = await list();
    let found: string | null = null;
    const walk = (children: RawBlockDeviceChild[] | undefined): void => {
        for (const child of children ?? []) {
            if (child.uuid === uuid && child.path) found = child.path;
            walk(child.children);
        }
    };
    for (const device of devices) walk(device.children);
    if (!found) log('no attached partition currently resolves uuid %s', uuid);
    return found;
}
