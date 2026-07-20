#!/usr/bin/env node
'use strict';
// ============================================================================================================
// TARGETED IN-PLACE PARITY REPAIR for the objects the full verify flagged with a real (parity-only) fault.
// Each is above quorum with all data slices intact, so the fix is to recompute the bad parity slice from the
// data and commit it over the old one. Uses the app's md5-gated SliceRepairer (which refuses to write unless
// the reconstruction reproduces the stored whole-object md5), then re-reads the whole object + rechecks parity
// to confirm before clearing the flag.
//
//   node tools/repair-parity.js            # DRY RUN -- validate + list, write nothing
//   node tools/repair-parity.js --apply    # repair + re-verify + clear the sliceErrors flag
//
// PRE-FLIGHT (both modes): the WHOLE flagged set must pass -- every object has a 16-byte stored md5, and every
// fault key is a real PARITY slice index (>= dataSliceCount, in range). Any violation ABORTS before a single
// write, rather than guessing. Volumes keep their persisted enabled/healthy/read-only/deleted state, so the
// repair targets only a genuinely-writable disk. Run from /opt/strubs.
// ============================================================================================================

const fs = require('fs');
const { createHash } = require('crypto');
const { MongoClient } = require('mongodb');
const { Volume } = require('../dist/lib/io/volume');
const { volumeFleet } = require('../dist/lib/io/volume-fleet');
const { FileObject } = require('../dist/lib/io/file-object');
const { FileObjectReader } = require('../dist/lib/io/file-object/reader');
const { sliceRepairer } = require('../dist/lib/io/file-object/slice-repairer');

const APPLY = process.argv.includes('--apply');
const MR = '/run/strubs/mounts';
const md5Of = doc => (doc && doc.md5 && doc.md5.buffer) ? doc.md5.buffer : (doc ? doc.md5 : null);
const isValidMd5 = m => Buffer.isBuffer(m) && m.length === 16;
const recToObj = doc => ({ id: doc._id.toHexString(), size: doc.size, chunkSize: doc.chunkSize, md5: md5Of(doc), dataVolumes: doc.dataVolumes, parityVolumes: doc.parityVolumes, name: doc.name, containerId: doc.containerId });
const die = async (client, msg) => { console.error('ABORT: ' + msg); await client.close(); process.exit(1); };

