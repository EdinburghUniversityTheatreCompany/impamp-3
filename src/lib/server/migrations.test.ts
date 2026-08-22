/**
 * The append-only migration rule, with something behind it.
 *
 * `MIGRATIONS` is applied by index: entry `n` runs on a database whose
 * `PRAGMA user_version` is `n`, and leaves it at `n + 1`. So an entry that has
 * run anywhere is history and can never be edited, reordered or removed — only
 * appended to. `db.ts` has said so in a comment since the table was created,
 * and migration 4 says it again in SQL, having had to drop an index that
 * migration 1 still creates for exactly this reason.
 *
 * A comment is the wrong enforcement for this rule, because breaking it does
 * not look like a mistake and does not fail anything. Editing an existing entry
 * looks like fixing a migration; it produces a correct schema on a fresh
 * database, so every test passes and every developer's machine agrees. It is
 * wrong only on databases that already ran the old text — which is the deployed
 * one, and nobody's development one.
 *
 * So the entries that have shipped are hashed here. Change one and this fails
 * with the entry number; append one and it does not.
 */

import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb, MIGRATIONS } from "./db";

/**
 * SHA-256 of every migration that has been applied to a real database.
 *
 * **Appending a migration?** Add its hash to the end of this list. That is the
 * whole ceremony, and it is deliberate: writing the hash down is the moment you
 * confirm the entry above yours is finished and will never be touched again.
 *
 * **This test failed and you did not add a migration?** Then an existing entry
 * changed. Do not update the hash — restore the entry and put the change in a
 * new one at the end. The production database has already run the old text and
 * will never run the new text; only an appended entry reaches both.
 */
const SHIPPED_MIGRATION_HASHES = [
  "e46ef8df2f2f7b702743983fa6efcd9ab3bfedd5b64eb907a45183e968314053", // 1 — initial schema
  "a2ee366f3e8585142cf4a98ea8d281ec38086a4018510690d6026d2e5030cc5c", // 2 — hosted audio
  "3aef48eae605f30ac2862e44ab669f2273ffc4cbdf3736f938332640cc6071c9", // 3 — profile_audio
  "32886b1e0bc1824f08238e3a29d357cfc7376eea42b0cdbc316cff529a3441ea", // 4 — drop sessions_user_idx
  "44227e17e1768785fcaf45a687169f9a86c996bbba2c1b4f2b503591140e7eaf", // 5 — profile_audio.added_by
  "cb3ac3046a145c5e6286ccc9b1882289dc4c372db8cb4746431b2123ad661f2c", // 6 — audio_pending_uploads
  "a3221def92ea69da11816f26f081c5e89608df4cd70a0b06d714a74999e2ca28", // 7 — profile_audio_adders
];

const hashOf = (sql: string) =>
  createHash("sha256").update(sql, "utf8").digest("hex");

beforeEach(() => {
  closeDb();
  process.env.IMPAMP_DB_PATH = ":memory:";
});

describe("schema migrations", () => {
  it("has not changed a migration that already ran somewhere", () => {
    expect(
      MIGRATIONS.slice(0, SHIPPED_MIGRATION_HASHES.length).map(hashOf),
    ).toEqual(SHIPPED_MIGRATION_HASHES);
  });

  it("has not dropped or reordered one", () => {
    // Removing an entry renumbers every entry after it, so a database at
    // version 5 would silently skip whatever now sits at index 4.
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(
      SHIPPED_MIGRATION_HASHES.length,
    );
  });

  it("leaves a fresh database at the version the list implies", () => {
    const { user_version: version } = getDb()
      .prepare("PRAGMA user_version")
      .get() as { user_version: number };

    expect(version).toBe(MIGRATIONS.length);
  });
});
