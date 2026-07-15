import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// ⚠️ A STATIC GUARD AGAINST REGRESSING THE by-uuid MIGRATION.
//
// The recovery-key and bootstrap paths address every LUKS header by its container uuid (`cryptsetup ... UUID=<u>`
// via luksHeaderSpecifier), never by /dev/sdX1 -- because a path can point at a different disk by the time we
// write, and these are USB disks that flap. The migration DELETED the per-op container-uuid bracketing that used
// to compensate; the safety now lives entirely in "we never hand a path to a key operation".
//
// So this test fails if anyone reintroduces a path-based header operation in those modules. It is deliberately a
// source-text check, not a behaviour test: the whole point is to catch the shape at author time, before it can
// ship. (Provisioning is intentionally NOT covered here -- it operates on a FRESH header whose uuid does not
// exist until luksFormat mints it, and it is fenced on the whole-disk SMART serial instead. See
// notes/dr-g-by-uuid-migration-plan.md, stage 5.)
const MIGRATED = ['lib/io/luks-recovery-key.ts', 'lib/recovery/bootstrap.ts'];

// Passing any of these a raw device PATH (disk.path / entry.device / a /dev/ string) is the regression.
const FORBIDDEN = [
    /testPassphrase\(\s*disk\.path/,
    /addPassphrase\(\s*disk\.path/,
    /removePassphrase\(\s*disk\.path/,
    /ensure\(\s*entry\.device/,          // bootstrap keyslot restore, pre-migration shape
    /\bdeps\.containerUuid\b/             // the deleted bracketing dep -- its return is not an operable handle
];

describe('the migrated LUKS paths never address a header by device path', () => {
    for (const file of MIGRATED) {
        it(`${file} operates on headers by UUID=, not by /dev/ path`, () => {
            const src = readFileSync(resolve(__dirname, '..', file), 'utf8');
            for (const pattern of FORBIDDEN)
                expect(src, `${file} reintroduced a path-based LUKS op matching ${pattern}`).not.toMatch(pattern);
        });
    }
});
