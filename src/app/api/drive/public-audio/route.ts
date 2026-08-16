import { NextRequest, NextResponse } from "next/server";
import {
  getProxyRequestParams,
  driveErrorResponse,
  isSameHostRequest,
} from "../proxyUtils";
import { fetchWithTimeout } from "@/lib/fetchWithTimeout";

/**
 * Streams a publicly shared Google Drive audio file using a server-side API key.
 * Complements /api/drive/public-file (which serves profile JSON) so that
 * view-only users without a Google sign-in — or whose drive.file token cannot
 * see the file — can still fetch the audio of profiles shared with
 * "anyone with the link".
 *
 * The file's bytes are streamed straight through; nothing is stored on the
 * server. Only audio mime types are allowed and a size cap prevents this
 * route from being abused as a generic Drive proxy.
 *
 * GET /api/drive/public-audio?id=FILE_ID
 * Returns: the audio bytes, or a JSON error response
 */

const MAX_AUDIO_BYTES = 100 * 1024 * 1024; // 100 MB

const ALLOWED_EXACT_TYPES = new Set(["application/ogg", "video/ogg"]);

function isAllowedAudioType(mimeType: string): boolean {
  return mimeType.startsWith("audio/") || ALLOWED_EXACT_TYPES.has(mimeType);
}

export async function GET(request: NextRequest) {
  const params = getProxyRequestParams(request);
  if (params.errorResponse) return params.errorResponse;
  const { apiKey, fileId } = params;

  if (!isSameHostRequest(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    // Check metadata first so we can enforce type and size before streaming
    const metaUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?fields=mimeType,size&key=${apiKey}`;
    const metaResponse = await fetchWithTimeout(metaUrl);

    if (!metaResponse.ok) {
      return driveErrorResponse(metaResponse);
    }

    const meta = (await metaResponse.json()) as {
      mimeType?: string;
      size?: string;
    };

    if (!meta.mimeType || !isAllowedAudioType(meta.mimeType)) {
      return NextResponse.json(
        { error: "File is not an audio file" },
        { status: 415 },
      );
    }

    const size = meta.size ? parseInt(meta.size, 10) : NaN;
    if (!Number.isFinite(size) || size > MAX_AUDIO_BYTES) {
      return NextResponse.json(
        { error: "File is too large to proxy" },
        { status: 413 },
      );
    }

    const mediaUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${apiKey}`;
    const mediaResponse = await fetchWithTimeout(mediaUrl);

    if (!mediaResponse.ok || !mediaResponse.body) {
      return NextResponse.json(
        { error: `Drive API error: ${mediaResponse.status}` },
        { status: mediaResponse.status === 404 ? 404 : 502 },
      );
    }

    return new NextResponse(mediaResponse.body, {
      status: 200,
      headers: {
        "Content-Type": meta.mimeType,
        "Content-Length": String(size),
        // Public Drive files rarely change; a short shared cache keeps
        // repeated connects cheap while still honouring revoked shares soon.
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch {
    return NextResponse.json(
      { error: "Could not reach Google. Check your connection." },
      { status: 503 },
    );
  }
}
