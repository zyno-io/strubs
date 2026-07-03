#!/usr/bin/env node
'use strict';
// Decode the 4x parity file: split into 4 blocks, strip each block's per-chunk 16B MD5 headers using
// the object's real plan chunk sizes, interleave the 4 blocks' per-chunk data into the object plaintext,
// and check md5 == content.md5. If it matches, the parity file IS the whole object's data and the
// missing vol-34 slice (block 1) is byte-recoverable. Uses the app's FileObject for exact geometry.
//   node tools/parity-decode-test.js [sample]
const fs = require('fs');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');
const { FileObject } = require('../dist/lib/io/file-object');
const FH = 48, CH = 16, MR = '/run/strubs/mounts';
const shard = id => `${id.substring(0,2)}/${id.substring(2,4)}/${id.substring(4,6)}`;
const md5 = b => crypto.createHash('md5').update(b).digest();

// per-chunk data sizes for one slice, from the plan
function chunkSizes(plan) {
  const sizes = [plan.startChunkDataSize];
  for (let i = 0; i < plan.standardChunkCountPerSlice; i++) sizes.push(plan.standardChunkDataSize);
  sizes.push(plan.endChunkDataSize);
  return sizes.filter(s => s > 0);
}
// decode a block (chunk-stream [16 md5][data]...) into its per-chunk data buffers, given expected sizes
function decodeBlock(block, sizes) { const parts = []; let o = 0;
  for (const L of sizes) { if (o + CH + L > block.length) return null; parts.push(block.subarray(o + CH, o + CH + L)); o += CH + L; }
  return parts;
}

(async () => {
  const N = parseInt(process.argv[2] || '8', 10);
  const c = await MongoClient.connect(process.env.STRUBS_MONGO_URL || 'mongodb://strubs:strubs@127.0.0.1:27017/strubs?authSource=admin');
  const C = c.db('strubs').collection('content'), V = c.db('strubs').collection('volumes');
  const vmap = new Map(); for (const v of await V.find({}).toArray()) vmap.set(v.id, { uuid: v.uuid, online: fs.existsSync(`${MR}/${v.uuid}/strubs`) });
  const docs = await C.aggregate([{ $match: { isFile: true, sliceErrors: { $exists: true }, parityVolumes: { $in: [47, 48] }, dataVolumes: 34 } }, { $sample: { size: N } }]).toArray();

  let ok = 0, tested = 0;
  for (const d of docs) {
    const id = d._id.toHexString(); const dataN = d.dataVolumes.length;
    const pv = vmap.get(d.parityVolumes[0]); if (!pv || !pv.online) continue;
    let par; try { par = fs.readFileSync(`${MR}/${pv.uuid}/strubs/${shard(id)}/${id}.${dataN}`); } catch { continue; }
    const objMd5 = (d.md5 && d.md5.buffer) ? d.md5.buffer : d.md5; if (!objMd5) continue;
    const fo = new FileObject(); await fo.loadFromRecord({ id, size: d.size, chunkSize: d.chunkSize, md5: objMd5, dataVolumes: d.dataVolumes, parityVolumes: d.parityVolumes, name: d.name, containerId: d.containerId });
    const plan = fo.plan; const sizes = chunkSizes(plan);
    const body = par.length - FH; if (body % dataN !== 0) continue; const blk = body / dataN;
    tested++;
    const blocks = []; for (let j = 0; j < dataN; j++) blocks.push(decodeBlock(par.subarray(FH + j * blk, FH + (j + 1) * blk), sizes));
    if (blocks.some(b => b === null)) { console.log(`${id}: block decode failed under plan framing`); continue; }
    // interleave: object plaintext = for each chunk k, concat block_j.chunk_k over j
    const parts = [];
    for (let k = 0; k < sizes.length; k++) for (let j = 0; j < dataN; j++) parts.push(blocks[j][k]);
    const plaintext = Buffer.concat(parts).subarray(0, d.size);
    const match = md5(plaintext).equals(objMd5);
    if (match) ok++;
    console.log(`${id}: size=${d.size} blk=${blk} chunks/slice=${sizes.length} -> plaintext md5 ${match ? 'MATCH ✓ (RECOVERABLE)' : 'mismatch'}`);
    if (!match) {
      // also try block order permutations? report first-chunk sanity
      console.log(`   objMd5=${objMd5.toString('hex').slice(0,16)} gotMd5=${md5(plaintext).toString('hex').slice(0,16)} plaintextLen=${plaintext.length}`);
    }
  }
  console.log(`\n=== ${ok}/${tested} objects fully reconstructed from the 4x parity file (md5-verified) ===`);
  await c.close();
})().catch(e => { console.error('FATAL', e.stack || e.message); process.exit(1); });
