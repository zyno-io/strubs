import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';

import { spawnHelper } from '../helpers/spawn';
import { createLogger } from '../log';
import type { RawBlockDeviceChild } from './device-discovery';
import { parseNameplate } from './luks';
import { probeSignature, type Signature } from './signature-probe';

const log = createLogger('device-identity-probe');

// The volume identity record (see volume-identity.ts): 41 bytes, magic 1F FB 01 FB, version at [4],
// the 16-byte INSTANCE identity at [5..21), the volume uuid at [21..37), the volume id at [37].
const IDENTITY_MAGIC = [0x1F, 0xFB, 0x01, 0xFB];
const IDENTITY_LENGTH = 41;

export type StrubsDiskIdentity = {
    instanceIdentity: string;   // hex of the 16-byte instance identity
    volumeId: number;
};

// Tri-state, and the third state is the whole point.
//
//   'strubs'  -- this disk carries a STRUBS identity. It may hold live data. REFUSE.
//   'clean'   -- positively established that it does not: we read the filesystem and found no identity,
//                or there is no filesystem of ours to read. Safe to provision.
//   'unknown' -- we could NOT establish either way (the filesystem exists but would not mount: busy,
//                dirty journal, I/O errors). REFUSE.
//
// 'unknown' must never collapse into 'clean'. This guard's only job is to stop a disk holding 4.4TB of
// customer data from being repartitioned, and "I could not tell" is not a licence to destroy it. An
// earlier version of this returned null on a failed mount, which the caller read as "not ours" -- i.e. it
// failed OPEN, in the one function that exists to fail closed.
export type ProbeResult =
    | { status: 'strubs'; identity: StrubsDiskIdentity }
    | { status: 'clean' }
    | { status: 'unknown'; reason: string };

