#!/usr/bin/env node
'use strict';
// READ-ONLY re-classification of the recoveryComment "dead" objects before we kill their slices.
// Reads each object fully through the app's REAL codec (FileObjectReader) and gates on the WHOLE-OBJECT
// md5 -- the only check that catches a foreign-but-self-consistent parity slice. Purpose: prove every
// object we are about to destroy is genuinely UNRECOVERABLE, and surface any that are secretly
// recoverable (which must be EXCLUDED from the kill). Writes NOTHING. Safe alongside the frozen service.
//   node tools/verify-dead.js            # classify all recoveryComment objects
//   node tools/verify-dead.js --limit N

const fs = require('fs');
const { createHash } = require('crypto');
const { MongoClient } = require('mongodb');

const { Volume } = require('../dist/lib/io/volume');
const { volumeFleet } = require('../dist/lib/io/volume-fleet');
const { FileObject } = require('../dist/lib/io/file-object');
const { FileObjectReader } = require('../dist/lib/io/file-object/reader');

const LIMIT = (() => { const i = process.argv.indexOf('--limit'); return i >= 0 ? parseInt(process.argv[i + 1], 10) : Infinity; })();
const CONC = 8;
const MR = '/run/strubs/mounts';
const DEAD = new Set([34, 7, 43]);   // offline/dead source vols -> their slices are erasures
const md5Of = doc => (doc && doc.md5 && doc.md5.buffer) ? doc.md5.buffer : (doc ? doc.md5 : null);

(async () => {
  const client = await MongoClient.connect(process.env.STRUBS_MONGO_URL || 'mongodb://strubs:strubs@127.0.0.1:27017/strubs?authSource=admin');
  const db = client.db('strubs');
  const C = db.collection('content');
  console.log('MODE READ-ONLY (classification only, writes nothing)');

  for (const doc of await db.collection('volumes').find({}).toArray()) {
    const v = new Volume(doc);
    const mount = `${MR}/${doc.uuid}`;
    const online = fs.existsSync(`${mount}/strubs`) && !DEAD.has(doc.id);
    if (online) { v.mountPoint = mount; v.isStarted = true; v.isEnabled = true; v.isHealthy = true; v.isReadOnly = false; }
    else { v.isStarted = false; }
    volumeFleet['_volumes'][doc.id] = v;
  }

  const recToObj = doc => ({ id: doc._id.toHexString(), size: doc.size, chunkSize: doc.chunkSize,
    md5: md5Of(doc), dataVolumes: doc.dataVolumes, parityVolumes: doc.parityVolumes, name: doc.name, containerId: doc.containerId });

  const verifyWhole = async (rec) => {
    const fo = new FileObject(); await fo.loadFromRecord(rec);
    if (!fo.md5) return { status: 'no-md5' };
    const reader = new FileObjectReader(fo);
    try {
      await reader.prepare();
      reader.setReadRange(0, fo.size);
      const h = createHash('md5');
      for (let b; (b = await reader.readChunk()) !== null; ) h.update(b);
      return { status: h.digest().equals(fo.md5) ? 'recoverable' : 'md5-mismatch' };
    } catch (e) { return { status: e && e.code === 'EQUORUM' ? 'equorum' : 'error', err: e && (e.code || e.message) }; }
    finally { await reader.close().catch(() => {}); }
  };

  const s = { objs: 0, recoverable: 0, equorum: 0, mismatch: 0, noMd5: 0, error: 0 };
  const recoverableList = [];   // MUST NOT be killed
  const errorSamples = [];

  const handle = async (doc) => {
    const rec = recToObj(doc);
    const res = await verifyWhole(rec);
    if (res.status === 'recoverable') { s.recoverable++; recoverableList.push(`${rec.id} name=${JSON.stringify(rec.name)} dv=[${rec.dataVolumes}] pv=[${rec.parityVolumes}] rc=${JSON.stringify(doc.recoveryComment)}`); return; }
    if (res.status === 'md5-mismatch') s.mismatch++;
    else if (res.status === 'equorum') s.equorum++;
    else if (res.status === 'no-md5') s.noMd5++;
    else { s.error++; if (errorSamples.length < 20) errorSamples.push(`${rec.id} ${res.err}`); }
  };

  const cur = C.find({ isFile: true, recoveryComment: { $exists: true } }).batchSize(500).addCursorFlag('noCursorTimeout', true);
  const inflight = new Set();
  for await (const doc of cur) {
    if (s.objs >= LIMIT) break; s.objs++;
    const p = handle(doc).catch(e => { s.error++; console.error('handle', doc._id.toString(), e && (e.message)); }).finally(() => inflight.delete(p));
    inflight.add(p);
    if (inflight.size >= CONC) await Promise.race(inflight);
    if (s.objs % 500 === 0) console.log(`  ...${s.objs} | recoverable ${s.recoverable} equorum ${s.equorum} mismatch ${s.mismatch} noMd5 ${s.noMd5} error ${s.error}`);
  }
  await Promise.all(inflight);

  console.log('\n=== DEAD-SET RE-CLASSIFICATION ===');
  console.log(JSON.stringify(s, null, 1));
  console.log(`\n*** RECOVERABLE (must be EXCLUDED from kill): ${recoverableList.length}`);
  for (const r of recoverableList) console.log('  ', r);
  if (errorSamples.length) { console.log('\nerror samples (could not classify -> also exclude):'); for (const e of errorSamples) console.log('  ', e); }
  await client.close();
  process.exit(0);
})().catch(e => { console.error('FATAL', e.stack || e.message); process.exit(1); });
