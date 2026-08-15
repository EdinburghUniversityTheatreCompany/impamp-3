import { NextRequest, NextResponse } from "next/server";
import {
  canUpload,
  getAudioObject,
  getUserUsage,
  quotaForUser,
  recordUpload,
  storageKeyForHash,
} from "@/lib/server/audio";
import { beginAudioRequest, uploadRefusal } from "@/lib/server/audioRequests";

/**
 * POST /api/audio/commit — confirm an upload landed, and start charging for it.
 *
 * The presigned PUT signs only `host`, so it cannot constrain what the browser
 * actually sent. This is where that is settled: the server HEADs the object,
 * takes the size from the bucket rather than from the client, and re-runs the
 * quota decision against the real number. An object that turns out to be over
 * the line is deleted again rather than kept and billed for.
 */
export async function POST(request: NextRequest) {
  const begun = await beginAudioRequest<{ name?: unknown }>(request);
  if (begun instanceof NextResponse) return begun;
  const { ctx, body, fields } = begun;
  const { user, store, config } = ctx;

  if (typeof body.name !== "string" || !body.name.trim()) {
    return NextResponse.json({ error: "A name is required" }, { status: 400 });
  }

  const key = storageKeyForHash(fields.hash, fields.extension);

  const stored = await store.head(key);
  if (!stored) {
    return NextResponse.json(
      { error: "No uploaded object found for that hash" },
      { status: 404 },
    );
  }

  // Re-decide with the size the bucket reports, not the one the client
  // claimed when it asked for the URL.
  const decision = canUpload({
    userId: user.id,
    canUploadAudio: user.can_upload_audio === 1,
    hash: fields.hash,
    sizeBytes: stored.sizeBytes,
    quotaBytes: quotaForUser(user.id, config.defaultUserQuotaBytes),
    capBytes: config.globalCapBytes,
    maxObjectBytes: config.maxObjectBytes,
  });

  if (!decision.allowed) {
    // Don't leave bytes in the bucket we refused to account for — but only if
    // nobody else is already holding this object. Keys are content-addressed,
    // so a refused upload of audio someone else legitimately stored must not
    // delete theirs.
    if (!getAudioObject(fields.hash)) {
      await store.remove(key).catch(() => {
        // Best effort: the accounting refusal is what matters to the caller.
      });
      // A commit of the same hash can land between that check and this line,
      // in which case the bytes someone else just paid for have gone. Nothing
      // here can undo it, so make it loud enough to notice and re-upload
      // rather than a silent 404 for whoever committed.
      if (getAudioObject(fields.hash)) {
        console.error(
          `Removed ${key} while refusing an upload, but another commit recorded that hash in the meantime — its bytes are gone.`,
        );
      }
    }
    return uploadRefusal(decision);
  }

  recordUpload({
    userId: user.id,
    hash: fields.hash,
    sizeBytes: stored.sizeBytes,
    contentType: fields.contentType,
    extension: fields.extension,
    name: body.name.trim(),
  });

  return NextResponse.json({
    hash: fields.hash,
    key,
    sizeBytes: stored.sizeBytes,
    usage: getUserUsage(user.id, config.defaultUserQuotaBytes),
  });
}
