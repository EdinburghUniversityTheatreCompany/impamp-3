import { NextRequest, NextResponse } from "next/server";
import {
  getAudioObject,
  releaseReference,
  userHoldsReference,
} from "@/lib/server/audio";
import {
  notFound,
  presignedDownloadResponse,
  requireAudioHosting,
} from "@/lib/server/audioRequests";
import { objectKeyForHash } from "@/lib/server/s3/client";
import type { AudioObjectRow, UserRow } from "@/lib/server/db";

/**
 * Resolve an object the caller personally holds.
 *
 * Not holding a reference is reported exactly like the object not existing, so
 * the bucket's contents stay unenumerable.
 */
function loadHeldObject(
  user: UserRow,
  hash: string,
): AudioObjectRow | NextResponse {
  const object = getAudioObject(hash);
  if (!object || !userHoldsReference(user.id, hash)) return notFound();
  return object;
}

/**
 * GET /api/audio/:hash — a presigned download URL for audio the caller holds.
 *
 * This is the owner's own-library path. Collaborators fetch through
 * /api/profiles/:id/audio/:hash instead, which authorizes via the profile
 * they were shared rather than via a reference of their own.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ hash: string }> },
) {
  const hosting = requireAudioHosting(request);
  if (hosting instanceof NextResponse) return hosting;

  const object = loadHeldObject(hosting.user, (await params).hash);
  if (object instanceof NextResponse) return object;

  return presignedDownloadResponse(hosting, object);
}

/**
 * DELETE /api/audio/:hash — give up this user's reference.
 *
 * Their allowance is freed at once. The bucket object only goes when the last
 * reference to it does, so deleting your copy never removes someone else's.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ hash: string }> },
) {
  const hosting = requireAudioHosting(request);
  if (hosting instanceof NextResponse) return hosting;

  const { hash } = await params;
  const object = loadHeldObject(hosting.user, hash);
  if (object instanceof NextResponse) return object;

  const { removed, orphaned } = releaseReference(hosting.user.id, hash);
  if (!removed) return notFound();

  if (orphaned) {
    await hosting.store.remove(objectKeyForHash(hash, object.extension));
  }

  return NextResponse.json({ removed: true, objectDeleted: orphaned });
}
