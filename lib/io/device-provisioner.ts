import { randomUUID } from 'crypto';

import { config, normalizeIdentity } from '../config';
import { database } from '../database';
import { createLogger } from '../log';
import { ioManager } from './manager';
import { HttpBadRequestError } from '../server/http/errors';
import { getDeviceIdentityKey, listRawBlockDevices, type RawBlockDevice, type RawBlockDeviceChild } from './device-discovery';
import { smartInfoService } from './smart-info';
import { probeDeviceForStrubsIdentity } from './device-identity-probe';
import { spawnHelper } from '../helpers/spawn';
import {
    DEFAULT_KEYFILE,
    addPassphrase as luksAddPassphrase,
    assertRecoverable as luksAssertRecoverable,
    format as luksFormat,
    keyfileReadable as luksKeyfileReadable,
    mapperPath as luksMapperPath,
    mapperBackingDevice as luksMapperBackingDevice,
    mapperName as luksMapperName,
    close as luksClose,
    LuksError,
    nameplateIsPresent as luksNameplateIsPresent,
    open as luksOpen,
    testPassphrase as luksTestPassphrase,
    writeNameplate as luksWriteNameplate
} from './luks';
import {
    assertFleetRecoveryPassphrase,
    assertPassphraseOpensTheFleet,
    hasRecoveryPassphrase,
    sealedRecoveryPassphrase,
    withEncryptionSlot
} from './luks-recovery-key';
import { conversionPhase } from './encryption-progress';
import type { VolumeConfig, PersistedVolumeConfig } from './volume';

// Whether a NEWLY PROVISIONED volume is encrypted. Ships `false`: encryption is a capability, not a default we
// impose on a live 130TB array. Flipping it changes nothing about the disks already in the fleet -- it decides
// what happens to the NEXT one. (Converting an existing volume is a separate, explicit act: POST .../encrypt.)
export const ENCRYPT_NEW_VOLUMES_KEY = 'encryptNewVolumes';

const log = createLogger('device-provisioner');

// IS THIS OUR IDENTITY? Two things make a raw !== comparison wrong here, and both of them fail in the SAFE
// direction for the ordinary guards (a mismatch means "refuse") but in the USELESS direction for conversion,
// where a match is what grants permission -- it would refuse every disk we own, forever, while telling the
// operator their own disk belongs to somebody else.
//
//   1. FORM. `config.identity` is stored in whatever form it was created in, and on this array that is a
//      HYPHENATED UUID (2fb05f23-1d5e-4c00-bb71-f3109b42476c). The probe reads 16 raw bytes off the platter
//      and hex-encodes them (2fb05f231d5e4c00bb71f3109b42476c). Those strings are never equal.
//
//   2. LENGTH. A LOCKED disk identifies itself by its GPT nameplate, which only has room for the FIRST 16 hex
//      characters. So the identity it offers is a PREFIX of the real one, not the whole thing.
//
// Normalise both (the same way config.normalizeIdentity does), then compare on the shorter of the two -- but
// never on fewer than 16 hex characters, because a prefix that short stops being evidence of anything.
const sameIdentity = (ours: string | null, theirs: string): boolean => {
    const a = normalizeIdentity(ours ?? '');
    const b = normalizeIdentity(theirs);
    const shared = Math.min(a.length, b.length);
    return shared >= 16 && a.slice(0, shared) === b.slice(0, shared);
};

type DeviceProvisionerDeps = {
    listRawBlockDevices: typeof listRawBlockDevices;
    luks: {
        keyfileReadable: typeof luksKeyfileReadable;
        format: typeof luksFormat;
        addPassphrase: typeof luksAddPassphrase;
        open: typeof luksOpen;
        assertRecoverable: typeof luksAssertRecoverable;
        testPassphrase: typeof luksTestPassphrase;
        writeNameplate: typeof luksWriteNameplate;
        nameplateIsPresent: typeof luksNameplateIsPresent;
        mapperPath: typeof luksMapperPath;
        mapperBackingDevice: typeof luksMapperBackingDevice;
        close: typeof luksClose;
    };
    // WHO IS AT THIS PATH RIGHT NOW -- asked of the DRIVE, live, not read from a snapshot we took a minute ago.
    //
    // ⚠️ AND NOT `lsblk`'s SERIAL, WHICH IS THE USB BRIDGE'S. On this rack that value repeats: six pairs of disks
    // share a bridge serial and eight report none at all, because the enclosure answers on the drive's behalf
    // (its WWN is 0x5000000000000001 on all thirty-one of them). Holding a wipe to THAT identity would let a
    // disk in the next bay inherit the blessing meant for its neighbour.
    //
    // The SMART serial comes from the drive itself: 31 disks, 31 distinct values, none blank. It is the only
    // thing here that names one piece of metal.
    currentDiskIdentity: (blockPath: string) => Promise<string | null>;

    assertFleetRecoveryPassphrase: typeof assertFleetRecoveryPassphrase;
    assertPassphraseOpensTheFleet: typeof assertPassphraseOpensTheFleet;
    sealedRecoveryPassphrase: typeof sealedRecoveryPassphrase;
    hasRecoveryPassphrase: typeof hasRecoveryPassphrase;
    withEncryptionSlot: typeof withEncryptionSlot;
    database: typeof database;
    ioManager: typeof ioManager;
    spawnHelper: typeof spawnHelper;
    sleepSecs: (seconds: number) => Promise<void>;
    probeDeviceForStrubsIdentity: typeof probeDeviceForStrubsIdentity;
    // ONE source for "who are we". This used to be a boolean predicate while the nameplate writer reached
    // around it to `config.identity` -- two answers to the same question, free to disagree.
    instanceIdentity: () => string | null;
};

const defaultDeps: DeviceProvisionerDeps = {
    listRawBlockDevices,
    luks: {
        keyfileReadable: luksKeyfileReadable,
        format: luksFormat,
        addPassphrase: luksAddPassphrase,
        open: luksOpen,
        assertRecoverable: luksAssertRecoverable,
        testPassphrase: luksTestPassphrase,
        writeNameplate: luksWriteNameplate,
        nameplateIsPresent: luksNameplateIsPresent,
        mapperBackingDevice: luksMapperBackingDevice,
        close: luksClose,
        mapperPath: luksMapperPath
    },
    currentDiskIdentity: async (blockPath: string) =>
        (await smartInfoService.fetch(blockPath))?.serial_number ?? null,
    assertFleetRecoveryPassphrase,
    assertPassphraseOpensTheFleet,
    sealedRecoveryPassphrase,
    hasRecoveryPassphrase,
    withEncryptionSlot,
    database,
    ioManager,
    spawnHelper,
    sleepSecs: (seconds: number) => new Promise(resolve => setTimeout(resolve, seconds * 1000)),
    probeDeviceForStrubsIdentity,
    instanceIdentity: () => config.identity
};

