/**
 * Shared authorization helpers for the server-sync API routes.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSessionUser, SESSION_COOKIE } from "./session";
import { resolveAccess } from "./shares";
import type { Access, UserRow } from "./db";

/** Header a client may use instead of `?token=` to present a share link token. */
export const SHARE_TOKEN_HEADER = "x-impamp-share-token";

function getRequestUser(request: NextRequest): UserRow | null {
  return getSessionUser(request.cookies.get(SESSION_COOKIE)?.value);
}

/**
 * A share link token from either the query string (what a pasted URL carries)
 * or a request header (what the client sends once it has stored the token).
 */
function getShareToken(request: NextRequest): string | null {
  return (
    request.nextUrl.searchParams.get("token") ??
    request.headers.get(SHARE_TOKEN_HEADER)
  );
}

export interface AuthorizedRequest {
  user: UserRow | null;
  access: Access;
}

/**
 * Resolve who the caller is and what they may do with a profile.
 *
 * On failure returns a response rather than throwing. No access and a missing
 * profile both answer 404: distinguishing them would let anyone probe which
 * profile IDs exist.
 */
export function authorizeProfileRequest(
  request: NextRequest,
  profileId: string,
): AuthorizedRequest | NextResponse {
  const user = getRequestUser(request);
  const access = resolveAccess({
    profileId,
    user: user ? { id: user.id, email: user.email } : null,
    linkToken: getShareToken(request),
  });

  if (!access) {
    return NextResponse.json({ error: "Profile not found" }, { status: 404 });
  }

  return { user, access };
}

/** Narrowing helper — `authorizeProfileRequest` returns either shape. */
export function isErrorResponse(
  result: AuthorizedRequest | NextResponse,
): result is NextResponse {
  return result instanceof NextResponse;
}

/** Require a signed-in user, or answer 401. */
export function requireUser(request: NextRequest): UserRow | NextResponse {
  const user = getRequestUser(request);
  if (!user) {
    return NextResponse.json(
      { error: "Sign in with Google to use server sync" },
      { status: 401 },
    );
  }
  return user;
}
