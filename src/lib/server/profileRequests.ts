/**
 * Request plumbing shared by the profile routes: loading an authorized
 * profile, and validating a profile write body.
 */

import { NextRequest, NextResponse } from "next/server";
import { authorizeProfileRequest, isErrorResponse } from "./apiAuth";
import { getProfileMeta, type ProfileMeta } from "./profiles";
import { redactProfileBlob } from "./profileBlob";
import { readBodyText, tooLargeResponse } from "./requestBody";
import type { Access, UserRow } from "./db";

export interface AuthorizedProfileMeta {
  profile: ProfileMeta;
  access: Access;
  user: UserRow | null;
}

/**
 * Resolve the caller's access to a profile, without reading the blob.
 *
 * A profile the caller may not see and a profile that does not exist both
 * answer 404, so profile IDs stay unenumerable.
 *
 * There is deliberately no blob-loading twin any more. Every route here needs
 * `version` or `owner_id` to authorise and nothing else — including PUT, whose
 * blob-loading version read up to MAX_PROFILE_BODY_BYTES off disk to check who
 * was allowed to *overwrite* it. GET is the one caller that wants the row, and
 * it asks `getProfileById` for it explicitly, after the 304 branch has had its
 * chance to answer without one.
 */
export function loadAuthorizedProfileMeta(
  request: NextRequest,
  id: string,
): AuthorizedProfileMeta | NextResponse {
  const auth = authorizeProfileRequest(request, id);
  if (isErrorResponse(auth)) return auth;

  const profile = getProfileMeta(id);
  if (!profile) {
    return NextResponse.json({ error: "Profile not found" }, { status: 404 });
  }

  return { profile, access: auth.access, user: auth.user };
}

export interface ProfileWriteBody {
  name: string;
  data: object;
  /**
   * `data` already serialised, so the write path does not do it again.
   *
   * The size check has to serialise to know the real size (content-length can
   * be absent or wrong), and the row stores that same string — but the second
   * `JSON.stringify` used to run *inside* `BEGIN IMMEDIATE`, holding the
   * global write lock across it. At the 8 MB cap that is a lot of synchronous
   * string work to hold a single-instance database still for.
   */
  serialisedData: string;
}

/**
 * The most a profile blob may be.
 *
 * Generous for a soundboard — the audio itself never travels this way, only
 * names, hashes and pad layout — and small enough that one request cannot
 * occupy the single instance this app runs as. There was no bound at all.
 *
 * A hundred and twenty-eight times `MAX_JSON_BODY_BYTES`, which is the point of
 * having both: this is the one route where a large body is expected, and it is
 * not a reason for every other route to accept one. The reader is the same.
 */
const MAX_PROFILE_BODY_BYTES = 8 * 1024 * 1024;

/**
 * The most sounds one profile may name.
 *
 * Bytes were the only bound, and bytes are the wrong unit for the cost that
 * hurts: `reindexProfileAudio` runs a statement per hash inside
 * `BEGIN IMMEDIATE`, so the entry count is what decides how long one PUT holds
 * the write lock of a single-instance, synchronous database — every other
 * request, every SSE heartbeat and `/up` waiting behind it. An 8 MB body fits
 * about 110,000 entries, measured at 593 ms.
 *
 * Twenty thousand is far outside any real board and cheap enough to hold:
 * twenty banks of forty-eight pads is 960 pads, so the ceiling is twenty
 * distinct sounds on every pad of a completely full profile, and 20,000 rows
 * measured 90 ms. Erring generous is deliberate — a refusal here costs a real
 * user the ability to save their show at all, which is worse than the
 * milliseconds it buys.
 *
 * The array's length rather than its distinct hashes: it is an O(1) test on
 * the value the client sent, and the distinct count can only be smaller.
 *
 * Batching the inserts was tried and dropped. At 10k/20k/50k/110k hashes,
 * one-statement-per-row measured 46/90/240/593 ms and hundred-row batches
 * 39/96/254/617 ms — the cost is the B-tree insert, not statement overhead,
 * which `prepared()` already caches away. Variable-length SQL for no
 * measurable gain is a worse trade than a number.
 */
export const MAX_PROFILE_AUDIO_ENTRIES = 20_000;

const TOO_LARGE = "That profile is too large to store";

