#!/usr/bin/env node
'use strict';
// Drop the full-verify "corrupt" objects (2021 telephony recordings, unrecoverable) -- their slice
// files AND their content records. DESTRUCTIVE + IRREVERSIBLE.
// HARD GUARDS (abort the WHOLE run, delete nothing, if any fails):
//   - every target must be a telephony recording (extension in ALLOWED_EXT)
//   - the target set must be exactly EXPECTED_COUNT objects, all with verifyStatus:'corrupt'
// Writes a manifest of everything removed before deleting. Slices deleted first (logged), then the
// record (conditional on still being verifyStatus:'corrupt').
//   node tools/drop-corrupt.js            # DRY RUN: manifest + guard check, deletes nothing
//   node tools/drop-corrupt.js --apply    # delete slice files + content records

const fs = require('fs');
const { MongoClient } = require('mongodb');
const APPLY = process.argv.includes('--apply');
const MR = '/run/strubs/mounts';
const ALLOWED_EXT = new Set(['G722', 'PCMU', 'PCMA', 'G729']);   // telephony codecs only
const EXPECTED_COUNT = 33;
const shard = id => `${id.substring(0,2)}/${id.substring(2,4)}/${id.substring(4,6)}`;
const MANIFEST = `/tmp/dropped-corrupt-${Date.now ? 'run' : 'run'}.json`;

(async () => {
  const client = await MongoClient.connect(process.env.STRUBS_MONGO_URL || 'mongodb://strubs:strubs@127.0.0.1:27017/strubs?authSource=admin');
  const C = client.db('strubs').collection('content'), V = client.db('strubs').collection('volumes');
  const vmap = new Map(); for (const v of await V.find({}).toArray()) vmap.set(v.id, { uuid: v.uuid, online: fs.existsSync(`${MR}/${v.uuid}/strubs`) });

  const docs = await C.find({ isFile: true, verifyStatus: 'corrupt' }).toArray();
  console.log(`MODE ${APPLY ? 'APPLY (DELETE)' : 'DRY RUN'}`);
  console.log(`targets (verifyStatus:corrupt): ${docs.length}`);

  // ---- HARD GUARDS ----
  const problems = [];
  if (docs.length !== EXPECTED_COUNT) problems.push(`count ${docs.length} != expected ${EXPECTED_COUNT}`);
  for (const d of docs) {
    const ext = String(d.name || '').split('.').pop().toUpperCase();
    if (!ALLOWED_EXT.has(ext)) problems.push(`${d._id} not telephony (name="${d.name}", ext="${ext}")`);
    if (d.verifyStatus !== 'corrupt') problems.push(`${d._id} verifyStatus=${d.verifyStatus}`);
  }
  if (problems.length) { console.error('\nABORT -- guard failed, deleting NOTHING:'); for (const p of problems) console.error('  ' + p); await client.close(); process.exit(1); }
  console.log('guards PASS: all telephony recordings, exact expected count.\n');

  // ---- build manifest ----
  const manifest = [];
  for (const d of docs) {
    const id = d._id.toHexString(); const all = [...(d.dataVolumes || []), ...(d.parityVolumes || [])];
    const slices = all.map((vol, idx) => { const vi = vmap.get(vol); const path = vi ? `${MR}/${vi.uuid}/strubs/${shard(id)}/${id}.${idx}` : null;
      return { idx, vol, online: vi ? vi.online : false, path, exists: path ? fs.existsSync(path) : false }; });
    manifest.push({ id, name: d.name, size: d.size, mime: d.mime, containerId: d.containerId && d.containerId.toString(), dataVolumes: d.dataVolumes, parityVolumes: d.parityVolumes, slices });
  }
  const totalSlices = manifest.reduce((n, m) => n + m.slices.length, 0);
  const present = manifest.reduce((n, m) => n + m.slices.filter(s => s.exists).length, 0);
  const offline = manifest.reduce((n, m) => n + m.slices.filter(s => !s.online).length, 0);
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 1));
  console.log(`manifest -> ${MANIFEST}`);
  console.log(`objects: ${manifest.length} | slice files: ${totalSlices} (present on disk: ${present}, on offline vols: ${offline})`);
  console.log('sample:'); for (const m of manifest.slice(0, 5)) console.log(`  ${m.id} ${m.name} (${m.size}B) slices ${m.slices.map(s => s.vol + (s.exists ? '' : s.online ? '?MISSING' : '!offline')).join(',')}`);

  if (!APPLY) { console.log('\nDRY RUN -- nothing deleted. Re-run with --apply to delete.'); await client.close(); process.exit(0); }

  // ---- delete: slices first (logged), then the record (conditional) ----
  let filesDeleted = 0, filesMissing = 0, fileErr = 0, recsDeleted = 0, recSkipped = 0;
  for (const m of manifest) {
    for (const sl of m.slices) {
      if (!sl.path) { continue; }
      try { fs.unlinkSync(sl.path); filesDeleted++; }
      catch (e) { if (e.code === 'ENOENT') filesMissing++; else { fileErr++; console.error(`  unlink FAIL ${sl.path}: ${e.code}`); } }
    }
    const r = await C.deleteOne({ _id: docs.find(d => d._id.toHexString() === m.id)._id, verifyStatus: 'corrupt' });
    if (r.deletedCount === 1) recsDeleted++; else recSkipped++;
  }
  console.log(`\n=== DROP RESULT ===`);
  console.log(`slice files: deleted ${filesDeleted}, already-missing ${filesMissing}, errors ${fileErr}`);
  console.log(`content records: deleted ${recsDeleted}, skipped ${recSkipped}`);
  const remain = await C.countDocuments({ isFile: true, verifyStatus: 'corrupt' });
  console.log(`verifyStatus:corrupt remaining: ${remain}`);
  console.log(`manifest of removed objects preserved at ${MANIFEST}`);
  await client.close(); process.exit(0);
})().catch(e => { console.error('FATAL', e.stack || e.message); process.exit(1); });