export type ProvisionOptions = {
    blockPath: string;
    wipe?: boolean;

    // Tri-state ON PURPOSE. `undefined` means "whatever the fleet default says" (the runtimeConfig flag); an
    // explicit true/false is the operator overriding it for this one disk. Defaulting this to `false` in the
    // signature would silently ignore the fleet setting, which is the bug this comment exists to prevent.
    encrypt?: boolean;

    // The fleet recovery passphrase. Required whenever we encrypt: it becomes the volume's SECOND keyslot, and
    // without a second keyslot the volume dies with the OS disk that holds the keyfile. Never stored, never
    // logged. Demanding it on every encryption is also the only honest way to enforce the design's rule that the
    // operator must have RECORDED it -- if they cannot produce it, they have not got it.
    recoveryPassphrase?: string;

    // The serial of the disk the CALLER scanned. Every destructive step is checked against it, so that a disk
    // swapped in after the scan (a clone, a re-enumerated USB spindle) cannot inherit the caller's blessing.
    expectDiskSerial?: string;

    // CONVERTING ONE OF OUR OWN DISKS IN PLACE (the encryption backfill).
    //
    // Every other path through this class REFUSES a disk that carries our identity, because wiping a live STRUBS
    // disk is the worst thing this file could do. Conversion is the one case where that is the INTENT -- so it
    // is stated explicitly, by volume id, and the disk must then prove it really is that volume before we touch
    // it. "Ours" stops being a refusal and becomes a REQUIREMENT.
    //
    // The caller is responsible for having drained and deregistered the volume first. Those are not this class's
    // invariants to check -- but the mounted-partitions guard below is, and it will catch a caller that forgot.
    convertVolumeId?: number;
};

export class DeviceProvisioner {
    constructor(private readonly deps: DeviceProvisionerDeps = defaultDeps) {}

    async provision(options: ProvisionOptions): Promise<PersistedVolumeConfig> {
        // A ROTATION MUST NOT RUN THROUGH THE MIDDLE OF AN ENCRYPTED PROVISION.
        //
        // The passphrase is checked early and written into the new disk's keyslot minutes later -- after the
        // wipe, the partition, the luksFormat. If a rotation slipped into that gap it would record the NEW
        // passphrase while this disk was still being built with the OLD one, and the new volume simply would not
        // open with the passphrase in the safe. So the gate covers the WHOLE operation, not just the check.
        //
        // ONLY for encrypted provisions, and the decision is made HERE rather than inside -- a plaintext disk has
        // no keyslot to get wrong, and blocking a passphrase rotation for the ten minutes it takes to mkfs an 4TB
        // disk would be a needless refusal. (An earlier version wrapped every provision and claimed in a comment
        // that it did not, which is worse than either behaviour on its own.)
        const encrypt = await this.shouldEncrypt(options.encrypt);

        return encrypt
            ? this.deps.withEncryptionSlot(() => this.doProvision(options, encrypt))
            : this.doProvision(options, encrypt);
    }

