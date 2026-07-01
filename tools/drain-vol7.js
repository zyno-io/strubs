#!/usr/bin/env node
'use strict';
// Phase 2 of the vol 7 (sdm) drain. Source = the holding copy on vol 51 (rsync'd off sdm).
// For each object still referencing vol 7: pick the emptiest ELIGIBLE destination volume the
// object doesn't already use, COPY the slice from holding, VERIFY its chunk checksums, and only
// then flip the ref 7->dest (conditional). Keep the holding copy + sdm originals as backups.
//
//   node tools/drain-vol7.js            # DRY RUN: placement plan + capacity feasibility, no changes
//   node tools/drain-vol7.js --apply    # execute (resumable: re-run processes whatever still refs 7)
//
// Eligible target = started + healthy + writable + has room, NOT failing/drained (7,31,47),
// NOT already in the object's 6 volumes. Verify-before-flip prevents propagating a bad copy
// (the gap that let 6449ae6c.1 slip through on the vol 31 re-home).

const fs = require('fs');
const cp = require('child_process');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');

const APPLY = process.argv.includes('--apply');
const FH = 48, CH = 16, MR = '/run/strubs/mounts';
const HOLD = `${MR}/37bc0249-a0e6-48d7-8b34-d448437b93ba/evac-vol7/strubs`;  // vol51 holding
const SRC_VOL = 7;
const EXCLUDE = new Set([7, 31, 47]);           // failing / drained
const MIN_FREE = 50 * 1e9;                        // keep >=50GB headroom per target
const shard = id => `${id.substring(0,2)}/${id.substring(2,4)}/${id.substring(4,6)}`;
function layout(sz, cs) { const o=[]; if(sz<=cs){o.push({h:FH,d:FH+CH,l:sz-FH-CH});return o;} o.push({h:FH,d:FH+CH,l:cs-FH-CH}); let off=cs; while(off<sz){const s=Math.min(cs,sz-off);o.push({h:off,d:off+CH,l:s-CH});off+=s;} return o; }
function verifyChecksums(path, cs) { let sz; try{sz=fs.statSync(path).size;}catch{return false;} const fd=fs.openSync(path,'r'); const lay=layout(sz,cs); let ok=true;
  for(const k of [...new Set([0,1,Math.floor(lay.length/2),lay.length-1])]){const c=lay[k];if(!c||c.l<=0)continue;const hb=Buffer.alloc(CH),db=Buffer.alloc(c.l);fs.readSync(fd,hb,0,CH,c.h);fs.readSync(fd,db,0,c.l,c.d);if(!crypto.createHash('md5').update(db).digest().equals(hb)){ok=false;break;}}
  fs.closeSync(fd); return ok; }