(async () => {
  const client = await MongoClient.connect(process.env.STRUBS_MONGO_URL || 'mongodb://strubs:strubs@127.0.0.1:27017/strubs?authSource=admin');
  const db = client.db('strubs'); const C = db.collection('content'), V = db.collection('volumes');
  console.log(`MODE ${APPLY ? 'APPLY' : 'DRY RUN'}`);

  // Register volumes RESPECTING their persisted flags (enabled/healthy/read-only/deleted come from the doc via
  // the Volume constructor). Only the runtime bits -- mountPoint + isStarted -- are set here. So isWritable
  // (= isStarted && isEnabled && isHealthy && !isReadOnly && !isDraining) reflects the real DB state, and a
  // repair onto a read-only/draining/disabled disk is refused by SliceRepairer.assertTargetWritable().
  for (const doc of await V.find({}).toArray()) {
    const v = new Volume(doc); const mount = `${MR}/${doc.uuid}`;
    if (fs.existsSync(`${mount}/strubs`)) { v.mountPoint = mount; v.isStarted = true; }
    else v.isStarted = false;
    volumeFleet['_volumes'][doc.id] = v;
  }

  // Full end-to-end confirmation after a repair. Read every chunk set through the codec: parity must now match
  // (0 mismatched/missing), whole-object md5 must match, and NO data slice may have been reconstructed
  // (dataIncomplete) -- a data-slice fault during re-verify means the object is not truly clean.
  const verifyClean = async (rec) => {
    const fo = new FileObject(); await fo.loadFromRecord(rec);
    const reader = new FileObjectReader(fo);
    try {
      await reader.prepare();
      const h = createHash('md5'); let hashed = 0, parityBad = 0, dataIncomplete = false;
      for (let r; (r = await reader.verifyChunkSetParity()) !== null; ) {
        if (r.dataIncomplete) dataIncomplete = true;
        parityBad += r.mismatched.length + r.missing.length;
        const take = Math.min(r.dataRegion.length, fo.size - hashed); if (take > 0) { h.update(r.dataRegion.subarray(0, take)); hashed += take; }
      }
      const md5ok = hashed === fo.size && fo.md5 && h.digest().equals(fo.md5);
      return { ok: !!md5ok && parityBad === 0 && !dataIncomplete, md5ok: !!md5ok, parityBad, dataIncomplete };
    } catch (e) { return { ok: false, err: e && (e.code || e.message) }; }
    finally { await reader.close().catch(() => {}); }
  };

  const docs = await C.find({ isFile: true, sliceErrors: { $exists: true } }).toArray();
  console.log(`flagged objects: ${docs.length}`);
  if (!docs.length) { console.log('nothing to do'); await client.close(); process.exit(0); }

  // ---- PRE-FLIGHT: the whole set must be a clean parity-only, md5-backed repair, or we abort before writing ----
  const plan = [];
  for (const d of docs) {
    const id = d._id.toHexString();
    const dataN = (d.dataVolumes || []).length, parityN = (d.parityVolumes || []).length, total = dataN + parityN;
    if (!isValidMd5(md5Of(d))) return die(client, `object ${id} has no valid 16-byte stored md5 -- refusing to rewrite parity without the whole-object gate.`);
    const idxs = [];
    for (const key of Object.keys(d.sliceErrors)) {
      const i = Number(key);
      if (!Number.isInteger(i) || i < 0 || i >= total) return die(client, `object ${id} has a non-index / out-of-range sliceErrors key ${JSON.stringify(key)} (dataN=${dataN} parityN=${parityN}). Review manually.`);
      if (i < dataN) return die(client, `object ${id} has a DATA-slice fault at index ${i} -- this tool only recomputes parity. Review manually.`);
      idxs.push(i);
    }
    if (!idxs.length) return die(client, `object ${id} is flagged but has no slice indices in sliceErrors. Review manually.`);
    idxs.sort((a, b) => a - b);
    plan.push({ d, id, idxs });
  }
  console.log(`pre-flight OK: ${plan.length} objects, all parity-only with a valid stored md5`);

  let repaired = 0, failed = 0, would = 0;
  for (const { d, id, idxs } of plan) {
    console.log(`\n${id}  parity slice(s) [${idxs}]  pv=[${d.parityVolumes}]`);
    if (!APPLY) { console.log('  (dry run -- would recompute + commit these parity slices, then re-verify)'); would++; continue; }

    const rec = recToObj(d);
    try {
      const fo = new FileObject(); await fo.loadFromRecord(rec);
      for (const idx of idxs) { await sliceRepairer.repair(fo, idx); console.log(`  recomputed + committed slice ${idx}`); }
    } catch (e) { console.error(`  REPAIR FAILED: ${e && (e.code || e.message)} -- leaving flagged`); failed++; continue; }

    const chk = await verifyClean(rec);
    if (!chk.ok) { console.error(`  RE-VERIFY FAILED: ${JSON.stringify(chk)} -- leaving flagged`); failed++; continue; }

    // Clear ONLY if the flag is still the one we validated (conditional on sliceErrors still existing).
    const res = await C.updateOne({ _id: d._id, sliceErrors: { $exists: true } }, { $unset: { sliceErrors: '', verifyStatus: '' }, $set: { lastVerifiedAt: new Date(), fullVerifiedAt: new Date() } });
    if (res.modifiedCount !== 1) { console.error(`  WARNING: flag not cleared (sliceErrors changed under us?) -- repair committed, DB left as-is`); }
    else console.log('  OK -- re-verified clean (parity + md5 match), flag cleared');
    repaired++;
  }

  console.log(`\n=== DONE === repaired ${repaired}  failed ${failed}${APPLY ? '' : `  would-repair ${would}`}`);
  await client.close(); process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FATAL', e.stack || e.message); process.exit(1); });
