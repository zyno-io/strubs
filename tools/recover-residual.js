#!/usr/bin/env node
'use strict';
// RECOVERY PASS for the residual flagged objects (slices on dead vols 34/7/43 + a few dataBad).
// Reconstructs each object through the app's REAL codec (FileObjectReader) and gates recoverability
// on the WHOLE-OBJECT md5 (the check the app's verify/repair pipeline lacks -- the only thing that
// catches a foreign-but-self-consistent slice). For recoverable objects it rebuilds the dead-volume
// slice onto a HEALTHY volume (sliceRepairer), re-verifies the whole object, then flips the DB refs
// and clears the flag. Sets lastVerifiedAt on EVERY processed object (recovered or not) so they land
// on the validated side of the 2026-06-30 skip boundary. READ-ONLY unless --apply.
//
//   node tools/recover-residual.js                # DRY RUN: classify recoverable/unrecoverable
//   node tools/recover-residual.js --apply        # rebuild + relocate + flip refs + clear flags
//   node tools/recover-residual.js --limit 50     # bounded
//
// Run from /opt/strubs (dotenv + dist/ resolve relative to cwd). Safe alongside the frozen service.

const fs = require('fs');
const cp = require('child_process');
const { createHash } = require('crypto');
const { MongoClient } = require('mongodb');

const { Volume } = require('../dist/lib/io/volume');
const { volumeFleet } = require('../dist/lib/io/volume-fleet');
const { FileObject } = require('../dist/lib/io/file-object');
const { FileObjectReader } = require('../dist/lib/io/file-object/reader');
const { sliceRepairer } = require('../dist/lib/io/file-object/slice-repairer');

const APPLY = process.argv.includes('--apply');
const LIMIT = (() => { const i = process.argv.indexOf('--limit'); return i >= 0 ? parseInt(process.argv[i+1],10) : Infinity; })();
const CONC = APPLY ? 4 : 8;
const MR = '/run/strubs/mounts';
const DEAD = new Set([34, 7, 43]);                 // offline/dead source vols -> slices are erasures
const DEST_EXCLUDE = new Set([7, 31, 34, 43, 47]); // never PLACE rebuilt slices here
const MIN_FREE = 50 * 1e9;

const md5Of = doc => (doc && doc.md5 && doc.md5.buffer) ? doc.md5.buffer : (doc ? doc.md5 : null);

