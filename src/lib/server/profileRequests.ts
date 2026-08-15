/**
 * Request plumbing shared by the profile routes: loading an authorized
 * profile, and validating a profile write body.
 */

import { NextRequest, NextResponse } from "next/server";
import { authorizeProfileRequest, isErrorResponse } from "./apiAuth";
import { getProfileById } from "./profiles";
import type { Access, ProfileRow, UserRow } from "./db";

export interface AuthorizedProfile {
  profile: ProfileRow;
  access: Access;
  user: UserRow | null;
}

/**
 * Resolve the caller's access to a profile and load the row, or return the
 * response to send instead.
 *
 * A profile the caller may not see and a profile that does not exist both
 * answer 404, so profile IDs stay unenumerable.
 */
export function loadAuthorizedProfile(
  request: NextRequest,
  id: string,
): AuthorizedProfile | NextResponse {
  const auth = authorizeProfileRequest(request, id);
  if (isErrorResponse(auth)) return auth;

  const profile = getProfileById(id);
  if (!profile) {
    return NextResponse.json({ error: "Profile not found" }, { status: 404 });
  }

  return { profile, access: auth.access, user: auth.user };
}

export interface ProfileWriteBody {
  name: string;
  data: object;
}

/** Validate the JSON body shared by profile create and update. */
export async function parseProfileBody(
  request: NextRequest,
): Promise<ProfileWriteBody | NextResponse> {
  let body: { name?: unknown; data?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body.name !== "string" || !body.name.trim()) {
    return NextResponse.json(
      { error: "A profile name is required" },
      { status: 400 },
    );
  }
  if (!body.data || typeof body.data !== "object") {
    return NextResponse.json(
      { error: "Profile data must be an object" },
      { status: 400 },
    );
  }

  return { name: body.name.trim(), data: body.data as object };
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

/** Parse `If-Match` / `If-None-Match`, tolerating weak and quoted forms. */
export function parseVersionHeader(value: string | null): number | null {
  if (!value) return null;
  const cleaned = value.trim().replace(/^W\//, "").replace(/^"|"$/g, "");
  const version = Number(cleaned);
  return Number.isInteger(version) && version > 0 ? version : null;
}
