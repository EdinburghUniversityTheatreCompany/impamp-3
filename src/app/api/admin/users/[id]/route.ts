import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/server/apiAuth";
import { setAudioPermissions } from "@/lib/server/users";
import { getUserUsage } from "@/lib/server/audio";
import { parseJsonBody } from "@/lib/server/requestBody";
import {
  audioHostingDisabled,
  resolveObjectStore,
} from "@/lib/server/audioRequests";

/**
 * PATCH /api/admin/users/:id — approve an account for audio hosting, or give
 * it a storage allowance other than the deployment default.
 *
 * Admin-only, and 404 rather than 403 for everyone else.
 *
 * Body: { canUploadAudio?: boolean, audioQuotaBytes?: number | null }
 * `audioQuotaBytes: null` puts the user back on the default.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const admin = requireAdmin(request);
  if (admin instanceof NextResponse) return admin;

  const hosting = resolveObjectStore();
  if (!hosting) return audioHostingDisabled();

  const userId = Number((await params).id);
  if (!Number.isInteger(userId) || userId <= 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await parseJsonBody<{
    canUploadAudio?: unknown;
    audioQuotaBytes?: unknown;
  }>(request);
  if (body instanceof NextResponse) return body;

  if (
    body.canUploadAudio !== undefined &&
    typeof body.canUploadAudio !== "boolean"
  ) {
    return NextResponse.json(
      { error: "canUploadAudio must be a boolean" },
      { status: 400 },
    );
  }

  if (
    body.audioQuotaBytes !== undefined &&
    body.audioQuotaBytes !== null &&
    (typeof body.audioQuotaBytes !== "number" ||
      !Number.isInteger(body.audioQuotaBytes) ||
      body.audioQuotaBytes < 0)
  ) {
    return NextResponse.json(
      { error: "audioQuotaBytes must be a non-negative integer or null" },
      { status: 400 },
    );
  }

  const updated = setAudioPermissions(userId, {
    canUploadAudio: body.canUploadAudio as boolean | undefined,
    audioQuotaBytes: body.audioQuotaBytes as number | null | undefined,
  });

  if (!updated) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({
    id: updated.id,
    email: updated.email,
    canUploadAudio: updated.can_upload_audio === 1,
    usage: getUserUsage(updated.id, hosting.config.defaultUserQuotaBytes),
  });
}
