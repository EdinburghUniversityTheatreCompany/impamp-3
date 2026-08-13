import { NextRequest, NextResponse } from "next/server";
import { getProxyRequestParams, driveErrorResponse } from "../proxyUtils";

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
export async function GET(request: NextRequest) {
  const params = getProxyRequestParams(request);
  if (params.errorResponse) return params.errorResponse;
  const { apiKey, fileId } = params;

  const wantMeta = request.nextUrl.searchParams.get("meta") === "1";

  try {
    const url = wantMeta
      ? `https://www.googleapis.com/drive/v3/files/${fileId}?fields=name,mimeType,size,modifiedTime,version&key=${apiKey}`
      : `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${apiKey}`;
    const response = await fetch(url);

    if (!response.ok) {
      return driveErrorResponse(response);
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch {
    return NextResponse.json(
      { error: "Could not reach Google. Check your connection." },
      { status: 503 },
    );
  }
}
