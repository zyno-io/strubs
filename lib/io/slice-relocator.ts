import type { Volume } from './volume';
import type { FileObject } from './file-object';

// Byte-copy a slice file from one volume to another (temp -> atomic commit). Returns false if the
// source is unreadable/missing or the copy fails.
async function copyFile(sourceVol: Volume, targetVol: Volume, fileName: string): Promise<boolean> {
    let src; let dst;
    try { src = await sourceVol.openCommittedFh(fileName); }
    catch { return false; } // offline / missing -> caller falls back to reconstruct
    try {
        dst = await targetVol.createTemporaryFh(fileName);
        const buf = Buffer.allocUnsafe(1 << 20);
        let pos = 0;
        for (;;) {
            const { bytesRead } = await src.read(buf, 0, buf.length, pos);
            if (!bytesRead) break;
            let written = 0;
            while (written < bytesRead) { const r = await dst.write(buf, written, bytesRead - written); written += r.bytesWritten; }
            pos += bytesRead;
        }
        // FSYNC BEFORE THE COMMIT. Closing a file flushes it to the page cache and no further -- the bytes
        // may not be on the platter at all. commitTemporaryFile() then renames it into place and makes that
        // NAME durable, and the caller takes the whole thing as proof the slice is safely on the target:
        // rebalance flips the object's ref to it and DELETES THE SOURCE. Lose power in that window and you
        // are left with a perfectly durable directory entry for a slice whose contents never existed, and
        // the only real copy already unlinked. Erasure coding can rebuild one such slice; it cannot rebuild
        // a habit.
        await dst.sync();
        await dst.close(); dst = undefined;
        await targetVol.commitTemporaryFile(fileName);
        return true;
    }
    catch { if (dst) await dst.close().catch(() => undefined); await targetVol.deleteTemporaryFile(fileName).catch(() => undefined); return false; }
    finally { await src.close().catch(() => undefined); }
}

// Copy-first relocation of a slice: copy the file off an ONLINE source to the target, then validate
// the copy (open + checksum every chunk via the slice verifier). The object's ref for this slice must
// already point at the target so validation reads the copy. Returns true iff the target now holds a
// valid copy; false (drop it, fall back to reconstruct) otherwise. Suitable for DATA slices only --
// parity should be recomputed, never copied (a byte-copy preserves known-bad parity).
export async function relocateByCopy(object: FileObject, sliceIndex: number, fileName: string, sourceVol: Volume, targetVol: Volume): Promise<boolean> {
    if (!sourceVol.isReadable || !targetVol.isWritable)
        return false;
    if (!await copyFile(sourceVol, targetVol, fileName))
        return false;
    try {
        const { FileObjectSliceVerifier } = require('./file-object/slice-verifier') as typeof import('./file-object/slice-verifier');
        await new FileObjectSliceVerifier(object).verifySlice(sliceIndex);
        return true;
    }
    catch {
        await targetVol.deleteCommittedFile(fileName).catch(() => undefined);
        return false;
    }
}
