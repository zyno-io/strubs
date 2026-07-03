#!/usr/bin/env node
'use strict';
// Rigorous framing test: does the parity contain many valid [MD5(16)][data] frames that are merely
// SHIFTED (by a header length or arbitrary offset), vs genuinely garbage? Walk the file; at each
// position try to validate a frame (data length 16320 OR 16368); if it fails, SCAN FORWARD up to
// maxScan bytes for the next offset where a valid frame begins (a resync), and continue. Report how
// many valid parity frames exist in total and the shift sizes needed. If ~all chunks validate with
// resyncs, parity data is intact-but-shifted (salvageable); if only a few, it's byte-level garbage.
//   node tools/parity-resync-search.js [sample] [maxScanBytes]
const fs = require('fs');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');
const FH = 48, CH = 16, MR = '/run/strubs/mounts';
const shard = id => `${id.substring(0,2)}/${id.substring(2,4)}/${id.substring(4,6)}`;
const md5 = b => crypto.createHash('md5').update(b).digest();

function validAt(buf, o, L) { return o + CH + L <= buf.length && buf.subarray(o, o + CH).equals(md5(buf.subarray(o + CH, o + CH + L))); }
// find next valid frame at offset >= o within maxScan; try both standard data lengths + partial tail
function findFrame(buf, o, cs, maxScan) {
  const Ls = [cs - CH, cs - FH - CH];
  for (let d = 0; d <= maxScan; d++) {
    const p = o + d; if (p + CH >= buf.length) break;
    for (const L of Ls) if (validAt(buf, p, L)) return { p, L, shift: d };
    // also allow a short final frame
    if (p + CH < buf.length) { const tail = buf.length - (p + CH); if (tail > 0 && tail < cs - CH && validAt(buf, p, tail)) return { p, L: tail, shift: d }; }
  }
  return null;
}

(async () => {
  const N = parseInt(process.argv[2] || '4', 10);
  const maxScan = parseInt(process.argv[3] || '32768', 10);
  const c = await MongoClient.connect(process.env.STRUBS_MONGO_URL || 'mongodb://strubs:strubs@127.0.0.1:27017/strubs?authSource=admin');
  const C = c.db('strubs').collection('content'), V = c.db('strubs').collection('volumes');
  const vmap = new Map(); for (const v of await V.find({}).toArray()) vmap.set(v.id, `${MR}/${v.uuid}/strubs`);
  const docs = await C.aggregate([{ $match: { isFile: true, sliceErrors: { $exists: true }, parityVolumes: { $in: [47, 48] } } }, { $sample: { size: N } }]).toArray();

  for (const d of docs) {
    const id = d._id.toString(), dataN = d.dataVolumes.length, cs = d.chunkSize, pidx = dataN, mp = vmap.get(d.parityVolumes[0]);
    let buf; try { buf = fs.readFileSync(`${mp}/${shard(id)}/${id}.${pidx}`); } catch { continue; }
    const approxChunks = Math.ceil(buf.length / cs);
    let o = FH, valid = 0, resyncs = 0, totalShift = 0, maxShiftSeen = 0, stalls = 0;
    while (o + CH < buf.length) {
      let f = validAt(buf, o, cs - CH) ? { p: o, L: cs - CH, shift: 0 } : (validAt(buf, o, cs - FH - CH) ? { p: o, L: cs - FH - CH, shift: 0 } : null);
      if (!f) { f = findFrame(buf, o, cs, maxScan); if (f) { resyncs++; totalShift += f.shift; maxShiftSeen = Math.max(maxShiftSeen, f.shift); } }
      if (!f) { stalls++; break; }         // no valid frame anywhere within maxScan -> garbage from here
      valid++; o = f.p + CH + f.L;
    }
    console.log(`${id}.${pidx} ~chunks=${approxChunks}  VALID frames found=${valid}  resyncs=${resyncs}  maxShift=${maxShiftSeen}  (stalled=${stalls})`);
  }
  await c.close();
})().catch(e => { console.error('FATAL', e.stack || e.message); process.exit(1); });
