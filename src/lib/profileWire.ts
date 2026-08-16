/**
 * What a profile record is allowed to look like once it leaves this device.
 *
 * Every outbound path — a `.impamp`/`.iaz` export, a Drive sync blob, a server
 * sync blob — used to serialise the profile by spreading the stored record and
 * removing one field:
 *
 * ```ts
 * const { lastBackedUpAt, ...profileToExport } = profile;
 * ```
 *
 * That fails open. Any field added to `Profile` travels by default, and the
 * author of the new field has to *know* about three separate spreads to stop
 * it. `serverShareToken` is what that cost: it is a bearer credential — whoever
 * holds it gets the role it was issued with (`src/lib/server/shares.ts`) — and
 * it rode inside every blob. `GET /api/profiles/:id` hands the blob back
 * verbatim to anyone authorised to *read* the profile, so a viewer could read
 * an editor's token out of it and promote themselves; the same token also
 * shipped inside every export file.
 *
 * So the list below is an allow-list, not a deny-list, and it is the only place
 * that decides. `buildImportedProfileFields` in `importExport.ts` is the
 * inbound counterpart and has worked this way all along — this is the missing
 * half of that pair.
 *
 * **Adding a field to `Profile` does not put it on the wire.** Add it here
 * deliberately, and only if a *different* device has business knowing it.
 *
 * @module lib/profileWire
 */

import type { Profile } from "./db";

/**
 * Profile fields that may be serialised for another device.
 *
 * Deliberately the full set that travelled before, minus the credential — the
 * point of this change is to close the leak without altering what sync and
 * import already agree about. In particular the Drive ids stay: the blob
 * carrying a Drive id for everything that has one is a deliberate decision
 * (withholding it assumed hosting had happened, and when it silently had not
 * the blob named sounds nobody could fetch and pads were emptied). Adoption is
 * gated on the receiving side, in `mayAdoptDriveIds`, not by withholding.
 */
const SHAREABLE_PROFILE_FIELDS = [
  "id",
  "name",
  "syncType",
  "googleDriveFileId",
  "googleDriveFolderId",
  "serverProfileId",
  "serverVersion",
  "serverRole",
  "audioLocation",
  "readOnly",
  "followOnly",
  "activePadBehavior",
  "normalisation",
  "syncPausedUntil",
  "lastBackedUpAt",
  "backupReminderPeriod",
  "createdAt",
  "updatedAt",
  "_created",
  "_modified",
  "_fieldsModified",
] as const satisfies readonly (keyof Profile)[];

/**
 * Profile fields deliberately withheld, and why.
 *
 * Short by design. The job here is to close the credential leak without
 * changing what sync and import already agree travels — `lastBackedUpAt` is
 * dropped by the *export* path specifically, as it always was, because an
 * import stamps its own.
 *
 * Kept as a checked list rather than a comment so the exhaustiveness assertion
 * below can prove that every field of `Profile` was considered — a new field is
 * a type error here until someone decides which side it belongs on.
 */
export const WITHHELD_PROFILE_FIELDS = [
  // A bearer credential. Never leaves the device that was granted it.
  "serverShareToken",
] as const satisfies readonly (keyof Profile)[];

type Shareable = (typeof SHAREABLE_PROFILE_FIELDS)[number];
type Withheld = (typeof WITHHELD_PROFILE_FIELDS)[number];

/**
 * Fails to compile if a `Profile` field appears on neither list, so a new field
 * cannot reach the wire — or be dropped from it — by accident.
 */
type Unclassified = Exclude<keyof Profile, Shareable | Withheld>;
const _everyProfileFieldIsClassified: Unclassified extends never
  ? true
  : ["Unclassified Profile field — add it to profileWire.ts", Unclassified] =
  true;
void _everyProfileFieldIsClassified;

/** A profile record as it appears in an export file or a sync blob. */
export type WireProfile = Pick<Profile, Shareable>;

/**
 * Reduces a stored profile to the fields that may leave this device.
 *
 * Copies only listed keys that are actually present, so an absent optional
 * field stays absent rather than becoming an explicit `undefined` — the blobs
 * are compared field-by-field during a merge, and `undefined` is not the same
 * answer as "not set".
 *
 * @param profile - The stored profile record
 * @returns A copy carrying only the shareable fields
 */
export function toWireProfile(profile: Profile): WireProfile {
  const wire: Partial<Record<Shareable, unknown>> = {};

  for (const field of SHAREABLE_PROFILE_FIELDS) {
    if (field in profile && profile[field] !== undefined) {
      wire[field] = profile[field];
    }
  }

  return wire as WireProfile;
}
