#!/usr/bin/env node
'use strict';
// Test the hypothesis: each 4x-oversized "parity" file = [48B file header] + concatenation of ALL
// data-slice chunk-streams (sliceFile[48:]) in slice order. If so, the missing vol-34 data slice is
// a contiguous block of the parity file and is recoverable byte-for-byte with NO RS.
//   node tools/parity-layout-probe.js [sample]
const fs = require('fs');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');
const FH = 48, MR = '/run/strubs/mounts';
const shard = id => `${id.substring(0,2)}/${id.substring(2,4)}/${id.substring(4,6)}`;

(async () => {
  const N = parseInt(process.argv[2] || '8', 10);
  const c = await MongoClient.connect(process.env.STRUBS_MONGO_URL || 'mongodb://strubs:strubs@127.0.0.1:27017/strubs?authSource=admin');
  const C = c.db('strubs').collection('content'), V = c.db('strubs').collection('volumes');
  const vmap = new Map(); for (const v of await V.find({}).toArray()) vmap.set(v.id, { uuid: v.uuid, online: fs.existsSync(`${MR}/${v.uuid}/strubs`) });
  const docs = await C.aggregate([{ $match: { isFile: true, sliceErrors: { $exists: true }, parityVolumes: { $in: [47, 48] }, dataVolumes: 34 } }, { $sample: { size: N } }]).toArray();

  let ok = 0, tested = 0, partial = 0;
  for (const d of docs) {
    const id = d._id.toHexString(); const dataN = d.dataVolumes.length;
    const pv = vmap.get(d.parityVolumes[0]); if (!pv || !pv.online) continue;
    let par; try { par = fs.readFileSync(`${MR}/${pv.uuid}/strubs/${shard(id)}/${id}.${dataN}`); } catch { continue; }
    const body = par.length - FH;
    if (body % dataN !== 0) { console.log(`${id}: parity body ${body} not divisible by ${dataN} -- skip`); continue; }
    const blk = body / dataN;                              // per-slice chunk-stream length
    tested++;
    // compare each LIVE data slice to its parity block; identify the missing (vol-34) block
    let matches = 0, live = 0, missingIdx = -1;
    for (let si = 0; si < dataN; si++) {
      const v = vmap.get(d.dataVolumes[si]);
      const block = par.subarray(FH + si * blk, FH + (si + 1) * blk);
      if (!v || !v.online) { missingIdx = si; continue; }
      live++;
      let sf; try { sf = fs.readFileSync(`${MR}/${v.uuid}/strubs/${shard(id)}/${id}.${si}`); } catch { continue; }
      const stream = sf.subarray(FH);
      if (stream.length === block.length && stream.equals(block)) matches++;
      else console.log(`${id}: slice ${si} live-vs-parityblock MISMATCH (len ${stream.length} vs ${block.length})`);
    }
    const allLiveMatch = matches === live && live === dataN - 1;
    if (allLiveMatch) ok++; else partial++;
    console.log(`${id}: dataN=${dataN} blk=${blk} live-blocks-match=${matches}/${live} missingSlice=${missingIdx} -> ${allLiveMatch ? 'PARITY=CONCAT-OF-DATA-SLICES (missing slice recoverable as block '+missingIdx+')' : 'layout differs'}`);
  }
  console.log(`\n=== ${ok}/${tested} objects: parity file == concat of data-slice streams (missing slice byte-recoverable) ===`);
  await c.close();
})().catch(e => { console.error('FATAL', e.stack || e.message); process.exit(1); });
