import { NextRequest, NextResponse } from "next/server";

/**
 * Downloads a publicly shared Google Drive file using a server-side API key.
 * This avoids CORS issues and keeps the API key out of the browser.
 * Works for files shared with "anyone with the link" or "anyone on the internet".
 *
 * GET /api/drive/public-file?id=FILE_ID
 * Returns: the raw JSON content of the file, or 403/404 passthrough
 */
export async function GET(request: NextRequest) {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "Google API key not configured on server" },
      { status: 500 },
    );
  }

  const fileId = request.nextUrl.searchParams.get("id");
  if (!fileId || !/^[a-zA-Z0-9_-]+$/.test(fileId)) {
    return NextResponse.json({ error: "Invalid file ID" }, { status: 400 });
  }

  try {
    const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${encodeURIComponent(apiKey)}`;
    const response = await fetch(url);

    if (response.status === 403 || response.status === 404) {
      return NextResponse.json(
        { error: "File not accessible" },
        { status: response.status },
      );
    }

    if (!response.ok) {
      return NextResponse.json(
        { error: `Drive API error: ${response.status}` },
        { status: 502 },
      );
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
