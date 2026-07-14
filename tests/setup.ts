// THE TESTS MUST NEVER SEE THIS MACHINE'S REAL LUKS KEYFILE -- nor depend on its absence.
//
// `DEFAULT_KEYFILE` falls back to /var/lib/strubs/luks.key, so on a host that actually runs STRUBS the suite
// would read the real key to every disk in the array. Worse, it did so INVISIBLY: the bootstrap-scan test
// "offers the recovery passphrase when the keyfile is gone" quietly relied on that file not existing, passed
// for months on a box where it didn't, and started failing the moment STRUBS created one at startup. The test
// was not testing the code; it was testing the developer's filesystem.
//
// Point every test at a path that cannot exist. A test that wants a keyfile mocks `fs` or passes its own path.
process.env.STRUBS_LUKS_KEYFILE ||= '/nonexistent/strubs-tests-never-touch-the-real-keyfile';
