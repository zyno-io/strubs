#!/usr/bin/env node
'use strict';
// ============================================================================================================
// ADVISORY HEADER-MD5 RE-STAMP for the legacy (pre-2015-scheme) cohort the full verify flagged as headerPatch.
//
// The 48-byte slice header carries an advisory md5 at bytes 7..22 = md5(header[23..48]) -- i.e. a checksum of
// the header's own DESCRIPTIVE FIELDS (id/size/counts/index/chunkSize/padding), NOT of the chunk data. The
// scheme changed mid-2015, so pre-2015 slices carry an old-scheme value there while being perfectly healthy;
// the live reader ignores this md5 entirely and gates on structure. This tool rewrites those 16 bytes in place
// to the current-scheme value so the checksum becomes usable again (a prerequisite for later ENFORCING it).
//
// It is a HEADER-ONLY operation: read 48 bytes, re-confirm every descriptive field still matches the DB, write
// 16 bytes at offset 7, re-read to confirm. No data is read or moved; the payload from byte 48 on is untouched;
// the header does not change length.
//
//   node tools/restamp-header-md5.js             # DRY RUN -- classify, write nothing
//   node tools/restamp-header-md5.js --apply     # rewrite the advisory md5 + clear headerPatch
//   node tools/restamp-header-md5.js --apply --conc 48
//
// HARD SAFETY per slice: patch ONLY if the header is structurally exactly what the DB says -- magic, version=1,
// hdrlen=48, id@23..34, size@35..39, dataN@40, parityN@41, sliceIndex@42, chunkSize@43..45, padding@46..47=0.
// Anything off -> NOT patched, headerPatch left in place for review (never stamp a valid checksum over a header
// that no longer describes its object). Already-current advisory md5 -> skipped (idempotent). Resumable: clears
// headerPatch per object, drained via _id-range pagination (short queries -- no long-lived cursor). Run from
// /opt/strubs. UV_THREADPOOL_SIZE=64 recommended.
// ============================================================================================================

const fs = require('fs');
const fsp = fs.promises;
const { createHash } = require('crypto');
const { MongoClient } = require('mongodb');
const constants = require('../dist/lib/constants');

const SLICE_MAGIC = constants.SLICE_MAGIC;             // Buffer 01 c3 bb 02
const HDR = constants.FILE_HEADER_SIZE || 48;
const APPLY = process.argv.includes('--apply');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const CONC = parseInt(arg('--conc', '48'), 10);
const LIMIT = (() => { const v = arg('--limit', null); return v == null ? Infinity : parseInt(v, 10); })();
const MR = '/run/strubs/mounts';

