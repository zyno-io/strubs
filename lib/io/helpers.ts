import crypto from 'crypto';
import os from 'os';
import { promises as fsp } from 'fs';

import { spawnHelper } from '../helpers/spawn';

export type SmartctlResult<T = Record<string, unknown>> = {
    data: T;
    exitCode: number;
};

const hostname = os.hostname();
const hostId = crypto.createHash('md5').update(hostname).digest().slice(13);

const objectIdPid = process.pid & 0xff;
let objectIdCounter = 0;

// NOTE: this follows the Mongo spec, but it's for our objects, so it's here.
// we need IDs for our files long before the database assigns them.
export function generateObjectId(): Buffer {
    const objectIndex = ++objectIdCounter & 0xffffff;
    const time = Math.floor(Date.now() / 1000);

    const result = Buffer.allocUnsafe(12);
    result.writeInt32BE(time, 0);
    hostId.copy(result, 4);
    result.writeInt16BE(objectIdPid, 7);
    result.writeIntBE(objectIndex, 9, 3);

    return result;
}

export async function lsblk(additionalParams?: string[]): Promise<any> {
    const params = ['-OJb'];

    if (additionalParams)
        params.push(...additionalParams);

    const { code, stdout } = await spawnHelper('lsblk', params);

    if (code !== 0)
        throw new Error('lsblk exited with code ' + code);

    return JSON.parse(stdout);
}

const FATAL_SMARTCTL_MASK = 0x03; // parsing/device open failures

export async function smartctl<T = Record<string, unknown>>(...args: string[]): Promise<SmartctlResult<T>> {
    args.unshift('--json=c');

    const { code, stdout } = await spawnHelper('smartctl', args);
    const exitCode = typeof code === 'number' ? code : -1;

    if (exitCode < 0 || (exitCode & FATAL_SMARTCTL_MASK) !== 0)
        throw new Error('smartctl exited with code ' + exitCode);

    if (!stdout.length)
        throw new Error('smartctl produced no output');

    let parsed: T;
    try {
        parsed = JSON.parse(stdout) as T;
    }
    catch {
        throw new Error('smartctl output was not valid JSON');
    }

    return {
        data: parsed,
        exitCode
    };
}

export async function mount(blockPath: string, mountPath: string, fsType: string, options?: Record<string, string | number | boolean>): Promise<void> {
    const params = [ blockPath, '-t', fsType, mountPath ];

    if (options) {
        const optionsStr = Object.entries(options)
            .map(([key, value]) => `${key}=${value}`)
            .join(',');
        params.splice(3, 0, '-o', optionsStr);
    }

    const { code, stdout } = await spawnHelper('mount', params);

    if (code !== 0)
        throw new Error('mount exited with code ' + code + (stdout ? ': ' + stdout : ''));
}

export async function unmount(mountPath: string, options?: { lazy?: boolean }): Promise<void> {
    // Lazy (umount -l) detaches the mount now and cleans up when it's no longer busy: needed when the
    // backing device has vanished (EIO), where a plain umount can block indefinitely.
    const params = options?.lazy ? [ '-l', mountPath ] : [ mountPath ];
    const { code, stdout } = await spawnHelper('umount', params);

    if (code !== 0)
        throw new Error('umount exited with code ' + code + (stdout ? ': ' + stdout : ''));
}

// Parse /proc/mounts into a map of mountpoint -> source device. Used to reconcile a volume's believed
// mount against the kernel's reality (is it still mounted, and by the device we expect?). /proc/mounts
// octal-escapes spaces/tabs in fields; mountpoints are decoded so lookups by path work.
export async function readProcMounts(): Promise<Map<string, string>> {
    const text = await fsp.readFile('/proc/mounts', 'utf8');
    const map = new Map<string, string>();
    const unescape = (field: string) => field.replace(/\\([0-7]{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
    for (const line of text.split('\n')) {
        if (!line)
            continue;
        const [source, mountpoint] = line.split(' ');
        if (source && mountpoint)
            map.set(unescape(mountpoint), unescape(source));
    }
    return map;
}

export function formatBytes(bytes: number): string {
    if (bytes >= 1099511627776)
        return (bytes / 1099511627776).toFixed(2) + ' TB';
    if (bytes >= 1073741824)
        return (bytes / 1073741824).toFixed(2) + ' GB';
    if (bytes >= 1048576)
        return (bytes / 1048576).toFixed(2) + ' MB';
    if (bytes >= 1024)
        return (bytes / 1024).toFixed(2) + ' KB';
    return bytes + ' b';
}
