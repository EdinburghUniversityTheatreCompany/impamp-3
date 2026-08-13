import { NextRequest, NextResponse } from "next/server";
import { authorizeProfileRequest, isErrorResponse } from "@/lib/server/apiAuth";
import { deleteShare } from "@/lib/server/shares";

/**
 * Revoke one share.
 *
 * DELETE /api/profiles/:id/shares/:shareId — owner only. Deleting a link
 * share invalidates that link and no other.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; shareId: string }> },
) {
  const { id, shareId } = await params;
  const auth = authorizeProfileRequest(request, id);
  if (isErrorResponse(auth)) return auth;

  if (auth.access !== "owner") {
    return NextResponse.json(
      { error: "Only the owner can manage sharing" },
      { status: 403 },
    );
  }

  const numericId = Number(shareId);
  if (!Number.isInteger(numericId)) {
    return NextResponse.json({ error: "Invalid share id" }, { status: 400 });
  }

  if (!deleteShare(id, numericId)) {
    return NextResponse.json({ error: "Share not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
