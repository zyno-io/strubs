# Development

## Setup

Node 24+, MongoDB, Yarn 4 (via corepack).

```bash
yarn install
yarn build        # tsc -> dist/
yarn test         # vitest
```

The UI is a workspace:

```bash
cd ui
yarn dev          # vite dev server, proxies /$/ to a real STRUBS host
yarn build        # -> ui/dist, served by the mgmt route at /$/ui
```

> `ui/vite.config.ts` proxies `/$/` to a hardcoded host for local development. Point it at your own instance.

## Running locally

STRUBS mounts filesystems and reads raw block devices, so it needs root:

```bash
yarn dev          # sudo + ts-node + --watch + --inspect (port 9229)
```

It binds **port 80** (object API) and **port 443** (admin API + UI over HTTPS, with a self-issued certificate
in `/var/lib/strubs/tls`), and opens the root-only admin socket at `/run/strubs/admin.sock`. FUSE is *not*
mounted unless you set `STRUBS_FUSE_ENABLED=true`. Without disks it starts, reports zero volumes, and does
nothing useful — which is fine for working on the HTTP layer.

Two things to know on a fresh dev box: the admin password is **generated on first start and logged once**
(grep the output for `NO ADMIN PASSWORD`), and the admin socket is the shortcut around all of it —
`curl --unix-socket /run/strubs/admin.sock http://localhost/\$/status` needs no credential and no TLS.
See [Access control](access-control.md).

To exercise the real data path you need actual volumes. Loopback devices work:

```bash
for i in 1 2 3 4 5 6; do
  truncate -s 2G /var/tmp/strubs-$i.img
  losetup -f /var/tmp/strubs-$i.img
done
losetup -a
# then provision each via POST /$/volumes (this WILL format them)
```

Six is the minimum for a default 4+2 write.

## Tests

```bash
yarn test                                  # everything
npx vitest run tests/rebalance-job.test.ts # one file
npx vitest run -t "below quorum"           # by name
npx tsc --noEmit                           # typecheck only
```

Tests are Vitest, colocated in `tests/`, and mostly unit tests over injected dependencies. Two conventions that will bite you if you don't know them:

**Every job takes a `deps` object.** Jobs are constructed with a full set of injectable dependencies (`database`, `getVolumes`, `repairSlice`, `runtimeConfig`, …) that default to the real singletons. Tests pass fakes. If you add a new external call to a job, thread it through `deps` — don't reach for the singleton directly, or you'll make the job untestable.

**Mock the native Reed–Solomon binding.** Vitest cannot load `.node` files. Any test whose import graph reaches the codec needs:

```ts
vi.mock('@ronomon/reed-solomon', () => ({
    default: { create: () => ({}), encode: () => {}, search: () => {}, XOR: () => {} }
}));
```

This bites indirectly — e.g. `rebalance-job` statically imports `verifyVolumesJob`, which drags in the codec. If a test suddenly fails with `Unknown file extension ".node"`, that's what happened.

For the real codec, `tests/parity-roundtrip.integration.test.ts` loads it via `createRequire` and exercises generate / reconstruct / foreign-detection for real.

### Writing tests that are worth having

A test that passes against the *old* code is worth nothing. When you fix a bug, check that the test fails without the fix — temporarily revert the change, run it, watch it fail, put it back. Several bugs in this codebase were "covered" by tests that never would have caught them.

Concurrency and placement bugs especially: assert on the thing that actually distinguishes the behaviours (peak in-flight count, which volume was chosen), not on something the buggy version also satisfies.

## Codebase conventions

- **4-space indent, single quotes, semicolons.** Match the surrounding file.
- **Comments explain *why*, not *what*.** The bar: a comment should tell the next reader something the code cannot. Constraints, hazards, the reason a non-obvious choice was made. Not a paraphrase of the line below it.
- **No deployment-specific detail in comments.** This is an open-source project — no "our fleet", no volume numbers, no incident references. Write for someone who has never seen your hardware.
- **Errors carry codes.** Slice-level failures are decorated with a `code` (`ECHECKSUM`, `EHEADER`, `EUNAVAIL`, `EQUORUM`, `ECORRUPT`, `IOABORT`, …) and a category. Don't throw bare `Error`s from the data path — the whole remediation pipeline triages on these, and free-text messages make failure modes indistinguishable from each other.

## Things to know before you touch the data path

A few invariants that are load-bearing. Breaking them silently loses data, and the tests may not catch you.

**Never commit a reconstruction that doesn't reproduce the whole-object MD5.** Per-slice checksums cannot tell a correct slice from a self-consistent wrong one. This gate is the only thing standing between a bad rebuild and a permanently corrupted object. See [Data integrity](data-integrity.md).

**Never byte-copy a parity slice.** A copy faithfully preserves parity that is silently wrong. Parity is *recomputed* from verified data, always. Copy-first is for data slices only.

**Move, verify, flip, then delete.** Relocation writes the new slice, validates it, flips the DB reference with a conditional positional update, and only then removes the source. A crash at any point leaves a harmless duplicate, never a dangling reference.

**`IOABORT` is not a slice error.** It means *we* cancelled the I/O during shutdown. It says nothing about the disk, so it must never be persisted as a slice error or counted toward quorum.

**Jobs must be resumable.** Anything that can run for hours checkpoints to `runtimeConfig` and resumes on startup. Assume the process will be restarted mid-job, because it will be.

## Layout

```
service.ts          entry point
lib/core.ts         startup / shutdown orchestration
lib/io/             volumes, devices, the file-object data path
lib/jobs/           verify, drain, rebalance
lib/remediation/    fault tracking, repair worker
lib/database/       Mongo repositories
lib/server/         HTTP (object + management) and FUSE
lib/notify/         notification transports
ui/                 Vue 3 + Vite management UI
tools/              standalone operator scripts
tests/              vitest
notes/              historical design drafts (point-in-time, not maintained)
docs/               reference documentation (this)
```

`notes/` are dated design documents written while features were being built. They're kept for context but they are **not** maintained and may not reflect the current code. `docs/` is the source of truth.
