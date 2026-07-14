import { spawnHelper } from '../helpers/spawn';

// Lives in its own module so that BOTH the identity probe (which decides whether a disk may be repartitioned)
// and the LUKS enumerator (which decides which encrypted disks the fleet passphrase must open) can use it
// without an import cycle. Two guards, one question, one answer -- and a second copy of this parser would be a
// second chance to get it subtly wrong.

// ASK THE DEVICE WHAT IS ON IT -- WITH A TOOL WHOSE "NOTHING" MEANS NOTHING.
//
// The first version of this used `blkid -p` and read exit 2 as "positively blank". blkid(8) documents exit 2
// for BOTH "no signature found" AND "impossible to gather any information about the device". Those are the two
// things this entire guard exists to distinguish, and I had collapsed them into one -- in the function written
// to stop exactly that. A failing STRUBS disk that blkid could not read would have come back CLEAN, and been
// repartitioned.
//
// `wipefs -n --json` does not have that ambiguity. It is read-only (-n), and its answers are distinct:
//
//   exit 0, "signatures": [ {...} ]   -- there IS something here, and this is what it is
//   exit 0, "signatures": [ ]         -- it probed the device successfully and there is genuinely NOTHING
//   non-zero                          -- it could not probe the device at all. We do not know.
//
// An empty list is a POSITIVE finding. A failure is a failure. They no longer look alike.
export type Signature =
    | { kind: 'none' }                    // probed successfully, and there is genuinely nothing there
    | { kind: 'type'; type: string }      // there IS a signature, and this is it
    | { kind: 'unreadable'; reason: string };

export async function probeSignature(devicePath: string): Promise<Signature> {
    try {
        const { code, stdout } = await spawnHelper('wipefs', ['-n', '--json', devicePath]);

        if (code !== 0)
            return {
                kind: 'unreadable',
                reason: `could not probe ${devicePath} for a filesystem signature (wipefs exit ${code}: `
                    + `${(stdout ?? '').trim().slice(0, 120)}). A disk whose superblock cannot be READ looks exactly `
                    + `like a blank one -- and this guard decides whether to repartition it.`
            };

        // AND AN ANSWER WE DID NOT UNDERSTAND IS NOT AN ANSWER OF "NOTHING".
        //
        // `JSON.parse(stdout || '{}')` with a `?? []` fallback quietly turns empty stdout, `{}`, or a malformed
        // `signatures` field into "no signatures" -- which is to say, into CLEAN. That is the same fail-open one
        // level further down, in the function written to close it. Only a well-formed answer counts.
        let sigs: Array<{ type?: string }>;
        try {
            const parsed = JSON.parse(stdout) as { signatures?: unknown };
            if (!Array.isArray(parsed.signatures)) throw new Error('no signatures array');
            sigs = parsed.signatures as Array<{ type?: string }>;
        }
        catch {
            return {
                kind: 'unreadable',
                reason: `wipefs exited 0 for ${devicePath} but did not return a signature list this understands `
                    + `(${(stdout ?? '').trim().slice(0, 80) || 'empty output'}). An answer we cannot read is not an `
                    + `answer of "the disk is blank".`
            };
        }

        // An EMPTY list here is a positive finding, not an absent one: wipefs probed the device and found no
        // signature at all. That -- and only that -- is a blank disk.
        if (!sigs.length)
            return { kind: 'none' };

        const types = sigs.map(sig => (sig.type ?? '').toLowerCase());

        // A SIGNATURE WE COULD NOT NAME IS NOT A SIGNATURE WE MAY IGNORE.
        //
        // `.filter(Boolean)` used to drop these on the floor. wipefs said "there is SOMETHING here" and we
        // discarded the only evidence of it -- then fell through to `types[0] ?? 'unknown'`, which the wipe
        // guard reads as "not ext, therefore not ours, therefore CLEAN". A disk that told us it had something
        // on it would have been repartitioned because we could not read the label.
        if (types.some(type => !type))
            return {
                kind: 'unreadable',
                reason: `wipefs found ${sigs.length} signature(s) on ${devicePath} but at least one of them has `
                    + `no type this understands. Something is on that disk and we cannot name it -- which is not `
                    + `a licence to repartition it.`
            };

        // LUKS anywhere in the list wins: it is the one signature that means "there may be an entire array in
        // here and you cannot see it".
        if (types.includes('crypto_luks'))
            return { kind: 'type', type: 'crypto_luks' };

        // ...AND EXT ANYWHERE IN THE LIST WINS NEXT, for the same reason and with the same stakes.
        //
        // Returning `types[0]` meant that a STRUBS ext4 partition carrying a second, stale signature (an old
        // mdraid superblock, a leftover LVM header -- wipefs happily reports every one it finds) could come back
        // as "mdraid". The wipe guard only goes and READS a partition it believes is ext; anything else it calls
        // positively-not-ours and waves through to be repartitioned. Which of the two signatures wipefs happened
        // to list first would have decided whether 4.4TB of customer data was destroyed.
        const ext = types.find(type => type.startsWith('ext'));
        if (ext)
            return { kind: 'type', type: ext };

        return { kind: 'type', type: types[0] };
    }
    catch (err) {
        return { kind: 'unreadable', reason: `probing ${devicePath} for a signature failed: ${err}` };
    }
}

// ---------------------------------------------------------------------------------------------------------
// WHAT IS ON THIS PARTITION? -- the single answer every guard uses.
//
// This existed three times, written by hand, and each copy made the same mistake: it read `child.fstype` and
// treated a MISSING value as "not the thing I am looking for". lsblk reports fstype null for a genuinely blank
// partition AND for one whose superblock it could not read -- so each copy in turn had a live STRUBS disk that
// it simply could not see:
//
//   the wipe guard          -- an unreadable ext4 looked blank, and would have been repartitioned;
//   findEncryptedPartitions -- an encrypted disk of ours was invisible, so the next encryption never checked
//                              its passphrase against it, and the fleet would split;
//   the bootstrap scan      -- an encrypted disk was skipped as foreign, so it never voted on which array this
//                              host is, and recovery could adopt a stale volume table.
//
// One classifier, one answer, and an absent fstype means GO AND LOOK rather than "no".
// ---------------------------------------------------------------------------------------------------------
export type PartitionKind =
    | { kind: 'luks' }
    | { kind: 'ext'; fsType: string }
    | { kind: 'other'; fsType: string }   // positively some other filesystem: not ours, and not a mystery
    | { kind: 'blank' }                   // probed, and there is genuinely nothing there
    | { kind: 'unreadable'; reason: string };

export async function classifyPartition(
    fsType: string | null | undefined, devicePath: string
): Promise<PartitionKind> {
    const fs = (fsType ?? '').toLowerCase();

    if (fs === 'crypto_luks')
        return { kind: 'luks' };

    if (fs.startsWith('ext'))
        return { kind: 'ext', fsType: fs };

    if (fs)
        return { kind: 'other', fsType: fs };

    // NO FSTYPE IS NOT AN ANSWER. It is the absence of one. Go and ask the device itself.
    const probed = await probeSignature(devicePath);

    if (probed.kind === 'unreadable')
        return { kind: 'unreadable', reason: probed.reason };

    if (probed.kind === 'none')
        return { kind: 'blank' };

    if (probed.type === 'crypto_luks')
        return { kind: 'luks' };

    if (probed.type.startsWith('ext'))
        return { kind: 'ext', fsType: probed.type };

    return { kind: 'other', fsType: probed.type };
}