    private async doProvision(options: ProvisionOptions, encrypt: boolean): Promise<PersistedVolumeConfig> {
        const { blockPath, wipe } = options;
        this.validateWipeOption(wipe);

        // Conversion rebuilds the disk from scratch: there is no such thing as converting it gently. Requiring
        // the caller to say `wipe` -- rather than setting it for them -- keeps every destructive path through
        // this class explicitly marked as one at the call site.
        if (options.convertVolumeId !== undefined) {
            if (wipe !== true)
                throw new HttpBadRequestError('converting a volume to encrypted rebuilds it: pass wipe');
            if (options.encrypt !== true)
                throw new HttpBadRequestError('converting a volume is only defined as a conversion TO encrypted: pass encrypt');
        }

        // HARD GATE 1: no instance identity means we are in RECOVERY. Provisioning FORMATS DISKS, and with
        // no identity we cannot even tell our own disks from a stranger's -- so the one thing we must not
        // do is offer to reinitialise the array we are trying to rescue. Refuse in the backend, not just
        // in the UI: the API is reachable regardless of what the UI renders.
        if (this.deps.instanceIdentity() === null)
            throw new HttpBadRequestError('provisioning is disabled during recovery: restore the instance identity first');

        let devices: RawBlockDevice[];
        let targetDevice: RawBlockDevice | undefined;

        // HARD GATE 2: ASK THE DISK WHETHER IT IS ALREADY OURS -- ON EVERY PATH, NOT JUST THE WIPE ONE.
        //
        // This used to run only when `wipe` was passed, on the reasoning that the non-wipe path is safe because
        // it refuses a partitioned disk. It is not. Both paths end in `parted mklabel` and `mkfs`, and the
        // non-wipe guard below only catches a disk that ADVERTISES A PARTITION TABLE. A whole-disk STRUBS volume
        // (or a whole-disk LUKS container) has no partition table at all, and would walk through the non-wipe
        // path and get repartitioned. So read the identity off the platter, with a probe that cannot write to
        // what it inspects. It fails CLOSED: a disk we could not read is refused, not assumed blank.
        //
        // ⚠️ ANCHOR THE DRIVE'S IDENTITY *BEFORE* WE READ IT TO DECIDE IF IT IS SAFE TO WIPE.
        //
        // The safety probe below (assertDeviceIsNotOurs) is the guard that says "this disk is blank / not ours".
        // It reads the disk to decide -- and a read is only trustworthy if the disk cannot change across it. The
        // initial lsblk snapshot can already be stale: if a blank disk was at this path when we listed, and a
        // partitioned STRUBS disk took the path before the probe, the probe would see the STALE snapshot's empty
        // `children`, fall through to a whole-disk signature read, find a GPT table, and call it "clean" -- and
        // we would repartition a live disk it never actually inspected.
        //
        // ⚠️ ASKED OF THE DRIVE, NOT THE ENCLOSURE. `targetDevice.serial` is the USB BRIDGE's: on this rack six
        // pairs share one and eight report nothing. Only the SMART serial names one spindle.
        const diskSerial = await this.deps.currentDiskIdentity(blockPath);

        if (!diskSerial)
            throw new HttpBadRequestError(
                `refusing to provision ${blockPath}: the drive will not report a SMART serial, so it cannot prove `
                + `which piece of metal it is -- and every check between here and the wipe depends on that.`
            );

        // THE DISK THE CALLER SCANNED -- not whatever holds the path now. A dd'd clone answering to the same path
        // and partition uuid cannot forge the drive's own SMART serial. (See mgmt's conversion handoff.)
        if (options.expectDiskSerial && options.expectDiskSerial !== diskSerial)
            throw new HttpBadRequestError(
                `refusing to provision ${blockPath}: the drive there is ${diskSerial}, but the disk that was `
                + `scanned for this operation is ${options.expectDiskSerial}. A DIFFERENT PHYSICAL DISK is sitting `
                + `at that path now. Nothing has been written.`
            );

        // LIST THE RACK ONLY NOW, AFTER the anchor -- so the snapshot the probe examines belongs to the disk we
        // just identified. The serial checks bracketing the probe (here, and again after it) prove the disk did
        // not change across the read, so its "blank / not ours" verdict is about the disk we are going to wipe.
        devices = await this.deps.listRawBlockDevices();
        targetDevice = this.findDeviceByPath(devices, blockPath);
        if (!targetDevice)
            throw new HttpBadRequestError('block device not found');
        await this.assertStillTheSameDisk(blockPath, diskSerial, `read ${blockPath}`);

        await this.assertDeviceIsNotOurs(blockPath, targetDevice, options.convertVolumeId);

        // Nothing swapped in WHILE the probe was reading the platter. If it had, the probe vetted one disk and we
        // would be about to wipe another.
        await this.assertStillTheSameDisk(blockPath, diskSerial, `provision ${blockPath}`);

        if (wipe === true) {
            if (this.deviceHasMountedPartitions(targetDevice))
                throw new HttpBadRequestError('block device has mounted partitions');

            await this.wipeDevice(blockPath, diskSerial);
            await this.deps.sleepSecs(1);
            devices = await this.deps.listRawBlockDevices();
            targetDevice = this.findDeviceByPath(devices, blockPath);
            if (!targetDevice)
                throw new HttpBadRequestError('block device not found after wipe');
        }
        else {
            // The non-wipe path still runs `parted` and `mkfs`, so it is just as destructive -- it is only
            // safe because it refuses a partitioned disk. But an EMPTY `children` list is not proof that a
            // disk is blank: if partition enumeration failed or is stale, a live STRUBS disk presents as
            // bare media and we would happily reformat it. So require POSITIVE evidence of blankness: a
            // device advertising a partition table while showing no readable partitions is UNKNOWN, and
            // unknown means refuse. (After a wipe this cannot apply -- `parted mklabel` has just written a
            // fresh, deliberately empty table.)
            if (targetDevice.pttype || targetDevice.ptuuid) {
                throw new HttpBadRequestError(
                    `refusing to provision ${blockPath}: it advertises a ${targetDevice.pttype ?? 'partition'} table `
                    + `but no readable partitions, so it cannot be established as blank. Pass wipe to deliberately destroy it.`
                );
            }
        }

        if (targetDevice.children?.length)
            throw new HttpBadRequestError('block device already partitioned');
        if (!targetDevice.serial)
            throw new HttpBadRequestError('block device serial unavailable');

        // On the conversion path the volume was deregistered before we were called, so it is no longer in the
        // fleet map for ensureDeviceNotRegistered to find -- but its id must be preserved regardless. Losing it
        // would renumber a disk that never left the array.
        // Reuse of an already-registered volume id happens ONLY on the conversion path (convertVolumeId), which
        // is fully guarded upstream: the volume must be drained and read-only, its DB references checked, and its
        // platter scanned for live-or-orphan slices. There is no longer a generic `replace` -- a new disk gets a
        // NEW id, and re-provisioning a registered disk means deleting its volume first. That deletes the last
        // unguarded destructive escape hatch (a `replace` that skipped every one of conversion's checks).
        const registeredVolumeId = await this.ensureDeviceNotRegistered(
            targetDevice, devices, options.convertVolumeId !== undefined);
        const replacedVolumeId = options.convertVolumeId ?? registeredVolumeId;

        // PREFLIGHT BEFORE WE TOUCH THE PARTITION TABLE. If the key is missing, or the operator cannot produce
        // the fleet recovery passphrase, we want to find out NOW, while the disk is still whole -- not after
        // `parted` has run, leaving a wiped disk and no way to encrypt it.
        const passphrase = encrypt ? await this.assertEncryptionIsPossible(options.recoveryPassphrase) : null;

        // The mapper is named from the volume's uuid, so the uuid has to exist before the container can be
        // opened -- which is before mkfs, which is well before we would otherwise have minted it.
        const volumeUuid = randomUUID();

        // THE LAST THING BEFORE THE DISK IS DESTROYED. assertEncryptionIsPossible() above may have spent
        // seconds on argon2 and on asking a disk whether the passphrase opens it; the rack can change under us
        // in that time. This is the final check, and it is deliberately the closest line to `parted`.
        await this.partitionDevice(blockPath, diskSerial, !wipe);
        await this.deps.sleepSecs(1);

        let partitionInfo = await this.waitForPartition(blockPath);
        const partitionPath = this.resolvePartitionPath(partitionInfo.partition);

        // ⚠️ `parted` WAS NOT THE LAST DESTRUCTIVE STEP, AND THE PATH IS STILL JUST A PATH.
        //
        // Between the serial check above and here we ran parted, SLEPT A SECOND, and re-enumerated the rack --
        // and waitForPartition() cheerfully hands back whatever now sits at this path. If the disk dropped in
        // that window and another took its name, the next two lines (luksFormat, mkfs) destroy a disk we never
        // looked at. So ask again, right before we write to what we just found.
        await this.assertStillTheSameDisk(blockPath, diskSerial, `encrypt and format ${blockPath}`);

        // WHAT WE MKFS IS NOT ALWAYS THE PARTITION. On an encrypted volume the ext4 goes on the mapper; putting
        // it on the partition would overwrite the LUKS header we just wrote.
        if (passphrase !== null)
            conversionPhase('encrypting');

        const filesystemTarget = passphrase !== null
            ? await this.encryptPartition(partitionPath, volumeUuid, passphrase, blockPath, diskSerial)
            : partitionPath;

        // mkfs on a 4TB disk is not instant either. Say so.
        conversionPhase('formatting');

        // The mkfs is fenced inside formatPartition. On an encrypted volume the target is the MAPPER, and the
        // mapper-backing check inside encryptPartition has already proven the mapper is backed by our disk.
        await this.formatPartition(filesystemTarget, blockPath, diskSerial);
        await this.deps.sleepSecs(2);

        partitionInfo = await this.waitForPartition(blockPath);
        const finalDevice = partitionInfo.device;
        const partition = partitionInfo.partition;

        // ⚠️ waitForPartition() RETURNS WHATEVER IS AT THE PATH NOW, and there was a 2-second sleep and a
        // re-enumeration since the last fence. On the ENCRYPTED path the nameplate write below is fenced, so a
        // swap is caught there -- but the PLAINTEXT path writes no nameplate, so without this its only identity
        // claim (registerVolume -> .identity) could land on a disk that swapped in during the sleep. Verify the
        // disk we are about to build a volume around, and claim identity on, is still the one we formatted.
        await this.assertStillTheSameDisk(blockPath, diskSerial, `register a volume on ${blockPath}`);

        // On an encrypted volume this uuid is the LUKS header's, not the ext4's -- lsblk reports the container's
        // uuid for a crypto_LUKS partition. That is exactly what we want: it is stable, unique, and READABLE
        // WHILE THE DISK IS STILL LOCKED, which is precisely when we need to identify it.
        if (!partition.uuid)
            throw new HttpBadRequestError('partition UUID unavailable');

        // ⚠️ READ IT BEFORE YOU DESTROY IT. deleteVolume() is a HARD deleteOne, and createVolumeConfig() below
        // rebuilds the record from scratch -- so anything we mean to carry across has to be in hand BEFORE this
        // line, not looked up after it. The first version of this fix read the row afterwards, found nothing,
        // and preserved nothing; its test passed only because the fake database's getVolumes() had never heard
        // of deleteVolume().
        const previousVolume = replacedVolumeId !== undefined
            ? (await this.deps.database.getVolumes()).find(volume => volume.id === replacedVolumeId)
            : undefined;

        if (replacedVolumeId) {
            await this.deps.database.deleteVolume(replacedVolumeId);
            // Drop the old in-memory Volume too. Without this, registerVolume below pushes a SECOND config with
            // the same id and the fleet keeps a stopped, stale Volume object bound to a disk that no longer
            // exists -- and `_volumeConfig.find(cfg => cfg.id === id)` hands out the dead one.
            await this.deps.ioManager.deregisterVolume(replacedVolumeId);
        }

        // Work out the volume's identity (id and uuid) WITHOUT writing anything yet: the nameplate needs the id,
        // and on an encrypted volume the nameplate has to be on the disk before the volume may exist at all.
        const volumeConfig = await this.createVolumeConfig(
            finalDevice, partition, volumeUuid, replacedVolumeId, previousVolume);

        // THE NAMEPLATE GOES ON BEFORE THE RECORD DOES, and it must land.
        //
        // It is how a LOCKED disk says it is ours, and the fleet-passphrase guard enumerates the array's
        // encrypted disks by reading these plates off the partition table -- so an encrypted disk without one is
        // invisible to it, and the next encryption would never test its passphrase against it. That is how a
        // fleet ends up split across two recovery passphrases.
        //
        // Doing this AFTER database.createVolume() would have made the refusal useless: the record would already
        // exist, and the next restart would mount the nameplate-less volume anyway -- the exact state we are
        // refusing, merely delayed. Fail here and all that is left behind is a formatted, unregistered disk that
        // nothing refers to.
        // The nameplate is written to the GPT of blockPath -- a claim on a physical disk, so it is fenced too. A
        // nameplate stamped onto the wrong disk is a wrong-disk write and, worse, a lie about whose data it is.
        if (encrypt)
            await this.fencedWrite(blockPath, diskSerial, `stamp the nameplate onto ${blockPath}`, () =>
                this.stampNameplate(blockPath, partition, volumeConfig.id));

        // NOTE: nothing is recorded in the database about WHICH volumes are encrypted -- deliberately.
        //
        // There used to be a `luksEncryptedVolumes` list here, so that a passphrase rotation could refuse while
        // an encrypted disk was unplugged. It produced a defect in EVERY review round: the record lives in the
        // same database that a restore or a rebuild can take away, so "volume 12 is not in the list" can mean
        // "12 is plaintext" OR "the list is gone" -- and the code kept betting on the first.
        //
        // The rule that replaced it needs no record: A ROTATION REFUSES WHILE ANY VOLUME IS ABSENT. It asks the
        // platters what is in front of it and will not rewrite the fleet's keys behind a disk it cannot see.
        // Nothing to lose, nothing to restore, nothing to get subtly wrong.

        // ⚠️ CLAIM THE DISK BEFORE THE DATABASE ROW, AND CLAIM IT NON-WRITABLE. Two invariants, one ordering:
        //
        //  1. ORPHANS BEAT PHANTOMS. The physical identity claim (.identity on the filesystem) goes onto the
        //     disk BEFORE the Mongo row. A failure then leaves a claimed disk with no row -- a recoverable
        //     orphan -- never a row pointing at a disk we did not finish claiming, which is a phantom.
        //
        //  2. NOT WRITABLE UNTIL DURABLE. registerVolume makes the volume part of the LIVE fleet. If it were
        //     writable in that instant, a concurrent PUT could place slices on it and write object rows that
        //     reference it -- and if the row write below then failed, those object rows would point at a volume
        //     the fleet no longer has. So we register it READ-ONLY: getWritableVolumes() excludes it, the planner
        //     never picks it, and no slice can land until its row is durable and we make it writable.
        //
        // registerVolume is the ONLY caller that may stamp our identity onto a disk -- it just formatted it.
        // Fenced, because initializeIdentity writes to physical media, and a claim on the wrong disk is a lie.
        const readOnlyConfig: PersistedVolumeConfig = { ...volumeConfig, read_only: true };

        await this.fencedWrite(blockPath, diskSerial, `claim identity on ${blockPath}`, () =>
            this.deps.ioManager.registerVolume(readOnlyConfig, { initializeIdentity: true }));

        // THE DURABLE ROW (still read-only). If this fails, deregister -- the volume was never writable, so no
        // slice can have landed on it -- and leave the disk as a recoverable orphan, not a phantom.
        try {
            await this.deps.database.createVolume(readOnlyConfig);
        }
        catch (err) {
            await this.deps.ioManager.deregisterVolume(volumeConfig.id).catch(deregErr =>
                log.error('volume%d: could not deregister after a failed record write: %s', volumeConfig.id, deregErr));
            throw new HttpBadRequestError(
                `volume ${volumeConfig.id} was written to disk but its database record could not be created `
                + `(${err instanceof Error ? err.message : String(err)}). The disk carries our identity and is a `
                + `recoverable orphan -- it was never made writable, so nothing was placed on it, and it has NOT `
                + `been left as a phantom. Fix the database and re-run recovery, or re-provision the disk.`
            );
        }

        // The row is durable. NOW make it writable, on disk (Mongo) first then in memory -- the same order every
        // other flag change uses. Whichever of these two fails, the result is safe: the durable row already
        // exists, so there is never a phantom and never lost data. If the Mongo update fails the volume is a
        // valid read-only volume an operator can enable; if only the in-memory update fails, Mongo says writable
        // and the fleet catches up on the next reconcile or restart. Not yet taking writes, at worst.
        await this.deps.database.updateVolumeFlags(volumeConfig.id, { isReadOnly: false });
        await this.deps.ioManager.updateVolumeFlags(volumeConfig.id, { isReadOnly: false });

        return volumeConfig;
    }

