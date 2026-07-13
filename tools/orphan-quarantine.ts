// QUARANTINE THE ORPHANS -- carefully, reversibly, and with a great deal of suspicion about its own inputs.
//
// An orphan is a slice with no name: it is on the platters, and MongoDB has never heard of it. This tool finds
// them and moves them out of the way. It does not delete them. Deleting is a separate, later, deliberate act
// (--purge), and by then you will have lived with the result for as long as you like.
//
// ---------------------------------------------------------------------------------------------------------
// THE WAY THIS TOOL DESTROYS YOUR ARRAY, if you let it
//
// An orphan is defined by SUBTRACTION: everything on the disks, minus everything Mongo names. That definition
// is only as good as the second half of it. If Mongo is empty, or half-loaded, or mid-restore, or the query
// quietly returns fewer rows than it should, then EVERY OBJECT ON THE ARRAY is an orphan -- all 3.5 million of
// them, all 130TB -- and this tool will cheerfully queue the lot for deletion.
//
// That is not a hypothetical. It is the single most likely way a well-meaning cleanup script ends a company.
// So this one refuses to run unless it can prove the ground it is standing on:
//
//   - every volume the fleet knows about is MOUNTED (a missing disk means slices we cannot see)
//   - not one disk fails a read (an EIO means we cannot trust what we did or did not find)
//   - Mongo names at least SANITY_FLOOR objects (a partially-loaded database is not an authority)
//   - the orphan set is no more than MAX_ORPHAN_FRACTION of the array (if it computes 500,000, the QUERY is
//     broken, not the array)
//
// And two things are excluded no matter what:
//
//   - THE NAMESPACE SNAPSHOT, which is itself an orphan by this definition. Snapshot objects are stored as
//     ordinary STRUBS objects and deliberately have no content record. Deleting one would destroy the pointer
//     target of the entire disaster-recovery path -- the array would lose the only copy of its own index. This
//     tool found its own snapshot in the orphan list on the first run, which is exactly the kind of thing that
//     makes you write a paragraph like this one.
//
//   - ANYTHING YOUNGER THAN MIN_AGE_DAYS. The write ordering is slices -> journal -> Mongo, so for a moment
//     every legitimate upload in flight has slices on disk and no record. It looks precisely like an orphan.
//     An in-flight write is seconds old; thirty days is a very wide moat.
// ---------------------------------------------------------------------------------------------------------

import { promises as fsp } from 'fs';
import path from 'path';
import { MongoClient, ObjectId } from 'mongodb';

const MONGO = 'mongodb://strubs:strubs@127.0.0.1:27017/strubs?authSource=admin';
const MOUNTS = '/run/strubs/mounts';
const QUARANTINE = '.quarantine';
const MANIFEST = '/opt/strubs/tools/orphan-quarantine-manifest.json';

// A database that names fewer objects than this is not an authority on what exists. The array has ~3.55M.
const SANITY_FLOOR = 3_000_000;

// If more than this fraction of the array looks unnamed, the QUERY is broken, not the array.
const MAX_ORPHAN_FRACTION = 0.01;

// The moat around in-flight writes.
const MIN_AGE_DAYS = 30;

const isSlice = /^[0-9a-f]{24}\.\d{1,2}$/;
const createdAt = (id: string) => new Date(parseInt(id.slice(0, 8), 16) * 1000);

type Entry = { id: string; created: string; sizeBytes: number; slices: { from: string; to: string }[] };

async function mountedVolumes(): Promise<{ id: number; uuid: string; mountPoint: string }[]> {
    const c = await MongoClient.connect(MONGO);
    const vols = await c.db('strubs').collection('volumes')
        .find({ is_deleted: { $ne: true } }).toArray();
    await c.close();

    const out: { id: number; uuid: string; mountPoint: string }[] = [];
    const missing: number[] = [];

    for (const v of vols) {
        const mp = path.join(MOUNTS, String(v.uuid));
        const ok = await fsp.stat(path.join(mp, 'strubs')).then(s => s.isDirectory(), () => false);
        if (ok) out.push({ id: Number(v.id), uuid: String(v.uuid), mountPoint: mp });
        else missing.push(Number(v.id));
    }

    // A DISK WE CANNOT SEE IS A DISK WHOSE SLICES WE CANNOT SEE -- and an object whose slices live only there
    // would look, from here, exactly like an object that has none. We are about to act on that judgement by
    // moving files. Not while a disk is missing, we are not.
    if (missing.length)
        throw new Error(`REFUSING: volume(s) ${missing.join(', ')} are not mounted. Their slices are invisible to `
            + `this scan, so objects living on them would look unnamed. Mount them, or delete them from the fleet.`);

    if (!out.length)
        throw new Error('REFUSING: the fleet reports no volumes at all. That is not an empty array, it is a fleet '
            + 'that has not come up.');

    return out;
}

