#!/usr/bin/env node
'use strict';
// ============================================================================================================
// ONE-TIME BACKFILL for the single verify run already in flight when the verifyRuns history collection was
// introduced. Every run started AFTER this collection existed gets a document automatically (VerifyVolumesJob
// writes it on start); this run started on 2026-07-14 and has been resuming across restarts ever since, so it
// predates that code and would otherwise show up in /$/verify-runs with no trigger and no history at all.
//
// The trigger this backfills is not a guess -- it is reconstructed from the actual logs:
//   journalctl -u strubs, 2026-07-14T00:03:00.442Z: "[syslog-watcher] device sdak (volume 58) reported
//   ioerror; triggering targeted verify", which followed a real kernel medium-error read failure on
//   /dev/sdak at 2026-07-14T00:00:13 (sector 25964869600).
//
// Status is left as 'running' -- this run is still active as of the backfill. VerifyVolumesJob will call
// recordVerifyRunFinish() itself when it completes or is stopped; this script does not guess that outcome.
//
//   node tools/backfill-verify-run-58.js             # DRY RUN -- shows what would be written
//   node tools/backfill-verify-run-58.js --apply     # writes the document
// ============================================================================================================

const { MongoClient } = require('mongodb');

const APPLY = process.argv.includes('--apply');

const STARTED_AT = '2026-07-14T00:03:00.455Z';
const DOC = {
    _id: STARTED_AT,
    startedAt: new Date(STARTED_AT),
    scope: 'targeted',
    mode: 'full',
    volumeIds: [58],
    trigger: {
        source: 'syslog-watcher',
        device: 'sdak',
        volumeId: 58,
        kind: 'ioerror',
        detail: 'i/o error'
    },
    status: 'running'
};

(async () => {
    const client = await MongoClient.connect(process.env.STRUBS_MONGO_URL || 'mongodb://strubs:strubs@127.0.0.1:27017/strubs?authSource=admin');
    const collection = client.db('strubs').collection('verifyRuns');

    const existing = await collection.findOne({ _id: STARTED_AT });
    if (existing) {
        console.log(`ALREADY PRESENT: verifyRuns/${STARTED_AT} exists (status=${existing.status}) -- nothing to do.`);
        await client.close();
        return;
    }

    console.log(`MODE ${APPLY ? 'APPLY' : 'DRY RUN'}`);
    console.log(JSON.stringify(DOC, null, 2));

    if (APPLY) {
        await collection.updateOne({ _id: STARTED_AT }, { $set: DOC }, { upsert: true });
        console.log(`Backfilled verifyRuns/${STARTED_AT}.`);
    }
    else {
        console.log('Dry run only -- re-run with --apply to write.');
    }

    await client.close();
})().catch(err => {
    console.error('ABORT:', err);
    process.exit(1);
});
