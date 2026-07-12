import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { normalizeIdentity } from '../lib/config';

// The instance identity is the 16 bytes that make the entire array recognisable. Losing it, or replacing
// it, orphans every disk permanently -- so its handling gets its own tests.
describe('instance identity', () => {
    describe('normalizeIdentity', () => {
        it('reduces any representation to the same 16 hex bytes', () => {
            // Production stores a hyphenated UUID; only the hex bytes are ever compared or buffered.
            const hyphenated = '2fb05f23-1d5e-4c00-bb71-f3109b42476c';
            const bare = '2fb05f231d5e4c00bb71f3109b42476c';
            expect(normalizeIdentity(hyphenated)).toBe(bare);
            expect(normalizeIdentity(bare)).toBe(bare);
            expect(normalizeIdentity('  ' + hyphenated.toUpperCase() + '\n')).toBe(bare);
            expect(Buffer.from(normalizeIdentity(hyphenated), 'hex')).toHaveLength(16);
        });
    });

    describe('config.loadIdentity / adoptIdentity', () => {
        let dir: string;
        let identityPath: string;

        beforeEach(async () => {
            dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'strubs-identity-'));
            identityPath = path.join(dir, 'identity');
            vi.resetModules();
        });

        afterEach(async () => {
            await fsp.rm(dir, { recursive: true, force: true });
            vi.restoreAllMocks();
        });

        // Build a Config whose identity file lives in a temp dir, by pointing the module's fs at it.
        async function loadConfigWith(fileContents: string | null) {
            vi.doMock('fs', async () => {
                const real = await vi.importActual<typeof import('fs')>('fs');
                return {
                    ...real,
                    promises: {
                        ...real.promises,
                        readFile: async (p: any, ...rest: any[]) => {
                            if (String(p) === '/var/lib/strubs/identity') {
                                if (fileContents === null) {
                                    const err: any = new Error('ENOENT');
                                    err.code = 'ENOENT';
                                    throw err;
                                }
                                return Buffer.from(fileContents);
                            }
                            return (real.promises.readFile as any)(p, ...rest);
                        },
                        writeFile: async (p: any, data: any, opts: any) => {
                            const target = String(p) === '/var/lib/strubs/identity' ? identityPath : p;
                            return real.promises.writeFile(target, data, opts);
                        },
                        mkdir: async (p: any, opts: any) => {
                            if (String(p) === '/var/lib/strubs') return undefined;
                            return real.promises.mkdir(p, opts);
                        }
                    }
                };
            });
            const { config } = await import('../lib/config');
            return config;
        }

        it('tolerates a MISSING identity file: null, no throw, and never generates one', async () => {
            const config = await loadConfigWith(null);
            await expect(config.loadIdentity()).resolves.toBeUndefined();   // must NOT throw
            expect(config.identity).toBeNull();
            expect(config.identityBuffer).toBeNull();
            // Crucially, nothing was written -- a freshly-generated identity would orphan every disk.
            await expect(fsp.access(identityPath)).rejects.toThrow();
        });

        it('loads a hyphenated UUID identity into 16 raw bytes', async () => {
            const config = await loadConfigWith('2fb05f23-1d5e-4c00-bb71-f3109b42476c\n');
            await config.loadIdentity();
            expect(config.identity).toBe('2fb05f23-1d5e-4c00-bb71-f3109b42476c');
            expect(config.identityBuffer).toHaveLength(16);
        });

        it('adopts an identity recovered from a manifest and populates the buffer in-process', async () => {
            const config = await loadConfigWith(null);
            await config.loadIdentity();                       // absent -> null

            await config.adoptIdentity('2fb05f23-1d5e-4c00-bb71-f3109b42476c');

            expect(config.identity).toBe('2fb05f23-1d5e-4c00-bb71-f3109b42476c');
            // Writing the file is not enough: volumes validate against identityBuffer in-process.
            expect(config.identityBuffer).toEqual(Buffer.from('2fb05f231d5e4c00bb71f3109b42476c', 'hex'));
            expect(await fsp.readFile(identityPath, 'utf8')).toBe('2fb05f23-1d5e-4c00-bb71-f3109b42476c');
        });

        it('re-adopting the SAME identity in a different representation is allowed, not a conflict', async () => {
            const config = await loadConfigWith('2fb05f23-1d5e-4c00-bb71-f3109b42476c');
            await config.loadIdentity();
            // Same 16 bytes, bare-hex form. Comparing raw strings here would wrongly reject it.
            await expect(config.adoptIdentity('2FB05F231D5E4C00BB71F3109B42476C')).resolves.toBeUndefined();
        });

        it('REFUSES to overwrite a different identity (two arrays must never be merged)', async () => {
            const config = await loadConfigWith('2fb05f23-1d5e-4c00-bb71-f3109b42476c');
            await config.loadIdentity();
            await expect(config.adoptIdentity('ffffffff-ffff-ffff-ffff-ffffffffffff'))
                .rejects.toThrow(/different instance identity/);
        });

        it('rejects a malformed identity rather than writing garbage', async () => {
            const config = await loadConfigWith(null);
            await expect(config.adoptIdentity('too-short')).rejects.toThrow(/16 bytes/);
        });
    });
});