// Every object id the bootstrap manifests point at. These are STORED OBJECTS with no content record -- orphans
// by the letter of the definition, and the last thing on this array anybody should delete.
async function protectedSnapshotIds(volumes: { id: number; mountPoint: string }[]): Promise<Set<string>> {
    const ids = new Set<string>();
    const silent: number[] = [];

    for (const v of volumes) {
        let raw: string;
        try {
            raw = await fsp.readFile(path.join(v.mountPoint, 'strubs', '.bootstrap.json'), 'utf8');
        }
        catch (err) {
            // ENOENT is a fact: this disk has no manifest, and it never named a snapshot. Anything else means
            // we could not LOOK -- and the manifest we could not read may be the only one naming the snapshot.
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
            silent.push(v.id);
            continue;
        }

        try {
            const m = JSON.parse(raw);
            if (m?.snapshot?.objectId) ids.add(String(m.snapshot.objectId));
            if (m?.previousSnapshot?.objectId) ids.add(String(m.previousSnapshot.objectId));
        }
        catch {
            // A manifest that will not parse is a manifest whose snapshot pointer we cannot see.
            silent.push(v.id);
        }
    }

    // AND IF EVEN ONE MANIFEST WOULD NOT ANSWER, WE DO NOT KNOW WHAT THE SNAPSHOT IS.
    //
    // A snapshot object is stored as an ordinary STRUBS object with no content record -- an orphan by the exact
    // definition this tool acts on. The ONLY thing standing between it and the bin is the manifests naming it.
    // If the manifest that names it is the one we could not read, we will not protect it, we will quarantine
    // it, and on purge we will delete the array's entire index of itself while reporting a tidy cleanup.
    //
    // This is the cheapest possible check in front of the most expensive possible mistake.
    if (silent.length)
        throw new Error(`REFUSING: the bootstrap manifest on volume(s) ${silent.join(', ')} could not be read. The `
            + `namespace SNAPSHOT is stored as an ordinary object with no database record -- an orphan by this `
            + `tool's own definition -- and the manifests are the only thing that names it. If the one we could `
            + `not read is the one that names it, this tool would quarantine the array's entire index of itself `
            + `and then delete it. Fix the disks and run this again.`);

    if (!ids.size)
        throw new Error('REFUSING: not one manifest names a snapshot. Either this array has never taken one, or '
            + 'something is very wrong -- and in the second case, the snapshot object is sitting in the orphan '
            + 'list right now. Take a snapshot, or establish why there is none, before deleting anything.');

    return ids;
}

// Re-derive the protected ids FROM THE DISKS and prove that not one of them is in the plan. Called before
// every action that moves or deletes a file -- never once, at plan time, and then trusted forever.
async function assertNoProtectedIds(entries: Entry[], volumes: { id: number; mountPoint: string }[]): Promise<void> {
    const protectedIds = await protectedSnapshotIds(volumes);
    const doomed = entries.filter(e => protectedIds.has(e.id));

    if (doomed.length)
        throw new Error(`REFUSING: the plan contains ${doomed.length} object(s) that the bootstrap manifests name `
            + `as the namespace SNAPSHOT (${doomed.map(d => d.id).join(', ')}). That is the array's index of `
            + `itself -- an orphan by this tool's definition, and the last thing on these platters that should `
            + `ever be deleted. The plan was built by an older, buggier version of this tool. Rebuild it.`);

    console.log(`snapshot protection re-checked against the disks: ${protectedIds.size} protected, none in the plan`);
}

