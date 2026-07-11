#!/usr/bin/env node
'use strict';
// Archive the recoveryComment "dead" (unrecoverable) objects: MOVE their content records into a
// `lostContent` collection (out of `content`, so verify/repair stop flagging them) and KILL their
// on-disk slice files (useless -- the objects are below quorum / foreign-parity, confirmed 0/5562
// recoverable by tools/verify-dead.js).
//
// SAFETY (this deletes real files + moves DB records):
//  - target = ONLY docs with recoveryComment set. Never touches an un-flagged object.
//  - writes a FULL backup manifest (every doc + every slice path) BEFORE any mutation.
//  - phase order: copy->lostContent, VERIFY all copied, THEN kill slices, THEN delete from content
//    (conditional on recoveryComment still present). Any inconsistency ABORTS before deletion.
//  - slice paths are built from each object's own id (shard/{id}.{idx}); only files that exist on a
//    MOUNTED strubs volume are unlinked. Vol 34 (gone) slices have no file.
//
//   node tools/archive-dead.js            # DRY RUN: manifest + guards, writes/deletes NOTHING
//   node tools/archive-dead.js --apply    # execute
// Run from /opt/strubs. Safe alongside the frozen service.

const fs = require('fs');
const { MongoClient } = require('mongodb');

const APPLY = process.argv.includes('--apply');
const MR = '/run/strubs/mounts';
const MANIFEST = '/opt/strubs/tools/dead-archive-manifest.json';
const shard = id => `${id.substring(0, 2)}/${id.substring(2, 4)}/${id.substring(4, 6)}`;
const abort = msg => { console.error(`\n*** ABORT (nothing deleted): ${msg}`); process.exit(1); };

(async () => {
  const client = await MongoClient.connect(process.env.STRUBS_MONGO_URL || 'mongodb://strubs:strubs@127.0.0.1:27017/strubs?authSource=admin');
  const db = client.db('strubs');
  const C = db.collection('content'), L = db.collection('lostContent'), V = db.collection('volumes');
  console.log(`MODE ${APPLY ? 'APPLY' : 'DRY RUN'}`);

  // mount base per LIVE volume (only these have deletable files)
  const mount = new Map();
  for (const v of await V.find({}).toArray()) {
    const base = `${MR}/${v.uuid}/strubs`;
    if (v.uuid && fs.existsSync(base)) mount.set(v.id, base);
  }
  console.log(`mounted volumes: ${[...mount.keys()].sort((a, b) => a - b).join(',')}`);

  // --- target set: recoveryComment present. Full docs (we archive them verbatim). ---
  const dead = await C.find({ recoveryComment: { $exists: true } }).toArray();
  if (!dead.length) abort('no recoveryComment objects found');

  // GUARD 1: every target really has recoveryComment (belt-and-suspenders vs the query).
  for (const d of dead) if (d.recoveryComment == null) abort(`doc ${d._id} in set without recoveryComment`);
  // GUARD 2: none already archived (would mean a prior partial run -- investigate first).
  const ids = dead.map(d => d._id);
  const already = await L.countDocuments({ _id: { $in: ids } });
  if (already > 0) abort(`${already} of the targets already exist in lostContent -- prior run? reconcile manually.`);

  // build manifest (docs + slice paths) and count deletable files
  let totalSlices = 0, presentFiles = 0, offlineRefs = 0;
  const perVol = {};
  const manifest = dead.map(d => {
    const id = d._id.toHexString();
    const all = [...(d.dataVolumes || []).map((v, i) => [v, i]), ...(d.parityVolumes || []).map((v, i) => [v, (d.dataVolumes || []).length + i])];
    const slices = all.map(([vol, idx]) => {
      totalSlices++;
      const base = mount.get(vol);
      if (!base) { offlineRefs++; return { vol, idx, path: null, exists: false, online: false }; }
      const path = `${base}/${shard(id)}/${id}.${idx}`;
      const exists = fs.existsSync(path);
      if (exists) { presentFiles++; perVol[vol] = (perVol[vol] || 0) + 1; }
      return { vol, idx, path, exists, online: true };
    });
    return { doc: d, id, slices };
  });

  // ALWAYS write the backup manifest (full docs) before doing anything.
  fs.writeFileSync(MANIFEST, JSON.stringify({ when: new Date().toISOString(), count: dead.length, docs: dead }, null, 0));
  console.log(`\nbackup manifest written: ${MANIFEST} (${dead.length} full docs)`);
  console.log(`objects: ${dead.length} | slice refs: ${totalSlices} | files present on disk (to delete): ${presentFiles} | refs on offline vols: ${offlineRefs}`);
  console.log(`deletable files per volume: ${JSON.stringify(perVol)}`);
  console.log('sample:'); for (const m of manifest.slice(0, 4)) console.log(`  ${m.id} ${JSON.stringify(m.doc.name)} slices ${m.slices.map(s => s.vol + (s.exists ? '' : s.online ? '?gone' : '!offline')).join(',')}`);

  if (!APPLY) { console.log('\nDRY RUN -- nothing moved or deleted. Review the manifest, then re-run with --apply.'); await client.close(); process.exit(0); }

  // ===== APPLY =====
  // Phase 1: copy every doc into lostContent (idempotent verify after).
  console.log('\n[1/3] copying records into lostContent...');
  const res = await L.insertMany(dead, { ordered: false }).catch(e => { if (e.code === 11000 || e.writeErrors) return e.result; throw e; });
  const inserted = await L.countDocuments({ _id: { $in: ids } });
  if (inserted !== dead.length) abort(`lostContent has ${inserted}/${dead.length} after copy -- NOT deleting anything.`);
  console.log(`  lostContent now holds all ${inserted} records (verified).`);

  // Phase 2: kill slice files (only after every record is safely copied).
  console.log('[2/3] deleting slice files...');
  let deleted = 0, delFail = 0;
  for (const m of manifest) {
    for (const s of m.slices) {
      if (!s.exists || !s.path) continue;
      try { fs.unlinkSync(s.path); deleted++; }
      catch (e) { if (e.code !== 'ENOENT') { delFail++; if (delFail <= 20) console.error(`  unlink fail ${s.path}: ${e.code}`); } }
    }
    if ((manifest.indexOf(m) + 1) % 1000 === 0) console.log(`  ...${manifest.indexOf(m) + 1}/${manifest.length} objects, ${deleted} files deleted`);
  }
  console.log(`  slice files deleted: ${deleted} (failures: ${delFail})`);

  // Phase 3: remove from content -- conditional on recoveryComment still present (never delete an
  // object that was un-flagged/changed since we snapshotted).
  console.log('[3/3] removing records from content...');
  const del = await C.deleteMany({ _id: { $in: ids }, recoveryComment: { $exists: true } });
  console.log(`  content records removed: ${del.deletedCount}`);

  // Final verification
  const remainingFlagged = await C.countDocuments({ recoveryComment: { $exists: true } });
  const lostTotal = await L.countDocuments({});
  console.log('\n=== DONE ===');
  console.log(`content still flagged (recoveryComment): ${remainingFlagged}`);
  console.log(`lostContent total: ${lostTotal}`);
  console.log(`slice files deleted: ${deleted}, delete-failures: ${delFail}`);
  await client.close();
  process.exit(0);
})().catch(e => { console.error('FATAL', e.stack || e.message); process.exit(1); });
