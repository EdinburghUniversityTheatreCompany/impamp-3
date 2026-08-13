import { NextRequest, NextResponse } from "next/server";
import {
  getProxyRequestParams,
  driveErrorResponse,
  isSameHostRequest,
} from "../proxyUtils";

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
  const params = getProxyRequestParams(request);
  if (params.errorResponse) return params.errorResponse;
  const { apiKey, fileId } = params;

  if (!isSameHostRequest(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const wantMeta = request.nextUrl.searchParams.get("meta") === "1";

  try {
    const url = wantMeta
      ? `https://www.googleapis.com/drive/v3/files/${fileId}?fields=name,mimeType,size,modifiedTime,version&key=${apiKey}`
      : `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${apiKey}`;
    const response = await fetch(url);

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
