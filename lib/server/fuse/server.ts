import Fuse from 'fuse-native';

import { database } from '../../database';
import type { ContentDocument } from '../../database';
import { type StoredObjectRecord, type FileObject } from '../../io/file-object';
import { fileObjectService, type FileObjectService } from '../../io/file-object/service';
import { createLogger } from '../../log';

const log = createLogger('fuse-server');

type FuseStat = {
    mtime: Date;
    atime: Date;
    ctime: Date;
    size: number;
    mode: number;
    uid: number;
    gid: number;
};

type FuseGetattrCallback = (code: number, stat?: FuseStat) => void;
type FuseGenericCallback<T = unknown> = (code: number, payload?: T) => void;
type FuseFdCallback = (code: number, fd?: number) => void;
type FuseReadCallback = (result: number) => void;

type FuseServerDeps = {
    fileObjectService: FileObjectService;
};

const defaultDeps: FuseServerDeps = {
    fileObjectService
};

export class FuseServer {
    private readonly mountPath: string;
    private readonly _fdCache: Record<number, FileObject> = {};
    private fuse: Fuse | null = null;
    private readonly deps: FuseServerDeps;
    private _nextRequestId = 1;

    constructor(deps: FuseServerDeps = defaultDeps) {
        this.mountPath = '/run/strubs/data';
        this.deps = deps;
        //this._readCnt = 0;
    }

    async start(): Promise<void> {
        log('mounting at ' + this.mountPath + ' ...');

        const opts = {
            force: true,
            mkdir: true
        };

        const handlers = this._buildHandlers();

        this.fuse = new Fuse(this.mountPath, handlers, opts);
        this.fuse.mount(err => {
            if (err)
                log('failed to mount:', err);
            else
                log('mounted');
        });

        /*
        process.on('SIGINT', () => {
            log('unmounting...');
            fuse.unmount(this.mountPath, err => {
                if (err)
                    log.error('failed to unmount:', err);
                else
                    log('unmounted');
            });
        });
        */
    }

    async stop(): Promise<void> {
        if (!this.fuse)
            return;

        // Close all open file objects before unmounting
        for (const [fd, object] of Object.entries(this._fdCache)) {
            try {
                await object.close();
            }
            catch (err) {
                log.error('failed to close file object during shutdown:', err);
            }
            delete this._fdCache[Number(fd)];
        }

        await new Promise<void>((resolve, reject) => {
            this.fuse?.unmount(err => {
                if (err) {
                    log.error('failed to unmount:', err);
                    reject(err);
                }
                else {
                    log('unmounted');
                    resolve();
                }
            });
        });

        this.fuse = null;
    }

    // async fuse_init() {
    //     log('init');
    // }

    // async fuse_access(path, mode, cb) {
    //     log('access', path, mode);
    //     cb(0);
    // }

    // async fuse_statfs(path, cb) {
    //     log('statfs', path);
    //     cb(0, {

    //     });
    // }

    async fuse_getattr(path: string, cb: FuseGetattrCallback): Promise<void> {
        log('getattr', path);

        if (path === '/')
            return this._fuse_getattrForDirectory(cb);

        try {
            const normalizedPath = path.slice(1);
            const object = await this._getObjectFromPath(normalizedPath);

            if (object.isContainer)
                return this._fuse_getattrForDirectory(cb);

            return this._fuse_getattrForObject(this._ensureFileRecord(object), cb);
        }
        catch (err) {
            cb(this._translateError(err));
        }
    }

    private _fuse_getattrForDirectory(cb: FuseGetattrCallback): void {
        cb(0, {
            mtime: new Date(),
            atime: new Date(),
            ctime: new Date(),
            // nlink: 1,
            size: 100,
            mode: 0o40755,
            uid: this._getUid(),
            gid: this._getGid()
        });
    }

    private _fuse_getattrForObject(object: StoredObjectRecord, cb: FuseGetattrCallback): void {
        const ts = database.getTimestampFromId(object.id);

        cb(0, {
            mtime: new Date(ts),
            atime: new Date(ts),
            ctime: new Date(ts),
            size: object.size,
            mode: 0o100644,
            uid: this._getUid(),
            gid: this._getGid()
        });
    }

    // async fuse_fgetattr(path, fd, cb) {
    //     log('fgetattr', path, fd);
    //     cb(Fuse.EOPNOTSUPP);
    // }

    // async fuse_flush(path, fd, cb) {
    //     log('flush', path, fd);
    //     cb(Fuse.EOPNOTSUPP);
    // }

    // async fuse_fsync(path, fd, datasync, cb) {
    //     log('fsync', path, fd, datasync);
    //     cb(Fuse.EOPNOTSUPP);
    // }