async function build(): Promise<{ entries: Entry[]; skipped: Record<string, number> }> {
    const volumes = await mountedVolumes();
    console.log(`fleet: ${volumes.length} volume(s), all mounted`);

    const protectedIds = await protectedSnapshotIds(volumes);
    console.log(`protected snapshot object(s): ${protectedIds.size ? [...protectedIds].join(', ') : 'none'}`);

    const c = await MongoClient.connect(MONGO);
    const named = new Set<string>();
    for await (const d of c.db('strubs').collection('content')
        .find({ isFile: true }, { projection: { _id: 1 } }))
        named.add(String(d._id));
    await c.close();

    console.log(`named in Mongo: ${named.size.toLocaleString()}`);

    // A DATABASE THAT HAS LOST ITS MIND IS NOT AN AUTHORITY ON WHAT EXISTS.
    if (named.size < SANITY_FLOOR)
        throw new Error(`REFUSING: Mongo names only ${named.size.toLocaleString()} objects, which is below the sanity `
            + `floor of ${SANITY_FLOOR.toLocaleString()}. If the database is empty or half-loaded, EVERY object on `
            + `this array looks unnamed -- and this tool would queue all 130TB of it for deletion.`);

    const bySlice = new Map<string, { from: string; to: string }[]>();
    const sizeOf = new Map<string, number>();

    for (const v of volumes) {
        const root = path.join(v.mountPoint, 'strubs');
        for (const a of await fsp.readdir(root)) {
            if (a.length !== 2) continue;                       // shard dirs only; skips .quarantine, .journal
            for (const b of await fsp.readdir(path.join(root, a)))
                for (const cc of await fsp.readdir(path.join(root, a, b))) {
                    const dir = path.join(root, a, b, cc);
                    for (const f of await fsp.readdir(dir)) {
                        if (!isSlice.test(f)) continue;
                        const id = f.slice(0, 24);
                        if (named.has(id)) continue;

                        const from = path.join(dir, f);
                        const to = path.join(root, QUARANTINE, f);
                        const list = bySlice.get(id) ?? [];
                        list.push({ from, to });
                        bySlice.set(id, list);

                        const st = await fsp.stat(from);
                        sizeOf.set(id, (sizeOf.get(id) ?? 0) + st.size);
                    }
                }
        }
    }

    const total = named.size + bySlice.size;
    if (bySlice.size > total * MAX_ORPHAN_FRACTION)
        throw new Error(`REFUSING: ${bySlice.size.toLocaleString()} of ${total.toLocaleString()} objects look `
            + `unnamed (${((bySlice.size / total) * 100).toFixed(1)}%). That is far more than this array has ever `
            + `leaked. Something is wrong with the QUERY, not the disks. Nothing has been touched.`);

    const cutoff = Date.now() - MIN_AGE_DAYS * 86_400_000;
    const skipped = { snapshot: 0, tooYoung: 0 };
    const entries: Entry[] = [];

    for (const [id, slices] of bySlice) {
        if (protectedIds.has(id)) { skipped.snapshot++; continue; }

        const when = createdAt(id);
        // A write in flight has slices and no record -- exactly an orphan's shape. Anything recent is left
        // alone on principle, and the cost of being wrong here is somebody's upload.
        if (when.getTime() > cutoff) { skipped.tooYoung++; continue; }

        entries.push({
            id,
            created: when.toISOString(),
            sizeBytes: sizeOf.get(id) ?? 0,
            slices: slices.sort((x, y) => x.from.localeCompare(y.from))
        });
    }

    entries.sort((a, b) => b.sizeBytes - a.sizeBytes);
    return { entries, skipped };
}

