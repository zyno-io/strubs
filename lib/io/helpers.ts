import crypto from 'crypto';
import os from 'os';
import { promises as fsp } from 'fs';

import { spawnHelper } from '../helpers/spawn';

export type SmartctlResult<T = Record<string, unknown>> = {
    data: T;
    exitCode: number;
};

const hostname = os.hostname();
const hostId = crypto.createHash('md5').update(hostname).digest().slice(13);

const objectIdPid = process.pid & 0xff;
let objectIdCounter = 0;

// NOTE: this follows the Mongo spec, but it's for our objects, so it's here.
// we need IDs for our files long before the database assigns them.
export function generateObjectId(): Buffer {
    const objectIndex = ++objectIdCounter & 0xffffff;
    const time = Math.floor(Date.now() / 1000);

    const result = Buffer.allocUnsafe(12);
    result.writeInt32BE(time, 0);
    hostId.copy(result, 4);
    result.writeInt16BE(objectIdPid, 7);
    result.writeIntBE(objectIndex, 9, 3);

    return result;
}

export async function lsblk(additionalParams?: string[]): Promise<any> {
    const params = ['-OJb'];

    if (additionalParams)
        params.push(...additionalParams);

    const { code, stdout } = await spawnHelper('lsblk', params);

    if (code !== 0)
        throw new Error('lsblk exited with code ' + code);

    return JSON.parse(stdout);
}

const FATAL_SMARTCTL_MASK = 0x03; // parsing/device open failures

export async function smartctl<T = Record<string, unknown>>(...args: string[]): Promise<SmartctlResult<T>> {
    args.unshift('--json=c');

    const { code, stdout } = await spawnHelper('smartctl', args);
    const exitCode = typeof code === 'number' ? code : -1;

    if (exitCode < 0 || (exitCode & FATAL_SMARTCTL_MASK) !== 0)
        throw new Error('smartctl exited with code ' + exitCode);

    if (!stdout.length)
        throw new Error('smartctl produced no output');

    let parsed: T;
    try {
        parsed = JSON.parse(stdout) as T;
    }
    catch {
        throw new Error('smartctl output was not valid JSON');
    }

    return {
        data: parsed,
        exitCode
    };
}

export async function mount(blockPath: string, mountPath: string, fsType: string, options?: Record<string, string | number | boolean>): Promise<void> {
    const params = [ blockPath, '-t', fsType, mountPath ];

    if (options) {
        const optionsStr = Object.entries(options)
            .map(([key, value]) => `${key}=${value}`)
            .join(',');
        params.splice(3, 0, '-o', optionsStr);
    }

    const { code, stdout } = await spawnHelper('mount', params);

    if (code !== 0)
        throw new Error('mount exited with code ' + code + (stdout ? ': ' + stdout : ''));
}

export async function unmount(mountPath: string, options?: { lazy?: boolean }): Promise<void> {
    // Lazy (umount -l) detaches the mount now and cleans up when it's no longer busy: needed when the
    // backing device has vanished (EIO), where a plain umount can block indefinitely.
    const params = options?.lazy ? [ '-l', mountPath ] : [ mountPath ];
    const { code, stdout } = await spawnHelper('umount', params);

    if (code !== 0)
        throw new Error('umount exited with code ' + code + (stdout ? ': ' + stdout : ''));
}

