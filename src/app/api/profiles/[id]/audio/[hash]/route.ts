import { NextRequest, NextResponse } from "next/server";
import { getAudioObject } from "@/lib/server/audio";
import {
  audioHostingDisabled,
  notFound,
  presignedDownloadResponse,
  resolveObjectStore,
} from "@/lib/server/audioRequests";
import { loadAuthorizedProfile } from "@/lib/server/profileRequests";
import type { ProfileSyncData } from "@/lib/syncUtils";

/**
 * GET /api/profiles/:id/audio/:hash — a presigned download URL for a
 * collaborator.
 *
 * This is how shared audio actually reaches the people a profile was shared
 * with, including anonymous holders of a link-share token: authorization comes
 * from access to the *profile*, not from owning the file. To stop that being a
 * skeleton key for the whole bucket, the profile's own data must list the hash.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; hash: string }> },
) {
  const { id, hash } = await params;

  const authorized = loadAuthorizedProfile(request, id);
  if (authorized instanceof NextResponse) return authorized;

  const hosting = resolveObjectStore();
  if (!hosting) return audioHostingDisabled();

  if (!profileReferencesHash(authorized.profile.data, hash)) return notFound();

  const object = getAudioObject(hash);
  if (!object) return notFound();

  return presignedDownloadResponse(hosting, object);
}

/**
 * Whether the stored profile blob lists this hash among its audio files.
 *
 * Parsed defensively: the column holds whatever a client last wrote, so bad
 * JSON or an unexpected shape must read as "no" rather than throw.
 */
function profileReferencesHash(data: string, hash: string): boolean {
  let parsed: Partial<ProfileSyncData>;
  try {
    parsed = JSON.parse(data);
  } catch {
    return false;
  }

  if (!Array.isArray(parsed.audioFiles)) return false;
  return parsed.audioFiles.some((file) => file?.hash === hash);
}
