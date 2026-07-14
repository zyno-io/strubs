import { randomUUID } from 'crypto';

import { config, normalizeIdentity } from '../config';
import { database } from '../database';
import { createLogger } from '../log';
import { ioManager } from './manager';
import { HttpBadRequestError } from '../server/http/errors';
import { getDeviceIdentityKey, listRawBlockDevices, type RawBlockDevice, type RawBlockDeviceChild } from './device-discovery';
import { probeDeviceForStrubsIdentity } from './device-identity-probe';
import { spawnHelper } from '../helpers/spawn';
import {
    DEFAULT_KEYFILE,
    addPassphrase as luksAddPassphrase,
    assertRecoverable as luksAssertRecoverable,
    format as luksFormat,
    keyfileReadable as luksKeyfileReadable,
    mapperPath as luksMapperPath,
    LuksError,
    nameplateIsPresent as luksNameplateIsPresent,
    open as luksOpen,
    testPassphrase as luksTestPassphrase,
    writeNameplate as luksWriteNameplate
} from './luks';
import { assertFleetRecoveryPassphrase, withEncryptionSlot } from './luks-recovery-key';
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
    };
    assertFleetRecoveryPassphrase: typeof assertFleetRecoveryPassphrase;
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
        mapperPath: luksMapperPath
    },
    assertFleetRecoveryPassphrase,
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
    replace?: boolean;

    // Tri-state ON PURPOSE. `undefined` means "whatever the fleet default says" (the runtimeConfig flag); an
    // explicit true/false is the operator overriding it for this one disk. Defaulting this to `false` in the
    // signature would silently ignore the fleet setting, which is the bug this comment exists to prevent.
    encrypt?: boolean;

    // The fleet recovery passphrase. Required whenever we encrypt: it becomes the volume's SECOND keyslot, and
    // without a second keyslot the volume dies with the OS disk that holds the keyfile. Never stored, never
    // logged. Demanding it on every encryption is also the only honest way to enforce the design's rule that the
    // operator must have RECORDED it -- if they cannot produce it, they have not got it.
    recoveryPassphrase?: string;

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
        const { blockPath, wipe, replace } = options;
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

        let devices = await this.deps.listRawBlockDevices();
        let targetDevice = this.findDeviceByPath(devices, blockPath);
        if (!targetDevice)
            throw new HttpBadRequestError('block device not found');

        // HARD GATE 2: ASK THE DISK WHETHER IT IS ALREADY OURS -- ON EVERY PATH, NOT JUST THE WIPE ONE.
        //
        // This used to run only when `wipe` was passed, on the reasoning that the non-wipe path is safe because
        // it refuses a partitioned disk. It is not. Both paths end in `parted mklabel` and `mkfs`, and the
        // non-wipe guard below only catches a disk that ADVERTISES A PARTITION TABLE.
        //
        // A whole-disk STRUBS volume has no partition table at all -- and neither does a whole-disk LUKS
        // container, which is what DR-G may well create. No pttype, no ptuuid, no children: it walks through
        // every check on the non-wipe path and gets repartitioned. That is a live route to destroying a disk
        // today, before encryption exists.
        //
        // Neither the mounted-partitions check nor the registered-volume check can save us either. The first
        // says nothing about a disk that is simply not mounted, and the second consults a `volumes` collection
        // that, in the exact scenario we fear, is EMPTY -- a fresh or wiped Mongo, a fleet that never started.
        // In that state the provisioner sees 4.4TB of live customer data as blank media.
        //
        // So read the identity off the platter, with a probe that cannot write to what it inspects, before we
        // touch anything. It fails CLOSED: a disk we could not read is refused, not assumed blank.
        await this.assertDeviceIsNotOurs(blockPath, targetDevice, options.convertVolumeId);

        if (wipe === true) {
            if (this.deviceHasMountedPartitions(targetDevice))
                throw new HttpBadRequestError('block device has mounted partitions');

            await this.wipeDevice(blockPath);
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
        const registeredVolumeId = await this.ensureDeviceNotRegistered(
            targetDevice, devices, replace || options.convertVolumeId !== undefined);
        const replacedVolumeId = options.convertVolumeId ?? registeredVolumeId;

        // PREFLIGHT BEFORE WE TOUCH THE PARTITION TABLE. If the key is missing, or the operator cannot produce
        // the fleet recovery passphrase, we want to find out NOW, while the disk is still whole -- not after
        // `parted` has run, leaving a wiped disk and no way to encrypt it.
        const passphrase = encrypt ? await this.assertEncryptionIsPossible(options.recoveryPassphrase) : null;

        // The mapper is named from the volume's uuid, so the uuid has to exist before the container can be
        // opened -- which is before mkfs, which is well before we would otherwise have minted it.
        const volumeUuid = randomUUID();

        await this.partitionDevice(blockPath, !wipe);
        await this.deps.sleepSecs(1);

        let partitionInfo = await this.waitForPartition(blockPath);
        const partitionPath = this.resolvePartitionPath(partitionInfo.partition);

        // WHAT WE MKFS IS NOT ALWAYS THE PARTITION. On an encrypted volume the ext4 goes on the mapper; putting
        // it on the partition would overwrite the LUKS header we just wrote.
        if (passphrase !== null)
            conversionPhase('encrypting');

        const filesystemTarget = passphrase !== null
            ? await this.encryptPartition(partitionPath, volumeUuid, passphrase)
            : partitionPath;

        // mkfs on a 4TB disk is not instant either. Say so.
        conversionPhase('formatting');
        await this.formatPartition(filesystemTarget);
        await this.deps.sleepSecs(2);

        partitionInfo = await this.waitForPartition(blockPath);
        const finalDevice = partitionInfo.device;
        const partition = partitionInfo.partition;

        // On an encrypted volume this uuid is the LUKS header's, not the ext4's -- lsblk reports the container's
        // uuid for a crypto_LUKS partition. That is exactly what we want: it is stable, unique, and READABLE
        // WHILE THE DISK IS STILL LOCKED, which is precisely when we need to identify it.
        if (!partition.uuid)
            throw new HttpBadRequestError('partition UUID unavailable');

        if (replacedVolumeId) {
            await this.deps.database.deleteVolume(replacedVolumeId);
            // Drop the old in-memory Volume too. Without this, registerVolume below pushes a SECOND config with
            // the same id and the fleet keeps a stopped, stale Volume object bound to a disk that no longer
            // exists -- and `_volumeConfig.find(cfg => cfg.id === id)` hands out the dead one.
            await this.deps.ioManager.deregisterVolume(replacedVolumeId);
        }

        // Work out the volume's identity (id and uuid) WITHOUT writing anything yet: the nameplate needs the id,
        // and on an encrypted volume the nameplate has to be on the disk before the volume may exist at all.
        const volumeConfig = await this.createVolumeConfig(finalDevice, partition, volumeUuid, replacedVolumeId);

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
        if (encrypt)
            await this.stampNameplate(blockPath, partition, volumeConfig.id);

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

        await this.deps.database.createVolume(volumeConfig);

        // The ONLY caller that may stamp our identity onto a disk: this one just formatted it.
        await this.deps.ioManager.registerVolume(volumeConfig, { initializeIdentity: true });
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

        if (!passphrase)
            throw new HttpBadRequestError(
                'encrypting a volume requires the fleet recovery passphrase. It becomes the volume\'s second '
                + 'keyslot, and a volume with only the keyfile slot dies with the OS disk.'
            );

        // Sets the verifier on the first encrypted volume; on every one after that, refuses a passphrase that
        // does not match the rest of the fleet.
        await this.deps.assertFleetRecoveryPassphrase(passphrase);
        return passphrase;
    }

    // Turn a bare partition into an unlocked LUKS container and hand back the mapper to mkfs.
    private async encryptPartition(partitionPath: string, volumeUuid: string, passphrase: string): Promise<string> {
        await this.deps.luks.format(partitionPath);
        await this.deps.luks.addPassphrase(partitionPath, passphrase);

        // Belt and braces: assertRecoverable ASKS THE DISK how many keyslots it actually has, rather than
        // trusting that the call above did what it said. If the passphrase somehow did not land, we find out
        // here -- BEFORE the mkfs, while walking away costs us nothing but a blank partition.
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
        // were given actually fits it.
        if (await this.deps.luks.testPassphrase(partitionPath, passphrase) !== 'opens')
            throw new LuksError(
                `${partitionPath} was encrypted, but the recovery passphrase does not open it. Refusing to put it `
                + `into service: it would be a disk that only the keyfile can open, and it would silently break `
                + `the guarantee that the fleet passphrase opens every disk. Nothing of value is on it yet.`,
                'failed');

        return await this.deps.luks.open(partitionPath, volumeUuid);
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

    private async ensureDeviceNotRegistered(targetDevice: RawBlockDevice, devices: RawBlockDevice[], replace?: boolean): Promise<number | undefined> {
        const { identityKeys, serials, volumeIdByIdentity, volumeIdBySerial } = await this.getRegisteredIdentities(devices);
        if (targetDevice.serial && serials.has(targetDevice.serial)) {
            if (!replace)
                throw new HttpBadRequestError('device already registered');
            return volumeIdBySerial.get(targetDevice.serial);
        }
        const identityKey = getDeviceIdentityKey(targetDevice);
        if (identityKey && identityKeys.has(identityKey)) {
            if (!replace)
                throw new HttpBadRequestError('device already registered');
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

    private async wipeDevice(blockPath: string): Promise<void> {
        await this.runCommand('parted', ['-s', blockPath, 'mklabel', 'gpt'], 'failed to wipe partition table');
    }

    private async partitionDevice(blockPath: string, shouldCreateLabel: boolean): Promise<void> {
        if (shouldCreateLabel)
            await this.runCommand('parted', ['-s', blockPath, 'mklabel', 'gpt'], 'failed to create partition table');
        await this.runCommand('parted', ['-s', blockPath, 'mkpart', 'primary', 'ext4', '0%', '100%'], 'failed to create partition');
        await this.deps.spawnHelper('partprobe', [blockPath]).catch(() => undefined);
    }

    private async formatPartition(partitionPath: string): Promise<void> {
        await this.runCommand('mkfs.ext4', ['-F', partitionPath], 'failed to format partition');
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

    private async createVolumeConfig(device: RawBlockDevice, partition: RawBlockDeviceChild, uuid: string, replaceVolumeId?: number): Promise<PersistedVolumeConfig> {
        const existing = await this.deps.database.getVolumes();
        const nextId = replaceVolumeId ?? this.getNextVolumeId(existing);
        if (!device.serial)
            throw new HttpBadRequestError('device serial unavailable');
        if (!partition.uuid)
            throw new HttpBadRequestError('partition UUID unavailable');
        return {
            id: nextId,
            uuid,
            enabled: true,
            healthy: true,
            read_only: false,
            disk_serial: device.serial,
            partition_uuid: partition.uuid,

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
