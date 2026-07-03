#!/usr/bin/env node
'use strict';
// CONFIRM salvage: for vol-34 objects, resync-extract the valid parity frames from parity slice 0,
// re-lay them into a corrected slice file (standard framing) on a scratch volume, repoint the object's
// parity[0] at the scratch copy, reconstruct the missing data slice through the REAL codec, and check
// the WHOLE-OBJECT md5. md5 match => the parity bytes are intact + aligned => salvageable. No DB writes.
//   node tools/parity-salvage-confirm.js [sample]
const fs = require('fs');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');
const { Volume } = require('../dist/lib/io/volume');
const { volumeFleet } = require('../dist/lib/io/volume-fleet');
const { FileObject } = require('../dist/lib/io/file-object');
const { FileObjectReader } = require('../dist/lib/io/file-object/reader');

const FH = 48, CH = 16, MR = '/run/strubs/mounts', SCRATCH = '/tmp/psalv', SCRATCH_VID = 999;
const DEAD = new Set([34, 7, 43]);
const shard = id => `${id.substring(0,2)}/${id.substring(2,4)}/${id.substring(4,6)}`;
const md5 = b => crypto.createHash('md5').update(b).digest();
const md5Of = doc => (doc && doc.md5 && doc.md5.buffer) ? doc.md5.buffer : (doc ? doc.md5 : null);

function validAt(buf, o, L) { return o + CH + L <= buf.length && buf.subarray(o, o + CH).equals(md5(buf.subarray(o + CH, o + CH + L))); }
// resync-extract ordered frames {md5,data} from a parity file; returns null if it stalls badly
function extractFrames(buf, cs, maxScan) {
  const frames = []; let o = FH;
  while (o + CH < buf.length) {
    let L = validAt(buf, o, cs - FH - CH) ? cs - FH - CH : (validAt(buf, o, cs - CH) ? cs - CH : null);
    if (L === null) { // resync: scan forward
      let found = false;
      for (let d = 1; d <= maxScan && o + d + CH < buf.length; d++) { const p = o + d;
        for (const cand of [cs - CH, cs - FH - CH]) if (validAt(buf, p, cand)) { o = p; L = cand; found = true; break; }
        if (found) break;
        const tail = buf.length - (p + CH); if (tail > 0 && tail < cs - CH && validAt(buf, p, tail)) { o = p; L = tail; found = true; break; }
      }
      if (!found) { const tail = buf.length - (o + CH); if (tail > 0 && tail < cs - CH && validAt(buf, o, tail)) L = tail; else break; }
    }
    frames.push({ md5: Buffer.from(buf.subarray(o, o + CH)), data: Buffer.from(buf.subarray(o + CH, o + CH + L)) });
    o += CH + L;
  }
  return frames;
}

(async () => {
  const N = parseInt(process.argv[2] || '10', 10);
  const client = await MongoClient.connect(process.env.STRUBS_MONGO_URL || 'mongodb://strubs:strubs@127.0.0.1:27017/strubs?authSource=admin');
  const db = client.db('strubs'); const C = db.collection('content'), V = db.collection('volumes');
  const volDocs = await V.find({}).toArray();
  for (const doc of volDocs) { const v = new Volume(doc); const mount = `${MR}/${doc.uuid}`;
    if (fs.existsSync(`${mount}/strubs`) && !DEAD.has(doc.id)) { v.mountPoint = mount; v.isStarted = true; v.isEnabled = true; v.isHealthy = true; v.isReadOnly = false; } else v.isStarted = false;
    volumeFleet['_volumes'][doc.id] = v; }
  // scratch volume for the corrected parity
  const sv = new Volume({ ...volDocs.find(d => !DEAD.has(d.id)), id: SCRATCH_VID, uuid: 'psalv' });
  sv.mountPoint = SCRATCH; sv.isStarted = true; sv.isEnabled = true; sv.isHealthy = true; sv.isReadOnly = false;
  volumeFleet['_volumes'][SCRATCH_VID] = sv;

  const docs = await C.aggregate([{ $match: { isFile: true, sliceErrors: { $exists: true }, parityVolumes: { $in: [47, 48] }, dataVolumes: 34 } }, { $sample: { size: N } }]).toArray();
  const s = { objs: 0, salvaged: 0, md5mismatch: 0, equorum: 0, framesShort: 0, error: 0 };
  for (const doc of docs) {
    const id = doc._id.toHexString(); const dataN = doc.dataVolumes.length; const cs = doc.chunkSize; const pidx = dataN;
    const pvol = volDocs.find(d => d.id === doc.parityVolumes[0]); if (!pvol) continue;
    const ppath = `${MR}/${pvol.uuid}/strubs/${shard(id)}/${id}.${pidx}`;
    let buf; try { buf = fs.readFileSync(ppath); } catch { continue; }
    s.objs++;
    const frames = extractFrames(buf, cs, 40000);
    // re-lay corrected parity: original 48B header + sequential [md5][data]
    const parts = [Buffer.from(buf.subarray(0, FH))]; for (const f of frames) { parts.push(f.md5, f.data); }
    const dir = `${SCRATCH}/strubs/${shard(id)}`; fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${dir}/${id}.${pidx}`, Buffer.concat(parts));
    // reconstruct with parity[0] repointed to the scratch corrected copy
    const rec = { id, size: doc.size, chunkSize: cs, md5: md5Of(doc), dataVolumes: [...doc.dataVolumes], parityVolumes: [...doc.parityVolumes], name: doc.name, containerId: doc.containerId };
    const fo = new FileObject(); await fo.loadFromRecord(rec); fo.paritySliceVolumeIds[0] = SCRATCH_VID;
    const reader = new FileObjectReader(fo);
    try { await reader.prepare(); reader.setReadRange(0, fo.size); const h = crypto.createHash('md5');
      for (let b; (b = await reader.readChunk()) !== null; ) h.update(b);
      if (h.digest().equals(fo.md5)) s.salvaged++; else s.md5mismatch++;
    } catch (e) { if (e && e.code === 'EQUORUM') s.equorum++; else { s.error++; if (s.error <= 5) console.error('err', id, e && (e.code || e.message)); } }
    finally { await reader.close().catch(() => {}); }
  }
  console.log('\n=== PARITY SALVAGE CONFIRM (resync re-frame -> reconstruct -> whole-object md5) ===');
  console.log(JSON.stringify(s, null, 1));
  console.log(`SALVAGED (md5 matched using re-framed parity): ${s.salvaged}/${s.objs}`);
  await client.close(); process.exit(0);
})().catch(e => { console.error('FATAL', e.stack || e.message); process.exit(1); });
