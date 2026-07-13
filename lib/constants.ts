// THE MAGIC BYTES THAT ARE ACTUALLY ON THE PLATTERS.
//
// These four bytes open the 48-byte header of every slice of all ~3.5 million objects on this array, and they
// are not the bytes anybody intended to write.
//
// The writer used to say `writeBuf.write('\x01\xfb\x02\xfb', 0)`. Buffer.write() defaults to UTF-8, and \xfb
// is U+00FB, which UTF-8 encodes as TWO bytes -- c3 bb. So that call actually emitted six bytes,
// `01 c3 bb 02 c3 bb`, of which the trailing two were immediately overwritten by the version and
// header-length fields at offsets 4-6. What survived, and what has been landing on disk since the first
// object ever written, is:
//
//     01 c3 bb 02        (and NOT the 01 fb 02 fb that the source appeared to promise)
//
// It is a bug, and it is now permanent. "Fixing" it would not repair history, it would DIVIDE it: every slice
// written before the change would stop matching a reader looking for the corrected bytes, and 130TB would
// become unreadable in a single deploy. These bytes ARE the format now.
//
// So it is declared here, once, as the literal bytes that are on the disk, and the writer and every reader
// share it. The old spelling was worse than merely wrong -- it was MISLEADING. The code said one thing and
// the platters said another, and anybody who trusted the source would have built a reader that found nothing
// and concluded the array was empty. Nothing about what we write has changed. The code has simply stopped
// lying about it.
export const SLICE_MAGIC = Buffer.from([0x01, 0xc3, 0xbb, 0x02]);

export const constants = {
    FILE_HEADER_SIZE: 48,
    CHUNK_HEADER_SIZE: 16,
    CHUNK_HEADER_ALGO: 'md5'
} as const;

export type Constants = typeof constants;
