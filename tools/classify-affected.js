#!/usr/bin/env node
'use strict';
// DIAGNOSTIC (read-only): random-sample affected objects fleet-wide and classify each
// flagged slice into a remediation bucket. No DB writes.
//   node tools/classify-affected.js [sampleObjs]
const fs = require('fs');
const crypto = require('crypto');
const { MongoClient, ObjectId } = require('mongodb');
const FH = 48, CH = 16, MR = '/run/strubs/mounts';
const shard = id => `${id.substring(0,2)}/${id.substring(2,4)}/${id.substring(4,6)}`;
function layout(sz, cs){const o=[];if(sz<=cs){o.push({h:FH,d:FH+CH,l:sz-FH-CH});return o;}o.push({h:FH,d:FH+CH,l:cs-FH-CH});let off=cs;while(off<sz){const s=Math.min(cs,sz-off);o.push({h:off,d:off+CH,l:s-CH});off+=s;}return o;}
function dataHashesOk(path, cs){let sz;try{sz=fs.statSync(path).size;}catch{return null;}if(!(cs>FH+CH))return null;const fd=fs.openSync(path,'r');const lay=layout(sz,cs);let ok=true,n=0;try{for(const k of [...new Set([0,1,Math.floor(lay.length/2),lay.length-1])]){const c=lay[k];if(!c||c.l<=0)continue;const hb=Buffer.alloc(CH),db=Buffer.alloc(c.l);fs.readSync(fd,hb,0,CH,c.h);fs.readSync(fd,db,0,c.l,c.d);n++;if(!crypto.createHash('md5').update(db).digest().equals(hb)){ok=false;break;}}}finally{fs.closeSync(fd);}return n?ok:null;}

(async () => {
  const N = parseInt(process.argv[2] || '1500', 10);
  const client = await MongoClient.connect(process.env.STRUBS_MONGO_URL || 'mongodb://strubs:strubs@127.0.0.1:27017/strubs?authSource=admin');
  const C = client.db('strubs').collection('content');
  const V = client.db('strubs').collection('volumes');
  const vmap = new Map();
  for (const v of await V.find({}).toArray()) vmap.set(v.id, { mount:`${MR}/${v.uuid}/strubs`, online: fs.existsSync(`${MR}/${v.uuid}/strubs`) });

  const docs = await C.aggregate([{ $match:{ isFile:true, sliceErrors:{$exists:true} } }, { $sample:{ size:N } },
    { $project:{ dataVolumes:1, parityVolumes:1, chunkSize:1, sliceErrors:1 } }]).toArray();

  const bucket = { restampable:0, dataBad:0, volUnavail:0, fileMissing:0, ioErr:0, idResolvesReal:0, sampledSlices:0 };
  const objClass = { allRestampable:0, hasDataBad:0, hasVolUnavail:0, mixed:0 };
  const realIdCache = new Map();
  let shown = 0;
  for (const d of docs) {
    const id = d._id.toString(); const idBuf = Buffer.from(id,'hex');
    const all = [...(d.dataVolumes||[]), ...(d.parityVolumes||[])];
    let oRe=0,oBad=0,oUn=0;
    for (const k of Object.keys(d.sliceErrors||{})) {
      const idx = parseInt(k,10); bucket.sampledSlices++;
      const v = vmap.get(all[idx]);
      if (!v || !v.online) { bucket.volUnavail++; oUn++; continue; }
      const path = `${v.mount}/${shard(id)}/${id}.${idx}`;
      let fd; try{fd=fs.openSync(path,'r');}catch(e){ if(e.code==='ENOENT'){bucket.fileMissing++;}else{bucket.ioErr++;} continue; }
      const buf=Buffer.alloc(FH); let br=0; try{br=fs.readSync(fd,buf,0,FH,0);}catch{} fs.closeSync(fd);
      if(br!==FH){bucket.ioErr++;continue;}
      const diskCS = buf.readIntLE(43,3);
      const hash = dataHashesOk(path, diskCS>FH+CH?diskCS:d.chunkSize);
      if (hash===false){ bucket.dataBad++; oBad++; if(shown<20){shown++;console.log(`DATA-BAD ${id}.${idx} vol=${all[idx]}`);} continue; }
      // data ok (or n/a) -> re-stampable header fix
      bucket.restampable++; oRe++;
      const diskHex = buf.subarray(23,35).toString('hex');
      if(/^[0-9a-f]{24}$/.test(diskHex) && !realIdCache.has(diskHex)){ realIdCache.set(diskHex, !!(await C.findOne({_id:new ObjectId(diskHex)},{projection:{_id:1}}))); }
      if(realIdCache.get(diskHex)) bucket.idResolvesReal++;
    }
    if(oBad) objClass.hasDataBad++; else if(oUn && !oRe) objClass.hasVolUnavail++; else if(oUn && oRe) objClass.mixed++; else objClass.allRestampable++;
  }
  console.log(`\nsampled objects: ${docs.length}, flagged slices: ${bucket.sampledSlices}`);
  console.log('flagged-slice buckets:', JSON.stringify(bucket,null,1));
  console.log('object classification:', JSON.stringify(objClass,null,1));
  await client.close();
})().catch(e=>{console.error('FATAL',e.stack||e.message);process.exit(1);});
