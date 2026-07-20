import { describe, expect, it } from 'vitest';

import { categorizeSliceError } from '../lib/slice-error';

describe('categorizeSliceError', () => {
    it('maps known source codes to categories', () => {
        expect(categorizeSliceError('ECHECKSUM')).toBe('checksum');
        expect(categorizeSliceError('EHEADER')).toBe('header-mismatch');
        expect(categorizeSliceError('EUNAVAIL')).toBe('volume-unavailable');
        expect(categorizeSliceError('ENOENT')).toBe('missing');
        expect(categorizeSliceError('EIO')).toBe('io');
        expect(categorizeSliceError('ETIMEOUT')).toBe('timeout');
        expect(categorizeSliceError('EPARITY')).toBe('parity-mismatch');
        expect(categorizeSliceError('EHDRSUM')).toBe('header-checksum');
    });

    it('prefers the code over the message', () => {
        // Wrapper messages contain "failed to read slice header" for both genuine
        // I/O faults and header mismatches; the code must win.
        expect(categorizeSliceError('EHEADER', 'failed to read slice header: slice header object id mismatch')).toBe('header-mismatch');
        expect(categorizeSliceError('EIO', 'failed to read slice header: short read on slice header')).toBe('io');
    });

    it('treats EOPEN and unrecognized codes as unknown', () => {
        expect(categorizeSliceError('EOPEN')).toBe('unknown');
        expect(categorizeSliceError('ESOMETHINGELSE')).toBe('unknown');
        expect(categorizeSliceError(undefined)).toBe('unknown');
    });

    it('falls back to message sniffing when no code is present', () => {
        expect(categorizeSliceError(undefined, 'checksum mismatch at file:0')).toBe('checksum');
        expect(categorizeSliceError(undefined, 'slice header object id mismatch')).toBe('header-mismatch');
        expect(categorizeSliceError(undefined, 'volume is not readable')).toBe('volume-unavailable');
        expect(categorizeSliceError(undefined, 'mount point is not configured')).toBe('volume-unavailable');
        expect(categorizeSliceError(undefined, 'ENOENT: no such file or directory')).toBe('missing');
        expect(categorizeSliceError(undefined, 'slice read slice header timed out after 30000ms')).toBe('timeout');
        expect(categorizeSliceError(undefined, 'short read on slice chunk: 1/4096')).toBe('io');
    });
});
