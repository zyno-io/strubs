#!/usr/bin/env node
'use strict';
// DIAGNOSTIC (read-only): for the vol-34 unrecoverable cluster, measure whether parity corruption
// is PER-CHUNK or WHOLE-SLICE. For a sample of still-flagged objects, read each parity slice
// (vols 47/48) chunk-by-chunk, verify each chunk's 16-byte MD5, and report:
//   - per parity slice: chunks OK / total (is the whole slice bad, or only some chunks?)
//   - per-chunk recoverability of the MISSING data slice: reconstructable at chunk i iff the 3
//     surviving data slices are good AND >=1 parity chunk is good at i (4+2 code, 1 data erasure).
//   - whether 47 and 48 fail on the SAME chunk indices (combining both parities buys nothing) or
//     DIFFERENT ones (combining helps).
//   node tools/parity-chunk-health.js [sample]

const fs = require('fs');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');
const FH = 48, CH = 16, MR = '/run/strubs/mounts';
const shard = id => `${id.substring(0,2)}/${id.substring(2,4)}/${id.substring(4,6)}`;
function layout(sz, cs){const o=[];if(sz<=cs){o.push({h:FH,d:FH+CH,l:sz-FH-CH});return o;}o.push({h:FH,d:FH+CH,l:cs-FH-CH});let off=cs;while(off<sz){const s=Math.min(cs,sz-off);o.push({h:off,d:off+CH,l:s-CH});off+=s;}return o;}
// returns boolean[] chunkOk per chunk index (null if file missing/unreadable)
function chunkHealth(path, cs){ let sz; try{sz=fs.statSync(path).size;}catch{return null;} const fd=fs.openSync(path,'r'); const lay=layout(sz,cs); const ok=[];
  try{ for(const c of lay){ if(c.l<=0){ok.push(true);continue;} const hb=Buffer.alloc(CH),db=Buffer.alloc(c.l); fs.readSync(fd,hb,0,CH,c.h); fs.readSync(fd,db,0,c.l,c.d); ok.push(crypto.createHash('md5').update(db).digest().equals(hb)); } }
  catch(e){ ok.push(false); } finally{ fs.closeSync(fd); } return ok; }

(async () => {
  const N = parseInt(process.argv[2] || '40', 10);
  const c = await MongoClient.connect(process.env.STRUBS_MONGO_URL || 'mongodb://strubs:strubs@127.0.0.1:27017/strubs?authSource=admin');
  const C = c.db('strubs').collection('content'), V = c.db('strubs').collection('volumes');
  const vmap = new Map(); for (const v of await V.find({}).toArray()) vmap.set(v.id, { mount:`${MR}/${v.uuid}/strubs`, online: fs.existsSync(`${MR}/${v.uuid}/strubs`) });

  const docs = await C.aggregate([{ $match:{ isFile:true, sliceErrors:{$exists:true} } }, { $sample:{ size:N } }]).toArray();
  const agg = { objs:0, chunksTotal:0, pA_ok:0, pB_ok:0, chunkRecoverable:0, dataAllGood:0, dataHasBad:0 };
  const buckets = { '0%':0, '1-25%':0, '25-75%':0, '75-99%':0, '100%':0 };
  let sameFailPairs = 0, diffFailPairs = 0, printed = 0;

  for (const d of docs) {
    const id = d._id.toString(); const dv = d.dataVolumes||[], pv = d.parityVolumes||[]; const dataN = dv.length; const cs = d.chunkSize;
    // parity slices are indices dataN..dataN+parityN-1
    const pAidx = dataN, pBidx = dataN + 1;
    const pAvol = vmap.get(pv[0]), pBvol = vmap.get(pv[1]);
    if (!pAvol || !pBvol) continue;
    const hA = pAvol.online ? chunkHealth(`${pAvol.mount}/${shard(id)}/${id}.${pAidx}`, cs) : null;
    const hB = pBvol.online ? chunkHealth(`${pBvol.mount}/${shard(id)}/${id}.${pBidx}`, cs) : null;
    if (!hA && !hB) continue;
    // surviving data slices health (are the 3 non-vol-34 data slices actually good?)
    let dataGood = true;
    for (let i = 0; i < dataN; i++) { const vol = vmap.get(dv[i]); if (!vol || !vol.online) continue; // the vol-34 one
      const hd = chunkHealth(`${vol.mount}/${shard(id)}/${id}.${i}`, cs); if (hd && hd.some(x => !x)) { dataGood = false; break; } }
    dataGood ? agg.dataAllGood++ : agg.dataHasBad++;

    const n = Math.max(hA?hA.length:0, hB?hB.length:0); agg.objs++; agg.chunksTotal += n;
    let recov = 0, aOk = 0, bOk = 0, sameFail = 0, diffFail = 0;
    for (let i = 0; i < n; i++) { const a = hA ? !!hA[i] : false, b = hB ? !!hB[i] : false;
      if (a) aOk++; if (b) bOk++; if (dataGood && (a || b)) recov++;
      if (!a && !b) sameFail++; else if (a !== b) diffFail++; }
    agg.pA_ok += aOk; agg.pB_ok += bOk; agg.chunkRecoverable += recov;
    if (sameFail > diffFail) sameFailPairs++; else if (diffFail > 0) diffFailPairs++;
    const frac = n ? recov / n : 0;
    buckets[frac===0?'0%':frac<0.25?'1-25%':frac<0.75?'25-75%':frac<0.99?'75-99%':'100%']++;
    if (printed < 20) { printed++; console.log(`${id} chunks=${n} pA(v${pv[0]})=${aOk}/${n} pB(v${pv[1]})=${bOk}/${n} recoverable=${recov}/${n} (${(frac*100).toFixed(0)}%) data=${dataGood?'ok':'BAD'}`); }
  }
  console.log('\n=== PARITY CHUNK HEALTH (sample ' + agg.objs + ' objs) ===');
  console.log(`total chunks: ${agg.chunksTotal}`);
  console.log(`parityA chunks OK: ${agg.pA_ok} (${(agg.pA_ok/agg.chunksTotal*100).toFixed(1)}%)  parityB chunks OK: ${agg.pB_ok} (${(agg.pB_ok/agg.chunksTotal*100).toFixed(1)}%)`);
  console.log(`per-chunk RECOVERABLE (data ok & >=1 parity ok): ${agg.chunkRecoverable} (${(agg.chunkRecoverable/agg.chunksTotal*100).toFixed(1)}%)`);
  console.log(`objects by recoverable-chunk fraction:`, JSON.stringify(buckets));
  console.log(`surviving-data all-good objs: ${agg.dataAllGood}, data-has-bad: ${agg.dataHasBad}`);
  console.log(`parity fail pattern: mostly-SAME-chunks ${sameFailPairs} objs, has-DIFFERENT-chunk-fails ${diffFailPairs} objs`);
  await c.close();
})().catch(e => { console.error('FATAL', e.stack || e.message); process.exit(1); });