    // The fleet default, overridable per disk. Read at provision time rather than cached: an operator who flips
    // the setting expects the next disk they add to honour it, not the next restart.
    private async shouldEncrypt(explicit?: boolean): Promise<boolean> {
        if (typeof explicit === 'boolean')
            return explicit;
        return await this.deps.database.getRuntimeConfig(ENCRYPT_NEW_VOLUMES_KEY) === true;
    }

    // Everything that must be true BEFORE the partition table is touched. Each of these, discovered later,
    // means a destroyed disk and a failed provision.
    private async assertEncryptionIsPossible(passphrase: string | undefined): Promise<string> {
        if (!await this.deps.luks.keyfileReadable())
            throw new HttpBadRequestError(
                `refusing to provision an encrypted volume: the LUKS keyfile (${DEFAULT_KEYFILE}) is missing or `
                + `unreadable. A disk encrypted with a key we do not have is a disk full of noise.`
            );

        // NOBODY IS ASKED FOR THE PASSPHRASE HERE, AND THAT IS DELIBERATE.
        //
        // STRUBS already holds it, sealed under the keyfile, and the disks were written with it BY US. Making an
        // operator re-type it to encrypt a disk was not a security control -- it protected nothing that the
        // keyfile does not already open -- it was just a prompt. Worse, it made `encryptNewVolumes` dishonest:
        // an automatically provisioned disk has no operator to prompt, so the setting could only ever fail.
        //
        // It still cannot be produced from thin air. If nothing is sealed, we stop -- we do not invent one, and
        // we do not encrypt a disk with the keyfile alone (that disk would die with the OS disk).
        const known = passphrase ?? await this.deps.sealedRecoveryPassphrase();

        if (!known) {
            // TWO DIFFERENT FAILURES, AND TELLING THEM APART IS THE WHOLE VALUE OF THE MESSAGE. "You never set
            // one" and "you set one and I cannot use it" want opposite things from the operator, and an array
            // that says the first when it means the second is calling its own admin a liar.
            const recorded = await this.deps.hasRecoveryPassphrase();

            throw new HttpBadRequestError(recorded
                ? 'refusing to encrypt: a recovery passphrase is recorded, but this array cannot USE it -- it '
                    + 'was set before STRUBS kept a sealed copy, or the keyfile it was sealed under is not the '
                    + 'one we hold now. A hash proves a passphrase; it cannot produce one. Enter it once on the '
                    + 'Encryption tab (POST /$/encryption/seal) and this fixes itself.'
                : 'refusing to encrypt: this array has no recovery passphrase. It becomes the volume\'s second '
                    + 'keyslot, and a volume with only the keyfile slot dies with the OS disk. Set one on the '
                    + 'Encryption tab (PUT /$/encryption/passphrase) and try again.'
            );
        }

        // ⚠️ THE DISK PROOF COMES FIRST, BECAUSE THE HASH CHECK HAS A SIDE EFFECT.
        //
        // assertFleetRecoveryPassphrase() seals the passphrase when it accepts it. Run it first and a stale
        // passphrase out of a restored database gets sealed before the platters ever get a say -- and then we
        // refuse the encryption, having already written the wrong answer down as gospel.
        //
        // ASK THE DISK, BECAUSE THE DISKS ARE AUTHORITATIVE AND MONGO IS A DERIVED INDEX.
        //
        // Everything above this line asks the database whether this is the fleet's passphrase, and the database
        // can be WRONG in the one way that matters: restore it from a backup older than the last rotation and
        // its notes say the old passphrase while every platter in the rack wants the new one. The notes agree
        // with each other perfectly -- they were rewound together -- so no amount of checking them against each
        // other can catch it. Meanwhile nothing else in the system would ever notice, because STRUBS mounts with
        // the keyfile and never touches the passphrase slot.
        //
        // Writing that stale passphrase into this disk's keyslot builds a split fleet on purpose. So before we
        // do: does it open a disk we ALREADY encrypted? One disk, three seconds. If not, refuse.
        await this.deps.assertPassphraseOpensTheFleet(known);

        // ⚠️ ONE DISK, DELIBERATELY -- the fleet-wide proof was a Mongo-anchored gate whose authority a database
        // restore could rewind, and defending a fact that lives in the database we do not trust turned into an
        // endless patch cycle. The single live proof + the absent/unknown refusal is the accepted design; the
        // background audit (below, and after every conversion) is the fleet-wide health check, no longer
        // load-bearing for this decision.

        // ⚠️ RECORDED LAST, BECAUSE RECORDING IS A WRITE.
        //
        // assertFleetRecoveryPassphrase() SEALS the passphrase as a side effect of accepting it. Every refusal
        // above has to come first, or a passphrase this array was not allowed to use gets written down as the
        // fleet's anyway -- the request fails, `passphraseUsable` goes true, and the lie outlives the error.
        // (This is also what sets the verifier on the FIRST encryption, which is why it cannot simply be moved
        // out of the way.)
        await this.deps.assertFleetRecoveryPassphrase(known);

        return known;
    }

