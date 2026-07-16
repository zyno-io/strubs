#!/usr/bin/env node
'use strict';
// ============================================================================================================
// ONE-OFF, WHOLE-FLEET, READ-ONLY VERIFY -- four checks in a SINGLE read of every slice.
//
//   per-chunk MD5 (data + parity)            -> ECHECKSUM        (via the app reader)
//   header structure + object-id/EC fields   -> EHEADER          (via the app reader)
//   whole-object MD5 (data == content.md5)   -> corrupt          (silent self-consistent-but-wrong)
//   parity recompute vs stored parity        -> EPARITY          (foreign/bad parity)
//   advisory HEADER MD5 (hdr[7:23] == md5(hdr[23:48]))           (raw 48-byte read; the reader ignores it)
//        -> header-checksum-stale  (structure+fields+data all good; the pre-2015 scheme -> SAFE to re-stamp)
//        -> header-suspect         (checksum bad AND a field disagrees or data is bad -> DO NOT patch)
//
// Writes findings to MONGO ONLY. Touches NO slice bytes. Invokes NO repair (taps reportSliceFault; run under
// maintenance freeze so the live repair worker is stopped). Data/parity faults -> `sliceErrors` (repair
// worklist). Safe stale headers -> `headerPatch` (patch worklist), set ONLY when the object is otherwise fully
// healthy so the patch pass never stamps a checksum over a slice that is under repair.
//
// RESUMABLE. A stable pass boundary is stored in runtimeConfig (`fullVerifyPassStartedAt`); every processed
// object is stamped `fullVerifiedAt=now`. The worklist is "no fullVerifiedAt >= boundary", so killing the
// process and relaunching -- even at a LOWER --conc -- resumes automatically and re-does at most one batch.
//
//   node tools/verify-all.js                      # DRY RUN: classify only, NO db writes
//   node tools/verify-all.js --sample 2000        # DRY RUN over a random sample (validation)
//   node tools/verify-all.js --apply --conc 8     # real pass, low concurrency (leave headroom for traffic)
//   node tools/verify-all.js --apply --restart    # begin a FRESH pass (reset the boundary)
//
// Run from /opt/strubs. UV_THREADPOOL_SIZE=32 recommended. Concurrency default is deliberately LOW (disk-bound
// on USB spindles; past ~16 it only thrashes seeks and starves production reads).
// ============================================================================================================

const { createHash } = require('crypto');
const { MongoClient } = require('mongodb');
const { Volume } = require('../dist/lib/io/volume');
const { volumeFleet } = require('../dist/lib/io/volume-fleet');
const { FileObject } = require('../dist/lib/io/file-object');
const { FileObjectReader } = require('../dist/lib/io/file-object/reader');
const { remediationService } = require('../dist/lib/remediation/service');
const constants = require('../dist/lib/constants');
let categorize; try { categorize = require('../dist/lib/slice-error').categorizeSliceError; } catch { categorize = (code) => code || 'unknown'; }

const SLICE_MAGIC = constants.SLICE_MAGIC;
const HDR = constants.FILE_HEADER_SIZE || 48;

const arg = (name, def) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : def; };
const APPLY = process.argv.includes('--apply');
const RESTART = process.argv.includes('--restart');
const CONC = parseInt(arg('--conc', '8'), 10);
const LIMIT = (() => { const v = arg('--limit', null); return v == null ? Infinity : parseInt(v, 10); })();
const SAMPLE = parseInt(arg('--sample', '0'), 10);
const PACE = parseInt(arg('--pace', '0'), 10); // optional ms delay per dispatched object (traffic fairness)
const MR = '/run/strubs/mounts';
const md5Of = doc => (doc && doc.md5 && doc.md5.buffer) ? doc.md5.buffer : (doc ? doc.md5 : null);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// tap the reader's fault reporter so per-(object,slice) codes are captured WITHOUT waking repair
const faultsByObj = new Map();
remediationService.reportSliceFault = (f) => {
  if (!f || f.objectId == null) return;
  let a = faultsByObj.get(f.objectId); if (!a) { a = []; faultsByObj.set(f.objectId, a); }
  a.push({ sliceIndex: f.sliceIndex, code: f.code, message: f.message });
};

