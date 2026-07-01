#!/usr/bin/env node
'use strict';
// DIAGNOSTIC (read-only): sample affected objects and break down WHICH of the five header
// fields mismatches, whether the on-disk id resolves to a real (old) content doc, and whether
// the data still hashes using the ON-DISK chunkSize (re-stampability test). No DB writes.
//
//   node tools/sample-headers.js [container] [n]
//   node tools/sample-headers.js 5c2ae06dd22cbb37a33ad7fb 60

const fs = require('fs');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');

const FH = 48, CH = 16, MR = '/run/strubs/mounts';
const shard = id => `${id.substring(0,2)}/${id.substring(2,4)}/${id.substring(4,6)}`;
function layout(sz, cs) { const o=[]; if(sz<=cs){o.push({h:FH,d:FH+CH,l:sz-FH-CH});return o;} o.push({h:FH,d:FH+CH,l:cs-FH-CH}); let off=cs; while(off<sz){const s=Math.min(cs,sz-off);o.push({h:off,d:off+CH,l:s-CH});off+=s;} return o; }
function dataHashesOk(path, cs) { let sz; try{sz=fs.statSync(path).size;}catch{return null;} if(cs<=FH+CH)return null; const fd=fs.openSync(path,'r'); const lay=layout(sz,cs); let ok=true,checked=0;
  for(const k of [...new Set([0,1,Math.floor(lay.length/2),lay.length-1])]){const c=lay[k];if(!c||c.l<=0)continue;const hb=Buffer.alloc(CH),db=Buffer.alloc(c.l);fs.readSync(fd,hb,0,CH,c.h);fs.readSync(fd,db,0,c.l,c.d);checked++;if(!crypto.createHash('md5').update(db).digest().equals(hb)){ok=false;break;}}
  fs.closeSync(fd); return checked? ok : null; }

(async () => {
  const client = await MongoClient.connect(process.env.STRUBS_MONGO_URL || 'mongodb://strubs:strubs@127.0.0.1:27017/strubs?authSource=admin');
  const C = client.db('strubs').collection('content');
  const V = client.db('strubs').collection('volumes');
  const container = process.argv[2];
  const N = parseInt(process.argv[3] || '60', 10);

  const vmap = new Map();
  for (const v of await V.find({}).toArray()) vmap.set(v.id, `${MR}/${v.uuid}/strubs`);

  const q = { isFile:true, sliceErrors:{$exists:true} };
  if (container) q.container = container;            // try common field names
  let docs = await C.find(q).limit(N).toArray();
  if (!docs.length && container) { delete q.container; q.containerId = container; docs = await C.find(q).limit(N).toArray(); }
  if (!docs.length && container) { delete q.containerId; q.bucket = container; docs = await C.find(q).limit(N).toArray(); }
  if (!docs.length) { delete q.container; delete q.containerId; delete q.bucket; docs = await C.find(q).limit(N).toArray(); }
  console.log(`sampled ${docs.length} affected objects${container?` (container filter tried)`:''}\n`);

  const fieldMiss = { id:0, dataN:0, parityN:0, idx:0, chunkSize:0 };
  const idResolves = { existsAsContent:0, notFound:0, sampled:0 };
  const dataIntact = { ok:0, bad:0, na:0 };
  const chunkSizePairs = {};   // "dbCS->diskCS": count
  let printed = 0;

  for (const d of docs) {
    const id = d._id.toString(); const idBuf = Buffer.from(id,'hex');
    const dv=d.dataVolumes||[], pv=d.parityVolumes||[]; const all=[...dv,...pv]; const dataN=dv.length, parityN=pv.length;
    const dbCS = d.chunkSize;
    for (let idx=0; idx<all.length; idx++) {
      const mp = vmap.get(all[idx]); if(!mp) continue;
      const path = `${mp}/${shard(id)}/${id}.${idx}`;
      let fd; try{fd=fs.openSync(path,'r');}catch{continue;}
      const buf=Buffer.alloc(FH); let br=0; try{br=fs.readSync(fd,buf,0,FH,0);}catch{} fs.closeSync(fd);
      if(br!==FH) continue;
      const diskId=buf.subarray(23,35), diskDN=buf.readUInt8(40), diskPN=buf.readUInt8(41), diskIdx=buf.readUInt8(42), diskCS=buf.readIntLE(43,3);
      const misses=[];
      if(!diskId.equals(idBuf)){misses.push('id');fieldMiss.id++;}
      if(diskDN!==dataN){misses.push('dataN');fieldMiss.dataN++;}
      if(diskPN!==parityN){misses.push('parityN');fieldMiss.parityN++;}
      if(diskIdx!==idx){misses.push('idx');fieldMiss.idx++;}
      if(diskCS!==dbCS){misses.push('chunkSize');fieldMiss.chunkSize++; const k=`${dbCS}->${diskCS}`; chunkSizePairs[k]=(chunkSizePairs[k]||0)+1;}
      if(!misses.length) continue;

      // id-resolution: does the on-disk id correspond to a real content doc?
      if(misses.includes('id')){ const diskHex=diskId.toString('hex'); idResolves.sampled++;
        let exists=false; try{ exists = !!(await C.findOne({_id: tryOid(diskHex)},{projection:{_id:1}})); }catch{}
        exists?idResolves.existsAsContent++:idResolves.notFound++;
      }
      // data integrity using ON-DISK chunkSize (re-stampability)
      const r = dataHashesOk(path, diskCS>FH+CH?diskCS:dbCS);
      if(r===null)dataIntact.na++; else if(r)dataIntact.ok++; else dataIntact.bad++;

      if(printed<25){ printed++;
        console.log(`${id}.${idx} vol=${all[idx]} miss=[${misses.join(',')}] diskId=${diskId.toString('hex')} dbCS=${dbCS} diskCS=${diskCS} dN=${diskDN}/${dataN} pN=${diskPN}/${parityN} idx=${diskIdx}/${idx} dataHash=${r===null?'n/a':r?'OK':'BAD'}`);
      }
    }
  }
  function tryOid(hex){ const {ObjectId}=require('mongodb'); return /^[0-9a-f]{24}$/.test(hex)?new ObjectId(hex):null; }

  console.log('\n--- which header field mismatches (slice count) ---'); console.log(JSON.stringify(fieldMiss,null,1));
  console.log('--- on-disk id resolves to existing content doc? ---'); console.log(JSON.stringify(idResolves,null,1));
  console.log('--- data hashes (using on-disk chunkSize) ---'); console.log(JSON.stringify(dataIntact,null,1));
  console.log('--- chunkSize transitions dbCS->diskCS ---'); console.log(JSON.stringify(chunkSizePairs,null,1));
  await client.close();
})().catch(e=>{console.error('FATAL',e.stack||e.message);process.exit(1);});