    // Turn a bare partition into an unlocked LUKS container and hand back the mapper to mkfs.
    private async encryptPartition(
        partitionPath: string, volumeUuid: string, passphrase: string, blockPath: string, diskSerial: string
    ): Promise<string> {
        // luksFormat OVERWRITES A LUKS HEADER. Point it at another STRUBS disk that has taken this path and you
        // have destroyed the only thing that could ever open it -- with the keyfile still happily in hand.
        await this.fencedWrite(blockPath, diskSerial, `write a LUKS header to ${blockPath}`, () =>
            this.deps.luks.format(partitionPath));

        // ⚠️ A SEPARATE WRITE, AND SO A SEPARATE FENCE. luksAddKey authenticates with the fleet keyfile, so it
        // would happily write a keyslot onto ANOTHER of our disks that took this path after luksFormat.
        await this.fencedWrite(blockPath, diskSerial, `add a keyslot to ${blockPath}`, () =>
            this.deps.luks.addPassphrase(partitionPath, passphrase));

        // Belt and braces: assertRecoverable ASKS THE DISK how many keyslots it actually has, rather than
        // trusting that the call above did what it said. If the passphrase somehow did not land, we find out
        // here -- BEFORE the mkfs, while walking away costs us nothing but a blank partition.
        //
        // ⚠️ ITS ANSWER IS LOAD-BEARING, SO FENCE IT. A header that swapped in here is a DISK that swapped in
        // (partitionPath is a partition of blockPath), which the SMART serial catches -- so we do not draw a
        // conclusion about this disk's keyslots from a reading of a different one.
        await this.assertStillTheSameDisk(blockPath, diskSerial, `count the keyslots on ${blockPath}`);
        await this.deps.luks.assertRecoverable(partitionPath);

        // ...BUT TWO KEYSLOTS IS NOT THE SAME AS "THE PASSPHRASE OPENS IT".
        //
        // assertRecoverable only COUNTS slots. It cannot tell you what is in them. And this disk is the base
        // case of the whole inductive argument that lets every LATER encryption check just one disk: we assert
        // that every encrypted volume opens with the fleet passphrase because each one was checked when it was
        // made. If that assertion is ever false at the moment of creation, every subsequent single-disk check
        // inherits the lie -- and the audit would find it months later, if at all.
        //
        // So prove it. Open nothing, write nothing: just ask this brand-new header whether the passphrase we
        // were given actually fits it -- and fence it before AND after, because the argon2 test is slow and its
        // 'opens' verdict is the base case of the whole single-disk-proof inductive argument. An impostor that
        // answered here would poison every later encryption.
        await this.assertStillTheSameDisk(blockPath, diskSerial, `prove the passphrase on ${blockPath}`);
        const newHeaderOpens = await this.deps.luks.testPassphrase(partitionPath, passphrase);
        await this.assertStillTheSameDisk(blockPath, diskSerial, `prove the passphrase on ${blockPath}`);

        if (newHeaderOpens !== 'opens')
            throw new LuksError(
                `${partitionPath} was encrypted, but the recovery passphrase does not open it. Refusing to put it `
                + `into service: it would be a disk that only the keyfile can open, and it would silently break `
                + `the guarantee that the fleet passphrase opens every disk. Nothing of value is on it yet.`,
                'failed');

        const mapperPath = await this.deps.luks.open(partitionPath, volumeUuid);

        // ⚠️ THE MAPPER HOLDS A DISK, NOT A PATH -- AND mkfs RUNS ON THE MAPPER.
        //
        // Every serial check so far asked "what is at /dev/sdb right now". But cryptsetup opened the mapper over
        // whatever backed /dev/sdb1 at the instant of open, and it keeps that kernel device by reference. So the
        // one wrong-disk path a path-check cannot see: A drops, B takes /dev/sdb, we open a mapper backed by B,
        // then A comes BACK to /dev/sdb before the next check -- the path reads A's serial and passes, while the
        // mapper we are about to mkfs is still B. Ask the mapper who ITS disk is, not who the path's is.
        await this.assertMapperBackedByExpectedDisk(volumeUuid, diskSerial);

        return mapperPath;
    }

