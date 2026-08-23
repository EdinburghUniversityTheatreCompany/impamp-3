import { NextRequest, NextResponse } from "next/server";
import { beginProxyRequest, driveErrorResponse } from "../proxyUtils";
import { fetchWithTimeout } from "@/lib/fetchWithTimeout";

/**
 * Downloads a publicly shared Google Drive file using a server-side API key.
 * This avoids CORS issues and keeps the API key out of the browser.
 * Works for files shared with "anyone with the link" or "anyone on the internet".
 *
 * GET /api/drive/public-file?id=FILE_ID
 * Returns: the raw JSON content of the file, or an error response
 *
 * GET /api/drive/public-file?id=FILE_ID&meta=1
 * Returns: file metadata (name, mimeType, size, modifiedTime, version) instead
 * of content — used by the client to cheaply detect remote changes on public
 * profiles without downloading the whole file.
 */
// Profile JSON is text; anything larger than this is not ours to proxy
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

export async function GET(request: NextRequest) {
  const begun = beginProxyRequest(request);
  if (begun instanceof NextResponse) return begun;
  const { apiKey, fileId } = begun;

  const wantMeta = request.nextUrl.searchParams.get("meta") === "1";

  try {
    const url = wantMeta
      ? `https://www.googleapis.com/drive/v3/files/${fileId}?fields=name,mimeType,size,modifiedTime,version&key=${apiKey}`
      : `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${apiKey}`;
    const response = await fetchWithTimeout(url);

    if (!response.ok) {
      return driveErrorResponse(response);
    }

    const declaredLength = Number(response.headers.get("content-length"));
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > MAX_RESPONSE_BYTES
    ) {
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
      // `nosniff` for the same reason the audio proxy carries it: the bytes
      // below are a stranger's, fetched with this deployment's own API key and
      // served from this app's origin. The type is ours rather than Drive's
      // here — the body is re-serialised as JSON — so the header is all that
      // is missing.
      return NextResponse.json(JSON.parse(body), {
        headers: { "X-Content-Type-Options": "nosniff" },
      });
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
