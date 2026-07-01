#!/usr/bin/env node
'use strict';
// Standalone GLOBAL light verification — FLAG-ONLY (records sliceErrors), never repairs.
// Mirrors the in-app light mode: per slice, existence + 48-byte header validation only
// (no chunk reads). Safe to run while the maintenance freeze is on (it never invokes repair).
// Run AFTER `archive sliceErrors` (rename to sliceErrorsArchive) so it writes a clean fresh map.
//
//   node tools/light-verify.js                 # DRY RUN: category counts, no DB writes
//   node tools/light-verify.js --apply         # write fresh content.sliceErrors
//   node tools/light-verify.js --apply --limit 10000   # bounded test run
//
// Header checks are byte-identical to slice.ts _validateHeader:
//   id bytes 23..34 == objectId(12B) ; u8@40==dataCount ; u8@41==parityCount ; u8@42==sliceIndex ; intLE@43..45==chunkSize

const fs = require('fs');
const fsp = require('fs/promises');
const { MongoClient } = require('mongodb');

const APPLY = process.argv.includes('--apply');
const LIMIT = (() => { const i = process.argv.indexOf('--limit'); return i >= 0 ? parseInt(process.argv[i+1],10) : Infinity; })();
const CONC = 48;                         // objects checked in parallel (spreads reads across disks)
const FH = 48, MR = '/run/strubs/mounts';
const shard = id => `${id.substring(0,2)}/${id.substring(2,4)}/${id.substring(4,6)}`;

async function checkSlice(mount, online, id, idBuf, dataN, parityN, idx, chunkSize) {
  // returns null (ok) or { category, err }
  if (!online) return { category: 'volume-unavailable', err: 'volume offline' };
  const path = `${mount}/strubs/${shard(id)}/${id}.${idx}`;
  let fh;
  try { fh = await fsp.open(path, 'r'); }
  catch (e) { return e.code === 'ENOENT' ? { category:'missing', err:'slice file missing' } : { category:'io', err:String(e.code||e.message) }; }
  try {
    const buf = Buffer.alloc(FH);
    const { bytesRead } = await fh.read(buf, 0, FH, 0);
    if (bytesRead !== FH) return { category:'io', err:`short header read ${bytesRead}/${FH}` };
    if (!buf.subarray(23,35).equals(idBuf)) return { category:'header-mismatch', err:'object id mismatch' };
    if (buf.readUInt8(40) !== dataN) return { category:'header-mismatch', err:'data slice count mismatch' };
    if (buf.readUInt8(41) !== parityN) return { category:'header-mismatch', err:'parity slice count mismatch' };
    if (buf.readUInt8(42) !== idx) return { category:'header-mismatch', err:'slice index mismatch' };
    if (buf.readIntLE(43,3) !== chunkSize) return { category:'header-mismatch', err:'chunk size mismatch' };
    return null;
  } catch (e) { return { category:'io', err:String(e.code||e.message) }; }
  finally { await fh.close().catch(()=>{}); }
}

(async () => {
  const client = await MongoClient.connect(process.env.STRUBS_MONGO_URL || 'mongodb://strubs:strubs@127.0.0.1:27017/strubs?authSource=admin');
  const db = client.db('strubs');
  console.log(`MODE ${APPLY ? 'APPLY' : 'DRY RUN'}  conc=${CONC}`);

  // volume id -> { mount, online }
  const vmap = new Map();
  for (const v of await db.collection('volumes').find({}).toArray()) {
    const mount = `${MR}/${v.uuid}`;
    vmap.set(v.id, { mount, online: fs.existsSync(`${mount}/strubs`) });
  }

  const C = db.collection('content');
  const stat = { objs:0, slices:0, withErr:0, cat:{} };
  let batch = [];
  const flush = async () => { if(!APPLY||!batch.length){batch=[];return;} try{await C.bulkWrite(batch,{ordered:false});}catch(e){console.error('bulk',e.message);} batch=[]; };

  const checkObject = async (d) => {
    const id = d._id.toString(); let idBuf; try { idBuf = Buffer.from(id,'hex'); } catch { return; }
    const dv = d.dataVolumes||[], pv = d.parityVolumes||[]; const all = [...dv,...pv]; const dataN = dv.length, parityN = pv.length;
    const chunkSize = d.chunkSize; const errs = {};
    for (let idx = 0; idx < all.length; idx++) {
      stat.slices++;
      const vinfo = vmap.get(all[idx]) || { mount:'', online:false };
      const r = await checkSlice(vinfo.mount, vinfo.online, id, idBuf, dataN, parityN, idx, chunkSize);
      if (r) { stat.cat[r.category] = (stat.cat[r.category]||0)+1;
        errs[String(idx)] = { category:r.category, err:r.err, type: idx < dataN ? 'data':'parity' }; }
    }
    if (Object.keys(errs).length) { stat.withErr++;
      if (APPLY) { batch.push({ updateOne:{ filter:{_id:d._id}, update:{ $set:{ sliceErrors:errs, lastVerifiedAt:new Date() } } } }); if(batch.length>=1000) await flush(); }
    } else if (APPLY) { batch.push({ updateOne:{ filter:{_id:d._id}, update:{ $set:{ lastVerifiedAt:new Date() }, $unset:{ sliceErrors:'' } } } }); if(batch.length>=1000) await flush(); }
  };

  // bounded-concurrency stream over file objects
  const cur = C.find({ isFile:true }, { projection:{ dataVolumes:1, parityVolumes:1, chunkSize:1 } })
    .batchSize(2000).addCursorFlag('noCursorTimeout', true);   // survive the long run (see drain cursor fix)
  const inflight = new Set();
  for await (const d of cur) {
    if (stat.objs >= LIMIT) break;
    stat.objs++;
    const p = checkObject(d).finally(() => inflight.delete(p)); inflight.add(p);
    if (inflight.size >= CONC) await Promise.race(inflight);
    if (stat.objs % 100000 === 0) console.log(`  ...${stat.objs} objs, ${stat.withErr} with errors`);
  }
  await Promise.all(inflight); await flush();

  console.log('\n=== LIGHT VERIFY RESULT ===');
  console.log(JSON.stringify({ objects:stat.objs, slices:stat.slices, objectsWithErrors:stat.withErr }, null, 1));
  console.log('error slices by category:', JSON.stringify(stat.cat, null, 1));
  await client.close();
})().catch(e => { console.error('FATAL', e.stack||e.message); process.exit(1); });
