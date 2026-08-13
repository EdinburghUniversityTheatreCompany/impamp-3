import { NextRequest, NextResponse } from "next/server";
import { upsertUserFromGoogle } from "@/lib/server/users";
import { createSession } from "@/lib/server/session";

/**
 * Test-only sign-in, for the E2E suite.
 *
 * Signing in properly needs a real Google account, which no test can have.
 * The alternative — writing a session row straight into the SQLite file from
 * the test process — makes the test a *second writer* against a database the
 * server holds open, and `node:sqlite` is synchronous: a lock wait blocks the
 * server's entire event loop, stalling every unrelated request. That showed up
 * as unrelated specs timing out and the suite taking four times as long.
 *
 * So the tests ask the server to do it instead, keeping one writer.
 *
 * The route does not exist unless `IMPAMP_E2E_SIGNIN_SECRET` is set *and* the
 * caller presents it. Production never sets it, and a missing or wrong secret
 * answers 404 rather than 401 — an attacker learns nothing about whether the
 * route is there at all.
 *
 * POST /api/test/session
 * Header: x-impamp-e2e-secret: <secret>
 * Body:   { email: string }
 * Returns: { user, token } — the caller attaches the token itself.
 */
const SECRET_HEADER = "x-impamp-e2e-secret";

export async function POST(request: NextRequest) {
  const expected = process.env.IMPAMP_E2E_SIGNIN_SECRET;
  const notFound = NextResponse.json({ error: "Not found" }, { status: 404 });

  if (!expected) return notFound;
  if (request.headers.get(SECRET_HEADER) !== expected) return notFound;

  let email: unknown;
  try {
    ({ email } = await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof email !== "string" || !email.includes("@")) {
    return NextResponse.json(
      { error: "An email is required" },
      { status: 400 },
    );
  }

  const user = upsertUserFromGoogle({
    sub: `e2e-${email}`,
    email,
    name: email,
    picture: null,
  });
  const token = createSession(user.id);

  // Deliberately no Set-Cookie: Playwright's APIRequestContext keeps a cookie
  // jar, so setting one here would silently sign in every later request made
  // through that context — including the ones asserting anonymous access.
  // Callers attach the token where they actually want it.
  return NextResponse.json({
    user: { id: user.id, email: user.email, isAdmin: user.is_admin === 1 },
    token,
  });
}
