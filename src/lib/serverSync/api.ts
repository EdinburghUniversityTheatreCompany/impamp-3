/**
 * HTTP client for the server-sync API.
 *
 * Every call is same-origin and carries the session cookie automatically.
 * A link-share token, when the profile was opened from a share URL, travels
 * in a header so it never ends up in a server access log's query string.
 */

import {
  NotSignedInError,
  VersionConflictError,
  type ProfileSyncData,
  type ServerProfilePayload,
  type ServerProfileSummary,
  type ServerShare,
  type ServerUser,
} from "./types";

const SHARE_TOKEN_HEADER = "x-impamp-share-token";

/** Identifies this browser tab, so it can ignore the echo of its own writes. */
export const ORIGIN_ID =
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : String(Math.random());

function headers(shareToken?: string | null, extra?: HeadersInit): Headers {
  const result = new Headers(extra);
  if (shareToken) result.set(SHARE_TOKEN_HEADER, shareToken);
  return result;
}

async function errorMessage(response: Response, fallback: string) {
  try {
    const body = await response.json();
    return typeof body?.error === "string" ? body.error : fallback;
  } catch {
    // A non-JSON error body (a proxy's HTML 502 page, say) tells us nothing
    // more useful than the status we already have.
    return fallback;
  }
}

/** The signed-in server user, or null when there is no session. */
export async function fetchCurrentUser(): Promise<ServerUser | null> {
  const response = await fetch("/api/auth/session");
  if (response.status === 401) return null;
  if (!response.ok) {
    throw new Error(await errorMessage(response, "Could not read session"));
  }
  return (await response.json()).user as ServerUser;
}

export async function signOutOfServer(): Promise<void> {
  await fetch("/api/auth/session", { method: "DELETE" });
}

export async function listServerProfiles(): Promise<ServerProfileSummary[]> {
  const response = await fetch("/api/profiles");
  if (response.status === 401) throw new NotSignedInError();
  if (!response.ok) {
    throw new Error(await errorMessage(response, "Could not list profiles"));
  }
  return (await response.json()).profiles as ServerProfileSummary[];
}

/**
 * Fetch a profile.
 *
 * Pass `knownVersion` to get `null` back when nothing has changed — the
 * server answers 304 and sends no body, which is what makes the change check
 * cheap enough to run often.
 */
export async function fetchServerProfile(
  profileId: string,
  options: {
    shareToken?: string | null;
    knownVersion?: number | null;
    knownAccess?: string | null;
  } = {},
): Promise<ServerProfilePayload | null> {
  const requestHeaders = headers(options.shareToken);
  // The access goes in the tag alongside the version, because the response
  // states it and it changes without the version moving. Ask with only the
  // version and a device promoted from viewer to editor gets 304 forever, and
  // never finds out it may write. Omitting it asks for the body every time,
  // which is the safe way to be wrong.
  if (options.knownVersion && options.knownAccess) {
    requestHeaders.set(
      "If-None-Match",
      `"${options.knownVersion}.${options.knownAccess}"`,
    );
  }

  const response = await fetch(`/api/profiles/${profileId}`, {
    headers: requestHeaders,
  });

  if (response.status === 304) return null;
  if (response.status === 404) {
    throw new Error(
      "This profile is no longer available on the server. It may have been deleted, or your access removed.",
    );
  }
  if (!response.ok) {
    throw new Error(await errorMessage(response, "Could not fetch profile"));
  }

  return (await response.json()) as ServerProfilePayload;
}

export async function createServerProfile(
  name: string,
  data: ProfileSyncData,
): Promise<{ id: string; version: number }> {
  const response = await fetch("/api/profiles", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, data }),
  });

  if (response.status === 401) throw new NotSignedInError();
  if (!response.ok) {
    throw new Error(await errorMessage(response, "Could not create profile"));
  }

  const body = await response.json();
  return { id: body.id, version: body.version };
}

/**
 * Push a profile, but only on top of `expectedVersion`.
 *
 * @throws VersionConflictError carrying the server's current state, so the
 * caller can merge and retry without another round trip.
 */
export async function pushServerProfile(
  profileId: string,
  name: string,
  data: ProfileSyncData,
  expectedVersion: number,
  shareToken?: string | null,
): Promise<{ version: number }> {
  const response = await fetch(`/api/profiles/${profileId}`, {
    method: "PUT",
    headers: headers(shareToken, {
      "Content-Type": "application/json",
      "If-Match": `"${expectedVersion}"`,
      "x-impamp-origin": ORIGIN_ID,
    }),
    body: JSON.stringify({ name, data }),
  });

  if (response.status === 409) {
    const body = await response.json();
    throw new VersionConflictError(body.version, body.name, body.data);
  }
  if (response.status === 403) {
    throw new Error("You have view-only access to this profile");
  }
  if (!response.ok) {
    throw new Error(await errorMessage(response, "Could not save profile"));
  }

  return { version: (await response.json()).version as number };
}

export async function deleteServerProfile(profileId: string): Promise<void> {
  const response = await fetch(`/api/profiles/${profileId}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    throw new Error(await errorMessage(response, "Could not delete profile"));
  }
}

export async function listServerShares(
  profileId: string,
): Promise<ServerShare[]> {
  const response = await fetch(`/api/profiles/${profileId}/shares`);
  if (!response.ok) {
    throw new Error(await errorMessage(response, "Could not list sharing"));
  }
  return (await response.json()).shares as ServerShare[];
}

export async function createServerShare(
  profileId: string,
  role: "viewer" | "editor",
  email?: string,
): Promise<ServerShare> {
  const response = await fetch(`/api/profiles/${profileId}/shares`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(email ? { role, email } : { role }),
  });
  if (!response.ok) {
    throw new Error(await errorMessage(response, "Could not share profile"));
  }
  return (await response.json()).share as ServerShare;
}

export async function deleteServerShare(
  profileId: string,
  shareId: number,
): Promise<void> {
  const response = await fetch(`/api/profiles/${profileId}/shares/${shareId}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    throw new Error(await errorMessage(response, "Could not revoke sharing"));
  }
}