const TOO_MANY_SOUNDS = "That profile names too many sounds to store";

function tooLarge(): NextResponse {
  return tooLargeResponse(TOO_LARGE);
}

/** How many entries a blob's `audioFiles` claims, without walking them. */
function audioEntryCount(data: unknown): number {
  const files = (data as { audioFiles?: unknown } | null)?.audioFiles;
  return Array.isArray(files) ? files.length : 0;
}

/** Validate the JSON body shared by profile create and update. */
export async function parseProfileBody(
  request: NextRequest,
): Promise<ProfileWriteBody | NextResponse> {
  const text = await readBodyText(request, MAX_PROFILE_BODY_BYTES, TOO_LARGE);
  if (text instanceof NextResponse) return text;

  // `JSON.parse` happily yields null, a number or an array; narrowed here so
  // the field checks below are reading properties off an object.
  let body: { name?: unknown; data?: unknown };
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") throw new Error("not an object");
    body = parsed as { name?: unknown; data?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Whatever the client believed it was withholding, decided here as well.
  // See `profileBlob` for why the server needs its own answer; the short
  // version is that a client is not a trustworthy filter of what the server
  // hands a third party. Done before serialising, so the string below — the
  // one the row stores — is already the redacted one and there is no second
  // pass over 8 MB.
  const data = redactProfileBlob(body.data);

  // Before the serialisation below, which is the expensive half of parsing a
  // body this size, and long before the write lock.
  if (audioEntryCount(data) > MAX_PROFILE_AUDIO_ENTRIES) {
    return tooLargeResponse(TOO_MANY_SOUNDS);
  }

  // Content-length can be absent or wrong, so the parsed size is what decides.
  // Kept rather than discarded: this is the exact string the row will store.
  //
  // Measured in bytes, not `.length`: that counts UTF-16 code units, so a blob
  // of astral-plane characters — an emoji-named pad, at scale — could be two
  // to three times the intended byte ceiling and still pass.
  const serialisedData = JSON.stringify(data ?? null);
  if (Buffer.byteLength(serialisedData, "utf8") > MAX_PROFILE_BODY_BYTES) {
    return tooLarge();
  }

  if (typeof body.name !== "string" || !body.name.trim()) {
    return NextResponse.json(
      { error: "A profile name is required" },
      { status: 400 },
    );
  }
  if (!data || typeof data !== "object") {
    return NextResponse.json(
      { error: "Profile data must be an object" },
      { status: 400 },
    );
  }

  return { name: body.name.trim(), data: data as object, serialisedData };
}

/** The version a profile is at, in ETag form. Used by `If-Match` on writes. */
export function versionEtag(version: number): string {
  return `"${version}"`;
}

/**
 * The ETag for a GET, which covers the access as well as the version.
 *
 * The version alone was wrong twice over. As HTTP, it gave one ETag to two
 * different bodies — the response carries `access`, and promoting a viewer to
 * editor changes it without touching the version. As behaviour, it was worse:
 * the promoted editor's device asked with the version it already had, got a
 * 304 every time, and never learned it had been promoted. Editing is gated on
 * that answer now, so it stayed locked out of a profile it was invited to
 * work on until somebody else happened to make an edit.
 *
 * An older client sending a bare version simply misses and gets a full body.
 */
export function profileEtag(version: number, access: string): string {
  return `"${version}.${access}"`;
}

/** Whether an `If-None-Match` header names this exact representation. */
export function etagMatches(value: string | null, etag: string): boolean {
  if (!value) return false;
  return value
    .split(",")
    .some((candidate) => candidate.trim().replace(/^W\//, "") === etag);
}

/**
 * Parse `If-Match` / `If-None-Match`, tolerating weak and quoted forms.
 *
 * A GET's ETag carries the access as well (`"5.owner"`), and feeding that
 * straight back on a write answered 428 "an If-Match header is required" to a
 * request that had sent one. The version is the part a write cares about, so
 * take it and ignore the rest rather than making the two tags a trap.
 */
export function parseVersionHeader(value: string | null): number | null {
  if (!value) return null;
  const cleaned = value.trim().replace(/^W\//, "").replace(/^"|"$/g, "");
  const version = Number(cleaned.split(".")[0]);
  return Number.isInteger(version) && version > 0 ? version : null;
}
