import { NextRequest, NextResponse } from "next/server";
import {
  canUpload,
  prunePendingUploads,
  quotaForUser,
  recordPendingUpload,
  storageKeyForHash,
} from "@/lib/server/audio";
import { beginAudioRequest, uploadRefusal } from "@/lib/server/audioRequests";
import { proofRangeFor } from "@/lib/server/proofOfPossession";
import { consume, LIMITS } from "@/lib/server/rateLimit";

/**
 * POST /api/audio/upload-url — ask permission to upload one audio file.
 *
 * Answers a short-lived presigned PUT the browser sends the bytes to directly;
 * they never pass through this server. The size quoted here is the client's
 * claim: it refuses an obviously-too-big upload early, and is charged
 * provisionally until the commit lands or the URL expires, so that a caller
 * who never commits cannot keep asking. What is finally charged is the size
 * the bucket reports at commit.
 *
 * `alreadyStored` tells the client the bytes are in the bucket already
 * (someone uploaded the same audio before) and it can skip straight to commit.
 */
export async function POST(request: NextRequest) {
  const begun = await beginAudioRequest<{ sizeBytes?: unknown }>(request);
  if (begun instanceof NextResponse) return begun;
  const { ctx, body, fields } = begun;
  const { user, store, config } = ctx;

  // Per account, not per IP: this route is authenticated, so the account is
  // both the stabler key and the thing being spent. It bounds a stolen session
  // minting presigned PUTs in a loop; the quota bounds what they can hold.
  const minting = consume(`upload-url:${user.id}`, LIMITS.uploadUrl);
  if (!minting.allowed) {
    return NextResponse.json(
      { error: "Too many upload requests. Try again shortly." },
      {
        status: 429,
        headers: { "Retry-After": String(minting.retryAfterSeconds) },
      },
    );
  }

  if (
    typeof body.sizeBytes !== "number" ||
    !Number.isInteger(body.sizeBytes) ||
    body.sizeBytes <= 0
  ) {
    return NextResponse.json(
      { error: "sizeBytes must be a positive integer" },
      { status: 400 },
    );
  }

  // A mint this old cannot be used any more: the presign has expired. Dropped
  // before deciding, so an upload that failed frees its provisional charge
  // rather than counting against the user until something else clears it.
  const pendingSince = Date.now() - config.uploadUrlTtlSeconds * 1000;
  prunePendingUploads(pendingSince);

  const decision = canUpload({
    userId: user.id,
    canUploadAudio: user.can_upload_audio === 1,
    hash: fields.hash,
    sizeBytes: body.sizeBytes,
    quotaBytes: quotaForUser(user.id, config.defaultUserQuotaBytes),
    capBytes: config.globalCapBytes,
    maxObjectBytes: config.maxObjectBytes,
    pendingSince,
  });

  if (!decision.allowed) return uploadRefusal(decision);

  const key = storageKeyForHash(fields.hash, fields.extension);

  // When the bytes are already there the caller uploads nothing — so it has to
  // show it actually holds them before commit will hand it a reference.
  // `head` proves the key exists, never that this caller has its contents, and
  // the hash is public: it travels in every profile blob a viewer can read.
  const stored = decision.alreadyStored ? await store.head(key) : null;

  // Nothing to upload when the bytes are already there — commit directly.
  const uploadUrl = decision.alreadyStored ? null : store.presignUpload(key);

  // This is the moment a caller is licensed to put bytes in the bucket, and
  // until now it was the moment nothing was recorded: the object is written on
  // commit, so a PUT that never commits stored bytes no total could see, once
  // per invented hash, bounded only by a sweep an admin had to trigger by
  // opening a page.
  //
  // The size is the caller's claim, which is all there is before the bytes
  // land — the presign signs only `host`, so it cannot constrain what is
  // actually sent, and commit re-decides against what the bucket reports. What
  // this bounds is how many licences one account can hold at once.
  if (uploadUrl) {
    recordPendingUpload({
      userId: user.id,
      hash: fields.hash,
      sizeBytes: body.sizeBytes,
    });
  }

  return NextResponse.json({
    key,
    alreadyStored: decision.alreadyStored,
    uploadUrl,
    proofRange: stored ? proofRangeFor(fields.hash, stored.sizeBytes) : null,
    expiresInSeconds: config.uploadUrlTtlSeconds,
  });
}
