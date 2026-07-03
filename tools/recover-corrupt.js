#!/usr/bin/env node
'use strict';
// The full verify found 33 "corrupt" objects (whole-object md5 mismatch, NO per-slice fault = a
// self-consistent-but-foreign slice). Try to recover each: drop one slice at a time (and each pair),
// reconstruct through the real codec, and check the whole-object md5. A match identifies the foreign
// slice and proves recoverability. READ-ONLY (no DB/volume writes) unless --apply.
//   node tools/recover-corrupt.js            # analyze which are recoverable and which slice is bad
const fs = require('fs');
const { createHash } = require('crypto');
const { MongoClient } = require('mongodb');
const { Volume } = require('../dist/lib/io/volume');
const { volumeFleet } = require('../dist/lib/io/volume-fleet');
const { FileObject } = require('../dist/lib/io/file-object');
const { FileObjectReader } = require('../dist/lib/io/file-object/reader');
const { remediationService } = require('../dist/lib/remediation/service');
remediationService.reportSliceFault = () => {};
const MR = '/run/strubs/mounts';
const md5Of = doc => (doc && doc.md5 && doc.md5.buffer) ? doc.md5.buffer : (doc ? doc.md5 : null);

async function md5With(rec, dropIdxs) {
  const fo = new FileObject(); await fo.loadFromRecord(rec);
  fo.unavailableSliceIdxs = dropIdxs;
  const r = new FileObjectReader(fo);
  try { await r.prepare(); r.setReadRange(0, fo.size); const h = createHash('md5');
    for (let b; (b = await r.readChunk()) !== null; ) h.update(b);
    return h.digest().equals(fo.md5) ? 'match' : 'mismatch';
  } catch (e) { return e && e.code === 'EQUORUM' ? 'equorum' : 'error'; }
  finally { await r.close().catch(() => {}); }
}

(async () => {
  const client = await MongoClient.connect(process.env.STRUBS_MONGO_URL || 'mongodb://strubs:strubs@127.0.0.1:27017/strubs?authSource=admin');
  const C = client.db('strubs').collection('content'), V = client.db('strubs').collection('volumes');
  for (const doc of await V.find({}).toArray()) { const v = new Volume(doc); const m = `${MR}/${doc.uuid}`;
    if (fs.existsSync(`${m}/strubs`)) { v.mountPoint = m; v.isStarted = true; v.isEnabled = true; v.isHealthy = true; v.isReadOnly = false; } else v.isStarted = false;
    volumeFleet['_volumes'][doc.id] = v; }

  const docs = await C.find({ isFile: true, verifyStatus: 'corrupt' }).toArray();
  const s = { total: 0, recov1: 0, recov2: 0, unrecoverable: 0 };
  const badSliceHist = {};
  for (const doc of docs) {
    s.total++;
    const rec = { id: doc._id.toHexString(), size: doc.size, chunkSize: doc.chunkSize, md5: md5Of(doc), dataVolumes: doc.dataVolumes, parityVolumes: doc.parityVolumes, name: doc.name, containerId: doc.containerId };
    const n = (doc.dataVolumes.length + doc.parityVolumes.length);
    let found = null;
    for (let i = 0; i < n && !found; i++) if (await md5With(rec, [i]) === 'match') found = { drop: [i] };
    if (found) { s.recov1++; badSliceHist[found.drop[0]] = (badSliceHist[found.drop[0]] || 0) + 1; }
    else {
      // try dropping pairs (up to 2 erasures for 4+2)
      outer: for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (await md5With(rec, [i, j]) === 'match') { found = { drop: [i, j] }; break outer; }
      if (found) s.recov2++; else s.unrecoverable++;
    }
    console.log(`${rec.id} size=${doc.size} -> ${found ? 'RECOVERABLE dropping slice(s) ' + found.drop.join(',') : 'not recoverable by single/pair drop'}`);
  }
  console.log('\n=== CORRUPT RECOVERY ANALYSIS ===');
  console.log(JSON.stringify(s, null, 1));
  console.log('bad-slice index histogram (single-drop recoveries):', JSON.stringify(badSliceHist));
  await client.close(); process.exit(0);
})().catch(e => { console.error('FATAL', e.stack || e.message); process.exit(1); });
