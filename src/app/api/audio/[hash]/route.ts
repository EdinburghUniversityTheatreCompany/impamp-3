import { NextRequest, NextResponse } from "next/server";
import {
  getAudioObject,
  deletingHashWouldSilenceAProfile,
  releaseReference,
  storageKeyForHash,
  userHoldsReference,
} from "@/lib/server/audio";
import {
  notFound,
  presignedDownloadResponse,
  requireAudioHosting,
} from "@/lib/server/audioRequests";
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

  // Letting go of the last reference deletes the bytes, and nothing used to
  // ask whether a board still played them: an owner tidying their library
  // could make their own live profile 404 on the sound it was still using.
  // Asked of the boards this caller's reference actually serves — a stranger
  // naming your hash in a profile of their own, or inviting you to one, must
  // not be able to pin your storage forever.
  if (deletingHashWouldSilenceAProfile(hosting.user.id, hash)) {
    return NextResponse.json(
      {
        error:
          "That sound is still used by a profile. Remove it from the profile first.",
      },
      { status: 409 },
    );
  }

  const { removed, orphaned } = releaseReference(hosting.user.id, hash);
  if (!removed) return notFound();

  let objectDeleted = orphaned;
  if (orphaned) {
    // The rows are already gone, so a throw here would 500 after the caller's
    // allowance was freed and leave bytes nothing counts and no API can
    // reach. Reported instead, so it is at least visible.
    try {
      await hosting.store.remove(storageKeyForHash(hash, object.extension));
    } catch (error) {
      objectDeleted = false;
      console.error(
        `Freed the reference to ${hash} but could not remove its bytes:`,
        error,
      );
    }
  }

  return NextResponse.json({ removed: true, objectDeleted });
}
