import { NextRequest, NextResponse } from "next/server";

/**
 * Shared request validation for the public Drive proxy routes
 * (public-file and public-audio).
 *
 * Returns the server API key and the validated ?id= param, or a ready-made
 * error response when either is missing/invalid.
 */
export function getProxyRequestParams(
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
 * `Sec-Fetch-Site` is the header that actually answers the question, and every
 * browser that can run this app sends it: `same-origin` for the app's own
 * fetches, `none` for a URL typed into the bar, and the cross-site values for
 * everything else. It cannot be set by page script, so a caller that wants to
 * claim same-origin has to actually be same-origin.
 *
 * There is deliberately no Origin/Referer fallback. It used to be here, for
 * clients that send no `Sec-Fetch-Site` — but it stopped nothing this gate
 * exists to stop, because `Referer` is set by the caller: one
 * `curl -H "Referer: https://this-host/"` satisfied it. A check an attacker
 * satisfies at will is not a check; it only costs the honest caller a header,
 * while leaving the quota and the bandwidth as open as before.
 *
 * The cost is browsers too old to send the header — Safari before 16.4, which
 * shipped in March 2023. They lose the *public share* proxies only: the
 * soundboard itself needs none of this, because its audio lives in IndexedDB,
 * and the failure is a clean 403 rather than a silent empty pad. That is a
 * better trade than a gate which reads as protection and is not.
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