(async () => {
  const client = await MongoClient.connect(process.env.STRUBS_MONGO_URL || 'mongodb://strubs:strubs@127.0.0.1:27017/strubs?authSource=admin');
  const db = client.db('strubs'); const C = db.collection('content'), V = db.collection('volumes');

  // volumeId -> mount path (uuid-based), online only. Header ops go straight to the file; no codec/fleet needed.
  const mountOf = new Map();
  for (const doc of await V.find({}, { projection: { id: 1, uuid: 1 } }).toArray()) {
    const m = `${MR}/${doc.uuid}/strubs`;
    if (fs.existsSync(m)) mountOf.set(doc.id, m);
  }
  console.log(`MODE ${APPLY ? 'APPLY' : 'DRY RUN'}  conc=${CONC}  online-volumes=${mountOf.size}`);

  const slicePath = (mount, idHex, sliceIndex) => `${mount}/${idHex.slice(0, 2)}/${idHex.slice(2, 4)}/${idHex.slice(4, 6)}/${idHex}.${sliceIndex}`;

  // Patch one slice's advisory md5. Returns: 'patched' | 'already' | 'skip-struct' | 'unavail' | 'ioerr'
  const patchSlice = async (idHex, idBuf, sliceIndex, volumeId, dataN, parityN, size, chunkSize) => {
    const mount = mountOf.get(volumeId);
    if (!mount) return 'unavail';
    let fh;
    try {
      fh = await fsp.open(slicePath(mount, idHex, sliceIndex), APPLY ? 'r+' : 'r');
      const buf = Buffer.alloc(HDR);
      const { bytesRead } = await fh.read(buf, 0, HDR, 0);
      if (bytesRead < HDR) return 'skip-struct';
      // The header must EXACTLY describe this object, or we do not touch its checksum.
      const structOk = buf.subarray(0, 4).equals(SLICE_MAGIC)
        && buf.readUInt8(4) === 1
        && buf.readUInt16LE(5) === HDR
        && buf.subarray(23, 35).equals(idBuf)
        && buf.readIntLE(35, 5) === size
        && buf.readUInt8(40) === dataN
        && buf.readUInt8(41) === parityN
        && buf.readUInt8(42) === sliceIndex
        && buf.readIntLE(43, 3) === chunkSize
        && buf.readUInt16LE(46) === 0;
      if (!structOk) return 'skip-struct';
      const want = createHash('md5').update(buf.subarray(23, 48)).digest();   // md5 of the descriptive fields
      if (buf.subarray(7, 23).equals(want)) return 'already';                  // current scheme already
      if (!APPLY) return 'patched';                                            // dry run: would patch
      await fh.write(want, 0, 16, 7);                                          // rewrite ONLY the 16 md5 bytes
      const chk = Buffer.alloc(16); await fh.read(chk, 0, 16, 7);              // page-cache-coherent confirm
      if (!chk.equals(want)) return 'skip-struct';
      await fh.datasync();                                                     // durable BEFORE the marker clears
      return 'patched';
    } catch (e) {
      const code = e && e.code;
      if (code === 'ENOENT') return 'unavail';   // file gone (a genuinely-missing slice -> leave for review)
      return 'ioerr';
    } finally { if (fh) await fh.close().catch(() => {}); }
  };

  const s = { objs: 0, cleared: 0, residual: 0, slicesPatched: 0, slicesAlready: 0, skipStruct: 0, unavail: 0, ioerr: 0 };

  const handle = async (d) => {
    s.objs++;
    const idHex = d._id.toHexString();
    let idBuf; try { idBuf = Buffer.from(idHex, 'hex'); } catch { s.residual++; return; }
    const dataN = (d.dataVolumes || []).length, parityN = (d.parityVolumes || []).length;
    const flagged = (d.headerPatch && Array.isArray(d.headerPatch.slices)) ? d.headerPatch.slices : [];
    // A marker with no slices proves nothing -- never clear it on the strength of an empty list.
    if (!flagged.length) { s.residual++; return; }
    let allOk = true;
    for (const idx of flagged) {
      const volumeId = idx < dataN ? d.dataVolumes[idx] : d.parityVolumes[idx - dataN];
      const r = await patchSlice(idHex, idBuf, idx, volumeId, dataN, parityN, d.size, d.chunkSize);
      if (r === 'patched') s.slicesPatched++;
      else if (r === 'already') s.slicesAlready++;
      else { allOk = false; s[r === 'skip-struct' ? 'skipStruct' : r === 'unavail' ? 'unavail' : 'ioerr']++; }
    }
    if (allOk && APPLY) {
      // Every flagged slice is now current-scheme -> the patch is done. Clear the EXACT marker we validated
      // (pinned on headerPatch.at) so a concurrently-rewritten marker is never cleared. Leave sliceErrors etc.
      // untouched.
      const res = await C.updateOne({ _id: d._id, 'headerPatch.at': d.headerPatch && d.headerPatch.at }, { $unset: { headerPatch: '' } });
      if (res.modifiedCount === 1) s.cleared++; else s.residual++;
    } else if (!allOk) s.residual++;
  };

  // _id-range pagination (short queries; no long-lived cursor).
  const proj = { dataVolumes: 1, parityVolumes: 1, chunkSize: 1, size: 1, headerPatch: 1 };
  const inflight = new Set(); const t0 = Date.now();
  let lastId = null;
  for (;;) {
    if (s.objs >= LIMIT) break;
    const q = { isFile: true, headerPatch: { $exists: true } };
    if (lastId) q._id = { $gt: lastId };
    const docs = await C.find(q, { projection: proj }).sort({ _id: 1 }).limit(500).toArray();
    if (!docs.length) break;
    lastId = docs[docs.length - 1]._id;
    for (const d of docs) {
      if (s.objs >= LIMIT) break;
      const p = handle(d).catch(e => { s.residual++; console.error('handle', d._id.toString(), e && (e.message || e)); }).finally(() => inflight.delete(p));
      inflight.add(p);
      if (inflight.size >= CONC) await Promise.race(inflight);
      if (s.objs % 50000 === 0) { const r = (s.objs / ((Date.now() - t0) / 1000)).toFixed(0); console.log(`  ...${s.objs} (${r}/s) cleared ${s.cleared} residual ${s.residual} patched ${s.slicesPatched} already ${s.slicesAlready} skipStruct ${s.skipStruct} unavail ${s.unavail} ioerr ${s.ioerr}`); }
    }
    // In DRY RUN nothing is cleared, so the worklist never shrinks -- advance purely by _id to avoid re-reading.
  }
  await Promise.all(inflight);

  console.log('\n=== RESTAMP-HEADER-MD5 RESULT ===');
  console.log(JSON.stringify(s, null, 1));
  console.log(`elapsed ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  await client.close(); process.exit(0);
})().catch(e => { console.error('FATAL', e.stack || e.message); process.exit(1); });
