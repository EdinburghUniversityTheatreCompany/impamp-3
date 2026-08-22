import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/server/apiAuth";
import {
  countProfilesOwnedBy,
  createProfile,
  listProfilesForUser,
  MAX_PROFILES_PER_USER,
} from "@/lib/server/profiles";
import { parseProfileBody, versionEtag } from "@/lib/server/profileRequests";

/**
 * Server-synced profiles belonging to, or shared with, the signed-in user.
 *
 * GET  /api/profiles — [{ id, name, version, updatedAt, access, ownerEmail }]
 * POST /api/profiles — create one from a ProfileSyncData blob
 */
export async function GET(request: NextRequest) {
  const user = requireUser(request);
  if (user instanceof NextResponse) return user;

  return NextResponse.json({
    profiles: listProfilesForUser(user.id, user.email),
  });
}

export async function POST(request: NextRequest) {
  const user = requireUser(request);
  if (user instanceof NextResponse) return user;

  // Before the body is read: nothing caps how large the store gets otherwise,
  // and an account that has hit the ceiling should not get there by uploading
  // 8 MB first.
  if (countProfilesOwnedBy(user.id) >= MAX_PROFILES_PER_USER) {
    return NextResponse.json(
      {
        error: `You already have ${MAX_PROFILES_PER_USER} profiles on this server. Delete one to add another.`,
      },
      { status: 403 },
    );
  }

  const body = await parseProfileBody(request);
  if (body instanceof NextResponse) return body;

  const profile = createProfile({ ownerId: user.id, ...body });

  return NextResponse.json(
    {
      id: profile.id,
      name: profile.name,
      version: profile.version,
      updatedAt: profile.updated_at,
      access: "owner",
    },
    { status: 201, headers: { ETag: versionEtag(profile.version) } },
  );
}
