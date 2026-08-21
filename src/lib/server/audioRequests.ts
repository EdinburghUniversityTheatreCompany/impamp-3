/**
 * Request plumbing shared by the hosted-audio routes: resolving the store,
 * validating the fields a client sends, and the refusal responses.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "./apiAuth";
import { getAudioHostingConfig, type AudioHostingConfig } from "./s3/config";
import {
  createObjectStore,
  objectKeyForHash,
  type ObjectStore,
} from "./s3/client";
import type { AudioObjectRow, UserRow } from "./db";
import type { UploadDecision } from "./audio";
import { parseJsonBody } from "./requestBody";

/**
 * Test seam. Route handlers call `resolveObjectStore()`; tests swap in the
 * in-memory fake so nothing touches a network or needs credentials.
 */
let storeOverride: { store: ObjectStore; config: AudioHostingConfig } | null =
  null;

export function setObjectStoreForTests(
  override: { store: ObjectStore; config: AudioHostingConfig } | null,
): void {
  storeOverride = override;
}

/**
 * The configured store, or `null` when this deployment does not host audio.
 */
export function resolveObjectStore(): {
  store: ObjectStore;
  config: AudioHostingConfig;
} | null {
  if (storeOverride) return storeOverride;

  const config = getAudioHostingConfig();
  if (!config) return null;
  return { store: createObjectStore(config), config };
}

/** 501 rather than 404: the route exists, this deployment just hosts nothing. */
export function audioHostingDisabled(): NextResponse {
  return NextResponse.json(
    { error: "This server does not host audio files" },
    { status: 501 },
  );
}

/** A SHA-256 hex digest, which is the only shape of key we mint. */
function isValidHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/**
 * Only audio, and only types we are willing to serve back. The download URL
 * pins the response Content-Type to this, so it is also the guarantee that a
 * bucket object can never be served as HTML.
 */
const ALLOWED_CONTENT_TYPES = new Set([
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
  "audio/mpeg",
  "audio/mp3",
  "audio/ogg",
  "audio/webm",
  "audio/flac",
  "audio/x-flac",
  "audio/aac",
  "audio/mp4",
  "audio/x-m4a",
]);

function isAllowedContentType(value: unknown): value is string {
  return typeof value === "string" && ALLOWED_CONTENT_TYPES.has(value);
}

/** Map a refusal to the status and message the client should see. */
export function uploadRefusal(
  decision: Extract<UploadDecision, { allowed: false }>,
): NextResponse {
  switch (decision.reason) {
    case "not_approved":
      return NextResponse.json(
        {
          error:
            "This account is not approved to upload audio. Ask an admin to enable it.",
          reason: decision.reason,
        },
        { status: 403 },
      );
    case "too_large":
      return NextResponse.json(
        {
          error: "That file is larger than this server accepts",
          reason: decision.reason,
        },
        { status: 413 },
      );
    case "user_quota":
      return NextResponse.json(
        {
          error: "That would put you over your storage allowance",
          reason: decision.reason,
          ...decision.detail,
        },
        { status: 413 },
      );
    case "global_cap":
      return NextResponse.json(
        {
          error: "The server's audio storage is full. Ask an admin.",
          reason: decision.reason,
          ...decision.detail,
        },
        { status: 507 },
      );
  }
}

export interface AudioHostingContext {
  user: UserRow;
  store: ObjectStore;
  config: AudioHostingConfig;
}

/**
 * The preamble every hosted-audio route shares: a signed-in caller and a
 * deployment that actually hosts audio.
 */
export function requireAudioHosting(
  request: NextRequest,
): AudioHostingContext | NextResponse {
  const user = requireUser(request);
  if (user instanceof NextResponse) return user;

  const hosting = resolveObjectStore();
  if (!hosting) return audioHostingDisabled();

  return { user, ...hosting };
}

export interface AudioFileFields {
  hash: string;
  contentType: string;
  extension: string;
}

/**
 * Validate the fields describing one audio file. Shared by the upload-url and
 * commit routes, which disagree only about whether a size is expected.
 */
export interface AudioBody {
  hash?: unknown;
  contentType?: unknown;
  extension?: unknown;
}

function parseAudioFields(body: AudioBody): AudioFileFields | NextResponse {
  if (!isValidHash(body.hash)) {
    return NextResponse.json(
      { error: "hash must be a SHA-256 hex digest" },
      { status: 400 },
    );
  }
  if (!isAllowedContentType(body.contentType)) {
    return NextResponse.json(
      { error: "Only audio files can be hosted" },
      { status: 415 },
    );
  }

  return {
    hash: body.hash,
    contentType: body.contentType,
    extension: typeof body.extension === "string" ? body.extension : "",
  };
}

/**
 * The presigned-download answer, identical whether the caller reached it
 * through their own library or through a profile they were shared.
 */
export function presignedDownloadResponse(
  { store, config }: { store: ObjectStore; config: AudioHostingConfig },
  object: AudioObjectRow,
): NextResponse {
  return NextResponse.json({
    url: store.presignDownload(
      objectKeyForHash(object.hash, object.extension),
      { contentType: object.content_type },
    ),
    sizeBytes: object.size_bytes,
    contentType: object.content_type,
    expiresInSeconds: config.downloadUrlTtlSeconds,
  });
}

/** A 404 used wherever distinguishing "absent" from "forbidden" would leak. */
export function notFound(): NextResponse {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

/**
 * The whole opening of an audio write route: authenticate, confirm the
 * deployment hosts audio, parse the JSON body, and validate the fields that
 * describe the file. Either every one of those succeeded, or the response to
 * send instead.
 */
export async function beginAudioRequest<T extends object>(
  request: NextRequest,
): Promise<
  | { ctx: AudioHostingContext; body: AudioBody & T; fields: AudioFileFields }
  | NextResponse
> {
  const ctx = requireAudioHosting(request);
  if (ctx instanceof NextResponse) return ctx;

  const body = await parseJsonBody<AudioBody & T>(request);
  if (body instanceof NextResponse) return body;

  const fields = parseAudioFields(body);
  if (fields instanceof NextResponse) return fields;

  return { ctx, body, fields };
}
