#!/usr/bin/env node
'use strict';
// DECISIVE EXPERIMENT (read-only): are the vol-34 cluster's parity BYTES still RS-valid (just carrying
// broken per-chunk MD5 headers), or are they genuinely garbage? Monkey-patch Slice.throwChecksumError
// to a no-op so readChunk returns raw chunk bytes despite a per-chunk MD5 mismatch; then reconstruct
// each object through the REAL codec and check the WHOLE-OBJECT md5. If md5 matches, the parity is
// salvageable without the physical drive. No writes.
//   node tools/parity-salvage-test.js [sample]

const fs = require('fs');
const { createHash } = require('crypto');
const { MongoClient } = require('mongodb');

const { Volume } = require('../dist/lib/io/volume');
const { volumeFleet } = require('../dist/lib/io/volume-fleet');
const { FileObject } = require('../dist/lib/io/file-object');
const { FileObjectReader } = require('../dist/lib/io/file-object/reader');
const { Slice } = require('../dist/lib/io/file-object/slice');

// --- THE BYPASS: accept chunks whose per-chunk MD5 header is wrong, return raw bytes ---
let bypassed = 0;
Slice.prototype.throwChecksumError = function () { bypassed++; /* no-op: use raw parity bytes */ };

const MR = '/run/strubs/mounts';
const DEAD = new Set([34, 7, 43]);
const md5Of = doc => (doc && doc.md5 && doc.md5.buffer) ? doc.md5.buffer : (doc ? doc.md5 : null);

(async () => {
  const N = parseInt(process.argv[2] || '50', 10);
  const client = await MongoClient.connect(process.env.STRUBS_MONGO_URL || 'mongodb://strubs:strubs@127.0.0.1:27017/strubs?authSource=admin');
  const db = client.db('strubs');
  const C = db.collection('content'), V = db.collection('volumes');

  for (const doc of await V.find({}).toArray()) {
    const v = new Volume(doc); const mount = `${MR}/${doc.uuid}`;
    if (fs.existsSync(`${mount}/strubs`) && !DEAD.has(doc.id)) { v.mountPoint = mount; v.isStarted = true; v.isEnabled = true; v.isHealthy = true; v.isReadOnly = false; }
    else v.isStarted = false;
    volumeFleet['_volumes'][doc.id] = v;
  }

  const docs = await C.aggregate([{ $match: { isFile: true, sliceErrors: { $exists: true }, $or: [{ dataVolumes: 34 }, { parityVolumes: 34 }] } }, { $sample: { size: N } }]).toArray();
  const s = { objs: 0, salvaged: 0, md5mismatch: 0, equorum: 0, error: 0, noMd5: 0 };
  const salvagedIds = [];

  for (const doc of docs) {
    const rec = { id: doc._id.toHexString(), size: doc.size, chunkSize: doc.chunkSize, md5: md5Of(doc), dataVolumes: doc.dataVolumes, parityVolumes: doc.parityVolumes, name: doc.name, containerId: doc.containerId };
    const fo = new FileObject(); await fo.loadFromRecord(rec);
    if (!fo.md5) { s.noMd5++; continue; }
    s.objs++;
    const reader = new FileObjectReader(fo);
    try {
      await reader.prepare();
      reader.setReadRange(0, fo.size);
      const h = createHash('md5');
      for (let b; (b = await reader.readChunk()) !== null; ) h.update(b);
      if (h.digest().equals(fo.md5)) { s.salvaged++; if (salvagedIds.length < 15) salvagedIds.push(rec.id); }
      else s.md5mismatch++;
    } catch (e) { if (e && e.code === 'EQUORUM') s.equorum++; else { s.error++; if (s.error <= 5) console.error('err', rec.id, e && (e.code || e.message)); } }
    finally { await reader.close().catch(() => {}); }
  }

  console.log('\n=== PARITY SALVAGE TEST (md5 gate, chunk-MD5 bypassed) ===');
  console.log(JSON.stringify(s, null, 1));
  console.log(`chunk-MD5 mismatches tolerated during reads: ${bypassed}`);
  console.log(`SALVAGEABLE => whole-object md5 MATCHED using raw parity bytes: ${s.salvaged}/${s.objs}`);
  if (salvagedIds.length) console.log('salvaged sample ids:', salvagedIds.join(' '));
  await client.close();
  process.exit(0);
})().catch(e => { console.error('FATAL', e.stack || e.message); process.exit(1); });
