import type { StoredObjectRecord } from '../../io/file-object';
import type { HttpRequest, HttpResponse } from './server';
import { applyFileMetadataHeaders, applyObjectIdentityHeaders, applySliceHeaders, applyObjectSecurityHeaders } from './object-response-headers';

export class ObjectHeadRequest {
    private readonly objectRecord: StoredObjectRecord;
    private readonly response: HttpResponse;

    constructor(
        private readonly _requestId: number,
        objectRecord: StoredObjectRecord,
        private readonly _request: HttpRequest,
        response: HttpResponse
    ) {
        this.objectRecord = objectRecord;
        this.response = response;
    }

    async process(): Promise<void> {
        applyObjectIdentityHeaders(this.response, this.objectRecord);

        if (this.objectRecord.isContainer) {
            this.response.setHeader('X-Is-Container', 'true');
        }

        else {
            this.response.setHeader('Content-Length', this.objectRecord.size);
            applyFileMetadataHeaders(this.response, this.objectRecord);
            applySliceHeaders(this.response, this.objectRecord);
            applyObjectSecurityHeaders(this.response, this.objectRecord);
        }

        this.response.end();
    }
}
