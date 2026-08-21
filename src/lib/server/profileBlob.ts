/**
 * The server's own guarantee about what a profile blob may contain.
 *
 * `src/lib/profileWire.ts` decides what leaves a *device*. That is the right
 * place for the decision and the wrong place for the enforcement: the server
 * takes the blob a client hands it, stores it verbatim, and splices it back out
 * verbatim to anyone authorised to read the profile. So the withholding held
 * only for blobs written by a client that had the fix. Every blob written
 * before it — and every blob written by anything that simply chooses not to
 * filter — still carried `serverShareToken`, a bearer credential, straight to a
 * viewer who then holds the editor role it was issued with.
 *
 * A client is not a trustworthy filter of what the server hands a third party.
 *
 * **Both ends, not one.** On write, so the database stops accumulating
 * credentials at rest — a backup, an admin export or a future route then cannot
 * leak one either, and after this ships every stored blob is already clean. On
 * read, because the write filter does nothing for the rows *already* in the
 * production database: those were written by clients that predate it, and
 * nothing rewrites a blob until its owner next saves. Read is the security
 * boundary; write is hygiene that makes the read side almost free.
 *
 * **Deny-list, not allow-list, and deliberately.** `profileWire` allow-lists
 * because it is deciding; this is enforcing one narrow guarantee — that the
 * server never re-serves a credential it stored — and an allow-list here would
 * silently destroy any field the list had not caught up with, permanently, on
 * write. The list is not a second copy: `WITHHELD_PROFILE_FIELDS` is imported
 * from `profileWire`, whose exhaustiveness assertion already fails to compile
 * when a new `Profile` field is classified as neither shareable nor withheld.
 * Classifying one as withheld arms this automatically.
 *
 * Scope is `data.profile` — the profile record inside `ProfileSyncData`, which
 * is where `toWireProfile` puts it and the only place a credential is withheld
 * *from*. A client that stashes its own token somewhere else in its own blob
 * has published it on purpose; that is not the server re-serving something it
 * was asked to hold back.
 *
 * @module lib/server/profileBlob
 */

import { WITHHELD_PROFILE_FIELDS } from "@/lib/profileWire";

/**
 * The key names, in the form they take in stored JSON.
 *
 * Sound as a substring test because the `data` column is never the client's
 * bytes: the write path parses the request and re-serialises with
 * `JSON.stringify`, so a stored blob is always canonical JSON, and
 * `JSON.stringify` emits a key like `serverShareToken` literally rather than
 * escaping any of it. There is no `"serverShareToken"` spelling to miss.
 */
const WITHHELD_KEYS_IN_JSON = WITHHELD_PROFILE_FIELDS.map(
  (field) => `"${field}"`,
);

/**
 * Removes the withheld fields from a parsed blob's profile record.
 *
 * Returns a copy — the caller may still be holding the original for something
 * else, and a redaction that mutates its input at a distance is the kind of
 * thing that turns up later as a field that vanished for no reason.
 *
 * Anything that is not a blob with an object `profile` is passed through
 * untouched: the write path validates shape separately, and a shape this does
 * not recognise carries nothing for it to remove.
 *
 * @param data - A parsed profile blob
 * @returns The blob, with no withheld field on its profile record
 */
export function redactProfileBlob<T>(data: T): T {
  if (!data || typeof data !== "object" || Array.isArray(data)) return data;

  const profile = (data as { profile?: unknown }).profile;
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    return data;
  }

  const kept: Record<string, unknown> = { ...(profile as object) };
  let removed = false;
  for (const field of WITHHELD_PROFILE_FIELDS) {
    if (field in kept) {
      delete kept[field];
      removed = true;
    }
  }
  if (!removed) return data;

  return { ...data, profile: kept };
}

/**
 * The stored blob as it may be served, given as JSON text.
 *
 * The scan first, because the response path splices the stored string into the
 * body rather than parsing it — three full traversals of up to 8 MB is exactly
 * what that splice exists to avoid, and paying it on every read to remove a
 * field that (after the write filter) is never there would trade one bug for a
 * different one. A miss costs a single pass with no allocation; a hit is a
 * legacy row, and pays the parse once per read until its owner next saves.
 *
 * @param json - The `data` column of a profile row
 * @returns The same JSON when there is nothing to remove, otherwise a
 *   re-serialised copy without it
 */
export function redactStoredProfileBlob(json: string): string {
  if (!WITHHELD_KEYS_IN_JSON.some((key) => json.includes(key))) return json;

  try {
    return JSON.stringify(redactProfileBlob(JSON.parse(json) as unknown));
  } catch {
    // The scan says this row names a withheld field and it will not parse, so
    // there is no way to prove what is being handed over. Nothing is lost by
    // refusing: a blob that does not parse here would not have parsed in the
    // client either, having been spliced into the response as it stands.
    console.error("Refusing to serve a profile blob that does not parse");
    return "null";
  }
}
