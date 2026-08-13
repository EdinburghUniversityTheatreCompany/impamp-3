import { NextRequest, NextResponse } from "next/server";

/**
 * Downloads a publicly shared Google Drive file using a server-side API key.
 * This avoids CORS issues and keeps the API key out of the browser.
 * Works for files shared with "anyone with the link" or "anyone on the internet".
 *
 * GET /api/drive/public-file?id=FILE_ID
 * Returns: the raw JSON content of the file, or an error response
 */
// Profile JSON is text; anything larger than this is not ours to proxy
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

/**
 * Rejects cross-site callers. Requests without an Origin or Referer (direct
 * navigation, same-origin fetches in some browsers) are allowed through.
 */
function isSameHostRequest(request: NextRequest): boolean {
  const source =
    request.headers.get("origin") ?? request.headers.get("referer");
  if (!source) return true;

  try {
    return new URL(source).host === request.nextUrl.host;
  } catch {
    return false;
  }
}

export async function GET(request: NextRequest) {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "Google API key not configured on server" },
      { status: 500 },
    );
  }

  if (!isSameHostRequest(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const fileId = request.nextUrl.searchParams.get("id");
  if (!fileId || !/^[a-zA-Z0-9_-]+$/.test(fileId)) {
    return NextResponse.json({ error: "Invalid file ID" }, { status: 400 });
  }

  try {
    const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${apiKey}`;
    const response = await fetch(url);

    if (!response.ok) {
      // Try to surface Google's own error message
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

    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
      return NextResponse.json(
        { error: "File is too large to import" },
        { status: 413 },
      );
    }

    const body = await response.text();
    if (body.length > MAX_RESPONSE_BYTES) {
      return NextResponse.json(
        { error: "File is too large to import" },
        { status: 413 },
      );
    }

    try {
      return NextResponse.json(JSON.parse(body));
    } catch {
      return NextResponse.json(
        { error: "File is not valid ImpAmp profile JSON" },
        { status: 502 },
      );
    }
  } catch {
    return NextResponse.json(
      { error: "Could not reach Google. Check your connection." },
      { status: 503 },
    );
  }
}
