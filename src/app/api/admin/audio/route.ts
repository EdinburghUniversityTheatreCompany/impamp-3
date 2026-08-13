import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/server/apiAuth";
import { getGlobalUsage, listUserUsage } from "@/lib/server/audio";
import {
  audioHostingDisabled,
  resolveObjectStore,
} from "@/lib/server/audioRequests";

/**
 * GET /api/admin/audio — how much hosted audio exists in total, and per user.
 *
 * Admin-only. Answers 404 rather than 403 for a non-admin, so the existence of
 * an admin surface isn't advertised to ordinary accounts.
 */
export async function GET(request: NextRequest) {
  const user = requireUser(request);
  if (user instanceof NextResponse) return user;
  if (user.is_admin !== 1) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const hosting = resolveObjectStore();
  if (!hosting) return audioHostingDisabled();
  const { config } = hosting;

  return NextResponse.json({
    global: getGlobalUsage(config.globalCapBytes),
    defaultUserQuotaBytes: config.defaultUserQuotaBytes,
    maxObjectBytes: config.maxObjectBytes,
    users: listUserUsage(config.defaultUserQuotaBytes),
  });
}
