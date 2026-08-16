import { NextRequest, NextResponse } from "next/server";
import { canWrite } from "@/lib/server/shares";
import { deleteProfile, updateProfile } from "@/lib/server/profiles";
import { publishProfileChange } from "@/lib/server/events";
import {
  loadAuthorizedProfile,
  loadAuthorizedProfileMeta,
  parseProfileBody,
  etagMatches,
  parseVersionHeader,
  profileEtag,
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
  // Meta first: the change poll is a conditional GET that almost always ends
  // in 304, and answering it does not need the blob. This used to read up to
  // MAX_PROFILE_BODY_BYTES off disk before even computing the ETag, which is
  // what made the comment above ("costs almost nothing") untrue.
  const meta = loadAuthorizedProfileMeta(request, id);
  if (meta instanceof NextResponse) return meta;

  const { access } = meta;
  const etag = profileEtag(meta.profile.version, access);

  if (etagMatches(request.headers.get("if-none-match"), etag)) {
    return new NextResponse(null, { status: 304, headers: { ETag: etag } });
  }

  const loaded = loadAuthorizedProfile(request, id);
  if (loaded instanceof NextResponse) return loaded;
  const { profile } = loaded;

  // The stored blob is already JSON, so it is spliced into the response rather
  // than parsed into an object graph for `NextResponse.json` to serialise
  // straight back — three full traversals of up to 8 MB, synchronously, on the
  // thread serving every other request.
  const body = `{"id":${JSON.stringify(profile.id)},"name":${JSON.stringify(
    profile.name,
  )},"version":${profile.version},"updatedAt":${profile.updated_at},"access":${JSON.stringify(
    access,
  )},"data":${profile.data}}`;

  return new NextResponse(body, {
    headers: { "content-type": "application/json", ETag: etag },
  });
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
    // Spliced rather than parsed, as in GET — and it matters more here: the
    // most expensive response is the one that accomplished nothing, and the
    // client retries it up to MAX_PUSH_ATTEMPTS times.
    const body = `{"error":"Profile changed since you last pulled it","version":${
      result.profile.version
    },"updatedAt":${result.profile.updated_at},"name":${JSON.stringify(
      result.profile.name,
    )},"data":${result.profile.data}}`;

    return new NextResponse(body, {
      status: 409,
      headers: {
        "content-type": "application/json",
        ETag: versionEtag(result.profile.version),
      },
    });
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
  // Only `version` is read below, so the blob stays on disk.
  const loaded = loadAuthorizedProfileMeta(request, id);
  if (loaded instanceof NextResponse) return loaded;

  if (loaded.access !== "owner") {
    return NextResponse.json(
      { error: "Only the owner can delete a profile" },
      { status: 403 },
    );
  }

  const { version } = loaded.profile;
  deleteProfile(id);
  // Watchers were never told, so a collaborator's tab sat on a profile that no
  // longer exists until something else made it look. The version is bumped
  // past the last one they saw so the pull that follows is not a no-op; that
  // pull 404s, which is how they find out.
  publishProfileChange({ profileId: id, version: version + 1 });
  return NextResponse.json({ ok: true });
}
