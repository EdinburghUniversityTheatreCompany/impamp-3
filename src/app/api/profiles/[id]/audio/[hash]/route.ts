import { NextRequest, NextResponse } from "next/server";
import { getAudioObject, profileMayServeHash } from "@/lib/server/audio";
import {
  audioHostingDisabled,
  notFound,
  presignedDownloadResponse,
  resolveObjectStore,
} from "@/lib/server/audioRequests";
import { loadAuthorizedProfileMeta } from "@/lib/server/profileRequests";
import { profileNamesHash } from "@/lib/server/profiles";

/**
 * GET /api/profiles/:id/audio/:hash — a presigned download URL for a
 * collaborator.
 *
 * This is how shared audio actually reaches the people a profile was shared
 * with, including anonymous holders of a link-share token: authorization comes
 * from access to the *profile*, not from owning the file. To stop that being a
 * skeleton key for the whole bucket, the profile's own data must list the hash.
 *
 * Nothing here needs the blob, and this is the busiest route of the lot — it
 * runs once per sound per collaborator per session. It used to load the profile
 * row with `SELECT *`, pulling up to 8 MB off disk and turning it into a UTF-16
 * string, and then `JSON.parse` it, to answer a membership question that
 * `profile_audio` has had an index for since migration 3. Synchronously, so it
 * blocked the event loop for its duration; a 60-sound board cost 60 of those on
 * every open.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; hash: string }> },
) {
  const { id, hash } = await params;

  const authorized = loadAuthorizedProfileMeta(request, id);
  if (authorized instanceof NextResponse) return authorized;

  const hosting = resolveObjectStore();
  if (!hosting) return audioHostingDisabled();

  if (!profileNamesHash(authorized.profile.id, hash)) return notFound();

  // The blob is the caller's own word — anyone can create a profile and list
  // any hash in it, which made this a fetch-by-hash service for the whole
  // bucket, and meant revoking a share did not revoke the audio. This asks
  // the server's own record instead: did someone who can publish to *this*
  // profile actually upload this sound.
  if (
    !profileMayServeHash(
      authorized.profile.id,
      authorized.profile.owner_id,
      hash,
    )
  ) {
    return notFound();
  }

  const object = getAudioObject(hash);
  if (!object) return notFound();

  return presignedDownloadResponse(hosting, object);
}
