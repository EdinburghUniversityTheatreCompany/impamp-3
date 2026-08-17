// Empty the E2E server database. Run immediately before the server starts —
// never while one is running.
//
// `E2E_DB_PATH` resolves to `data/e2e.db`, which is gitignored and used to be
// reset by nothing at all: no globalSetup, no teardown, nothing truncating it.
// It accumulated for as long as a machine had been running the suite (48 users
// and 117 profiles on the machine the review measured, with a 4 MB
// write-ahead log beside it), which made local and CI runs test different
// databases and let an assertion counting rows measure how many times the
// suite had been run rather than what the app did.
//
// Deliberately *not* a Playwright `globalSetup`: the webServer plugin's setup
// runs before globalSetup, so by then the server has the file open. Unlinking
// it there leaves the server writing to an orphaned inode — the run is
// unaffected, the reset achieves nothing, and the next thing to open the path
// gets an empty database while the live process disagrees. Tying the
// database's lifetime to the server's is both safe and easy to state.
//
// Deleting rather than truncating also keeps this honest across schema
// changes: the server migrates an empty file from scratch, so a database
// written by an older checkout can never survive into a newer run.

import { rmSync } from "node:fs";
import { E2E_DB_PATH } from "./env.js";

// SQLite in WAL mode keeps committed data in the sidecars, so removing only
// the main file would let the last run's writes be replayed into the new one.
for (const path of [E2E_DB_PATH, `${E2E_DB_PATH}-wal`, `${E2E_DB_PATH}-shm`]) {
  rmSync(path, { force: true });
}
