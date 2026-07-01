#!/usr/bin/env node
'use strict';
// Hybrid re-home of vol 31 (sdaf, retiring) slices. Two modes run IN PARALLEL on
// independent disks:
//   --mode nonoverlap : objects WITHOUT a vol40 slice -> RENAME holding-copy slice into
//                       vol40 (/strubs on sdd, same fs = instant). ref 31->40.
//   --mode overlap    : objects that ALREADY have a vol40 slice -> COPY the slice straight
//                       from sdaf (vol31 source) to vol54/55 (sdac/sdae), split by id. ref 31->54/55.
//                       Leaves the holding copy in place as a 2nd backup (cleanup is separate).
//   --mode cleanup    : delete the leftover (overlap) slices in the holding dir. Run ONLY after
//                       the overlap copy is verified complete.
//
//   node tools/rehome-vol31.js --mode <m>           # dry run (counts only)
//   node tools/rehome-vol31.js --mode <m> --apply   # execute (resumable)
//
// vol 31's originals on sdaf are untouched by nonoverlap/overlap (overlap only READS them),
// so sdaf stays a full backup until explicitly retired. Move/copy file FIRST, then flip ref;
// the original always exists, so every read is satisfiable throughout.

const fs = require('fs');
const { MongoClient, ObjectId } = require('mongodb');

const APPLY = process.argv.includes('--apply');
const MODE = (process.argv.find(a => a.startsWith('--mode=')) || (process.argv.includes('--mode') ? '--mode='+(process.argv[process.argv.indexOf('--mode')+1]) : '')).split('=')[1];
if (!['nonoverlap', 'overlap', 'cleanup'].includes(MODE)) { console.error('need --mode nonoverlap|overlap|cleanup'); process.exit(1); }

const MROOT = '/run/strubs/mounts';
const HOLD = `${MROOT}/5958d51d-4e5a-4196-ad53-2d1d6c6d7957/evac-vol31/strubs`;
const SDAF = `${MROOT}/80731fe6-ba4c-4dce-8afb-767e08d89a85/strubs`;            // vol31 source (read-only)
const DEST = {
  40: `${MROOT}/5958d51d-4e5a-4196-ad53-2d1d6c6d7957/strubs`,
  54: `${MROOT}/4e56cc9a-13fa-4a83-8cca-d0e9281adbfc/strubs`,
  55: `${MROOT}/3629b622-a45d-42e5-bf4a-9dd98d7cf690/strubs`
};
const shardDir = id => `${id.substring(0,2)}/${id.substring(2,4)}/${id.substring(4,6)}`;
const overlapDest = id => (parseInt(id.slice(-1), 16) % 2 === 0 ? 54 : 55);

function* walk(root) {
  for (const a of fs.readdirSync(root)) { const pa = `${root}/${a}`;
    let sa; try { sa = fs.statSync(pa); } catch { continue; } if (!sa.isDirectory()) continue;
    for (const b of fs.readdirSync(pa)) { const pb = `${pa}/${b}`; if (!fs.statSync(pb).isDirectory()) continue;
      for (const c of fs.readdirSync(pb)) { const pc = `${pb}/${c}`; if (!fs.statSync(pc).isDirectory()) continue;
        for (const f of fs.readdirSync(pc)) yield { file: f, dir: pc };
      }
    }
  }
}

(async () => {
  const client = await MongoClient.connect(process.env.STRUBS_MONGO_URL || 'mongodb://strubs:strubs@127.0.0.1:27017/strubs?authSource=admin');
  const C = client.db('strubs').collection('content');
  console.log(`MODE=${MODE} ${APPLY ? 'APPLY' : 'DRY'}`);

  // overlap map: id -> slice index where vol31 sits (so overlap mode needs NO holding walk,
  // decoupling it from nonoverlap's concurrent renames). Set of ids drives nonoverlap membership.
  const overlapIdx = new Map();
  for await (const d of C.find({ $and: [ { $or:[{dataVolumes:31},{parityVolumes:31}] }, { $or:[{dataVolumes:40},{parityVolumes:40}] } ] }, { projection:{dataVolumes:1,parityVolumes:1} })) {
    const idx = [...(d.dataVolumes||[]), ...(d.parityVolumes||[])].indexOf(31);
    if (idx >= 0) overlapIdx.set(d._id.toString(), idx);
  }
  console.log(`overlap set: ${overlapIdx.size}`);

  const s = { seen:0, acted:0, skippedDone:0, ioErr:0, refMatched:0 };
  let batch = [];
  const flush = async () => {
    if (!APPLY || !batch.length) { batch = []; return; }
    try { const r = await C.bulkWrite(batch, { ordered:false }); s.refMatched += r.matchedCount; } catch (e) { console.error('bulk err', e.message); }
    batch = [];
  };
  const queueRef = (id, dest) => { let oid; try { oid = new ObjectId(id); } catch { return; }
    batch.push({ updateOne: { filter:{_id:oid}, update:{ $set:{ 'dataVolumes.$[e]':dest, 'parityVolumes.$[e]':dest } }, arrayFilters:[{e:31}] } }); };

  if (MODE === 'overlap') {
    // iterate the DB overlap set directly; copy each slice from sdaf -> 54/55. No holding access.
    for (const [id, idx] of overlapIdx) {
      s.seen++;
      const dest = overlapDest(id); const file = `${id}.${idx}`;
      if (!APPLY) { s.acted++; continue; }
      const dstDir = `${DEST[dest]}/${shardDir(id)}`; const dst = `${dstDir}/${file}`;
      try {
        if (fs.existsSync(dst)) { s.skippedDone++; }
        else { fs.mkdirSync(dstDir, { recursive:true }); fs.copyFileSync(`${SDAF}/${shardDir(id)}/${file}`, dst); s.acted++; }
      } catch (e) { s.ioErr++; if (s.ioErr<=12) console.error('io', id, e.message); continue; }
      queueRef(id, dest); if (batch.length >= 2000) await flush();
      if (s.seen % 20000 === 0) console.log(`  ...${s.seen} seen, ${s.acted} copied, ${s.skippedDone} done`);
    }
  } else {
    // nonoverlap / cleanup walk the holding tree
    for (const { file, dir } of walk(HOLD)) {
      const id = file.slice(0, file.lastIndexOf('.'));
      const isOv = overlapIdx.has(id);
      if (MODE === 'cleanup') { s.seen++; if (isOv) { s.acted++; if (APPLY) { try { fs.unlinkSync(`${dir}/${file}`); } catch {} } } continue; }
      if (isOv) continue; // nonoverlap skips overlap files (overlap mode handles them from sdaf)
      s.seen++;
      if (!APPLY) { s.acted++; continue; }
      const dstDir = `${DEST[40]}/${shardDir(id)}`;
      try { fs.mkdirSync(dstDir, { recursive:true }); fs.renameSync(`${dir}/${file}`, `${dstDir}/${file}`); s.acted++; }
      catch (e) { s.ioErr++; if (s.ioErr<=12) console.error('io', id, e.message); continue; }
      queueRef(id, 40); if (batch.length >= 2000) await flush();
      if (s.seen % 100000 === 0) console.log(`  ...${s.seen} renamed`);
    }
  }
  await flush();
  console.log('RESULT', JSON.stringify(s));
  await client.close();
})().catch(e => { console.error('FATAL', e.stack||e.message); process.exit(1); });
