import { NextRequest, NextResponse } from "next/server";
import { canWrite } from "@/lib/server/shares";
import { deleteProfile, updateProfile } from "@/lib/server/profiles";
import { publishProfileChange } from "@/lib/server/events";
import {
  loadAuthorizedProfile,
  parseProfileBody,
  parseVersionHeader,
  versionEtag,
} from "@/lib/server/profileRequests";

/**
 * A single server-synced profile.
 *
 * GET    /api/profiles/:id — the blob plus its version, as an ETag.
 *                            Honours `If-None-Match` and answers 304, so the
 *                            client's change poll costs almost nothing.
 * PUT    /api/profiles/:id — requires `If-Match: "<version>"`. A stale version
 *                            gets 409 *with the current blob*, which is what
 *                            lets the client merge and retry without an extra
 *                            round trip.
 * DELETE /api/profiles/:id — owner only.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const loaded = loadAuthorizedProfile(request, id);
  if (loaded instanceof NextResponse) return loaded;

  const { profile, access } = loaded;
  const etag = versionEtag(profile.version);

  if (
    parseVersionHeader(request.headers.get("if-none-match")) === profile.version
  ) {
    return new NextResponse(null, { status: 304, headers: { ETag: etag } });
  }

  return NextResponse.json(
    {
      id: profile.id,
      name: profile.name,
      version: profile.version,
      updatedAt: profile.updated_at,
      access,
      data: JSON.parse(profile.data),
    },
    { headers: { ETag: etag } },
  );
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const loaded = loadAuthorizedProfile(request, id);
  if (loaded instanceof NextResponse) return loaded;

  if (!canWrite(loaded.access)) {
    return NextResponse.json(
      { error: "You have view-only access to this profile" },
      { status: 403 },
    );
  }

  const expectedVersion = parseVersionHeader(request.headers.get("if-match"));
  if (expectedVersion === null) {
    // Without this the last writer would silently win, which is exactly the
    // failure mode server sync exists to remove.
    return NextResponse.json(
      { error: 'An If-Match: "<version>" header is required' },
      { status: 428 },
    );
  }

  const body = await parseProfileBody(request);
  if (body instanceof NextResponse) return body;

  const result = updateProfile(id, { ...body, expectedVersion });

  if (result.status === "not_found") {
    return NextResponse.json({ error: "Profile not found" }, { status: 404 });
  }

  if (result.status === "conflict") {
    // Hand back the current state so the caller can merge locally and retry.
    return NextResponse.json(
      {
        error: "Profile changed since you last pulled it",
        version: result.profile.version,
        updatedAt: result.profile.updated_at,
        name: result.profile.name,
        data: JSON.parse(result.profile.data),
      },
      { status: 409, headers: { ETag: versionEtag(result.profile.version) } },
    );
  }

  publishProfileChange({
    profileId: id,
    version: result.profile.version,
    originId: request.headers.get("x-impamp-origin") ?? undefined,
  });

  return NextResponse.json(
    {
      id: result.profile.id,
      name: result.profile.name,
      version: result.profile.version,
      updatedAt: result.profile.updated_at,
    },
    { headers: { ETag: versionEtag(result.profile.version) } },
  );
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const loaded = loadAuthorizedProfile(request, id);
  if (loaded instanceof NextResponse) return loaded;

  if (loaded.access !== "owner") {
    return NextResponse.json(
      { error: "Only the owner can delete a profile" },
      { status: 403 },
    );
  }

  deleteProfile(id);
  return NextResponse.json({ ok: true });
}
