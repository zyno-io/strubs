#!/usr/bin/env node
'use strict';
// One-off storage-stats reconcile. Recomputes the per-volume + system snapshot from the current content
// refs and replaces the cached snapshot, so the UI reports true numbers. Best run with STRUBS STOPPED so
// content isn't mutating under the scan. Run from /opt/strubs.
//   systemctl stop strubs && node tools/resync-stats.js && systemctl start strubs

const fs = require('fs');
const { MongoClient } = require('mongodb');
const { database } = require('../dist/lib/database');

const MR = '/run/strubs/mounts';
const DEAD = new Set([34, 7, 43]);

(async () => {
    const raw = await MongoClient.connect(process.env.STRUBS_MONGO_URL || 'mongodb://strubs:strubs@127.0.0.1:27017/strubs?authSource=admin');
    const vols = await raw.db('strubs').collection('volumes').find({}).toArray();
    // Readable = enabled, not-deleted, not a known-dead volume (its slices are erasures). Use DB state,
    // NOT a live mount check -- STRUBS unmounts its volumes when stopped, so mounts aren't present during
    // an offline re-sync. (The system-level unavailable counter is refreshed against live readability on
    // the first getSnapshot after start anyway.)
    const readable = vols
        .filter(v => v.enabled !== false && v.is_deleted !== true && !DEAD.has(v.id))
        .map(v => v.id)
        .sort((a, b) => a - b);
    await raw.close();

    await database.connect();
    console.log(`reconciling against ${readable.length} readable volumes: ${readable.join(',')}`);
    const snapshot = await database.computeStorageStats(readable, new Date());
    await database.replaceStorageStats(snapshot);
    console.log('re-synced storage stats. system:', JSON.stringify(snapshot.system));
    process.exit(0);
})().catch(e => { console.error('FATAL', e.stack || e.message); process.exit(1); });
