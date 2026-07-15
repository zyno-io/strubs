#!/usr/bin/env node
'use strict';
// PARITY VERIFICATION -- the check nothing else does. For each object it reads the STORED parity and the
// data through the app's REAL codec, recomputes the correct parity from the data, and compares. A
// foreign/bad parity slice (self-consistent -- valid header + chunk checksums -- but encoding the wrong
// data, the 2026-06 incident failure mode) shows up as a mismatch. Read-only; writes NOTHING.
//   node tools/parity-verify.js                 # full array
//   node tools/parity-verify.js --limit 5000
//   node tools/parity-verify.js --conc 12
// Run from /opt/strubs (dotenv + dist/ resolve relative to cwd). UV_THREADPOOL_SIZE=32 recommended.

const fs = require('fs');
const { MongoClient } = require('mongodb');

const { Volume } = require('../dist/lib/io/volume');
const { volumeFleet } = require('../dist/lib/io/volume-fleet');
const { FileObject } = require('../dist/lib/io/file-object');
const { FileObjectReader } = require('../dist/lib/io/file-object/reader');

const LIMIT = (() => { const i = process.argv.indexOf('--limit'); return i >= 0 ? parseInt(process.argv[i + 1], 10) : Infinity; })();
const CONC = (() => { const i = process.argv.indexOf('--conc'); return i >= 0 ? parseInt(process.argv[i + 1], 10) : 8; })();
const SAMPLE = (() => { const i = process.argv.indexOf('--sample'); return i >= 0 ? parseInt(process.argv[i + 1], 10) : 0; })();
const MR = '/run/strubs/mounts';
const DEAD = new Set([34, 7, 43]); // offline/dead vols -> their slices are erasures
const md5Of = doc => (doc && doc.md5 && doc.md5.buffer) ? doc.md5.buffer : (doc ? doc.md5 : null);

(async () => {
  const client = await MongoClient.connect(process.env.STRUBS_MONGO_URL || 'mongodb://strubs:strubs@127.0.0.1:27017/strubs?authSource=admin');
  const db = client.db('strubs');
  const C = db.collection('content');
  console.log(`MODE READ-ONLY (parity verification)  conc=${CONC}`);

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

  const verifyParity = async (rec) => {
    const fo = new FileObject(); await fo.loadFromRecord(rec);
    const reader = new FileObjectReader(fo);
    try {
      await reader.prepare();
      let mismatched = 0, missing = 0, incomplete = 0;
      for (let r; (r = await reader.verifyChunkSetParity()) !== null; ) {
        mismatched += r.mismatched.length;
        missing += r.missing.length;
        if (r.dataIncomplete) incomplete++;
      }
      if (mismatched > 0) return { status: 'bad-parity', mismatched };
      if (incomplete > 0) return { status: 'data-incomplete' }; // couldn't fully verify (missing data slice)
      if (missing > 0) return { status: 'parity-missing', missing };
      return { status: 'ok' };
    } catch (e) { return { status: e && e.code === 'EQUORUM' ? 'equorum' : 'error', err: e && (e.code || e.message) }; }
    finally { await reader.close().catch(() => {}); }
  };

  const s = { objs: 0, ok: 0, badParity: 0, parityMissing: 0, dataIncomplete: 0, equorum: 0, noMd5: 0, error: 0 };
  const badSamples = [];

  const handle = async (doc) => {
    if (!doc.md5) { s.noMd5++; return; }
    const res = await verifyParity(recToObj(doc));
    if (res.status === 'ok') s.ok++;
    else if (res.status === 'bad-parity') { s.badParity++; if (badSamples.length < 40) badSamples.push(`${recToObj(doc).id} mismatched=${res.mismatched} dv=[${doc.dataVolumes}] pv=[${doc.parityVolumes}]`); }
    else if (res.status === 'parity-missing') s.parityMissing++;
    else if (res.status === 'data-incomplete') s.dataIncomplete++;
    else if (res.status === 'equorum') s.equorum++;
    else s.error++;
  };

  const proj = { dataVolumes: 1, parityVolumes: 1, chunkSize: 1, size: 1, md5: 1, name: 1, containerId: 1 };
  const cur = SAMPLE > 0
    ? C.aggregate([{ $match: { isFile: true } }, { $sample: { size: SAMPLE } }, { $project: proj }], { allowDiskUse: true }).batchSize(500)
    : C.find({ isFile: true }, { projection: proj }).batchSize(500).addCursorFlag('noCursorTimeout', true);
  if (SAMPLE > 0) console.log(`RANDOM SAMPLE of ${SAMPLE} objects`);
  const inflight = new Set();
  for await (const doc of cur) {
    if (s.objs >= LIMIT) break; s.objs++;
    const p = handle(doc).catch(e => { s.error++; console.error('handle', doc._id.toString(), e && (e.stack || e.message)); }).finally(() => inflight.delete(p));
    inflight.add(p);
    if (inflight.size >= CONC) await Promise.race(inflight);
    if (s.objs % 2000 === 0) console.log(`  ...${s.objs} | ok ${s.ok} BAD-PARITY ${s.badParity} parity-missing ${s.parityMissing} data-incomplete ${s.dataIncomplete} equorum ${s.equorum}`);
  }
  await Promise.all(inflight);

  console.log('\n=== PARITY VERIFY RESULT ===');
  console.log(JSON.stringify(s, null, 1));
  if (badSamples.length) { console.log('\n*** BAD PARITY (recomputed != stored) samples:'); for (const b of badSamples) console.log('  ', b); }
  await client.close();
  process.exit(0);
})().catch(e => { console.error('FATAL', e.stack || e.message); process.exit(1); });
