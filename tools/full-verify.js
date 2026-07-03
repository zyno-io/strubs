#!/usr/bin/env node
'use strict';
// FULL read-verify (flag-only) of the never-deeply-checked objects. Reads each object through the app's
// REAL reader and gates on the WHOLE-OBJECT md5 (definitive "is this file bad") -- reconstructing on
// slice faults, never repairing (freeze stays ON; this process never invokes repair). Scoped to
// lastVerifiedAt < BOUNDARY (the light-only/never-checked 1.74M; the re-stamped/recovered set is
// skipped). Resumable: stamps lastVerifiedAt=now on every processed object. Per-slice fault codes are
// captured by tapping remediationService.reportSliceFault, so degraded-but-readable objects are flagged
// (for repair once unfrozen) and genuinely-bad objects (below quorum / md5 mismatch) are recorded.
//
//   node tools/full-verify.js                 # DRY RUN: classify only, no DB writes
//   node tools/full-verify.js --apply         # write verify results (sliceErrors/lastVerifiedAt)
//   node tools/full-verify.js --apply --limit 2000
//
// Run from /opt/strubs. UV_THREADPOOL_SIZE=64 recommended.

const fs = require('fs');
const { createHash } = require('crypto');
const { MongoClient } = require('mongodb');
const { Volume } = require('../dist/lib/io/volume');
const { volumeFleet } = require('../dist/lib/io/volume-fleet');
const { FileObject } = require('../dist/lib/io/file-object');
const { FileObjectReader } = require('../dist/lib/io/file-object/reader');
const { remediationService } = require('../dist/lib/remediation/service');
let categorize; try { categorize = require('../dist/lib/slice-error').categorizeSliceError; } catch { categorize = (code) => code || 'unknown'; }

const APPLY = process.argv.includes('--apply');
const LIMIT = (() => { const i = process.argv.indexOf('--limit'); return i >= 0 ? parseInt(process.argv[i+1],10) : Infinity; })();
const CONC = (() => { const i = process.argv.indexOf('--conc'); return i >= 0 ? parseInt(process.argv[i+1],10) : 12; })();
const MR = '/run/strubs/mounts';
const BOUNDARY = new Date('2026-06-30T12:00:00Z');   // >= this == already validated (re-stamp/recovery)
const md5Of = doc => (doc && doc.md5 && doc.md5.buffer) ? doc.md5.buffer : (doc ? doc.md5 : null);

// tap the reader's fault reporter to capture per-(object,slice) codes without triggering repair
const faultsByObj = new Map();
remediationService.reportSliceFault = (f) => {
  if (!f || f.objectId == null) return;
  let arr = faultsByObj.get(f.objectId); if (!arr) { arr = []; faultsByObj.set(f.objectId, arr); }
  arr.push({ sliceIndex: f.sliceIndex, code: f.code, message: f.message });
};

