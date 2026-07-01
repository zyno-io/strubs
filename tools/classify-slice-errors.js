#!/usr/bin/env node
'use strict';

// Post-verification analysis: bucket every object that has slice errors into
// actionable remediation classes, using the categorized `sliceErrors` written by
// the verify jobs (code+category). Run AFTER a full verification so the data is
// complete.
//
//   node tools/classify-slice-errors.js                 # DB-only summary (fast)
//   node tools/classify-slice-errors.js --disk          # + confirm a sample on disk
//   node tools/classify-slice-errors.js --disk --limit 200 --bucket lost
//
// Buckets (T = data+parity slices, need `data` to reconstruct):
//   readable-now        good slices >= data            (errors only on redundant slices)
//   recoverable-remount good+unavailable >= data       (just remount the offline volume)
//   recoverable-restamp good+unavailable+headerMismatch >= data (re-stamp header bytes)
//   lost                fewer than `data` potentially-intact slices anywhere
// A "needs-reconstruct" note is added when corrupt/missing slices remain after the
// object is otherwise recoverable (rebuild them to restore full redundancy).

const fs = require('fs');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');

const FILE_HEADER = 48, CHUNK_HEADER = 16;
const MONGO = process.env.STRUBS_MONGO_URL || 'mongodb://strubs:strubs@127.0.0.1:27017/strubs?authSource=admin';
const MOUNT_ROOT = '/run/strubs/mounts';

const argv = process.argv.slice(2);
const flag = name => argv.includes(name);
const opt = (name, def) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; };
const DISK = flag('--disk');
const LIMIT = parseInt(opt('--limit', '100'), 10);
const ONLY_BUCKET = opt('--bucket', null);

// Derive the category of a stored slice error. Prefers the new `category` field;
// falls back to code/checksum/message (mirrors lib/slice-error.ts) so this tool
// is useful on legacy, pre-categorization data too.
const CODE_CATEGORY = { ECHECKSUM: 'checksum', EHEADER: 'header-mismatch', EUNAVAIL: 'volume-unavailable', ENOENT: 'missing', EIO: 'io', ETIMEOUT: 'timeout' };
function categoryOf(e) {
    if (e.category) return e.category;
    if (e.checksum) return 'checksum';
    if (e.code && CODE_CATEGORY[e.code]) return CODE_CATEGORY[e.code];
    const m = (e.err || '').toLowerCase();
    if (m.includes('checksum')) return 'checksum';
    if (m.includes('header') && m.includes('mismatch')) return 'header-mismatch';
    if (m.includes('not readable') || m.includes('mount point is not configured') || m.includes('volume is not')) return 'volume-unavailable';
    if (m.includes('enoent') || m.includes('no such file')) return 'missing';
    if (m.includes('timed out') || m.includes('timeout')) return 'timeout';
    if (m.includes('short read') || m.includes('i/o error') || m.includes('input/output')) return 'io';
    return 'unknown';
}

function classify(doc) {
    const dataN = (doc.dataVolumes || []).length;
    const parityN = (doc.parityVolumes || []).length;
    const total = dataN + parityN;
    const se = doc.sliceErrors || {};
    let good = 0, unavail = 0, restamp = 0, corrupt = 0;
    const cats = {};
    for (let i = 0; i < total; i++) {
        const e = se[String(i)];
        if (!e) { good++; continue; }
        const cat = categoryOf(e);
        cats[cat] = (cats[cat] || 0) + 1;
        if (cat === 'volume-unavailable') unavail++;
        else if (cat === 'header-mismatch') restamp++;
        else corrupt++;
    }
    const potentiallyGood = good + unavail + restamp;
    let bucket;
    if (good >= dataN) bucket = 'readable-now';
    else if (good + unavail >= dataN) bucket = 'recoverable-remount';
    else if (potentiallyGood >= dataN) bucket = 'recoverable-restamp';
    else bucket = 'lost';
    return { bucket, dataN, parityN, good, unavail, restamp, corrupt, cats, needsReconstruct: corrupt > 0 && bucket !== 'lost' };
}

// ---- on-disk confirmation (uses verified geometry) ----
function layout(diskSize, chunkSize) {
    const o = [];
    if (diskSize <= chunkSize) { o.push({ off: FILE_HEADER, dataOff: FILE_HEADER + CHUNK_HEADER, dataLen: diskSize - FILE_HEADER - CHUNK_HEADER }); return o; }
    o.push({ off: FILE_HEADER, dataOff: FILE_HEADER + CHUNK_HEADER, dataLen: chunkSize - FILE_HEADER - CHUNK_HEADER });
    let off = chunkSize;
    while (off < diskSize) { const slot = Math.min(chunkSize, diskSize - off); o.push({ off, dataOff: off + CHUNK_HEADER, dataLen: slot - CHUNK_HEADER }); off += slot; }
    return o;
}

