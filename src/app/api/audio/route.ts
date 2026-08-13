import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/server/apiAuth";
import { getUserUsage, listUserAudio } from "@/lib/server/audio";
import {
  audioHostingDisabled,
  resolveObjectStore,
} from "@/lib/server/audioRequests";

/**
 * GET /api/audio — what the signed-in user is storing, and how much of their
 * allowance it uses.
 */
export async function GET(request: NextRequest) {
  const user = requireUser(request);
  if (user instanceof NextResponse) return user;

  const hosting = resolveObjectStore();
  if (!hosting) return audioHostingDisabled();

  return NextResponse.json({
    canUploadAudio: user.can_upload_audio === 1,
    usage: getUserUsage(user.id, hosting.config.defaultUserQuotaBytes),
    files: listUserAudio(user.id).map((file) => ({
      hash: file.hash,
      name: file.name,
      sizeBytes: file.size_bytes,
      contentType: file.content_type,
      createdAt: file.created_at,
    })),
  });
}