(async () => {
  const client = await MongoClient.connect(process.env.STRUBS_MONGO_URL || 'mongodb://strubs:strubs@127.0.0.1:27017/strubs?authSource=admin');
  const db = client.db('strubs'); const C = db.collection('content'), V = db.collection('volumes');
  console.log(`MODE ${APPLY ? 'APPLY' : 'DRY RUN'}  conc=${CONC}  threadpool=${process.env.UV_THREADPOOL_SIZE || '4'}  boundary=${BOUNDARY.toISOString()}`);

  for (const doc of await V.find({}).toArray()) {
    const v = new Volume(doc); const mount = `${MR}/${doc.uuid}`;
    if (fs.existsSync(`${mount}/strubs`)) { v.mountPoint = mount; v.isStarted = true; v.isEnabled = true; v.isHealthy = true; v.isReadOnly = false; }
    else v.isStarted = false;
    volumeFleet['_volumes'][doc.id] = v;
  }

  const s = { objs: 0, healthy: 0, degraded: 0, belowQuorum: 0, corrupt: 0, noMd5: 0, error: 0, slicesFlagged: 0 };
  const badSamples = [];
  let batch = [];
  const flush = async () => { if (!APPLY || !batch.length) { batch = []; return; } const b = batch; batch = []; try { await C.bulkWrite(b, { ordered: false }); } catch (e) { console.error('bulk', e.message); } };

  const verify = async (doc) => {
    const id = doc._id.toHexString();
    faultsByObj.delete(id);
    const rec = { id, size: doc.size, chunkSize: doc.chunkSize, md5: md5Of(doc), dataVolumes: doc.dataVolumes, parityVolumes: doc.parityVolumes, name: doc.name, containerId: doc.containerId };
    const fo = new FileObject(); await fo.loadFromRecord(rec);
    if (!fo.md5) { s.noMd5++; if (APPLY) batch.push({ updateOne: { filter: { _id: doc._id }, update: { $set: { lastVerifiedAt: new Date() } } } }); return; }
    const dataN = (doc.dataVolumes || []).length;
    const reader = new FileObjectReader(fo);
    let status;
    try {
      await reader.prepare(); reader.setReadRange(0, fo.size);
      const h = createHash('md5');
      for (let b; (b = await reader.readChunk()) !== null; ) h.update(b);
      status = h.digest().equals(fo.md5) ? 'ok' : 'corrupt';
    } catch (e) { status = (e && e.code === 'EQUORUM') ? 'belowQuorum' : 'error'; if (status === 'error' && s.error < 10) console.error('read', id, e && (e.code || e.message)); }
    finally { await reader.close().catch(() => {}); }

    const faults = faultsByObj.get(id) || []; faultsByObj.delete(id);
    // build a sliceErrors map from captured faults (deduped by slice index, last code wins)
    const errs = {};
    for (const f of faults) { if (f.sliceIndex == null) continue; errs[String(f.sliceIndex)] = { category: categorize(f.code, f.message), code: f.code, err: f.message || f.code, type: f.sliceIndex < dataN ? 'data' : 'parity' }; }
    const nErr = Object.keys(errs).length;

    let upd;
    if (status === 'ok' && nErr === 0) { s.healthy++; upd = { $set: { lastVerifiedAt: new Date() }, $unset: { sliceErrors: '' } }; }
    else if (status === 'ok') { s.degraded++; s.slicesFlagged += nErr; upd = { $set: { sliceErrors: errs, lastVerifiedAt: new Date() } }; }          // readable but some slice bad -> repair later
    else { // belowQuorum / corrupt / error -> genuinely bad
      s[status === 'belowQuorum' ? 'belowQuorum' : status === 'corrupt' ? 'corrupt' : 'error']++;
      s.slicesFlagged += nErr;
      upd = { $set: { sliceErrors: nErr ? errs : { verify: { category: status === 'corrupt' ? 'checksum' : 'unavailable', err: status } }, verifyStatus: status, lastVerifiedAt: new Date() } };
      if (badSamples.length < 30) badSamples.push(`${id} ${status} faults=${JSON.stringify(faults.map(f => f.sliceIndex + ':' + f.code))}`);
    }
    if (APPLY) { batch.push({ updateOne: { filter: { _id: doc._id }, update: upd } }); if (batch.length >= 500) await flush(); }
  };

  const q = { isFile: true, $or: [{ lastVerifiedAt: { $lt: BOUNDARY } }, { lastVerifiedAt: { $exists: false } }] };
  const cur = C.find(q, { projection: { dataVolumes: 1, parityVolumes: 1, chunkSize: 1, size: 1, md5: 1, name: 1, containerId: 1 } }).batchSize(500).addCursorFlag('noCursorTimeout', true);
  const inflight = new Set(); const t0 = Date.now();
  for await (const doc of cur) {
    if (s.objs >= LIMIT) break; s.objs++;
    const p = verify(doc).catch(e => { s.error++; console.error('verify', doc._id.toString(), e && (e.stack || e.message)); }).finally(() => inflight.delete(p));
    inflight.add(p);
    if (inflight.size >= CONC) await Promise.race(inflight);
    if (s.objs % 20000 === 0) { const r = Math.round(s.objs / ((Date.now() - t0) / 1000)); console.log(`  ...${s.objs} (${r}/s) healthy ${s.healthy} degraded ${s.degraded} belowQuorum ${s.belowQuorum} corrupt ${s.corrupt}`); }
  }
  await Promise.all(inflight); await flush();

  console.log('\n=== FULL VERIFY RESULT ==='); console.log(JSON.stringify(s, null, 1));
  console.log(`elapsed ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  if (badSamples.length) { console.log('\nbad samples:'); for (const b of badSamples) console.log('  ', b); }
  await client.close(); process.exit(0);
})().catch(e => { console.error('FATAL', e.stack || e.message); process.exit(1); });
