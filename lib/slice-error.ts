import type { SliceErrorCategory } from './database/types';

// Map the source error code to a coarse category. Codes are assigned at the
// point of failure (slice.ts / volume.ts): ECHECKSUM, EHEADER, EUNAVAIL,
// ETIMEOUT, EIO, and the filesystem ENOENT preserved through openCommittedFh.
const CODE_CATEGORY: Record<string, SliceErrorCategory> = {
    ECHECKSUM: 'checksum',
    EHEADER: 'header-mismatch',
    EUNAVAIL: 'volume-unavailable',
    ENOENT: 'missing',
    EIO: 'io',
    ETIMEOUT: 'timeout',
    EPARITY: 'parity-mismatch',
    EHDRSUM: 'header-checksum'
};

// IOABORT (io-shutdown.ts) is raised when our own shutdown cancels in-flight I/O. It is
// evidence about us, not about the slice: we never learned whether the slice is readable.
// So it must never be persisted as a slice error, and any already-persisted entry must not
// count toward quorum -- otherwise a restart mid-verify permanently parks a healthy object
// as below-quorum. Accepts either a thrown Error or a stored SliceErrorInfo (both carry .code).
export function isIOAbort(subject: unknown): boolean {
    return (subject as { code?: string } | undefined)?.code === 'IOABORT';
}

// Derive a SliceErrorCategory from an error code (preferred) with a message-based
// fallback. The fallback exists so errors raised on paths that don't set a code,
// and historical-shaped errors, still classify without re-instrumenting every site.
export function categorizeSliceError(code: string | undefined, message?: string): SliceErrorCategory {
    if (code && CODE_CATEGORY[code])
        return CODE_CATEGORY[code];

    const m = (message ?? '').toLowerCase();
    if (m.includes('checksum'))
        return 'checksum';
    if (m.includes('header') && m.includes('mismatch'))
        return 'header-mismatch';
    if (m.includes('not readable') || m.includes('mount point is not configured') || m.includes('volume is not'))
        return 'volume-unavailable';
    if (m.includes('enoent') || m.includes('no such file'))
        return 'missing';
    if (m.includes('timed out') || m.includes('timeout'))
        return 'timeout';
    if (m.includes('short read') || m.includes('i/o error') || m.includes('input/output'))
        return 'io';
    return 'unknown';
}
