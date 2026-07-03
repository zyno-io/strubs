const fs=require('fs'),crypto=require('crypto');
const {MongoClient}=require('mongodb');
const {FileObject}=require('../dist/lib/io/file-object');
const {create,encode}=require('../dist/lib/async-bridges/reed-solomon');
const FH=48,CH=16,MR='/run/strubs/mounts';
const shard=id=>`${id.substring(0,2)}/${id.substring(2,4)}/${id.substring(4,6)}`;
const md5=b=>crypto.createHash('md5').update(b).digest();
function sizesOf(p){const s=[p.startChunkDataSize];for(let i=0;i<p.standardChunkCountPerSlice;i++)s.push(p.standardChunkDataSize);s.push(p.endChunkDataSize);return s.filter(x=>x>0);}
function decode(sb,sizes){const parts=[];let o=0;for(const L of sizes){if(o+CH+L>sb.length)return null;parts.push(sb.subarray(o+CH,o+CH+L));o+=CH+L;}return parts;}
function validAt(buf,o,L){return o+CH+L<=buf.length&&buf.subarray(o,o+CH).equals(md5(buf.subarray(o+CH,o+CH+L)));}
function walk(buf,cs){const fr=[];let o=FH;while(o+CH<buf.length){let L=validAt(buf,o,cs-CH)?cs-CH:(validAt(buf,o,cs-FH-CH)?cs-FH-CH:null);if(L===null){let f=false;for(let dd=1;dd<=40000&&o+dd+CH<buf.length;dd++){const p=o+dd;for(const cand of[cs-CH,cs-FH-CH]){if(validAt(buf,p,cand)){o=p;L=cand;f=true;break;}}if(f)break;}if(!f)break;}fr.push({data:buf.subarray(o+CH,o+CH+L),len:L});o+=CH+L;}return fr;}
(async()=>{
 const c=await MongoClient.connect('mongodb://strubs:strubs@127.0.0.1:27017/strubs?authSource=admin');
 const C=c.db('strubs').collection('content'),V=c.db('strubs').collection('volumes');
 const vmap=new Map();for(const v of await V.find({}).toArray())vmap.set(v.id,{uuid:v.uuid,online:fs.existsSync(`${MR}/${v.uuid}/strubs`)});
 const id='608db9fd3b1e7a09d6001fe7';
 const d=await C.findOne({_id:require('mongodb').ObjectId.createFromHexString(id)});
 const dataN=d.dataVolumes.length,parityN=d.parityVolumes.length,miss=d.dataVolumes.indexOf(34),cs=d.chunkSize;
 const fo=new FileObject();await fo.loadFromRecord({id,size:d.size,chunkSize:cs,md5:d.md5.buffer||d.md5,dataVolumes:d.dataVolumes,parityVolumes:d.parityVolumes,name:d.name,containerId:d.containerId});
 const sizes=sizesOf(fo.plan);const ctx=create(dataN,parityN);
 const dch=[];for(let si=0;si<dataN;si++){if(si===miss){dch.push(null);continue;}dch.push(decode(fs.readFileSync(`${MR}/${vmap.get(d.dataVolumes[si]).uuid}/strubs/${shard(id)}/${id}.${si}`).subarray(FH),sizes));}
 const f0=walk(fs.readFileSync(`${MR}/${vmap.get(d.parityVolumes[0]).uuid}/strubs/${shard(id)}/${id}.${dataN}`),cs);
 const f1=walk(fs.readFileSync(`${MR}/${vmap.get(d.parityVolumes[1]).uuid}/strubs/${shard(id)}/${id}.${dataN+1}`),cs);
 console.log(`frames p0=${f0.length} p1=${f1.length} chunks/slice=${sizes.length} ratio=${(f0.length/sizes.length).toFixed(2)}`);
 console.log('p0 frame lens[0:12]:',f0.slice(0,12).map(f=>f.len).join(','));
 async function consistent(k,i0,i1){const ss=sizes[k];if(!f0[i0]||!f1[i1]||f0[i0].len!==ss||f1[i1].len!==ss)return false;
  const dbuf=Buffer.alloc(dataN*ss),pbuf=Buffer.alloc(parityN*ss);let s=0;for(let i=0;i<dataN;i++){if(i===miss)continue;dch[i][k].copy(dbuf,i*ss);s|=(1<<i);}f0[i0].data.copy(pbuf,0);s|=(1<<dataN);
  await encode(ctx,s,(1<<miss),dbuf,0,dataN*ss,pbuf,0,parityN*ss);const recon=Buffer.from(dbuf.subarray(miss*ss,(miss+1)*ss));
  for(let i=0;i<dataN;i++)(i===miss?recon:dch[i][k]).copy(dbuf,i*ss);
  const pc=Buffer.alloc(parityN*ss);await encode(ctx,(1<<dataN)-1,(1<<dataN)|(1<<(dataN+1)),dbuf,0,dataN*ss,pc,0,parityN*ss);
  return pc.subarray(ss,2*ss).equals(f1[i1].data);}
 for(const stride of [1,2,4]){let good=0;for(let k=0;k<Math.min(sizes.length,20);k++){if(await consistent(k,stride*k,stride*k))good++;}console.log(`stride ${stride}: consistent chunk-sets = ${good}/20`);}
 await c.close();
})().catch(e=>{console.error(e.stack||e.message);process.exit(1);});