    // async fuse_fsyncdir(path, fd, datasync, cb) {
    //     log('fsyncdir', path, fd, datasync);
    //     cb(Fuse.EOPNOTSUPP);
    // }

    async fuse_readdir(path: string, cb: FuseGenericCallback<string[]>): Promise<void> {
        log('readdir', path);

        try {
            const objects = await database.getObjectsInContainerPath(path.slice(1));
            const names = objects.map(object => object.name);
            cb(0, names);
        }
        catch (err) {
            cb(this._translateError(err));
        }
    }

    // async fuse_truncate(path, size, cb) {
    //     log('truncate', path, size);
    //     cb(Fuse.EOPNOTSUPP);
    // }

    // async fuse_ftruncate(path, fd, size, cb) {
    //     log('ftruncate', path, fd, size);
    //     cb(Fuse.EOPNOTSUPP);
    // }

    // async fuse_readlink(path, cb) {
    //     log('readlink', path);
    //     cb(Fuse.EOPNOTSUPP);
    // }

    // async fuse_chown(path, uid, gid, cb) {
    //     log('chown', path, uid, gid);
    //     cb(Fuse.EOPNOTSUPP);
    // }

    // async fuse_chmod(path, mode, cb) {
    //     log('chmod', path, mode);
    //     cb(Fuse.EOPNOTSUPP);
    // }

    // async fuse_mknod(path, mode, dev, cb) {
    //     log('mknod', path, mode, dev);
    //     cb(Fuse.EOPNOTSUPP);
    // }

    // async fuse_setxattr(path, name, buffer, length, offset, flags, cb) {
    //     log('setxattr', path, name, buffer, length, offset, flags);
    //     cb(Fuse.EOPNOTSUPP);
    // }

    // async fuse_getxattr(path, name, buffer, length, offset, cb) {
    //     log('getxattr', path, name, buffer, length, offset);
    //     cb(Fuse.EOPNOTSUPP);
    // }

    // async fuse_listxattr(path, buffer, length) {
    //     log('flush', path, fd);
    //     cb(Fuse.EOPNOTSUPP);
    // }

    // async fuse_removexattr(path, name, cb) {
    //     log('removexattr', path, name);
    //     cb(Fuse.EOPNOTSUPP);
    // }

    async fuse_open(path: string, flags: number, cb: FuseFdCallback): Promise<void> {
        log('open', path, flags);

        try {
            const normalizedPath = path.slice(1);
            const object = await this._getObjectFromPath(normalizedPath);

            if (object.isContainer)
                return cb(Fuse.EISDIR);

            const accessFlags = flags & 3;
            if (accessFlags === 1) return cb(Fuse.EROFS);
            if (accessFlags !== 0) return cb(Fuse.EPERM);

            let fd = 0;
            while (this._fdCache[fd])
                fd++;

            const requestId = this._allocateRequestId();
            const fileObjectInstance = await this.deps.fileObjectService.openForRead(this._ensureFileRecord(object), { requestId });
            this._fdCache[fd] = fileObjectInstance;

            cb(0, fd);
        }

        catch (err) {
            cb(this._translateError(err));
        }
    }

    // async fuse_opendir(path, flags, cb) {
    //     log('opendir', path, flags);
    //     cb(Fuse.EOPNOTSUPP);
    // }

    async fuse_read(path: string, fd: number, buffer: Buffer, length: number, position: number, cb: FuseReadCallback): Promise<void> {
        // const readId = this._readCnt++;
        // log('read', readId, path, fd, `@${position}`, `+${length}`);

        const object = this._fdCache[fd];
        if (!object)
            return cb(Fuse.EINVAL ?? Fuse.EPERM);

        const endPosition = Math.min(object.size, position + length);

        if (position >= endPosition)
            return cb(0);

        let isLocked = false;
        try {
            // Hold the lock for the ENTIRE duration of the read operation
            // This prevents concurrent reads from overwriting setReadRange
            await object.acquireIOLock();
            isLocked = true;
            object.setReadRange(position, endPosition);

            const bytesRead = await new Promise<number>((resolve, reject) => {
                let bufferOffset = 0;
                let bytesRemaining = endPosition - position;
                let resolved = false;

                const handleData = (data: Buffer): void => {
                    if (resolved) return;
                    data.copy(buffer, bufferOffset, 0, data.length);
                    bufferOffset += data.length;
                    bytesRemaining -= data.length;

                    if (bytesRemaining <= 0) {
                        resolved = true;
                        cleanup();
                        resolve(bufferOffset);
                    }
                };

                const handleError = (err: Error): void => {
                    if (resolved) return;
                    resolved = true;
                    log('read error', path, fd, `@${position}`, `+${length}`, err);
                    cleanup();
                    reject(err);
                };

                // Use removeListener instead of removeAllListeners to only
                // remove THIS read's handlers, not handlers from other reads
                const cleanup = (): void => {
                    object.removeListener('data', handleData);
                    object.removeListener('error', handleError);
                };

                object.on('data', handleData);
                object.on('error', handleError);
            });

            object.releaseIOLock();
            cb(bytesRead);
        }
        catch (err) {
            if (isLocked)
                object.releaseIOLock();
            // If lock acquisition failed, translate the error; otherwise return EREMOTEIO for read errors
            cb(isLocked ? Fuse.EREMOTEIO : this._translateError(err));
        }
    }

