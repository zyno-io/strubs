import type { StoredObjectRecord } from '../../io/file-object';
import type { HttpResponse } from './server';

export function applyObjectIdentityHeaders(res: HttpResponse, record: StoredObjectRecord): void {
    res.setHeader('X-Object-Id', record.id);

    if (record.containerId)
        res.setHeader('X-Container-Id', record.containerId);
}

export function applyFileMetadataHeaders(res: HttpResponse, record: StoredObjectRecord): void {
    if (record.md5)
        res.setHeader('Content-MD5', record.md5.toString('hex'));

    if (record.mime)
        res.setHeader('Content-Type', record.mime);
}

// Content types that a browser may render INLINE without executing anything the uploader controls.
// Deliberately narrow: `image/svg+xml` is NOT here -- an SVG can carry <script>, so it is treated like
// any other active content and forced to download. Everything not on this list downloads rather than
// renders, which is what neutralises "upload evil.html to a public bucket, get an admin to open it".
const INLINE_SAFE = new Set([
    'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif',
    'image/bmp', 'image/x-icon', 'image/tiff'
]);
function isInlineSafe(mime: string | null | undefined): boolean {
    if (!mime)
        return false;
    const type = mime.split(';')[0].trim().toLowerCase();
    return INLINE_SAFE.has(type) || type.startsWith('video/') || type.startsWith('audio/') || type === 'application/octet-stream';
}

// Defence in depth against object-hosted active content. The origin split (object API on its own
// port/scheme) is the real boundary; these headers ensure that even so, uploaded HTML/SVG/JS cannot
// execute in a browser that opens it directly.
//   - nosniff: the browser honours our Content-Type instead of guessing an executable one;
//   - Content-Disposition: attachment for anything not inline-safe, so it downloads instead of rendering;
//   - CSP: the content can load/run nothing.
// A caller-supplied disposition (?download_as) already forces a download, so it is left untouched.
//
// The CSP is deliberately SPLIT by inline-safety, because one blanket policy cannot serve both cases:
//
//   * Active/unknown content is force-downloaded anyway, so it gets the full lockdown -- `sandbox` and
//     no sources at all. If a browser somehow renders it regardless, it can still do nothing.
//
//   * Inert media (image/video/audio) we deliberately render inline. Navigating straight to a video makes
//     the browser build a small viewer document around it, and the response's CSP applies to THAT
//     document -- so a blanket `default-src 'none'; sandbox` forbids the viewer from loading the very
//     bytes it was opened to show (and `sandbox` blocks its own scripts). That broke direct playback of
//     every video and audio object. These bytes are not a document and cannot execute; `nosniff` stops
//     the browser reinterpreting them as one. So the policy only has to permit the media itself.
const CSP_INERT_MEDIA = "default-src 'none'; media-src 'self'; img-src 'self'";
const CSP_LOCKDOWN = "default-src 'none'; sandbox";

export function applyObjectSecurityHeaders(res: HttpResponse, record: StoredObjectRecord): void {
    res.setHeader('X-Content-Type-Options', 'nosniff');

    if (isInlineSafe(record.mime)) {
        res.setHeader('Content-Security-Policy', CSP_INERT_MEDIA);
        return;
    }

    res.setHeader('Content-Security-Policy', CSP_LOCKDOWN);
    if (!res.hasHeader('Content-Disposition'))
        res.setHeader('Content-Disposition', 'attachment');
}

// A filename for Content-Disposition, with quotes/backslashes/control chars stripped so a hostile
// ?download_as value cannot inject additional header directives or break out of the quoted string.
export function sanitizeDispositionFilename(name: string): string {
    return name.replace(/[\r\n"\\]/g, '').replace(/[\x00-\x1f]/g, '').slice(0, 255);
}

export function applySliceHeaders(res: HttpResponse, record: StoredObjectRecord): void {
    res.setHeader('X-Data-Slice-Count', record.dataVolumes.length);
    res.setHeader('X-Data-Slice-Volumes', record.dataVolumes.join(','));
    res.setHeader('X-Parity-Slice-Count', record.parityVolumes.length);
    res.setHeader('X-Parity-Slice-Volumes', record.parityVolumes.join(','));
    res.setHeader('X-Chunk-Size', record.chunkSize);
}