(async () => {
  const client = await MongoClient.connect(process.env.STRUBS_MONGO_URL || 'mongodb://strubs:strubs@127.0.0.1:27017/strubs?authSource=admin');
  const db = client.db('strubs');
  const C = db.collection('content'), V = db.collection('volumes');
  console.log(`MODE ${APPLY ? 'APPLY' : 'DRY RUN'}  conc=${CONC}`);

  // --- register volumes into the shared fleet the codec reads from ---
  const targets = [];
  for (const doc of await V.find({}).toArray()) {
    const v = new Volume(doc);
    const mount = `${MR}/${doc.uuid}`;
    const online = fs.existsSync(`${mount}/strubs`) && !DEAD.has(doc.id);
    if (online) { v.mountPoint = mount; v.isStarted = true; v.isEnabled = true; v.isHealthy = true; v.isReadOnly = false; }
    else { v.isStarted = false; }                  // erasure
    volumeFleet['_volumes'][doc.id] = v;
    if (online && !DEST_EXCLUDE.has(doc.id)) {
      let total = 0, free = 0;
      try { const [t, a] = cp.execSync(`df -B1 --output=size,avail ${mount}/strubs 2>/dev/null | tail -1`).toString().trim().split(/\s+/).map(Number); total = t; free = a; } catch {}
      if (Number.isFinite(free) && free > MIN_FREE) targets.push({ id: doc.id, total, free });
    }
  }
  console.log(`dest-eligible volumes: ${targets.map(t => t.id + ':' + (t.free/1e12).toFixed(1) + 'T').join(' ')}`);
  const pickDest = (used, need) => { let best = null, bf = Infinity;
    for (const t of targets) { if (used.has(t.id)) continue; if (t.free < need + MIN_FREE) continue; const fill = (t.total - t.free)/t.total; if (fill < bf) { bf = fill; best = t; } }
    return best; };

  const recToObj = doc => ({ id: doc._id.toHexString(), size: doc.size, chunkSize: doc.chunkSize,
    md5: md5Of(doc), dataVolumes: doc.dataVolumes, parityVolumes: doc.parityVolumes, name: doc.name, containerId: doc.containerId });

  // Read the object fully through the codec and compare whole-object md5. Returns status + fo.
  const verifyWhole = async (rec) => {
    const fo = new FileObject(); await fo.loadFromRecord(rec);
    if (!fo.md5) return { status: 'no-md5', fo };
    const reader = new FileObjectReader(fo);
    try {
      await reader.prepare();
      reader.setReadRange(0, fo.size);
      const h = createHash('md5');
      for (let b; (b = await reader.readChunk()) !== null; ) h.update(b);
      return { status: h.digest().equals(fo.md5) ? 'recoverable' : 'md5-mismatch', fo };
    } catch (e) { return { status: e && e.code === 'EQUORUM' ? 'equorum' : 'error', err: e && (e.code || e.message), fo }; }
    finally { await reader.close().catch(() => {}); }
  };

  const s = { objs: 0, recoverable: 0, repaired: 0, equorum: 0, md5mismatch: 0, noMd5: 0, error: 0, noDest: 0, repairFail: 0, reverifyFail: 0 };
  const unrecoverableSamples = [];
  let batch = [];
  const flush = async () => { if (!APPLY || !batch.length) { batch = []; return; } const b = batch; batch = []; try { await C.bulkWrite(b, { ordered: false }); } catch (e) { console.error('bulk', e.message); } };

  const handle = async (doc) => {
    const rec = recToObj(doc);
    const badIdxs = Object.keys(doc.sliceErrors || {}).map(Number);
    const res = await verifyWhole(rec);

    if (res.status !== 'recoverable') {
      s[res.status === 'md5-mismatch' ? 'md5mismatch' : res.status === 'equorum' ? 'equorum' : res.status === 'no-md5' ? 'noMd5' : 'error']++;
      if (unrecoverableSamples.length < 30) unrecoverableSamples.push(`${rec.id} ${res.status}${res.err ? '(' + res.err + ')' : ''} bad=[${badIdxs}] dv=[${rec.dataVolumes}] pv=[${rec.parityVolumes}]`);
      if (APPLY) batch.push({ updateOne: { filter: { _id: doc._id }, update: { $set: { lastVerifiedAt: new Date() } } } }); // keep flag, mark verified
      return;
    }
    s.recoverable++;
    if (!APPLY) return;                            // dry run stops at classification

    // --- rebuild each bad slice onto a healthy volume ---
    const fo = res.fo;
    const sliceBytes = doc.sliceSize || Math.ceil((doc.size || 0) / Math.max(1, rec.dataVolumes.length)) || 5e6;
    const used = new Set([...fo.dataSliceVolumeIds, ...fo.paritySliceVolumeIds].filter((_v, i) => !badIdxs.includes(i)));
    let failed = false;
    for (const idx of badIdxs) {
      const dest = pickDest(used, sliceBytes);
      if (!dest) { s.noDest++; failed = true; break; }
      used.add(dest.id);
      if (idx < fo.dataSliceCount) fo.dataSliceVolumeIds[idx] = dest.id;
      else fo.paritySliceVolumeIds[idx - fo.dataSliceCount] = dest.id;
      try { await sliceRepairer.repair(fo, idx); dest.free -= sliceBytes; }
      catch (e) { s.repairFail++; if (s.repairFail <= 10) console.error('repair', rec.id, idx, e && (e.code || e.message)); failed = true; break; }
    }
    if (failed) { batch.push({ updateOne: { filter: { _id: doc._id }, update: { $set: { lastVerifiedAt: new Date() } } } }); return; }

    // --- re-verify the WHOLE object now including rebuilt slices, before trusting the flip ---
    const re = await verifyWhole({ ...rec, dataVolumes: fo.dataSliceVolumeIds, parityVolumes: fo.paritySliceVolumeIds });
    if (re.status !== 'recoverable') { s.reverifyFail++; console.error('reverify', rec.id, re.status, re.err || ''); // leave written slices; do NOT flip refs
      batch.push({ updateOne: { filter: { _id: doc._id }, update: { $set: { lastVerifiedAt: new Date() } } } }); return; }

    s.repaired++;
    // Persist new slice locations. loadFromRecord aliases dataSliceVolumeIds to the record's array,
    // so doc.dataVolumes is already the MUTATED (new) refs here -- capture fresh copies to write, and
    // guard on still-flagged (frozen service -> nothing else mutates these) rather than the old arrays.
    const newData = [...fo.dataSliceVolumeIds], newParity = [...fo.paritySliceVolumeIds];
    batch.push({ updateOne: { filter: { _id: doc._id, sliceErrors: { $exists: true } },
      update: { $set: { dataVolumes: newData, parityVolumes: newParity, lastVerifiedAt: new Date() }, $unset: { sliceErrors: '' } } } });
    if (batch.length >= 200) await flush();
  };

  const cur = C.find({ isFile: true, sliceErrors: { $exists: true } }).batchSize(500).addCursorFlag('noCursorTimeout', true);
  const inflight = new Set();
  for await (const doc of cur) {
    if (s.objs >= LIMIT) break; s.objs++;
    const p = handle(doc).catch(e => { s.error++; console.error('handle', doc._id.toString(), e && (e.stack || e.message)); }).finally(() => inflight.delete(p));
    inflight.add(p);
    if (inflight.size >= CONC) await Promise.race(inflight);
    if (s.objs % 500 === 0) console.log(`  ...${s.objs} objs | recoverable ${s.recoverable} repaired ${s.repaired} equorum ${s.equorum} md5mismatch ${s.md5mismatch}`);
  }
  await Promise.all(inflight); await flush();

  console.log('\n=== RECOVERY RESULT ===');
  console.log(JSON.stringify(s, null, 1));
  console.log('\nunrecoverable samples:'); for (const u of unrecoverableSamples) console.log('  ', u);
  await client.close();
  process.exit(0);
})().catch(e => { console.error('FATAL', e.stack || e.message); process.exit(1); });