    private async assertMapperBackedByExpectedDisk(volumeUuid: string, diskSerial: string): Promise<void> {
        const backing = await this.deps.luks.mapperBackingDevice(luksMapperName(volumeUuid));

        const tearDownAndThrow = async (message: string): Promise<never> => {
            // Leave nothing mapped over a disk we are refusing to trust.
            await this.deps.luks.close(volumeUuid).catch(() => undefined);
            throw new HttpBadRequestError(message);
        };

        if (!backing)
            return tearDownAndThrow(
                `refusing to make a filesystem: the encrypted mapper for ${volumeUuid} has no single backing `
                + `device we can identify. Nothing has been written to the filesystem.`);

        // "sdb1" -> "/dev/sdb", "nvme0n1p1" -> "/dev/nvme0n1". The parent disk is what carries a SMART serial.
        const parentPath = `/dev/${backing.replace(/p?\d+$/, '')}`;
        const backingSerial = await this.deps.currentDiskIdentity(parentPath);

        if (backingSerial !== diskSerial)
            return tearDownAndThrow(
                `refusing to make a filesystem: the encrypted mapper is backed by drive `
                + `${backingSerial ?? 'unknown'} (${parentPath}), not ${diskSerial} -- the disk we scanned. A `
                + `DIFFERENT PHYSICAL DISK was mapped. Nothing has been written to the filesystem.`);
    }

    // "strubs-<identity>-<id>", written into the GPT partition entry -- OUTSIDE the container, so a locked disk
    // can still say whose it is and which volume it holds. Without it, a locked STRUBS disk and a locked stranger
    // are indistinguishable until someone unlocks them, and telling those apart is the whole job of the wipe guard.
    // MANDATORY ON AN ENCRYPTED VOLUME. Best-effort would not do.
    //
    // The nameplate is the ONLY thing that identifies a locked disk -- everything else about it is inside the
    // encryption. And the passphrase guard now enumerates the fleet's encrypted disks BY NAMEPLATE, straight
    // off the platters, precisely so that it does not have to trust Mongo's idea of which disks exist.
    //
    // So an encrypted disk without a nameplate is a disk that is invisible to that guard: the next encryption
    // would not know to check its passphrase against it, and could quietly split the fleet. A plate we failed
    // to write is therefore a failed provision, not a warning -- we would rather leave a blank encrypted
    // partition behind than an unidentifiable one in service.
    private async stampNameplate(diskPath: string, partition: RawBlockDeviceChild, volumeId: number): Promise<void> {
        const identity = this.deps.instanceIdentity();
        if (!identity)
            throw new HttpBadRequestError('cannot stamp a nameplate without an instance identity');

        const partitionNumber = this.partitionNumberOf(partition);
        if (partitionNumber === null)
            throw new HttpBadRequestError(
                `could not work out a partition number for ${partition.name}, so the nameplate cannot be `
                + `written. An encrypted disk with no nameplate cannot be identified while locked, and would be `
                + `invisible to the guard that stops this fleet drifting onto two recovery passphrases.`
            );

        await this.deps.luks.writeNameplate(diskPath, partitionNumber, identity, volumeId);

        // writeNameplate() logs and returns on failure rather than throwing -- it is advisory for a plaintext
        // volume. On an ENCRYPTED one it is load-bearing, so go and check that it actually landed.
        if (!await this.deps.luks.nameplateIsPresent(diskPath, partitionNumber, identity, volumeId))
            throw new HttpBadRequestError(
                `the nameplate could not be written to ${diskPath} partition ${partitionNumber}. Refusing to put `
                + `an unidentifiable encrypted disk into service: while locked it would be indistinguishable `
                + `from a stranger's, and invisible to the fleet-passphrase check.`
            );
    }

    private partitionNumberOf(partition: RawBlockDeviceChild): number | null {
        const match = /(\d+)$/.exec(partition.name);
        return match ? Number(match[1]) : null;
    }

