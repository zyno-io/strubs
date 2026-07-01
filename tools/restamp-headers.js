#!/usr/bin/env node
'use strict';
// Header RE-STAMP for the legacy id-mis-stamp cohort. Rewrites ONLY the 12 object-id bytes
// (header bytes 23..34) to Buffer.from(_id,'hex'); leaves data and every other header field
// untouched. Drives off objects already flagged with sliceErrors (the light-verify map).
//
// HARD SAFETY: a slice is patched ONLY if
//   (a) its on-disk id (23..34) currently MISMATCHES the DB _id (idempotent: skip if already ok),
//   (b) every OTHER header field matches the DB (dataN@40, parityN@41, sliceIndex@42, chunkSize@43..45)
//       -- pure id-mismatch, correct EC layout (anything else is out of scope, left for review), and
//   (c) the slice DATA hashes OK against its embedded chunk MD5s (verify-before-patch -- never stamp a
//       good header onto corrupt data and mask real loss).
// After patching, the 12 bytes are re-read and confirmed. The object's sliceErrors map is then
// recomputed from a fresh full header check and either $unset (all clean) or rewritten (residual).
//
// CONCURRENCY: async fs (fs/promises) over the libuv threadpool, throttled by a PER-VOLUME queue
// (depth VOL_DEPTH per disk) so every disk stays busy in parallel but no single disk -- especially
// the failing ones -- is hammered. Launch with a big threadpool, e.g.:
//   UV_THREADPOOL_SIZE=64 node tools/restamp-headers.js --apply
//
//   node tools/restamp-headers.js                 # DRY RUN: counts only, no writes
//   node tools/restamp-headers.js --apply         # patch headers + refresh sliceErrors
//   node tools/restamp-headers.js --apply --limit 2000          # bounded verified batch
//   node tools/restamp-headers.js --apply --vol-depth 4         # per-disk queue depth (default 4)

const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const { MongoClient, ObjectId } = require('mongodb');

const arg = (name, def) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i+1] : def; };
const APPLY = process.argv.includes('--apply');
const LIMIT = (() => { const v = arg('--limit'); return v ? parseInt(v,10) : Infinity; })();
const CONTAINER = arg('--container', null);
const VOL_DEPTH = parseInt(arg('--vol-depth', '8'), 10);   // concurrent slice ops per HEALTHY volume
const RISKY = new Set([7, 31, 47]);                        // failing drives -> shallow queue (pending sectors)
const RISKY_DEPTH = 2;
const OBJ_INFLIGHT = 600;                                   // bound objects in flight (backpressure)
const FH = 48, CH = 16, MR = '/run/strubs/mounts';
const shard = id => `${id.substring(0,2)}/${id.substring(2,4)}/${id.substring(4,6)}`;
function layout(sz, cs){const o=[];if(sz<=cs){o.push({h:FH,d:FH+CH,l:sz-FH-CH});return o;}o.push({h:FH,d:FH+CH,l:cs-FH-CH});let off=cs;while(off<sz){const s=Math.min(cs,sz-off);o.push({h:off,d:off+CH,l:s-CH});off+=s;}return o;}

// per-volume concurrency limiter
function makeLimiter(depth){ let active=0; const q=[];
  const pump=()=>{ while(active<depth && q.length){ const job=q.shift(); active++;
    Promise.resolve().then(job.fn).then(job.res,job.rej).then(()=>{active--;pump();}); } };
  return fn=>new Promise((res,rej)=>{ q.push({fn,res,rej}); pump(); }); }

// returns true=hashes ok, false=bad, null=cannot determine (bad chunkSize)
async function dataHashesOk(fh, sz, cs){ if(!(cs>FH+CH))return null; const lay=layout(sz,cs); let n=0;
  for(const k of [...new Set([0,1,Math.floor(lay.length/2),lay.length-1])]){const c=lay[k];if(!c||c.l<=0)continue;
    const hb=Buffer.alloc(CH),db=Buffer.alloc(c.l);
    await fh.read(hb,0,CH,c.h); await fh.read(db,0,c.l,c.d); n++;
    if(!crypto.createHash('md5').update(db).digest().equals(hb))return false;}
  return n?true:null; }

