// WHAT IS IT DOING RIGHT NOW?
//
// Converting a volume to encrypted is a long operation made of several long steps: walking the platter (89
// seconds on the fullest disk in this array -- two million slice files), wiping it, writing a LUKS header,
// making a filesystem, bringing it back into service. All of that behind a single HTTP request that returns
// when it is over.
//
// An operator watching a disabled button for two minutes cannot tell a working system from a wedged one, and
// the reasonable thing for them to do -- reload, click again, restart the service -- is the worst thing they
// could do to a disk that is mid-wipe. So say what is happening.
//
// In memory, not the database: this is the status of an operation running in THIS process right now, and if the
// process dies the operation died with it. Persisting it would only preserve a lie.

export type ConversionPhase =
    | 'checking'      // is this volume drained, is its journal safe, does the passphrase check out
    | 'scanning'      // walking the platter -- the slow one
    | 'wiping'        // the point of no return
    | 'encrypting'    // luksFormat + keyslots
    | 'formatting'    // mkfs on the mapper
    | 'registering';  // back into service, empty, ready for the rebalance to refill

export type ConversionProgress = {
    volumeId: number;
    phase: ConversionPhase;
    startedAt: string;

    // Only during 'scanning'. The total is what the LAST full scan of this volume found, so it is a decent
    // guess and never a promise -- which is why the UI shows a count, not a percentage it would have to lie about.
    filesScanned?: number;
};

let current: ConversionProgress | null = null;

export const conversionInProgress = (): ConversionProgress | null => current;

// ⚠️ THIS IS THE LOCK, NOT A STATUS LINE. It CLAIMS the conversion slot, and returns false if somebody already
// holds it.
//
// It has to be, because "check that nobody is converting, then convert" is only safe if nothing can happen in
// between -- and the caller now has to `await` its way through an lsblk to find out which disk it is even
// talking about. Two requests could both pass a separate `conversionInProgress()` check while the first sat in
// that await, and then wipe two disks at once. Node is single-threaded, which makes a synchronous test-and-set
// a real mutex: nothing can interleave between the read and the write below.
export function beginConversion(volumeId: number): boolean {
    if (current) return false;
    current = { volumeId, phase: 'checking', startedAt: new Date().toISOString() };
    return true;
}

export function conversionPhase(phase: ConversionPhase): void {
    if (current)
        current = { ...current, phase, filesScanned: undefined };
}

export function conversionScanned(files: number): void {
    if (current)
        current = { ...current, filesScanned: files };
}

// Cleared whether the conversion succeeded or failed. A stale "still working" is worse than no status at all:
// it is the exact lie this module exists to prevent.
export function endConversion(): void {
    current = null;
}