    // async fuse_write(path, fd, buffer, length, position, cb) {
    //     log('write', path, fd, buffer, length, position);
    //     cb(Fuse.EOPNOTSUPP);
    // }

    async fuse_release(path: string, fd: number, cb: FuseReadCallback): Promise<void> {
        log('release', path, fd);

        const object = this._fdCache[fd];
        delete this._fdCache[fd];

        if (object) {
            try {
                await object.close();
            }
            catch (err) {
                log.error('failed to close file object:', err);
            }
        }

        cb(0);
    }

    // async fuse_releasedir(path, fd, cb) {
    //     log('releasedir', path, fd);
    //     cb(Fuse.EOPNOTSUPP);
    // }

    // async fuse_create(path, mode, cb) {
    //     log('create', path, mode);
    //     cb(Fuse.EOPNOTSUPP);
    // }

    // async fuse_utimens(path, atime, mtime, cb) {
    //     log('utimens', path, atime, mtime);
    //     cb(Fuse.EOPNOTSUPP);
    // }

    // async fuse_unlink(path, cb) {
    //     log('unlink', path);
    //     cb(Fuse.EOPNOTSUPP);
    // }

    // async fuse_rename(src, dest, cb) {
    //     log('rename', src, dest);
    //     cb(Fuse.EOPNOTSUPP);
    // }

    // async fuse_link(src, dest, cb) {
    //     log('link', src, dest);
    //     cb(Fuse.EOPNOTSUPP);
    // }

    // async fuse_symlink(src, dest, cb) {
    //     log('symlink', src, dest);
    //     cb(Fuse.EOPNOTSUPP);
    // }

    // async fuse_mkdir(path, mode, cb) {
    //     log('mkdir', path, mode);
    //     cb(Fuse.EOPNOTSUPP);
    // }

    // async fuse_rmdir(path, cb) {
    //     log('rmdir', path);
    //     cb(Fuse.EOPNOTSUPP);
    // }

    // async fuse_destroy(cb) {
    //     log('destroy');
    //     cb(Fuse.EOPNOTSUPP);
    // }

    private _buildHandlers(): Record<string, (...args: unknown[]) => void> {
        const handlers: Record<string, (...args: unknown[]) => void> = {};
        const proto = Object.getPrototypeOf(this) as Record<string, unknown>;
        Object.getOwnPropertyNames(proto).forEach(fnName => {
            if (!fnName.startsWith('fuse_'))
                return;
            const handler = (this as Record<string, unknown>)[fnName];
            if (typeof handler === 'function')
                handlers[fnName.slice(5)] = handler.bind(this);
        });
        return handlers;
    }

    private async _getObjectFromPath(path: string): Promise<ContentDocument> {
        if (path.startsWith('$'))
            return database.getObjectById(path.slice(1));
        return database.getObjectByPath(path);
    }

    private _ensureFileRecord(object: ContentDocument): StoredObjectRecord {
        if (
            typeof object.id !== 'string' ||
            typeof object.size !== 'number' ||
            typeof object.chunkSize !== 'number' ||
            !Array.isArray(object.dataVolumes) ||
            !Array.isArray(object.parityVolumes)
        )
            throw new Error('object is missing file metadata');
        return object as StoredObjectRecord;
    }

    private _allocateRequestId(): string {
        const id = `fuse-${this._nextRequestId++}`;
        if (this._nextRequestId > Number.MAX_SAFE_INTEGER)
            this._nextRequestId = 1;
        return id;
    }

    private _translateError(err: unknown): number {
        const code = (err as { code?: string })?.code;
        if (code && typeof (Fuse as Record<string, number>)[code] === 'number')
            return (Fuse as Record<string, number>)[code];
        return Fuse.ECONNRESET;
    }

    private _getUid(): number {
        return typeof process.getuid === 'function' ? process.getuid() : 0;
    }

    private _getGid(): number {
        return typeof process.getgid === 'function' ? process.getgid() : 0;
    }
}
