#!/usr/bin/env node
'use strict';
// One-off backfill of `bucketId` onto every pre-existing content document (files + containers).
//
// PURELY ADDITIVE. It only ever $sets bucketId on documents that LACK it ({ bucketId: {$exists:false} }),
// so it never rewrites an existing value, never deletes anything, and never touches a disk. Safe to run
// while the service is live (new writes already carry bucketId) and safe to re-run (idempotent).
//
//   node tools/backfill-bucketids.js            # DRY RUN: report what WOULD be stamped, write nothing
//   node tools/backfill-bucketids.js --apply    # perform the backfill
//
// It reuses the exact, unit-tested repository logic (dist/lib/database) rather than reimplementing the
// tree walk, so the historical backfill and the creation-time stamping can never drift apart.

const APPLY = process.argv.includes('--apply');

async function main() {
    const { database } = require('../dist/lib/database');
    await database.connect();               // also ensures the sparse bucketId index exists
    try {
        console.log(APPLY ? '=== APPLYING bucketId backfill ===' : '=== DRY RUN (no writes) ===');
        const started = Date.now();
        const res = await database.backfillBucketIds({ apply: APPLY });
        const secs = ((Date.now() - started) / 1000).toFixed(1);
        console.log(`containers ${APPLY ? 'stamped' : 'to stamp'}: ${res.containersStamped}`);
        console.log(`objects    ${APPLY ? 'stamped' : 'to stamp'}: ${res.objectsStamped}`);
        console.log(`skipped containers (orphan/cycle, left unstamped): ${res.skippedContainers}`);
        console.log(`elapsed: ${secs}s`);
        if (!APPLY)
            console.log('\nre-run with --apply to perform the backfill.');
    }
    finally {
        await database.close?.();
    }
}

main().then(() => process.exit(0)).catch(err => {
    console.error('backfill failed:', err);
    process.exit(1);
});
