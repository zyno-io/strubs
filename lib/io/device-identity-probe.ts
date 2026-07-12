import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';

import { spawnHelper } from '../helpers/spawn';
import { createLogger } from '../log';
import type { RawBlockDeviceChild } from './device-discovery';

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

    // We only ever mkfs ext. A partition with no filesystem, or a foreign one, cannot be one of ours, and
    // there is nothing to mount -- that is a positive 'clean', not an 'unknown'.
    // (Under LUKS the partition reports crypto_LUKS and its ext4 lives on a mapper child; encryption will
    // extend this, and until it does an encrypted disk correctly reports 'clean' only because we never
    // create one.)
    if (!fsType || !fsType.toLowerCase().startsWith('ext'))
        return { status: 'clean' };

    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'strubs-probe-'));
    let mounted = false;
    let result: ProbeResult;

    try {
        // noload: never replay the journal -- replaying it would be a WRITE to a disk we are inspecting.
        const { code, stdout } = await spawnHelper('mount', ['-o', 'ro,noload', '-t', fsType, partitionPath, dir]);
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
export async function probeDeviceForStrubsIdentity(children: RawBlockDeviceChild[] | undefined): Promise<ProbeResult> {
    let unknown: ProbeResult | null = null;
    for (const child of children ?? []) {
        if (child.type !== 'part')
            continue;
        const result = await probeStrubsIdentity(child);
        if (result.status === 'strubs')
            return result;                        // decisive: it is ours
        if (result.status === 'unknown')
            unknown = result;                     // remember, but keep looking for a decisive 'strubs'
    }
    return unknown ?? { status: 'clean' };
}
