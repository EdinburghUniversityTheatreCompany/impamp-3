import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/server/apiAuth";
import { getGlobalUsage, listUserUsage } from "@/lib/server/audio";
import {
  audioHostingDisabled,
  resolveObjectStore,
} from "@/lib/server/audioRequests";
import { sweepIfDue } from "@/lib/server/audioSweep";

/**
 * GET /api/admin/audio — how much hosted audio exists in total, and per user.
 *
 * Admin-only. Answers 404 rather than 403 for a non-admin, so the existence of
 * an admin surface isn't advertised to ordinary accounts.
 */
export async function GET(request: NextRequest) {
  const admin = requireAdmin(request);
  if (admin instanceof NextResponse) return admin;

  const hosting = resolveObjectStore();
  if (!hosting) return audioHostingDisabled();
  const { config } = hosting;

  // Bytes a browser PUT and never committed are invisible to every number
  // below — no audio_objects row means nothing counts them — so the one page
  // that reports storage is also where they get cleared up. Throttled to once
  // an hour, and a bucket failure is logged rather than 500ing this page.
  const sweep = await sweepIfDue(hosting);

  return NextResponse.json({
    global: getGlobalUsage(config.globalCapBytes),
    defaultUserQuotaBytes: config.defaultUserQuotaBytes,
    maxObjectBytes: config.maxObjectBytes,
    users: listUserUsage(config.defaultUserQuotaBytes),
    sweep,
  });
}