    // Refuse to destroy a disk that is (or might be) already ours. Fails CLOSED on 'unknown': if the
    // filesystem is there but will not mount -- busy, dirty journal, failing sectors -- we do NOT get to
    // call it blank. An operator who is certain can still clear the disk by hand; the API will not do it
    // for them on a guess.
    private async assertDeviceIsNotOurs(blockPath: string, device: RawBlockDevice, convertVolumeId?: number): Promise<void> {
        const probe = await this.deps.probeDeviceForStrubsIdentity(device);

        // THE CONVERSION EXCEPTION -- the only way past the guard, and it is narrower than the guard itself.
        //
        // Encrypting an existing volume means wiping one of our own disks on purpose. So instead of "prove this
        // disk is NOT ours", conversion must prove it IS ours, and is EXACTLY the volume we were told to
        // convert, on THIS instance. An unreadable disk, a stranger's disk, a blank disk, or one of ours
        // bearing a different volume id all fall through to the refusals below -- so a mistyped id destroys
        // nothing.
        if (convertVolumeId !== undefined) {
            if (probe.status !== 'strubs')
                throw new HttpBadRequestError(
                    `refusing to convert ${blockPath} to an encrypted volume: it does not identify itself as `
                    + `volume ${convertVolumeId} of this array (${probe.status}). Conversion wipes the disk, so it `
                    + `must first prove it is the disk you meant.`
                );

            if (probe.identity.volumeId !== convertVolumeId)
                throw new HttpBadRequestError(
                    `refusing to convert ${blockPath}: it carries STRUBS volume ${probe.identity.volumeId}, not `
                    + `volume ${convertVolumeId}. That is a different disk from the one you asked to convert.`
                );

            const identity = this.deps.instanceIdentity();
            if (!sameIdentity(identity, probe.identity.instanceIdentity))
                throw new HttpBadRequestError(
                    `refusing to convert ${blockPath}: it belongs to STRUBS instance `
                    + `${probe.identity.instanceIdentity}, not this one (${identity}).`
                );

            return;
        }

        if (probe.status === 'strubs') {
            throw new HttpBadRequestError(
                `refusing to wipe ${blockPath}: it carries STRUBS volume ${probe.identity.volumeId} of instance `
                + `${probe.identity.instanceIdentity} and may hold live data. If this disk is genuinely being `
                + `retired, drain and remove that volume first.`
            );
        }

        if (probe.status === 'unknown') {
            throw new HttpBadRequestError(
                `refusing to wipe ${blockPath}: could not establish whether it belongs to this STRUBS array `
                + `(${probe.reason}). Refusing rather than assuming it is blank.`
            );
        }
    }

    private findDeviceByPath(devices: RawBlockDevice[], blockPath: string): RawBlockDevice | undefined {
        return devices.find(device => device.path === blockPath);
    }

    // ⚠️ THE MOUNT IS NOT ON THE PARTITION. IT IS ON THE MAPPER UNDERNEATH IT.
    //
    // This used to ask each direct `part` child whether it had a mountpoint. On a LUKS volume the answer is
    // NO -- and it is no even while the disk is mounted, in service, and holding live customer data. The
    // partition carries crypto_LUKS and nothing else; the ext4 and the mountpoint live on a `crypt` grandchild:
    //
    //     sdf          disk
    //     └─sdf1       part   fstype=crypto_LUKS   mountpoint=null      <- what this asked
    //       └─luks-..  crypt  fstype=ext4          mountpoint=/run/..   <- where the mount actually is
    //
    // So the guard returned false, and `POST /$/volumes {wipe}` would have repartitioned a mounted, in-service,
    // encrypted disk. The design calls this out as ⚠️ DATA LOSS and says it must be fixed before the first
    // volume is ever encrypted. It is being fixed before the first volume is ever encrypted.
    //
    // Walk the whole subtree. Device-mapper stacks, and a check that only looks one level down is a check that
    // a second layer strolls straight past.
    private deviceHasMountedPartitions(device: RawBlockDevice): boolean {
        const anyMounted = (children: RawBlockDeviceChild[] | undefined): boolean =>
            Boolean(children?.some(child => {
                const mountPoint = child.mountpoint;
                if (typeof mountPoint === 'string' && mountPoint.length > 0) return true;
                return anyMounted(child.children);
            }));

        return anyMounted(device.children);
    }

    private validateWipeOption(wipe?: boolean): void {
        if (wipe === undefined || typeof wipe === 'boolean')
            return;
        throw new HttpBadRequestError('wipe must be a boolean');
    }

    private async ensureDeviceNotRegistered(targetDevice: RawBlockDevice, devices: RawBlockDevice[], reuseForConversion?: boolean): Promise<number | undefined> {
        const alreadyRegistered = () => new HttpBadRequestError(
            'device already registered: this disk already belongs to a volume. Delete that volume first, then '
            + 'add the disk as a new one (it will get a new id). To re-encrypt an existing volume in place, use '
            + 'the conversion flow, which drains and checks it first.');

        const { identityKeys, serials, volumeIdByIdentity, volumeIdBySerial } = await this.getRegisteredIdentities(devices);
        if (targetDevice.serial && serials.has(targetDevice.serial)) {
            if (!reuseForConversion)
                throw alreadyRegistered();
            return volumeIdBySerial.get(targetDevice.serial);
        }
        const identityKey = getDeviceIdentityKey(targetDevice);
        if (identityKey && identityKeys.has(identityKey)) {
            if (!reuseForConversion)
                throw alreadyRegistered();
            return volumeIdByIdentity.get(identityKey);
        }
        return undefined;
    }

    private async getRegisteredIdentities(devices: RawBlockDevice[]): Promise<{ identityKeys: Set<string>; serials: Set<string>; volumeIdByIdentity: Map<string, number>; volumeIdBySerial: Map<string, number> }> {
        const identityKeys = new Set<string>();
        const serials = new Set<string>();
        const volumeIdByIdentity = new Map<string, number>();
        const volumeIdBySerial = new Map<string, number>();
        for (const [volumeId, volume] of this.deps.ioManager.getVolumeEntries()) {
            if (volume.deviceSerial) {
                serials.add(volume.deviceSerial);
                volumeIdBySerial.set(volume.deviceSerial, volumeId);
            }
            const partitionUuid = volume.partitionUuid;
            if (!partitionUuid)
                continue;
            const device = devices.find(dev => dev.children?.some(child => child.uuid === partitionUuid));
            if (!device)
                continue;
            const identityKey = getDeviceIdentityKey(device);
            if (identityKey) {
                identityKeys.add(identityKey);
                volumeIdByIdentity.set(identityKey, volumeId);
            }
        }
        return { identityKeys, serials, volumeIdByIdentity, volumeIdBySerial };
    }

    // ⚠️ A PATH IS NOT AN IDENTITY, AND `parted` TAKES A PATH.
    //
    // Everything between the scan and the wipe is asynchronous -- an identity probe, an argon2 hash, a
    // passphrase test against a disk. That is seconds, and these are USB spindles on a hub that drops them. If
    // the disk at /dev/sdf goes away in that window and another takes the name, `targetDevice` still describes
    // the disk we MEANT and /dev/sdf now points at a disk we did not. The next line formats it.
    //
    // The serial comes from the hardware, not the kernel's enumeration order, so it survives a rename. Ask the
    // machine again, right now, and refuse if the answer changed. This costs one lsblk before an operation that
    // takes minutes -- and a wipe aimed at the wrong disk is not something we get to apologise for afterwards.
    private async assertStillTheSameDisk(blockPath: string, expected: string, context: string): Promise<void> {
        const now = await this.deps.currentDiskIdentity(blockPath);

        if (!now)
            throw new HttpBadRequestError(
                `refusing to ${context}: ${blockPath} will not say who it is (no SMART serial). It may have gone `
                + `away while we were preparing to write to it. A disk that cannot prove its identity does not `
                + `get wiped.`
            );

        if (now !== expected)
            throw new HttpBadRequestError(
                `refusing to ${context}: ${blockPath} is now drive ${now}, not ${expected}. A DIFFERENT PHYSICAL `
                + `DISK has taken that path since we looked. Nothing has been written.`
            );
    }