// READ-ONLY. Mounts a partition `ro` in a throwaway directory, looks for strubs/.identity, unmounts.
// It never writes to the device -- that is the entire point: this is how we ask "does this disk already
// belong to a STRUBS array?" without the ability to claim it by asking.
export async function probeStrubsIdentity(partition: RawBlockDeviceChild): Promise<ProbeResult> {
    const fsType = partition.fstype;
    const partitionPath = partition.path ?? `/dev/${partition.name}`;

    const fs = fsType?.toLowerCase() ?? '';

    // AN ENCRYPTED DISK IS NOT A BLANK ONE. IT IS A DISK WE CANNOT SEE INSIDE.
    //
    // Under LUKS the partition reports `crypto_LUKS` and the ext4 lives on a device-mapper child. Every byte of
    // the array's data can be sitting there and this probe -- which decides whether a disk may be REPARTITIONED
    // -- would look at the fstype, see something that is not ext, and call it CLEAN.
    //
    // Until now that was true by accident: STRUBS never created an encrypted disk, so there were none to
    // mistake. DR-G changes exactly that, which is why this had to be fixed BEFORE a single volume is ever
    // encrypted. Shipping the feature with this in place would arm the bug: the first encrypted disk in the
    // rack becomes a 4TB disk that the wipe guard is happy to destroy.
    //
    // We cannot read a LUKS container without the key -- but we can read the NAMEPLATE, which is why it exists.
    //
    // The nameplate lives in the GPT partition entry, OUTSIDE the container: `strubs-<identity>-<volumeId>`,
    // readable with no mount, no unlock and no cryptsetup. A locked disk bearing one is telling us it is ours,
    // and that is enough to REFUSE -- which is the only decision this function makes.
    //
    // Using an advisory field to refuse is always safe: the worst a forged or stale nameplate can do is stop us
    // destroying a disk. (It would be a different matter to AUTHORISE a wipe on one, and we never do -- the
    // conversion path requires a disk to prove itself from INSIDE the filesystem, which a locked disk cannot.)
    //
    // No nameplate, or one we do not recognise, still means 'unknown': a LUKS disk we hold no key for is either
    // somebody else's or ours with a lost key, and neither is a disk to reformat on a hunch.
    if (fs === 'crypto_luks') {
        const plate = parseNameplate(partition.partlabel);

        if (plate)
            return {
                status: 'strubs',
                identity: { instanceIdentity: plate.identity, volumeId: plate.volumeId }
            };

        return {
            status: 'unknown',
            reason: `${partitionPath} is a LUKS container carrying no STRUBS nameplate. Its contents cannot be `
                + `read without the key, so this guard cannot establish whether it is blank or holds a STRUBS `
                + `volume -- and "I could not tell" is not a licence to repartition 4TB. Unlock it, or take it `
                + `out of the machine.`
        };
    }

    // NO FSTYPE IS NOT PROOF OF BLANKNESS -- IT IS THE ABSENCE OF PROOF, AND THAT IS THE OTHER FAIL-OPEN.
    //
    // `lsblk` reports fstype null for a genuinely blank partition. It ALSO reports it null when it could not
    // read the superblock -- which is exactly what a dying disk does. So a live STRUBS volume whose ext4
    // superblock has gone unreadable presents as a blank partition, and this guard, whose whole job is to stop
    // us wiping a disk with data on it, would happily wave 4TB of somebody's only copy through to be
    // repartitioned. "I could not tell" is not a licence to destroy.
    //
    // So blankness is ESTABLISHED, not assumed. `blkid -p` probes the device itself rather than trusting a
    // cached fstype: exit 2 with no output is a positive "there is no signature here"; a signature means there
    // is something; and anything else -- an I/O error, a disk that will not talk -- is UNKNOWN.
    let effective = fs;

    if (!fs) {
        const probed = await probeSignature(partitionPath);

        if (probed.kind === 'unreadable')
            return { status: 'unknown', reason: probed.reason };

        if (probed.kind === 'none')
            return { status: 'clean' };               // probed, and positively nothing there

        // THERE IS A SIGNATURE AFTER ALL -- lsblk simply had not cached it. And if it is EXT, this is very
        // possibly one of ours: we must go and READ it, not shrug and call it clean because lsblk was quiet.
        // Returning 'clean' here on an ext4 partition would be a direct route to repartitioning a STRUBS disk.
        effective = probed.type;

        if (effective === 'crypto_luks')
            return {
                status: 'unknown',
                reason: `${partitionPath} is a LUKS container (found by probing it directly -- lsblk reported no `
                    + `filesystem at all). Its contents cannot be read without the key.`
            };
    }

    // We only ever mkfs ext. A partition with a FOREIGN filesystem cannot be one of ours -- it positively is
    // not a STRUBS volume, which is the only question this function is asked.
    if (!effective.startsWith('ext'))
        return { status: 'clean' };

    const fsForMount = effective;

    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'strubs-probe-'));
    let mounted = false;
    let result: ProbeResult;

    try {
        // noload: never replay the journal -- replaying it would be a WRITE to a disk we are inspecting.
        const { code, stdout } = await spawnHelper('mount', ['-o', 'ro,noload', '-t', fsForMount, partitionPath, dir]);
        if (code !== 0) {
            const reason = `could not read-only mount ${partitionPath}${stdout ? ': ' + stdout.trim() : ''}`;
            log.error('%s -- treating as UNKNOWN (refusing to assume it is blank)', reason);
            result = { status: 'unknown', reason };
        }
        else {
            mounted = true;
            result = await readIdentity(dir, partitionPath);
        }
    }
    catch (err) {
        result = { status: 'unknown', reason: `probe of ${partitionPath} failed: ${err}` };
    }

    // Cleanup is part of the SAFETY property, not housekeeping. If we cannot unmount, we have left a
    // mount on a disk the caller is about to reformat -- and we no longer know what state it is in. That
    // downgrades any answer we were about to give to 'unknown', which means refuse. A 'clean' verdict we
    // could not clean up after is not a verdict worth acting on.
    if (mounted) {
        let unmountFailed = false;
        try {
            const { code, stdout } = await spawnHelper('umount', [dir]);
            if (code !== 0) {
                unmountFailed = true;
                log.error('failed to unmount identity probe at %s: %s', dir, stdout?.trim());
            }
        }
        catch (err) {
            unmountFailed = true;
            log.error('failed to unmount identity probe at %s: %s', dir, err);
        }
        if (unmountFailed && result.status !== 'strubs') {
            result = {
                status: 'unknown',
                reason: `could not unmount the read-only probe of ${partitionPath}; refusing to vouch for this disk`
            };
        }
    }
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);

    return result;
}


async function readIdentity(dir: string, partitionPath: string): Promise<ProbeResult> {
    let data: Buffer;
    try {
        data = await fsp.readFile(path.join(dir, 'strubs', '.identity'));
    }
    catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT')
            return { status: 'clean' };     // mounted fine, definitively has no identity
        return { status: 'unknown', reason: `identity file unreadable on ${partitionPath}: ${err}` };
    }

    if (data.length < IDENTITY_LENGTH)
        return { status: 'unknown', reason: `truncated identity file on ${partitionPath}` };
    for (let i = 0; i < IDENTITY_MAGIC.length; i++) {
        if (data[i] !== IDENTITY_MAGIC[i])
            return { status: 'unknown', reason: `identity file on ${partitionPath} has a bad magic number` };
    }

    return {
        status: 'strubs',
        identity: {
            instanceIdentity: data.subarray(5, 21).toString('hex'),
            volumeId: data[37]
        }
    };
}