async function main() {
    const mode = process.argv[2] ?? 'plan';

    if (mode === 'plan') {
        const { entries, skipped } = await build();
        const bytes = entries.reduce((n, e) => n + e.sizeBytes, 0);
        const files = entries.reduce((n, e) => n + e.slices.length, 0);

        await fsp.writeFile(MANIFEST, JSON.stringify({
            builtAt: new Date().toISOString(),
            objects: entries.length,
            sliceFiles: files,
            bytes,
            entries
        }, null, 2));

        console.log(`\nTO QUARANTINE: ${entries.length.toLocaleString()} object(s), `
            + `${files.toLocaleString()} slice file(s), ${(bytes / 1e9).toFixed(1)} GB`);
        console.log(`  left alone -- the namespace snapshot: ${skipped.snapshot}`);
        console.log(`  left alone -- younger than ${MIN_AGE_DAYS} days (a write may be in flight): ${skipped.tooYoung}`);
        console.log(`\nthe ten largest:`);
        for (const e of entries.slice(0, 10))
            console.log(`  ${e.id}  ${e.created.slice(0, 10)}  ${(e.sizeBytes / 1e6).toFixed(1).padStart(9)} MB  `
                + `${e.slices.length} slice(s)`);
        console.log(`\nmanifest written: ${MANIFEST}`);
        console.log('NOTHING HAS BEEN MOVED. Run with `apply` to quarantine, and only then `purge` to delete.');
        return;
    }

    if (mode === 'apply') {
        const m = JSON.parse(await fsp.readFile(MANIFEST, 'utf8'));

        // Re-verify the fleet: the manifest may have been built an hour ago, and a disk may have dropped since.
        const volumes = await mountedVolumes();

        // ...AND RE-CHECK THE SNAPSHOT PROTECTION, because a saved plan is a claim, not a fact.
        //
        // The manifest file on disk may have been written by an OLDER version of this tool -- one that treated
        // an unreadable bootstrap manifest as "no snapshot named here" and cheerfully listed the array's own
        // index as an orphan. Trusting that file now would let a bug we have already fixed reach through time
        // and delete the snapshot anyway. The plan is re-checked against the disks, every single time.
        await assertNoProtectedIds(m.entries as Entry[], volumes);

        // AND RE-ASK MONGO, RIGHT NOW, ABOUT EVERY SINGLE ID.
        //
        // The manifest is a photograph of a moving array. Between building it and acting on it, an object could
        // have acquired a name -- an upload that was in flight when we looked, a record that landed late. Its
        // slices are in our list, and we are about to move them out from under a live object.
        //
        // The thirty-day rule already makes that close to impossible. This makes it actually impossible, and it
        // costs one query. The cheapest guard in this file, in front of the most expensive mistake.
        const c = await MongoClient.connect(MONGO);
        const ids = (m.entries as Entry[]).map(e => new ObjectId(e.id));
        const nowNamed = await c.db('strubs').collection('content')
            .find({ _id: { $in: ids } }, { projection: { _id: 1 } }).toArray();
        await c.close();

        if (nowNamed.length)
            throw new Error(`REFUSING: ${nowNamed.length} object(s) in this manifest have a NAME in Mongo now that `
                + `they did not have when it was built (first: ${String(nowNamed[0]._id)}). They are live objects. `
                + `Rebuild the manifest. Nothing has been touched.`);

        console.log(`re-checked all ${ids.length.toLocaleString()} ids against Mongo: still unnamed`);

        let moved = 0, gone = 0;
        for (const e of m.entries as Entry[]) {
            for (const s of e.slices) {
                await fsp.mkdir(path.dirname(s.to), { recursive: true });
                try {
                    // A RENAME, not an unlink. Same filesystem, atomic, instant, and undone by running this in
                    // reverse. Nothing is destroyed today.
                    await fsp.rename(s.from, s.to);
                    moved++;
                }
                catch (err) {
                    if ((err as NodeJS.ErrnoException).code === 'ENOENT') { gone++; continue; }
                    throw err;
                }
            }
        }
        console.log(`quarantined ${moved.toLocaleString()} slice file(s) (${gone} were already gone)`);
        console.log(`the space is NOT yet reclaimed. Live with it. When you are satisfied, run \`purge\`.`);
        return;
    }

    if (mode === 'restore') {
        const m = JSON.parse(await fsp.readFile(MANIFEST, 'utf8'));
        let back = 0;
        for (const e of m.entries as Entry[])
            for (const s of e.slices) {
                await fsp.mkdir(path.dirname(s.from), { recursive: true });
                await fsp.rename(s.to, s.from).then(() => { back++; }, () => undefined);
            }
        console.log(`put ${back.toLocaleString()} slice file(s) back exactly where they were`);
        return;
    }

    if (mode === 'purge') {
        if (process.argv[3] !== '--yes-delete-them') {
            console.log('purge is the irreversible one. Re-run with:  purge --yes-delete-them');
            return;
        }
        const m = JSON.parse(await fsp.readFile(MANIFEST, 'utf8'));

        // THIS IS THE ONE THAT DOES NOT COME BACK. Check the snapshot protection again, here, against the
        // disks -- not against a JSON file that some earlier version of this tool wrote.
        await assertNoProtectedIds(m.entries as Entry[], await mountedVolumes());
        let removed = 0;
        for (const e of m.entries as Entry[])
            for (const s of e.slices)
                await fsp.unlink(s.to).then(() => { removed++; }, () => undefined);
        console.log(`deleted ${removed.toLocaleString()} slice file(s); ${(m.bytes / 1e9).toFixed(1)} GB reclaimed`);
        return;
    }

    console.log('usage: orphan-quarantine.ts [plan | apply | restore | purge --yes-delete-them]');
}

main().catch(err => { console.error(String(err.message ?? err)); process.exit(1); });
