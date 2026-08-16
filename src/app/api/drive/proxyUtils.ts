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
 * Origin/Referer stay as a fallback for anything that does not send it, and a
 * request with no signal at all is now refused rather than trusted.
 */
export function isSameHostRequest(request: NextRequest): boolean {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite) return fetchSite === "same-origin";

  const source =
    request.headers.get("origin") ?? request.headers.get("referer");
  if (!source) return false;

  try {
    return new URL(source).host === request.nextUrl.host;
  } catch {
    return false;
  }
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