(async () => {
  const client = await MongoClient.connect(process.env.STRUBS_MONGO_URL || 'mongodb://strubs:strubs@127.0.0.1:27017/strubs?authSource=admin');
  const db = client.db('strubs');
  const C = db.collection('content'), V = db.collection('volumes'), RC = db.collection('runtimeConfig');

  // ---- volumes: register, mark online iff mounted -------------------------------------------------------
  const volById = new Map();
  for (const doc of await V.find({}).toArray()) {
    const v = new Volume(doc);
    const mount = `${MR}/${doc.uuid}`;
    const online = require('fs').existsSync(`${mount}/strubs`);
    if (online) { v.mountPoint = mount; v.isStarted = true; v.isEnabled = true; v.isHealthy = true; v.isReadOnly = false; }
    else { v.isStarted = false; }
    volumeFleet['_volumes'][doc.id] = v;
    volById.set(doc.id, { vol: v, online });
  }

  // ---- resumable pass boundary --------------------------------------------------------------------------
  const BKEY = 'fullVerifyPassStartedAt';
  let boundary;
  if (SAMPLE > 0) {
    boundary = null; // sample mode ignores the worklist boundary
  } else {
    const existing = await RC.findOne({ key: BKEY });
    if (RESTART || !existing) {
      boundary = new Date();
      if (APPLY) await RC.updateOne({ key: BKEY }, { $set: { key: BKEY, value: boundary.toISOString() } }, { upsert: true });
    } else {
      boundary = new Date(existing.value);
    }
  }

  console.log(`MODE ${APPLY ? 'APPLY' : 'DRY-RUN'}  conc=${CONC}  threadpool=${process.env.UV_THREADPOOL_SIZE || '4'}` +
    (SAMPLE > 0 ? `  RANDOM SAMPLE=${SAMPLE}` : `  boundary=${boundary.toISOString()}`) + (PACE ? `  pace=${PACE}ms` : ''));

  const s = { objs: 0, healthy: 0, headerStale: 0, degraded: 0, belowQuorum: 0, corrupt: 0, incomplete: 0, noMd5: 0, error: 0,
    slicesFlagged: 0, hdrStaleSlices: 0, hdrSuspect: 0, hdrCorrupt: 0, badParity: 0 };
  const samples = { corrupt: [], belowQuorum: [], badParity: [], hdrSuspect: [], incomplete: [] };
  const note = (k, msg) => { if (samples[k] && samples[k].length < 25) samples[k].push(msg); };

  let batch = [];
  const flush = async () => { if (!APPLY || !batch.length) { batch = []; return; } const b = batch; batch = []; try { await C.bulkWrite(b, { ordered: false }); } catch (e) { console.error('bulk', e.message); } };

  // ---- advisory header check for one slice (raw 48-byte read; the reader never checks this md5) ----------
  // returns { st: 'ok'|'stale'|'suspect'|'corrupt'|'short'|'missing'|'unavail'|'ioerr' }
  // 'stale' means SAFE to re-stamp: EVERY structural byte the checksum covers (and the whole header) already
  // matches the DB / spec, and only the advisory md5 is on the pre-2015 scheme. Anything structurally off (a
  // wrong field, wrong version/hdrlen/padding, or a self-consistent-but-wrong id like the June mis-stamp) is
  // 'suspect' and is NEVER patched.
  const checkHeader = async (idHex, idBuf, sliceIndex, volumeId, dataN, parityN, size, chunkSize) => {
    const info = volById.get(volumeId);
    if (!info || !info.online) return { st: 'unavail' };
    let fh;
    try {
      fh = await info.vol.openCommittedFh(`${idHex}.${sliceIndex}`);
      const buf = Buffer.alloc(HDR);
      const { bytesRead } = await fh.read(buf, 0, HDR, 0);
      if (bytesRead < HDR) return { st: 'short' };
      if (!buf.subarray(0, 4).equals(SLICE_MAGIC)) return { st: 'corrupt' };
      // Validate the WHOLE header against the spec + DB, INDEPENDENT of the advisory checksum. Everything the
      // re-stamp would bless (bytes 23..47) plus version/hdrlen must be exactly right, or it is not "stale".
      const structOk = buf.readUInt8(4) === 1               // version
        && buf.readUInt16LE(5) === HDR                      // header length
        && buf.subarray(23, 35).equals(idBuf)               // object id
        && buf.readIntLE(35, 5) === size                    // file size (reader does NOT check this)
        && buf.readUInt8(40) === dataN                      // data slice count
        && buf.readUInt8(41) === parityN                    // parity slice count
        && buf.readUInt8(42) === sliceIndex                 // slice index
        && buf.readIntLE(43, 3) === chunkSize               // chunk size
        && buf.readUInt16LE(46) === 0;                      // end padding
      const advisoryOk = buf.subarray(7, 23).equals(createHash('md5').update(buf.subarray(23, 48)).digest());
      if (!structOk) return { st: 'suspect' };
      return { st: advisoryOk ? 'ok' : 'stale' };
    } catch (e) {
      const code = e && e.code;
      if (code === 'EUNAVAIL') return { st: 'unavail' };
      if (code === 'ENOENT') return { st: 'missing' };  // the slice file is genuinely gone -> a real fault
      return { st: 'ioerr' };                           // transient read failure -> do not conclude anything
    } finally { if (fh) await fh.close().catch(() => {}); }
  };

  const verify = async (doc) => {
    const idHex = doc._id.toHexString();
    faultsByObj.delete(idHex);
    const dataN = (doc.dataVolumes || []).length, parityN = (doc.parityVolumes || []).length;
    const idBuf = Buffer.from(idHex, 'hex');
    const rec = { id: idHex, size: doc.size, chunkSize: doc.chunkSize, md5: md5Of(doc), dataVolumes: doc.dataVolumes, parityVolumes: doc.parityVolumes, name: doc.name, containerId: doc.containerId };
    const fo = new FileObject(); await fo.loadFromRecord(rec);

    // ---- (1) advisory header md5 for every slice (raw read) --------------------------------------------
    const hdr = new Array(dataN + parityN);
    await Promise.all(Array.from({ length: dataN + parityN }, (_x, idx) => {
      const volumeId = idx < dataN ? doc.dataVolumes[idx] : doc.parityVolumes[idx - dataN];
      return checkHeader(idHex, idBuf, idx, volumeId, dataN, parityN, doc.size, doc.chunkSize)
        .then(r => { hdr[idx] = r; });
    }));

    // ---- (2) single read pass: per-chunk MD5 (data+parity) + parity recompute + whole-object MD5 -------
    const reader = new FileObjectReader(fo);
    let status, mismatchedParity = [], missingParity = [], transient = false, dataIncomplete = false;
    const parityFaultCode = new Map();
    const drainParity = (r) => {
      if (r.dataIncomplete) dataIncomplete = true;                        // a DATA slice had to be reconstructed
      if (r.mismatched.length) mismatchedParity.push(...r.mismatched);
      if (r.missing.length) missingParity.push(...r.missing);
      for (const pe of (r.parityErrors || [])) parityFaultCode.set(pe.index, pe.code); // real code, not "missing"
    };
    try {
      await reader.prepare();
      if (!fo.md5) {
        // still exercise reads (per-chunk + parity + header faults) but cannot render a whole-object verdict
        for (let r; (r = await reader.verifyChunkSetParity()) !== null;) drainParity(r);
        status = 'noMd5';
      } else {
        const h = createHash('md5'); let hashed = 0;
        for (let r; (r = await reader.verifyChunkSetParity()) !== null;) {
          drainParity(r);
          const take = Math.min(r.dataRegion.length, doc.size - hashed);
          if (take > 0) { h.update(r.dataRegion.subarray(0, take)); hashed += take; }
        }
        status = (hashed === doc.size && h.digest().equals(fo.md5)) ? 'ok' : 'corrupt';
      }
    } catch (e) {
      if (e && e.code === 'EQUORUM') status = 'belowQuorum';
      else { status = 'error'; transient = true; if (s.error < 10) console.error('read', idHex, e && (e.code || e.message)); }
    } finally { await reader.close().catch(() => {}); }

    // ---- (3) assemble per-slice errors -----------------------------------------------------------------
    const errs = {};
    const put = (idx, category, code, type, msg) => { errs[String(idx)] = { category, code, err: msg || code, type: type || (idx < dataN ? 'data' : 'parity') }; };
    let incompleteFromRead = false;
    for (const f of (faultsByObj.get(idHex) || [])) {
      if (f.sliceIndex == null) continue;
      // A volume being OFFLINE is a transient, volume-level condition -- not a per-slice permanent fault. Do not
      // flag it; let it make the object `incomplete` so it is retried when the volume returns (incident lesson).
      if (f.code === 'EUNAVAIL') { incompleteFromRead = true; continue; }
      put(f.sliceIndex, categorize(f.code, f.message), f.code, f.sliceIndex < dataN ? 'data' : 'parity', f.message);
    }
    faultsByObj.delete(idHex);

    // EPARITY (foreign parity) is only trustworthy when the DATA was fully and cleanly read: if a data slice was
    // reconstructed (dataIncomplete) or faulted, the recomputed parity is derived from possibly-wrong data, so a
    // mismatch is NOT evidence against the stored parity -- and the object is already flagged via that data fault.
    const anyDataFault = Object.keys(errs).some(k => Number(k) < dataN);
    const parityTrustworthy = !dataIncomplete && !anyDataFault;
    if (parityTrustworthy) for (const p of mismatchedParity) put(p, 'parity-mismatch', 'EPARITY', 'parity', 'stored parity != recomputed');
    // a parity slice we could not read: use the REAL code (ECHECKSUM/EIO/EHEADER/ENOENT), not a blanket "missing"
    for (const p of missingParity) if (!errs[String(p)]) {
      const code = parityFaultCode.get(p);
      if (code === 'EUNAVAIL') { incompleteFromRead = true; continue; }
      if (code && code !== 'EPARITYREAD') put(p, categorize(code), code, 'parity', `parity slice unreadable (${code})`);
      else put(p, 'missing', 'EMISSING', 'parity', 'parity slice could not be read');
    }
    // header verdicts. 'corrupt'/'suspect'/'short'/'missing' are real faults. 'ioerr'/'unavail' mean we could
    // not read the header at all -> the object was NOT fully verified (headerIncomplete). 'stale' is patchable.
    const staleSlices = [];
    let headerIncomplete = false;
    hdr.forEach((r, idx) => {
      if (!r) return;
      if (r.st === 'corrupt') { s.hdrCorrupt++; put(idx, 'header-corrupt', 'EHDR', undefined, 'slice magic missing / header unreadable'); }
      else if (r.st === 'suspect') { s.hdrSuspect++; put(idx, 'header-suspect', 'EHDRSUM', undefined, 'header checksum bad AND a structural field disagrees'); }
      else if (r.st === 'short') put(idx, 'io', 'EIO', undefined, 'short read on slice header');
      else if (r.st === 'missing') { if (!errs[String(idx)]) put(idx, 'missing', 'ENOENT', undefined, 'slice file missing'); }
      else if (r.st === 'ioerr' || r.st === 'unavail') headerIncomplete = true;
      else if (r.st === 'stale') staleSlices.push(idx);
    });

    const nErr = Object.keys(errs).length;
    if (parityTrustworthy && mismatchedParity.length) s.badParity++;

    // ---- (4) classify + build the DB update ------------------------------------------------------------
    const now = new Date();
    const set = { lastVerifiedAt: now }, unset = {};
    let cls;
    const markIncomplete = () => { cls = 'incomplete'; transient = true; s.incomplete++; note('incomplete', idHex); };
    // A slice that may RETURN -- an offline volume (EUNAVAIL) or a header we could not read (ioerr/unavail) --
    // makes the WHOLE-OBJECT verdict provisional: reconstructing through a REDUCED source set can read as
    // belowQuorum or corrupt now yet be merely degraded once that slice is back. So when ANY slice is
    // transiently unavailable, DEFER the entire object -- write nothing, keep prior flags, retry next run --
    // no matter what else was found. A definitive verdict is rendered ONLY when every slice was actually
    // consulted: read-clean, read-and-bad, or a genuinely-missing file (ENOENT) -- none of which changes on a
    // retry. (dataIncomplete with NO explaining fault is the rare in-flight-reconstruction case -> also defer,
    // so such an object is never called healthy on data it did not truly read.)
    const transientIncomplete = incompleteFromRead || headerIncomplete;
    if (status === 'error') { cls = 'error'; s.error++; }
    else if (transientIncomplete) markIncomplete();
    else if (status === 'belowQuorum') { cls = 'belowQuorum'; s.belowQuorum++; note('belowQuorum', idHex); }
    else if (status === 'corrupt') { cls = 'corrupt'; s.corrupt++; note('corrupt', idHex); }
    else if (nErr > 0) { cls = 'degraded'; s.degraded++; }   // md5 ok / noMd5 but a slice is genuinely bad -> repairable
    else if (dataIncomplete) markIncomplete();               // reconstructed with no explaining fault -> defer, never healthy
    else if (status === 'noMd5') { cls = 'noMd5'; s.noMd5++; }
    else { cls = 'healthy'; s.healthy++; }

    // fullVerifiedAt only on a DEFINITIVE verdict -- never on a transient error or an incomplete read (so the
    // object stays in the worklist and is retried, and a prior flag is never wiped by a blip or an absent slice).
    if (!transient) set.fullVerifiedAt = now;

    if (nErr) { set.sliceErrors = errs; s.slicesFlagged += nErr; } else { unset.sliceErrors = ''; }
    if (cls === 'corrupt' || cls === 'belowQuorum') set.verifyStatus = cls; else unset.verifyStatus = '';

    // headerPatch worklist: ONLY when the object is otherwise fully healthy (no faults, md5 ok). Never patch a
    // header on an object that is degraded/corrupt/below-quorum -- fix the data first, re-verify, then re-stamp.
    if (staleSlices.length && cls === 'healthy') { set.headerPatch = { slices: staleSlices, at: now }; s.headerStale++; s.hdrStaleSlices += staleSlices.length; }
    else unset.headerPatch = '';

    for (const p of mismatchedParity) note('badParity', `${idHex} parity ${p} dv=[${doc.dataVolumes}] pv=[${doc.parityVolumes}]`);
    if (cls === 'belowQuorum') note('belowQuorum', idHex);
    if (staleSlices.length && cls !== 'healthy') hdr.forEach((r, i) => { if (r && r.st === 'suspect') note('hdrSuspect', `${idHex}.${i}`); });

    // A transient read error (not a definitive verdict) writes NOTHING -- no stamp, no clear -- so the object
    // stays in the worklist and is retried cleanly on resume, and a prior flag is never wiped by a blip.
    if (APPLY && !transient) {
      const update = {};
      if (Object.keys(set).length) update.$set = set;
      if (Object.keys(unset).length) update.$unset = unset;
      batch.push({ updateOne: { filter: { _id: doc._id }, update } });
      // Flush often (not every 500): with multi-GB objects a 500-wide batch is ~an hour of work, so a crash
      // would re-read ~1 TB and the fullVerifiedAt progress marker would sit still for that whole time. A small
      // batch keeps the checkpoint tight and progress visible; the extra bulkWrites are negligible.
      if (batch.length >= 25) await flush();
    }
  };

  // ---- worklist iteration -------------------------------------------------------------------------------
  const proj = { dataVolumes: 1, parityVolumes: 1, chunkSize: 1, size: 1, md5: 1, name: 1, containerId: 1 };
  const inflight = new Set(); const t0 = Date.now();
  const logProgress = () => {
    if (s.objs % 5000 !== 0) return;
    const rate = (s.objs / ((Date.now() - t0) / 1000)).toFixed(1);
    console.log(`  ...${s.objs} (${rate}/s) healthy ${s.healthy} hdr-stale ${s.headerStale} degraded ${s.degraded} corrupt ${s.corrupt} belowQ ${s.belowQuorum} incomplete ${s.incomplete} badParity ${s.badParity} hdrSuspect ${s.hdrSuspect} err ${s.error}`);
  };
  const dispatch = async (doc) => {
    s.objs++;
    const p = verify(doc).catch(e => { s.error++; console.error('verify', doc._id.toString(), e && (e.stack || e.message)); }).finally(() => inflight.delete(p));
    inflight.add(p);
    if (PACE) await sleep(PACE);
    if (inflight.size >= CONC) await Promise.race(inflight);
    logProgress();
  };

  if (SAMPLE > 0) {
    const cur = C.aggregate([{ $match: { isFile: true } }, { $sample: { size: SAMPLE } }, { $project: proj }], { allowDiskUse: true }).batchSize(200);
    for await (const doc of cur) { if (s.objs >= LIMIT) break; await dispatch(doc); }
  } else {
    // _id-RANGE PAGINATION rather than one long-lived streaming cursor. A single find() streamed for hours gets
    // reaped server-side ("cursor id not found"); each SHORT batch query cannot. Sorted by _id and advancing
    // `lastId`, the _id index seeks PAST the already-verified prefix instead of re-scanning it, so this stays
    // O(n) even as the worklist shrinks. The fullVerifiedAt filter still drops verified docs, so a
    // transiently-skipped object is picked up on a later sweep (and a crash just re-sweeps forward, cheaply).
    const BATCH = 500;
    let lastId = null;
    for (;;) {
      if (s.objs >= LIMIT) break;
      const q = { isFile: true, $or: [{ fullVerifiedAt: { $exists: false } }, { fullVerifiedAt: { $lt: boundary } }] };
      if (lastId) q._id = { $gt: lastId };
      const batch = await C.find(q, { projection: proj }).sort({ _id: 1 }).limit(BATCH).toArray();
      if (!batch.length) break;
      lastId = batch[batch.length - 1]._id;
      for (const doc of batch) { if (s.objs >= LIMIT) break; await dispatch(doc); }
    }
  }
  await Promise.all(inflight); await flush();

  const secs = ((Date.now() - t0) / 1000);
  console.log('\n=== VERIFY-ALL RESULT ===');
  console.log(JSON.stringify(s, null, 1));
  console.log(`elapsed ${secs.toFixed(0)}s  (${(s.objs / secs).toFixed(1)} obj/s)`);
  for (const k of Object.keys(samples)) if (samples[k].length) { console.log(`\n${k} samples:`); for (const m of samples[k]) console.log('  ', m); }
  await client.close();
  process.exit(0);
})().catch(e => { console.error('FATAL', e.stack || e.message); process.exit(1); });
