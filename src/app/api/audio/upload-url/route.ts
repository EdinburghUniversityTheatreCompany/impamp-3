import { NextRequest, NextResponse } from "next/server";
import { canUpload, quotaForUser, storageKeyForHash } from "@/lib/server/audio";
import { beginAudioRequest, uploadRefusal } from "@/lib/server/audioRequests";
import { proofRangeFor } from "@/lib/server/proofOfPossession";

/**
 * POST /api/audio/upload-url — ask permission to upload one audio file.
 *
 * Answers a short-lived presigned PUT the browser sends the bytes to directly;
 * they never pass through this server. The size quoted here is the client's
 * claim and is only used to refuse obviously-too-big uploads early — what
 * actually gets charged is measured server-side at commit time.
 *
 * `alreadyStored` tells the client the bytes are in the bucket already
 * (someone uploaded the same audio before) and it can skip straight to commit.
 */
export async function POST(request: NextRequest) {
  const begun = await beginAudioRequest<{ sizeBytes?: unknown }>(request);
  if (begun instanceof NextResponse) return begun;
  const { ctx, body, fields } = begun;
  const { user, store, config } = ctx;

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

  const decision = canUpload({
    userId: user.id,
    canUploadAudio: user.can_upload_audio === 1,
    hash: fields.hash,
    sizeBytes: body.sizeBytes,
    quotaBytes: quotaForUser(user.id, config.defaultUserQuotaBytes),
    capBytes: config.globalCapBytes,
    maxObjectBytes: config.maxObjectBytes,
  });

  if (!decision.allowed) return uploadRefusal(decision);

  const key = storageKeyForHash(fields.hash, fields.extension);

  // When the bytes are already there the caller uploads nothing — so it has to
  // show it actually holds them before commit will hand it a reference.
  // `head` proves the key exists, never that this caller has its contents, and
  // the hash is public: it travels in every profile blob a viewer can read.
  const stored = decision.alreadyStored ? await store.head(key) : null;

  return NextResponse.json({
    key,
    alreadyStored: decision.alreadyStored,
    // Nothing to upload when the bytes are already there — commit directly.
    uploadUrl: decision.alreadyStored ? null : store.presignUpload(key),
    proofRange: stored ? proofRangeFor(fields.hash, stored.sizeBytes) : null,
    expiresInSeconds: config.uploadUrlTtlSeconds,
  });
}
