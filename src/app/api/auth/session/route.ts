import { NextRequest, NextResponse } from "next/server";
import {
  destroySession,
  getSessionUser,
  SESSION_COOKIE,
} from "@/lib/server/session";
import { toPublicUser } from "@/lib/server/users";

/**
 * The current server-sync session.
 *
 * The session cookie is HttpOnly, so the client can't read it directly — this
 * route is how the app finds out whether server sync is available to it.
 *
 * GET    /api/auth/session — { user } for a valid session, 401 otherwise
 * DELETE /api/auth/session — sign out of server sync
 */
export async function GET(request: NextRequest) {
  const user = getSessionUser(request.cookies.get(SESSION_COOKIE)?.value);
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  return NextResponse.json({ user: toPublicUser(user) });
}

export async function DELETE(request: NextRequest) {
  destroySession(request.cookies.get(SESSION_COOKIE)?.value);

  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, "", { path: "/", maxAge: 0 });
  return response;
}
