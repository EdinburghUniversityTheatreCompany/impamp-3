/**
 * HTTP client for hosted audio.
 *
 * Same shape as `serverSync/api.ts`: same-origin, session cookie carried
 * automatically, link-share token in a header rather than the query string.
 *
 * The bytes themselves never go through these calls — the server hands back a
 * presigned URL and the browser talks to the bucket directly.
 */

import { NotSignedInError } from "@/lib/serverSync/types";
import { fetchWithTimeout } from "@/lib/fetchWithTimeout";

const SHARE_TOKEN_HEADER = "x-impamp-share-token";

/** Raised when the account is not approved to host audio. */
export class NotApprovedForAudioError extends Error {
  constructor(message = "This account is not approved to upload audio") {
    super(message);
    this.name = "NotApprovedForAudioError";
  }
}

/** Raised when an upload would cross a quota or the deployment-wide cap. */
export class AudioQuotaError extends Error {
  constructor(
    message: string,
    readonly reason: "too_large" | "user_quota" | "global_cap",
    readonly usedBytes?: number,
    readonly limitBytes?: number,
  ) {
    super(message);
    this.name = "AudioQuotaError";
  }
}

/** Raised when this deployment hosts no audio at all. */
export class AudioHostingUnavailableError extends Error {
  constructor() {
    super("This server does not host audio files");
    this.name = "AudioHostingUnavailableError";
  }
}

export interface AudioUsage {
  usedBytes: number;
  quotaBytes: number;
  fileCount: number;
}

export interface HostedAudioFile {
  hash: string;
  name: string;
  sizeBytes: number;
  contentType: string;
  createdAt: number;
}

export interface UploadTicket {
  key: string;
  uploadUrl: string | null;
  alreadyStored: boolean;
  expiresInSeconds: number;
}

export interface DownloadTicket {
  url: string;
  sizeBytes: number;
  contentType: string;
  expiresInSeconds: number;
}

async function errorBody(response: Response): Promise<{
  error?: string;
  reason?: string;
  usedBytes?: number;
  limitBytes?: number;
}> {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

/** Turn a refusal into the specific error the UI can act on. */
async function throwForStatus(response: Response, fallback: string) {
  if (response.status === 401) throw new NotSignedInError();
  if (response.status === 501) throw new AudioHostingUnavailableError();

  const body = await errorBody(response);

  if (response.status === 403) {
    throw new NotApprovedForAudioError(body.error);
  }
  if (response.status === 413 || response.status === 507) {
    throw new AudioQuotaError(
      body.error ?? fallback,
      (body.reason as AudioQuotaError["reason"]) ?? "user_quota",
      body.usedBytes,
      body.limitBytes,
    );
  }

  // The status rides along so a caller can tell "this object is gone" from
  // "the server is having a moment". Getting that wrong in either direction is
  // costly: retrying a permanent failure blocks the profile from ever syncing
  // again, and warning on a transient one lets the pull apply without the
  // audio, which strips the pads.
  const error = new Error(body.error ?? fallback) as Error & {
    status?: number;
  };
  error.status = response.status;
  throw error;
}

/** What the signed-in user is storing, and whether they may store more. */
export async function fetchAudioLibrary(): Promise<{
  canUploadAudio: boolean;
  usage: AudioUsage;
  files: HostedAudioFile[];
}> {
  const response = await fetchWithTimeout("/api/audio");
  if (!response.ok)
    await throwForStatus(response, "Could not read audio usage");
  return response.json();
}

/** Ask permission to upload, and get somewhere to put the bytes. */
export async function requestUploadUrl(file: {
  hash: string;
  sizeBytes: number;
  contentType: string;
  extension: string;
}): Promise<UploadTicket> {
  const response = await fetchWithTimeout("/api/audio/upload-url", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(file),
  });
  if (!response.ok) {
    await throwForStatus(response, "Could not start the upload");
  }
  return response.json();
}

/** Tell the server the bytes landed, so it can start accounting for them. */
export async function commitUpload(file: {
  hash: string;
  name: string;
  contentType: string;
  extension: string;
}): Promise<{ hash: string; sizeBytes: number; usage: AudioUsage }> {
  const response = await fetchWithTimeout("/api/audio/commit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(file),
  });
  if (!response.ok) {
    await throwForStatus(response, "Could not finish the upload");
  }
  return response.json();
}

/** A presigned URL for audio the signed-in user holds. */
export async function requestOwnDownloadUrl(
  hash: string,
): Promise<DownloadTicket> {
  const response = await fetchWithTimeout(`/api/audio/${hash}`);
  if (!response.ok) {
    await throwForStatus(response, "Could not fetch that audio");
  }
  return response.json();
}

/**
 * A presigned URL for audio belonging to a profile the caller can see. This is
 * the path collaborators and anonymous link-share holders use.
 */
export async function requestProfileDownloadUrl(
  serverProfileId: string,
  hash: string,
  shareToken?: string | null,
): Promise<DownloadTicket> {
  const requestHeaders = new Headers();
  if (shareToken) requestHeaders.set(SHARE_TOKEN_HEADER, shareToken);

  const response = await fetchWithTimeout(
    `/api/profiles/${serverProfileId}/audio/${hash}`,
    { headers: requestHeaders },
  );
  if (!response.ok) {
    await throwForStatus(response, "Could not fetch that audio");
  }
  return response.json();
}

/** Give up this user's reference to an object. */
export async function deleteHostedAudio(hash: string): Promise<void> {
  const response = await fetchWithTimeout(`/api/audio/${hash}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    await throwForStatus(response, "Could not delete that audio");
  }
}
