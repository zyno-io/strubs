import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { config } from '../config';
import { createLogger } from '../log';
import { spawnHelper } from '../helpers/spawn';

const log = createLogger('tls');

export interface TlsMaterial {
    key: Buffer;
    cert: Buffer;
}

// Modern browsers reject leaf certificates valid for more than 398 days. The CA is long-lived because
// it is installed by hand and its rollover is disruptive; the leaf auto-renews well inside the window.
const LEAF_DAYS = 398;
const CA_DAYS = 3650;
const RENEW_WHEN_DAYS_LEFT = 30;

// The names and addresses the admin listener may legitimately be reached by. Browsers authenticate on
// the SAN list and ignore CN entirely, so this is the whole game: derive it from what the machine
// actually is, at issue time, and reissue when it changes (an IP move otherwise silently breaks trust).
export function computeSanEntries(extraHosts: string[] = []): string[] {
    const dns = new Set<string>(['localhost']);
    const ips = new Set<string>(['127.0.0.1', '::1']);

    const hostname = os.hostname();
    if (hostname) {
        dns.add(hostname);
        // `<hostname>.local` costs nothing and is correct the moment anyone runs avahi/mDNS.
        if (!hostname.includes('.'))
            dns.add(`${hostname}.local`);
    }

    for (const addrs of Object.values(os.networkInterfaces())) {
        for (const addr of addrs ?? []) {
            if (addr.internal)
                continue;
            const ip = addr.address.replace(/%.*$/, ''); // strip IPv6 zone id
            // Skip IPv6 link-local (fe80::/10): not routable, never how the service is reached, and
            // just noise in the certificate (there is one per interface).
            if (/^fe[89ab]/i.test(ip))
                continue;
            ips.add(ip);
        }
    }

    for (const host of extraHosts) {
        // An entry that parses as an IP is an IP SAN; otherwise a DNS SAN.
        (/^[0-9.]+$/.test(host) || host.includes(':') ? ips : dns).add(host);
    }

    return [
        ...[...dns].sort().map(d => `DNS:${d}`),
        ...[...ips].sort().map(i => `IP:${i}`)
    ];
}

// The SANs a leaf was issued for are recorded in a sidecar file next to it, NOT read back from the
// certificate. openssl normalises SANs on output (`::1` -> `0:0:0:0:0:0:0:1`, uppercased, expanded), so
// comparing our computed list against the parsed cert never matches and we would reissue on every
// startup. The sidecar stores exactly the strings we generated, making the drift check deterministic.
async function readIssuedSans(sansPath: string): Promise<string[] | null> {
    try {
        const raw = await fs.readFile(sansPath, 'utf8');
        return raw.split('\n').map(s => s.trim()).filter(Boolean).sort();
    }
    catch {
        return null;
    }
}

async function certDaysRemaining(certPath: string): Promise<number | null> {
    try {
        const res = await spawnHelper('openssl', ['x509', '-in', certPath, '-noout', '-enddate']);
        if (res.code !== 0)
            return null;
        const match = /notAfter=(.+)/.exec(res.stdout.trim());
        if (!match)
            return null;
        const end = new Date(match[1]).getTime();
        return Math.floor((end - Date.now()) / 86400000);
    }
    catch {
        return null;
    }
}

async function fileExists(p: string): Promise<boolean> {
    try { await fs.access(p); return true; }
    catch { return false; }
}

async function run(args: string[], failure: string): Promise<void> {
    const res = await spawnHelper('openssl', args);
    if (res.code !== 0)
        throw new Error(`${failure}: openssl exited ${res.code}: ${res.stderr ?? ''}`);
}

// Ensure a CA exists (create once) and a leaf certificate exists whose SANs match the host and which is
// not near expiry (reissue otherwise). Idempotent and cheap: on the steady-state path it runs two
// read-only openssl invocations and returns the existing material.
export async function ensureTlsMaterial(): Promise<TlsMaterial> {
    // Bring-your-own certificate short-circuits everything self-issued.
    if (config.tlsCertPath && config.tlsKeyPath) {
        log('using operator-provided certificate at %s', config.tlsCertPath);
        return {
            cert: await fs.readFile(config.tlsCertPath),
            key: await fs.readFile(config.tlsKeyPath)
        };
    }

    const dir = config.tlsDir;
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const caKey = path.join(dir, 'ca.key');
    const caCrt = path.join(dir, 'ca.crt');
    const tlsKey = path.join(dir, 'tls.key');
    const tlsCrt = path.join(dir, 'tls.crt');
    const tlsSans = path.join(dir, 'tls.sans');

    if (!await fileExists(caKey) || !await fileExists(caCrt)) {
        log('generating STRUBS local CA (10 years) at %s', caCrt);
        await run(['req', '-x509', '-newkey', 'rsa:4096', '-sha256', '-days', String(CA_DAYS), '-nodes',
            '-keyout', caKey, '-out', caCrt, '-subj', '/CN=STRUBS Local CA',
            '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0',
            '-addext', 'keyUsage=critical,keyCertSign,cRLSign'], 'failed to generate CA');
        await fs.chmod(caKey, 0o600);
        const fp = await spawnHelper('openssl', ['x509', '-in', caCrt, '-noout', '-fingerprint', '-sha256']);
        // Print the fingerprint so whoever installs the CA can verify what they are trusting. Installing
        // it makes this host a trusted CA on that machine -- ca.key must never leave the box.
        log('CA fingerprint -- verify before installing: %s', fp.stdout.trim());
    }

    const wantSans = computeSanEntries(config.tlsExtraHosts).sort();
    const haveSans = await readIssuedSans(tlsSans);
    const daysLeft = await fileExists(tlsCrt) ? await certDaysRemaining(tlsCrt) : null;

    const sansMatch = haveSans !== null && haveSans.join(',') === wantSans.join(',');
    const fresh = daysLeft !== null && daysLeft > RENEW_WHEN_DAYS_LEFT;

    if (!sansMatch || !fresh) {
        const why = haveSans === null ? 'no valid leaf certificate'
            : !sansMatch ? `host names/addresses changed (was [${haveSans}], now [${wantSans}])`
                : `certificate expires in ${daysLeft} day(s)`;
        log('issuing leaf certificate (%s)', why);

        const csr = path.join(dir, 'tls.csr');
        const extfile = path.join(dir, 'tls.ext');
        await fs.writeFile(extfile, [
            'basicConstraints=CA:FALSE',
            'keyUsage=critical,digitalSignature,keyEncipherment',
            'extendedKeyUsage=serverAuth',
            `subjectAltName=${wantSans.join(',')}`
        ].join('\n') + '\n');

        await run(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', tlsKey, '-out', csr,
            '-subj', '/CN=strubs'], 'failed to generate leaf key/CSR');
        await run(['x509', '-req', '-in', csr, '-CA', caCrt, '-CAkey', caKey, '-CAcreateserial',
            '-out', tlsCrt, '-days', String(LEAF_DAYS), '-sha256', '-extfile', extfile], 'failed to sign leaf');
        await fs.chmod(tlsKey, 0o600);
        // Record exactly the SANs we issued for, so the next startup's drift check is normalisation-proof.
        await fs.writeFile(tlsSans, wantSans.join('\n') + '\n');
        await fs.rm(csr, { force: true });
        await fs.rm(extfile, { force: true });
        log('leaf certificate issued for %s', wantSans.join(', '));
    }

    return {
        cert: await fs.readFile(tlsCrt),
        key: await fs.readFile(tlsKey)
    };
}