// Parse /proc/mounts into a map of mountpoint -> source device. Used to reconcile a volume's believed
// mount against the kernel's reality (is it still mounted, and by the device we expect?). /proc/mounts
// octal-escapes spaces/tabs in fields; mountpoints are decoded so lookups by path work.
export async function readProcMounts(): Promise<Map<string, string>> {
    const text = await fsp.readFile('/proc/mounts', 'utf8');
    const map = new Map<string, string>();
    const unescape = (field: string) => field.replace(/\\([0-7]{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
    for (const line of text.split('\n')) {
        if (!line)
            continue;
        const [source, mountpoint] = line.split(' ');
        if (source && mountpoint)
            map.set(unescape(mountpoint), unescape(source));
    }
    return map;
}

export function formatBytes(bytes: number): string {
    if (bytes >= 1099511627776)
        return (bytes / 1099511627776).toFixed(2) + ' TB';
    if (bytes >= 1073741824)
        return (bytes / 1073741824).toFixed(2) + ' GB';
    if (bytes >= 1048576)
        return (bytes / 1048576).toFixed(2) + ' MB';
    if (bytes >= 1024)
        return (bytes / 1024).toFixed(2) + ' KB';
    return bytes + ' b';
}

// A committed slice file: a 24-hex object id, a dot, and the slice index. Nothing else in a volume's
// strubs/ tree is one.
//
// This is LOAD-BEARING, not cosmetic. `.identity`, `.tmp/`, `.bootstrap.json` and `.journal/` all live in
// the same volume root as the slice shards, and every one of them is a recovery artifact. A scanner that
// walked the tree by "everything that is a file" would sweep the journal into a rebuild -- or, worse,
// treat it as a stray slice and delete it. Any code that walks a volume MUST key on this.
const SLICE_FILENAME = /^[0-9a-f]{24}\.\d+$/;

export function isSliceFileName(name: string): boolean {
    return SLICE_FILENAME.test(name);
}

// fsync a DIRECTORY, so that the entries inside it survive a power cut.
//
// Fsyncing a FILE makes its contents durable and says NOTHING about the directory entry that names it. A
// file created (or renamed into place) and fsynced can still vanish entirely on power loss if the entry
// pointing at it never reached the platter. Anywhere we tell a caller "this is now committed to disk", the
// name has to be as durable as the bytes -- otherwise we are promising something we did not do.
//
// Only a filesystem that cannot fsync a directory handle at all is tolerated. Anything else is a failed
// durability boundary and is thrown, because the caller is about to act on the promise.
export async function fsyncDirectory(dir: string): Promise<void> {
    const fh = await fsp.open(dir, 'r');
    try {
        await fh.sync();
    }
    catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EPERM')
            throw err;
    }
    finally {
        await fh.close();
    }
}

// Make a file's name durable after it has been created (or renamed) inside `leaf` -- INCLUDING any
// directory levels that `mkdir -p` had to create to get there.
//
// Fsyncing `leaf` makes the FILE's entry durable inside it. But if this call also created leaf's parents
// (strubs/aa/bb/cc, where none of aa, bb, cc existed), then cc's own entry lives in bb, bb's in aa, and
// aa's in strubs -- and none of those have reached the platter. A power cut can take the whole subtree,
// slices and all, while the fsync of the leaf reports success. So each level that was newly created gets
// its own fsync, walking up from the leaf to the parent of the shallowest new directory.
//
// `firstCreated` is exactly what fs.mkdir(recursive: true) returns: the shallowest path it had to create,
// or undefined if everything already existed. That undefined is the common case by far -- a shard
// directory is created once and then used by thousands of objects -- so the steady-state cost of this is
// a single fsync.
// WHAT ACTUALLY MAKES THIS SAFE, and it is worth being precise about.
//
// STRUBS volumes are ext4 and nothing else -- the provisioner only ever runs mkfs.ext4. On ext4, jbd2
// commits its transactions in strict sequence: committing transaction N necessarily commits every
// transaction before it. So an fsync of the LEAF directory forces the whole chain of metadata that led to
// it, including the mkdirs of its parents. That single fsync after the rename is the load-bearing guarantee,
// and it is why the steady-state cost of all this is one fsync.
//
// The explicit walk below is belt-and-braces for a filesystem without ordered-journal semantics. On such a
// filesystem there would still be a residual race between siblings (two objects creating aa/bb and aa/cc
// under a brand-new aa, each fsyncing only its own branch, neither proving aa's own entry) -- and rather
// than build a general per-level durability tracker for a filesystem STRUBS never creates, this is stated
// plainly: if STRUBS is ever taught to use a non-ext4 volume, come back and read this.

// mkdir -p, and do not return until every directory it had to create is DURABLE.
//
// The naive version has a race, and it is a data-loss one. Two objects landing in the same brand-new shard
// at the same moment both call mkdir: the winner creates it and gets back the path, the loser is told
// `undefined` -- the directory already exists -- and therefore skips the parent fsyncs. But the winner may
// not have performed them yet. The loser then renames its slice in, fsyncs only the leaf, and reports the
// slice committed; the journal and Mongo are written on the strength of that, and a power cut in the gap
// takes the whole un-fsynced subtree, slices and all. An acknowledged object with no data: a phantom.
//
// So creation is shared, not raced: whoever gets there first does the mkdir AND the fsyncs, and everyone
// else waits on that same promise. Arriving after it has finished is fine -- the fsyncs are done. In the
// steady state (the shard already exists) this is one mkdir syscall and no fsync at all.
const creating = new Map<string, Promise<void>>();

// Directories we created but could NOT prove durable, and how far up the chain the fsyncs had to reach.
//
// This has to be remembered, because the filesystem will never tell us again: mkdir returns `undefined` the
// moment the directory exists, so a retry after a failed fsync would sail straight past the very step that
// failed and report success. The entry is dropped the instant the fsyncs do succeed.
const unproven = new Map<string, string>();

export async function ensureDirectoryDurable(dir: string): Promise<void> {
    const inFlight = creating.get(dir);
    if (inFlight) return inFlight;

    const work = (async () => {
        const firstCreated = (await fsp.mkdir(dir, { recursive: true })) ?? unproven.get(dir);
        if (!firstCreated)
            return;                          // already existed, and already proven durable

        unproven.set(dir, firstCreated);
        await fsyncCreatedPath(dir, firstCreated);
        unproven.delete(dir);
    })();

    creating.set(dir, work);
    try {
        await work;
    }
    finally {
        creating.delete(dir);
    }
}

export async function fsyncCreatedPath(leaf: string, firstCreated: string | undefined): Promise<void> {
    if (!firstCreated) {
        await fsyncDirectory(leaf);
        return;
    }

    const parentOfFirstCreated = firstCreated.slice(0, firstCreated.lastIndexOf('/'));
    for (let dir = leaf; ; dir = dir.slice(0, dir.lastIndexOf('/'))) {
        await fsyncDirectory(dir);
        if (dir === parentOfFirstCreated || dir.lastIndexOf('/') <= 0)
            break;
    }
}