    // ⚠️ THE ONE CHOKE POINT FOR DESTRUCTIVE WRITES. Every command that could destroy a disk -- parted, mkfs,
    // luksFormat, luksAddKey, the nameplate write -- goes through here, and here checks the drive's SMART serial
    // IMMEDIATELY before the write. Not "before the sequence": before each individual write.
    //
    // The reason is a lesson learned the hard way, over several reviews: it is not enough to check once and then
    // run three destructive steps, because these are USB disks on a hub that drops them, and the disk at a path
    // can change between any two commands. `parted mklabel` then `parted mkpart` is two writes; a serial check
    // before the first does not vouch for the second. Routing every write through one fenced call makes it
    // structurally impossible to add a destructive step that forgets the check -- which is exactly how the
    // unfenced ones kept reappearing.
    //
    // It does NOT close the window to zero: a path-based tool always has a gap between our check and its own
    // open() of the path. It closes the gap to a single event-loop tick, which is the floor without holding an
    // exclusive handle on the disk for the whole operation.
    private async fencedWrite<T>(
        blockPath: string, diskSerial: string, context: string, write: () => Promise<T>
    ): Promise<T> {
        await this.assertStillTheSameDisk(blockPath, diskSerial, context);
        return await write();
    }

    private async wipeDevice(blockPath: string, diskSerial: string): Promise<void> {
        await this.fencedWrite(blockPath, diskSerial, `wipe the partition table of ${blockPath}`, () =>
            this.runCommand('parted', ['-s', blockPath, 'mklabel', 'gpt'], 'failed to wipe partition table'));
    }

    private async partitionDevice(blockPath: string, diskSerial: string, shouldCreateLabel: boolean): Promise<void> {
        if (shouldCreateLabel)
            await this.fencedWrite(blockPath, diskSerial, `write a partition table to ${blockPath}`, () =>
                this.runCommand('parted', ['-s', blockPath, 'mklabel', 'gpt'], 'failed to create partition table'));

        // ⚠️ A SEPARATE WRITE FROM mklabel, AND SO A SEPARATE FENCE. `parted mklabel` completed and released the
        // disk; the disk could have changed before this second `parted` runs.
        await this.fencedWrite(blockPath, diskSerial, `create a partition on ${blockPath}`, () =>
            this.runCommand('parted', ['-s', blockPath, 'mkpart', 'primary', 'ext4', '0%', '100%'], 'failed to create partition'));

        await this.deps.spawnHelper('partprobe', [blockPath]).catch(() => undefined);
    }

    private async formatPartition(partitionPath: string, blockPath: string, diskSerial: string): Promise<void> {
        await this.fencedWrite(blockPath, diskSerial, `make a filesystem on ${blockPath}`, () =>
            this.runCommand('mkfs.ext4', ['-F', partitionPath], 'failed to format partition'));
    }

    private resolvePartitionPath(partition: RawBlockDeviceChild): string {
        return `/dev/${partition.name}`;
    }

    private async waitForPartition(blockPath: string, attempts = 20, delayMs = 500): Promise<{ device: RawBlockDevice; partition: RawBlockDeviceChild }> {
        for (let attempt = 0; attempt < attempts; attempt++) {
            const devices = await this.deps.listRawBlockDevices();
            const device = this.findDeviceByPath(devices, blockPath);
            const partition = device?.children?.[0];
            if (device && partition)
                return { device, partition };
            await this.deps.sleepSecs(delayMs / 1000);
        }
        throw new HttpBadRequestError('partition creation timed out');
    }

    private async createVolumeConfig(
        device: RawBlockDevice, partition: RawBlockDeviceChild, uuid: string, replaceVolumeId?: number,
        previous?: { label?: string | null; comment?: string | null }
    ): Promise<PersistedVolumeConfig> {
        const existing = await this.deps.database.getVolumes();
        const nextId = replaceVolumeId ?? this.getNextVolumeId(existing);
        if (!device.serial)
            throw new HttpBadRequestError('device serial unavailable');
        if (!partition.uuid)
            throw new HttpBadRequestError('partition UUID unavailable');

        // WHAT THE OPERATOR WROTE DOWN SURVIVES THE WIPE.
        //
        // This record is built from scratch and stored under the SAME id, so every field not named here is
        // silently dropped. The label ("2.1") is which shelf and which bay the disk is physically in, and the
        // comment is whatever the operator needed to remember about it -- neither is derivable from the disk,
        // neither is recreated by anything, and neither has the faintest thing to do with encryption. Converting
        // a volume erased them, which is how volume 57 came back from its conversion as an anonymous spindle in
        // a rack of thirty identical ones.
        //
        // The volume is the same volume: same id, same slot, same bay. It only changed clothes.
        //
        // `previous` is handed in by the caller, which read it BEFORE the old row was hard-deleted. It cannot be
        // looked up here: by this point the row is gone.
        return {
            id: nextId,
            uuid,
            enabled: true,
            healthy: true,
            read_only: false,
            disk_serial: device.serial,
            partition_uuid: partition.uuid,

            // Operator-set, and about the DISK IN THE RACK -- not about the filesystem we just rewrote.
            label: previous?.label ?? null,
            comment: previous?.comment ?? null,

            // THE RAW PARTITION SIZE, encrypted or not. A LUKS2 header takes ~16MiB off the top, so the usable
            // payload is fractionally smaller -- but this field is checked against the DISCOVERED partition size
            // when a disk is bound at bootstrap, and lsblk reports the raw partition either way. Recording the
            // payload size here would make every encrypted volume fail its own bind check.
            partition_size: Number(partition.size),
            data_size: 0,
            parity_size: 0,
            is_deleted: false
        };
    }

    private getNextVolumeId(existing: Array<{ id?: number }>): number {
        const maxId = existing.reduce((max, volume) => typeof volume.id === 'number' ? Math.max(max, volume.id) : max, 0);
        return maxId + 1;
    }

    private async runCommand(command: string, args: string[], context: string): Promise<void> {
        const { code, stdout } = await this.deps.spawnHelper(command, args);
        if (code !== 0)
            throw new HttpBadRequestError(`${context}: ${stdout || 'command failed'}`);
    }
}

export const deviceProvisioner = new DeviceProvisioner();
