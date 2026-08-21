import { NextRequest, NextResponse } from "next/server";
import { authorizeProfileRequest, isErrorResponse } from "@/lib/server/apiAuth";
import {
  createLinkShare,
  listShares,
  upsertEmailShare,
} from "@/lib/server/shares";
import type { Role, ShareRow } from "@/lib/server/db";
import { parseJsonBody } from "@/lib/server/requestBody";

/**
 * Collaborators on a profile.
 *
 * GET  /api/profiles/:id/shares — owner only; listing who has access is
 *                                 itself sensitive.
 * POST /api/profiles/:id/shares — invite an email, or mint a share link.
 *                                 Body: { role, email? } — omitting `email`
 *                                 creates a link share.
 */

const ROLES: Role[] = ["viewer", "editor"];

function serializeShare(share: ShareRow) {
  return {
    id: share.id,
    role: share.role,
    email: share.email,
    // The token is the credential — only ever returned to the owner, who is
    // the only caller this route serves.
    linkToken: share.link_token,
    createdAt: share.created_at,
  };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const auth = authorizeProfileRequest(request, id);
  if (isErrorResponse(auth)) return auth;

  if (auth.access !== "owner") {
    return NextResponse.json(
      { error: "Only the owner can manage sharing" },
      { status: 403 },
    );
  }

  return NextResponse.json({ shares: listShares(id).map(serializeShare) });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const auth = authorizeProfileRequest(request, id);
  if (isErrorResponse(auth)) return auth;

  if (auth.access !== "owner" || !auth.user) {
    return NextResponse.json(
      { error: "Only the owner can manage sharing" },
      { status: 403 },
    );
  }

  const body = await parseJsonBody<{ role?: unknown; email?: unknown }>(
    request,
  );
  if (body instanceof NextResponse) return body;

  const role = body.role;
  if (typeof role !== "string" || !ROLES.includes(role as Role)) {
    return NextResponse.json(
      { error: 'Role must be "viewer" or "editor"' },
      { status: 400 },
    );
  }

  if (body.email === undefined || body.email === null) {
    const share = createLinkShare(id, role as Role, auth.user.id);
    return NextResponse.json({ share: serializeShare(share) }, { status: 201 });
  }

  if (typeof body.email !== "string" || !body.email.includes("@")) {
    return NextResponse.json(
      { error: "A valid email address is required" },
      { status: 400 },
    );
  }

  const share = upsertEmailShare(id, body.email, role as Role, auth.user.id);
  return NextResponse.json({ share: serializeShare(share) }, { status: 201 });
}