(async () => {
  const client = await MongoClient.connect(process.env.STRUBS_MONGO_URL || 'mongodb://strubs:strubs@127.0.0.1:27017/strubs?authSource=admin');
  const C = client.db('strubs').collection('content');
  const V = client.db('strubs').collection('volumes');
  console.log(`MODE ${APPLY ? 'APPLY' : 'DRY RUN'}`);

  // eligible targets: not deleted, healthy, not excluded, mounted with room
  const targets = [];
  for (const v of await V.find({}).toArray()) {
    if (v.is_deleted || v.healthy === false || EXCLUDE.has(v.id)) continue;
    const mp = `${MR}/${v.uuid}`; let total = 0, free = 0;
    try { const [t, a] = cp.execSync(`df -B1 --output=size,avail ${mp}/strubs 2>/dev/null | tail -1`).toString().trim().split(/\s+/).map(Number); total = t; free = a; } catch {}
    if (!Number.isFinite(free) || !total || free <= MIN_FREE) continue;   // skip offline (NaN) / full
    targets.push({ id: v.id, mount: `${mp}/strubs`, total, free });
  }
  console.log(`eligible targets: ${targets.map(t=>t.id+':'+(t.free/1e12).toFixed(1)+'T').join(' ')}`);

  // Spread by FILL RATIO: place onto the lowest used/capacity target the object doesn't already use.
  // This balances fill % across the heterogeneous pool rather than piling onto the biggest-free disks.
  const pickDest = (objVols, sliceBytes) => {
    let best = null, bestFill = Infinity;
    for (const t of targets) { if (objVols.has(t.id)) continue; if (t.free < sliceBytes + MIN_FREE) continue;
      const fill = (t.total - t.free) / t.total; if (fill < bestFill) { bestFill = fill; best = t; } }
    return best;
  };

  const s = { objs:0, placed:0, noDest:0, srcMissing:0, copyErr:0, verifyFail:0, refMatched:0, byDest:{} };
  let batch = [];
  const flush = async () => { if(!APPLY||!batch.length){batch=[];return;} try{const r=await C.bulkWrite(batch,{ordered:false});s.refMatched+=r.matchedCount;}catch(e){console.error('bulk',e.message);} batch=[]; };

  // Slow per-object processing (copy+verify) between getMores can exceed the server's idle
  // cursor timeout -> "cursor id not found". noCursorTimeout keeps it alive; a small batchSize
  // touches the cursor frequently. Resumable anyway: re-running processes whatever still refs 7.
  const cur = C.find({ $or:[{dataVolumes:SRC_VOL},{parityVolumes:SRC_VOL}] }, { projection:{dataVolumes:1,parityVolumes:1,chunkSize:1,sliceSize:1,size:1} })
    .batchSize(500).addCursorFlag('noCursorTimeout', true);
  for await (const d of cur) {
    s.objs++;
    const dv=d.dataVolumes||[], pv=d.parityVolumes||[]; const all=[...dv,...pv]; const idx=all.indexOf(SRC_VOL); if(idx<0) continue;
    const objVols = new Set(all);
    const sliceBytes = d.sliceSize || Math.ceil((d.size||0)/Math.max(1,dv.length)) || 5e6;
    const dest = pickDest(objVols, sliceBytes);
    if (!dest) { s.noDest++; continue; }
    s.byDest[dest.id] = (s.byDest[dest.id]||0)+1;
    if (!APPLY) { s.placed++; dest.free -= sliceBytes; continue; }
    const id = d._id.toString(); const file = `${id}.${idx}`;
    const src = `${HOLD}/${shard(id)}/${file}`;
    if (!fs.existsSync(src)) { s.srcMissing++; continue; }       // unreadable on sdm during evac -> needs reconstruct
    const dstDir = `${dest.mount}/${shard(id)}`; const dst = `${dstDir}/${file}`;
    try { fs.mkdirSync(dstDir,{recursive:true}); if(!fs.existsSync(dst)) fs.copyFileSync(src, dst); }
    catch(e){ s.copyErr++; if(s.copyErr<=10)console.error('copy',id,e.message); continue; }
    if (!verifyChecksums(dst, d.chunkSize)) { s.verifyFail++; try{fs.unlinkSync(dst);}catch{} continue; }  // bad copy -> drop, leave ref on 7
    dest.free -= sliceBytes;
    // conditional flip: 7 present, dest absent from all 6
    batch.push({ updateOne: { filter:{ _id:d._id, $or:[{dataVolumes:SRC_VOL},{parityVolumes:SRC_VOL}], dataVolumes:{$ne:dest.id}, parityVolumes:{$ne:dest.id} }, update:{ $set:{ 'dataVolumes.$[e]':dest.id, 'parityVolumes.$[e]':dest.id } }, arrayFilters:[{e:SRC_VOL}] } });
    s.placed++;
    if (batch.length>=2000) await flush();
    if (s.objs % 50000 === 0) console.log(`  ...${s.objs} objs, ${s.placed} placed`);
  }
  await flush();
  console.log('\nRESULT', JSON.stringify(s.byDest), '\n', JSON.stringify({objs:s.objs,placed:s.placed,noDest:s.noDest,srcMissing:s.srcMissing,copyErr:s.copyErr,verifyFail:s.verifyFail,refMatched:s.refMatched}));
  if (s.noDest) console.log(`WARNING: ${s.noDest} objects had NO eligible destination (constraint/capacity).`);
  await client.close();
})().catch(e => { console.error('FATAL', e.stack||e.message); process.exit(1); });
