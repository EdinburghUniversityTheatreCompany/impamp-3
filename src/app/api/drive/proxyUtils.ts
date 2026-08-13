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
