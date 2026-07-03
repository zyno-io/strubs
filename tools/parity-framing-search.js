#!/usr/bin/env node
'use strict';
// Reverse-engineer the parity on-disk framing. For a sample of vol-34 parity slices, try several
// framing MODELS and count how many chunks validate (storedMD5 == MD5(data)) under each. If some
// alternate model validates ~all chunks, the parity bytes are intact-but-misframed (salvageable);
// if none does, the parity data is genuinely garbage.
//   node tools/parity-framing-search.js [sample]
const fs = require('fs');
const crypto = require('crypto');
const { MongoClient, ObjectId } = require('mongodb');
const FH = 48, CH = 16, MR = '/run/strubs/mounts';
const shard = id => `${id.substring(0,2)}/${id.substring(2,4)}/${id.substring(4,6)}`;
const md5 = b => crypto.createHash('md5').update(b).digest();

// Try a framing: frames start at `first`, each frame = [CH header][dataLen data], with dataLen given
// by dataLenFn(chunkIndex). Count how many frames validate before running past EOF.
function countValid(buf, first, dataLenFn) {
  let off = first, i = 0, valid = 0, total = 0;
  while (off + CH < buf.length) {
    const dl = dataLenFn(i);
    if (dl <= 0 || off + CH + dl > buf.length) break;
    total++;
    const stored = buf.subarray(off, off + CH);
    const data = buf.subarray(off + CH, off + CH + dl);
    if (stored.equals(md5(data))) valid++;
    off += CH + dl; i++;
  }
  return { valid, total };
}

(async () => {
  const N = parseInt(process.argv[2] || '6', 10);
  const c = await MongoClient.connect(process.env.STRUBS_MONGO_URL || 'mongodb://strubs:strubs@127.0.0.1:27017/strubs?authSource=admin');
  const C = c.db('strubs').collection('content'), V = c.db('strubs').collection('volumes');
  const vmap = new Map(); for (const v of await V.find({}).toArray()) vmap.set(v.id, `${MR}/${v.uuid}/strubs`);
  const docs = await C.aggregate([{ $match: { isFile: true, sliceErrors: { $exists: true }, parityVolumes: { $in: [47, 48] }, $or: [{ dataVolumes: 34 }, { parityVolumes: 34 }] } }, { $sample: { size: N } }]).toArray();

  for (const d of docs) {
    const id = d._id.toString(); const dataN = d.dataVolumes.length; const cs = d.chunkSize;
    const pidx = dataN; const mp = vmap.get(d.parityVolumes[0]);
    const path = `${mp}/${shard(id)}/${id}.${pidx}`;
    let buf; try { buf = fs.readFileSync(path); } catch { continue; }
    const stdLen = i => i === 0 ? cs - FH - CH : cs - CH;          // standard: chunk0 short by file header
    const models = {
      'A std(0:cs-FH-CH,rest:cs-CH)@48': { first: FH, fn: stdLen },
      'B uniform cs-FH-CH @48':          { first: FH, fn: () => cs - FH - CH },
      'C uniform cs-CH @48':             { first: FH, fn: () => cs - CH },
      'D uniform cs-CH @0 (no fhdr)':    { first: 0,  fn: () => cs - CH },
      'E uniform cs-FH-CH @0':           { first: 0,  fn: () => cs - FH - CH },
    };
    const out = Object.entries(models).map(([name, m]) => { const r = countValid(buf, m.first, m.fn); return `${name}: ${r.valid}/${r.total}`; });
    console.log(`${id}.${pidx} v${d.parityVolumes[0]} size=${buf.length} cs=${cs}`);
    for (const o of out) console.log('   ', o);
  }
  await c.close();
})().catch(e => { console.error('FATAL', e.stack || e.message); process.exit(1); });