// Probe every partition on a device. A single 'strubs' or 'unknown' partition condemns the whole device:
// we only report 'clean' when every partition on it was positively established to be clean.
//
// AND THE DISK ITSELF HAS TO BE ASKED, not merely its partitions.
//
// The loop below inspects `children`. If there are none it inspected NOTHING -- and used to return 'clean' on
// the strength of having looked at nothing at all. That is fine for a genuinely blank disk, which is the
// ordinary case for provisioning. It is catastrophic for a WHOLE-DISK LUKS container: `cryptsetup luksFormat
// /dev/sdf` with no partition table at all puts crypto_LUKS on the DISK, gives it no `part` children, and this
// function would look straight past it and call the whole 4TB clean.
//
// DR-G may well format whole disks. Even if it does not, an operator can. So the disk's own signature is
// checked, and only a device with no signature AND no partition table AND no partitions is called clean.
// THE WHOLE DEVICE, NEVER JUST ITS CHILDREN.
//
// This used to accept a bare `children` array, and that signature cannot be made safe: with no disk path there
// is nothing to probe, so a device with no partitions can only ever come back 'clean' -- which is precisely the
// whole-disk LUKS / whole-disk STRUBS fail-open. A convenience overload that can only fail open is not a
// convenience. It is the bug, kept warm for the next caller.
export async function probeDeviceForStrubsIdentity(
    device: { fstype?: string | null; pttype?: string; path?: string; name?: string;
              children?: RawBlockDeviceChild[] } | undefined
): Promise<ProbeResult> {
    const dev = device ?? {};
    const children = dev.children ?? [];

    const diskPath = dev.path ?? (dev.name ? `/dev/${dev.name}` : '');

    let unknown: ProbeResult | null = null;
    let inspected = 0;

    for (const child of children) {
        if (child.type !== 'part')
            continue;
        inspected++;
        const result = await probeStrubsIdentity(child);
        if (result.status === 'strubs')
            return result;                        // decisive: it is ours
        if (result.status === 'unknown')
            unknown = result;                     // remember, but keep looking for a decisive 'strubs'
    }

    if (unknown) return unknown;

    // A DISK THAT ADVERTISES A PARTITION TABLE AND SHOWS NO PARTITIONS HAS NOT BEEN LOOKED AT.
    //
    // Either the table is corrupt, or the enumeration was stale, or the kernel could not read it. Whatever the
    // reason, we did not inspect a single partition -- and returning 'clean' on the strength of having looked at
    // nothing is the same fail-open in its purest form.
    if (dev.pttype && !inspected)
        return {
            status: 'unknown',
            reason: `${diskPath || 'the device'} says it has a ${dev.pttype} partition table, and not one partition `
                + `could be enumerated on it. Nothing was inspected, so nothing is known -- and this guard decides `
                + `whether to repartition the disk.`
        };

    // NOTHING WAS INSPECTED. SO ASK THE DISK ITSELF, DIRECTLY.
    //
    // We are about to say a device with no partitions is blank. The first version of this trusted `dev.fstype`
    // to spot a whole-disk LUKS container -- and device-discovery's sanitizer STRIPS the top-level fstype, so
    // that field is never even there. The check was reading a field that does not arrive: a real whole-disk
    // crypto_LUKS device would have sailed through it, looking for all the world like bare media.
    //
    // Trusting a cached field is what got us here twice. Probe the block device.
    // No partition inspected AND no disk path to probe: we have looked at nothing and can look at nothing.
    // That is 'unknown', not 'clean' -- the whole point of this function.
    if (!inspected && !diskPath)
        return {
            status: 'unknown',
            reason: 'no partition could be inspected and no device path was given, so nothing about this disk is '
                + 'known. It will not be repartitioned on the strength of an empty answer.'
        };

    if (!inspected && diskPath) {
        const probed = await probeSignature(diskPath);

        if (probed.kind === 'unreadable')
            return { status: 'unknown', reason: probed.reason };

        if (probed.kind === 'type') {
            if (probed.type === 'crypto_luks')
                return {
                    status: 'unknown',
                    reason: `${diskPath} is a WHOLE-DISK LUKS container -- no partition table, the encryption is on `
                        + `the disk itself. Its contents cannot be read without the key, so this guard cannot say `
                        + `whether it is blank or holds a STRUBS volume. It will not be repartitioned on a guess.`
                };

            // A whole-disk EXT filesystem with no partition table could well be one of ours. Read it.
            if (probed.type.startsWith('ext'))
                return probeStrubsIdentity({
                    type: 'part', name: dev.name ?? '', path: diskPath, fstype: probed.type
                } as unknown as RawBlockDeviceChild);

            return { status: 'clean' };               // a foreign whole-disk filesystem is positively not ours
        }
    }

    return { status: 'clean' };
}