// Confirm how many of the object's data slices are physically present + checksum-clean
// on currently-mounted volumes (offline-volume slices are reported separately).
function confirmOnDisk(doc, mount) {
    const id = doc._id.toString();
    const dataVols = doc.dataVolumes || [], dataN = dataVols.length, chunkSize = doc.chunkSize;
    const shard = `${id.substring(0, 2)}/${id.substring(2, 4)}/${id.substring(4, 6)}`;
    let intact = 0, mountedAbsent = 0, offline = 0, csumFail = 0;
    for (let i = 0; i < dataN; i++) {
        const mp = mount[dataVols[i]];
        if (!mp) { offline++; continue; }
        const p = `${mp}/strubs/${shard}/${id}.${i}`;
        let fd, sz;
        try { sz = fs.statSync(p).size; fd = fs.openSync(p, 'r'); } catch { mountedAbsent++; continue; }
        const lay = layout(sz, chunkSize); let bad = false;
        for (const k of [...new Set([0, Math.floor(lay.length / 2), lay.length - 1])]) {
            const c = lay[k]; if (!c || c.dataLen <= 0) continue;
            const hh = Buffer.alloc(CHUNK_HEADER), bd = Buffer.alloc(c.dataLen);
            fs.readSync(fd, hh, 0, CHUNK_HEADER, c.off); fs.readSync(fd, bd, 0, c.dataLen, c.dataOff);
            if (!crypto.createHash('md5').update(bd).digest().equals(hh)) { bad = true; break; }
        }
        fs.closeSync(fd); if (bad) csumFail++; else intact++;
    }
    return { dataN, intact, mountedAbsent, offline, csumFail };
}

(async () => {
    const client = await MongoClient.connect(MONGO);
    const db = client.db('strubs');
    let mount = {};
    if (DISK) for (const v of await db.collection('volumes').find({}).toArray()) mount[v.id] = `${MOUNT_ROOT}/${v.uuid}`;

    const buckets = {};
    const catTotals = {};
    const byContainerLost = {};
    let scanned = 0;
    const diskSamples = [];

    const cur = db.collection('content').find({ sliceErrors: { $exists: true, $ne: {} } });
    for await (const doc of cur) {
        if (!(doc.dataVolumes || []).length) continue;
        scanned++;
        const r = classify(doc);
        buckets[r.bucket] = (buckets[r.bucket] || 0) + 1;
        for (const [c, n] of Object.entries(r.cats)) catTotals[c] = (catTotals[c] || 0) + n;
        if (r.bucket === 'lost') byContainerLost[doc.containerId] = (byContainerLost[doc.containerId] || 0) + 1;
        if (DISK && diskSamples.length < LIMIT && (!ONLY_BUCKET || r.bucket === ONLY_BUCKET))
            diskSamples.push({ id: doc._id.toString(), name: doc.name, bucket: r.bucket, db: r, disk: confirmOnDisk(doc, mount) });
    }

    console.log(`scanned objects with sliceErrors: ${scanned}\n`);
    console.log('buckets:');
    for (const [b, n] of Object.entries(buckets).sort((a, b2) => b2[1] - a[1])) console.log(`  ${b.padEnd(20)} ${n}`);
    console.log('\nslice-error categories (total slices):');
    for (const [c, n] of Object.entries(catTotals).sort((a, b) => b[1] - a[1])) console.log(`  ${c.padEnd(20)} ${n}`);
    const topLost = Object.entries(byContainerLost).sort((a, b) => b[1] - a[1]).slice(0, 10);
    if (topLost.length) { console.log('\nlost by container (top 10):'); for (const [c, n] of topLost) console.log(`  ${c}: ${n}`); }

    if (DISK) {
        console.log(`\non-disk confirmation (${diskSamples.length} sampled${ONLY_BUCKET ? `, bucket=${ONLY_BUCKET}` : ''}):`);
        let agree = 0;
        for (const s of diskSamples) {
            const d = s.disk;
            const recoverableOnMounted = d.intact >= d.dataN;
            if ((s.bucket !== 'lost') === (recoverableOnMounted || d.offline > 0)) agree++;
            console.log(`  ${s.id} ${JSON.stringify(s.name)} bucket=${s.bucket} dataN=${d.dataN} intact=${d.intact} offline=${d.offline} mountedAbsent=${d.mountedAbsent} csumFail=${d.csumFail}`);
        }
        console.log(`\n  disk-vs-db agreement: ${agree}/${diskSamples.length}`);
    }

    await client.close();
})().catch(e => { console.error('ERR', e.stack || e.message); process.exit(1); });