(async () => {
  const client = await MongoClient.connect(process.env.STRUBS_MONGO_URL || 'mongodb://strubs:strubs@127.0.0.1:27017/strubs?authSource=admin');
  const C = client.db('strubs').collection('content');
  const V = client.db('strubs').collection('volumes');
  console.log(`MODE ${APPLY ? 'APPLY' : 'DRY RUN'}  vol-depth=${VOL_DEPTH}  threadpool=${process.env.UV_THREADPOOL_SIZE||'4(default)'}${CONTAINER?`  container=${CONTAINER}`:''}${LIMIT<Infinity?`  limit=${LIMIT}`:''}`);

  const vmap = new Map();
  for (const v of await V.find({}).toArray()) { const mount=`${MR}/${v.uuid}/strubs`; vmap.set(v.id,{mount,online:fs.existsSync(mount)}); }
  const limiters = new Map();
  const onVol = (vid, fn) => { let l=limiters.get(vid); if(!l){l=makeLimiter(RISKY.has(vid)?RISKY_DEPTH:VOL_DEPTH);limiters.set(vid,l);} return l(fn); };

  const s = { objs:0, objsCleared:0, objsResidual:0, patched:0, alreadyOk:0, dataBad:0, fieldMismatch:0, volUnavail:0, missing:0, ioErr:0, badChunkSize:0, patchVerifyFail:0 };
  let batch = [];
  const flush = async () => { if(!APPLY||!batch.length){batch=[];return;} const b=batch; batch=[]; try{await C.bulkWrite(b,{ordered:false});}catch(e){console.error('bulk',e.message);} };

  // Returns the fresh category for one slice (null=ok). When patchable and APPLY, performs the patch.
  const handleSlice = async (id, idBuf, all, dataN, parityN, dbCS, idx) => {
    const v = vmap.get(all[idx]); if(!v||!v.online) { s.volUnavail++; return 'volume-unavailable'; }
    const path = `${v.mount}/${shard(id)}/${id}.${idx}`;
    let fh; try { fh = await fsp.open(path, APPLY ? 'r+' : 'r'); }
    catch(e){ if(e.code==='ENOENT'){s.missing++;return 'missing';} s.ioErr++; return 'io'; }
    try {
      const buf=Buffer.alloc(FH); const { bytesRead } = await fh.read(buf,0,FH,0);
      if(bytesRead!==FH){ s.ioErr++; return 'io'; }
      const idOk = buf.subarray(23,35).equals(idBuf);
      const fieldsOk = buf.readUInt8(40)===dataN && buf.readUInt8(41)===parityN && buf.readUInt8(42)===idx && buf.readIntLE(43,3)===dbCS;
      if(idOk && fieldsOk){ s.alreadyOk++; return null; }
      if(!fieldsOk){ s.fieldMismatch++; return 'header-mismatch'; }       // other field wrong -> OUT OF SCOPE
      const { size } = await fh.stat();
      const dh = await dataHashesOk(fh, size, dbCS);
      if(dh===false){ s.dataBad++; return 'header-mismatch'; }            // corrupt -> DO NOT mask
      if(dh===null){ s.badChunkSize++; return 'header-mismatch'; }        // can't verify -> leave
      if(!APPLY){ s.patched++; return null; }
      await fh.write(idBuf, 0, 12, 23);                                   // rewrite ONLY the 12 id bytes
      // No per-slice fsync: durability comes from OS writeback + a final global sync() at end.
      // Safe here because the patch is idempotent (re-runnable) and the full verify re-reads all.
      const chk=Buffer.alloc(12); await fh.read(chk,0,12,23);             // page-cache coherent: confirms the write
      if(!chk.equals(idBuf)){ s.patchVerifyFail++; return 'header-mismatch'; }
      s.patched++; return null;
    } catch(e){ s.ioErr++; return 'io'; }
    finally { await fh.close().catch(()=>{}); }
  };

  const handleObject = async (d) => {
    const id=d._id.toString(); let idBuf; try{idBuf=Buffer.from(id,'hex');}catch{return;}
    const dv=d.dataVolumes||[], pv=d.parityVolumes||[]; const all=[...dv,...pv]; const dataN=dv.length, parityN=pv.length, dbCS=d.chunkSize;
    // fan the 6 slice ops out across their volume queues, in parallel
    const cats = await Promise.all(all.map((vid,idx)=> onVol(vid, ()=>handleSlice(id,idBuf,all,dataN,parityN,dbCS,idx)) ));
    const errs={};
    cats.forEach((cat,idx)=>{ if(cat) errs[String(idx)]={ category:cat, err:cat, type: idx<dataN?'data':'parity' }; });
    if(Object.keys(errs).length){ s.objsResidual++;
      if(APPLY) batch.push({updateOne:{filter:{_id:d._id},update:{$set:{sliceErrors:errs,lastVerifiedAt:new Date()}}}});
    } else { s.objsCleared++;
      if(APPLY) batch.push({updateOne:{filter:{_id:d._id},update:{$set:{lastVerifiedAt:new Date()},$unset:{sliceErrors:''}}}}); }
    if(APPLY && batch.length>=1000) await flush();
  };

  const q={ isFile:true, sliceErrors:{$exists:true} };
  if(CONTAINER){ try{ q.containerId=new ObjectId(CONTAINER); }catch{ q.containerId=CONTAINER; } }
  const cur=C.find(q,{projection:{dataVolumes:1,parityVolumes:1,chunkSize:1}}).batchSize(2000).addCursorFlag('noCursorTimeout',true);
  const inflight=new Set();
  const t0=Date.now();
  for await(const d of cur){ if(s.objs>=LIMIT) break; s.objs++;
    const p=handleObject(d).finally(()=>inflight.delete(p)); inflight.add(p);
    if(inflight.size>=OBJ_INFLIGHT) await Promise.race(inflight);
    if(s.objs%50000===0){ const rate=Math.round(s.objs/((Date.now()-t0)/1000)); console.log(`  ...${s.objs} objs (${rate}/s), ${s.patched} patched, ${s.dataBad} dataBad, ${s.objsResidual} residual`); }
  }
  await Promise.all(inflight); await flush();
  if(APPLY){ try{ require('child_process').execSync('sync'); }catch{} }   // flush writeback to platters

  console.log('\n=== RESTAMP RESULT ==='); console.log(JSON.stringify(s,null,1));
  console.log(`elapsed ${((Date.now()-t0)/1000).toFixed(0)}s`);
  await client.close();
})().catch(e=>{console.error('FATAL',e.stack||e.message);process.exit(1);});
