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
 * server. Only the audio types named below are allowed, the response is
 * marked `nosniff`, and a size cap prevents this route from being abused as a
 * generic Drive proxy.
 *
 * GET /api/drive/public-audio?id=FILE_ID
 * Returns: the audio bytes, or a JSON error response
 */

const MAX_AUDIO_BYTES = 100 * 1024 * 1024; // 100 MB

/**
 * The types this proxy is willing to serve, named one by one.
 *
 * `mimeType` comes from Drive, which reports whatever the uploader's browser
 * or client declared — so it is attacker-influenced input, and it used to be
 * echoed straight back as the response `Content-Type` after nothing more than
 * a `startsWith("audio/")` test. Any `audio/<anything>` passed, including
 * types no browser has an opinion about, on a route that streams up to 100 MB
 * from this deployment's own origin. Naming the types is what makes the
 * response header this app's word rather than the uploader's.
 *
 * Deliberately generous: everything a browser or Drive plausibly reports for
 * a sound file is here, because refusing a legitimate one costs a view-only
 * listener their audio, while an unrecognised type costs an attacker only the
 * trouble of picking a real one. The narrowing that matters is that the set
 * is closed and the value echoed is the one from this list.
 */
const ALLOWED_TYPES = new Set([
  // What the hosted-audio upload path accepts, so the two agree about what a
  // sound file is (src/lib/server/audioRequests.ts).
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
  "audio/vnd.wave",
  "audio/x-pn-wav",
  "audio/mpeg",
  "audio/mp3",
  "audio/ogg",
  "audio/opus",
  "audio/webm",
  "audio/flac",
  "audio/x-flac",
  "audio/aac",
  "audio/mp4",
  "audio/x-m4a",
  "audio/aiff",
  "audio/x-aiff",
  "audio/3gpp",
  "audio/amr",
  "audio/x-ms-wma",
  // Drive labels a .ogg as a container rather than as audio, and has since
  // before this route existed.
  "application/ogg",
  "video/ogg",
]);

/**
 * The type to serve this file under, or null to refuse it.
 *
 * Parameters are dropped rather than passed on: `audio/wav; charset=utf-8` is
 * a thing an uploader can write, and there is no charset in a WAV.
 */
function allowedAudioType(mimeType: string): string | null {
  const bare = mimeType.split(";")[0].trim().toLowerCase();
  return ALLOWED_TYPES.has(bare) ? bare : null;
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

    const contentType = meta.mimeType ? allowedAudioType(meta.mimeType) : null;
    if (!contentType) {
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
    // `transfer`, not the default `control` tier: this streams up to
    // MAX_AUDIO_BYTES. The tier was wrong from the start and harmless only
    // because the deadline used to stop at the headers — now that it runs to
    // the last byte, a 10s idle limit would cut off a working download on the
    // kind of connection a venue actually has.
    const mediaResponse = await fetchWithTimeout(mediaUrl, {
      timeoutKind: "transfer",
    });

    if (!mediaResponse.ok || !mediaResponse.body) {
      return NextResponse.json(
        { error: `Drive API error: ${mediaResponse.status}` },
        { status: mediaResponse.status === 404 ? 404 : 502 },
      );
    }

    return new NextResponse(mediaResponse.body, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(size),
        // Without this the type above is a suggestion. A browser that decides
        // the bytes look like something else renders them as that instead,
        // from this app's own origin — which is the whole of what a proxy of
        // someone else's bytes has to prevent.
        "X-Content-Type-Options": "nosniff",
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
