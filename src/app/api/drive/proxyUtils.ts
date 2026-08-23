import { NextRequest, NextResponse } from "next/server";
import { clientKey, consume, LIMITS } from "@/lib/server/rateLimit";

/**
 * Shared request validation for the public Drive proxy routes
 * (public-file and public-audio).
 *
 * Returns the server API key and the validated ?id= param, or a ready-made
 * error response when either is missing/invalid.
 */
function getProxyRequestParams(
  request: NextRequest,
):
  | { apiKey: string; fileId: string; errorResponse?: undefined }
  | { apiKey?: undefined; fileId?: undefined; errorResponse: NextResponse } {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    return {
      errorResponse: NextResponse.json(
        { error: "Google API key not configured on server" },
        { status: 500 },
      ),
    };
  }

  const fileId = request.nextUrl.searchParams.get("id");
  if (!fileId || !/^[a-zA-Z0-9_-]+$/.test(fileId)) {
    return {
      errorResponse: NextResponse.json(
        { error: "Invalid file ID" },
        { status: 400 },
      ),
    };
  }

  return { apiKey, fileId };
}

/**
 * Rejects callers that cannot show they came from this app.
 *
 * This used to allow a request carrying *neither* Origin nor Referer, on the
 * reasoning that some same-origin fetches omit both. Omitting both is also the
 * easiest thing in the world to do deliberately — one curl — and these proxies
 * are unauthenticated, unrate-limited, serve up to 100 MB, and spend the
 * deployment's own `GOOGLE_API_KEY` doing it.
 *
 * `Sec-Fetch-Site` is the header that answers it for a browser, and every
 * browser that can run this app sends it: `same-origin` for the app's own
 * fetches, `none` for a URL typed into the bar, and the cross-site values for
 * everything else. Page script cannot set it, so no page on another origin can
 * make its fetch look like ours.
 *
 * **That is the whole of what this stops, and it is worth being exact about.**
 * This comment used to conclude "a caller that wants to claim same-origin has
 * to actually be same-origin", which does not follow: "cannot be set by page
 * script" is a statement about browsers, and a caller that is not a browser
 * sets it freely. One `curl -H "Sec-Fetch-Site: same-origin"` passes this gate
 * — exactly as `curl -H "Referer: https://this-host/"` passed the Referer
 * check that was removed *for that reason*, three paragraphs of this same
 * docstring ago. The replacement inherited the flaw along with the job.
 *
 * So: this is a filter against cross-origin *browser* abuse, which is real and
 * worth having, and it is not an authorisation control. What bounds a scripted
 * caller is the rate limit in `lib/server/rateLimit.ts`, which is why these
 * routes now take one. Do not downgrade a finding on the strength of this
 * gate alone — that has happened once already, in
 * `plans/repo-review-2026-08-22-subsystems.md`.
 *
 * There is deliberately no Origin/Referer fallback, for the reason above.
 *
 * The cost is browsers too old to send the header — Safari before 16.4, which
 * shipped in March 2023. They lose the *public share* proxies only: the
 * soundboard itself needs none of this, because its audio lives in IndexedDB,
 * and the failure is a clean 403 rather than a silent empty pad.
 */
export function isSameHostRequest(request: NextRequest): boolean {
  return request.headers.get("sec-fetch-site") === "same-origin";
}

/**
 * Map a failed Google Drive API response to a JSON error response,
 * surfacing Google's own error message where available. 403/404 pass
 * through; anything else becomes a 502.
 */
export async function driveErrorResponse(
  response: Response,
): Promise<NextResponse> {
  const errorBody = (await response.json().catch(() => null)) as {
    error?: { message?: string };
  } | null;
  const message =
    errorBody?.error?.message ?? `Drive API error: ${response.status}`;
  return NextResponse.json(
    { error: message },
    {
      status:
        response.status === 403 || response.status === 404
          ? response.status
          : 502,
    },
  );
}

/**
 * Everything both proxies must do before they spend anything.
 *
 * One function rather than the same seven lines in two routes: the duplication
 * gate caught the second copy the moment the rate limit was added to both, and
 * "the same rule written twice" is this repo's characteristic regression.
 * Order matters and is the point — validate the parameters, then reject a
 * cross-origin browser, then count the request — so that a refusal costs a
 * regex and a map lookup rather than a call to Google on the deployment's key.
 *
 * @param request - The inbound request
 * @returns The validated key and file id, or a response to return as-is
 */
export function beginProxyRequest(
  request: NextRequest,
): { apiKey: string; fileId: string } | NextResponse {
  const params = getProxyRequestParams(request);
  if (params.errorResponse) return params.errorResponse;

  if (!isSameHostRequest(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const key = clientKey(request);
  // Nothing in front of the app — dev, or the E2E run. See `clientKey`.
  if (key) {
    const result = consume(`drive:${key}`, LIMITS.driveProxy);
    if (!result.allowed) {
      return NextResponse.json(
        { error: "Too many requests. Try again shortly." },
        {
          status: 429,
          headers: { "Retry-After": String(result.retryAfterSeconds) },
        },
      );
    }
  }

  return { apiKey: params.apiKey, fileId: params.fileId };
}
