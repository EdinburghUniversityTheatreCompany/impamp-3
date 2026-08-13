import { NextRequest, NextResponse } from "next/server";
import { subscribeToProfile } from "@/lib/server/events";
import { loadAuthorizedProfile } from "@/lib/server/profileRequests";

/**
 * Server-sent events for one profile: "it changed, pull again".
 *
 * GET /api/profiles/:id/events
 *
 * This is what replaces Drive's 15-minute polling window with roughly a
 * second. The payload deliberately carries only the new version, never the
 * data — the client pulls through the normal ETag path, so there is one code
 * path for reading a profile and no way for an event to deliver stale bytes.
 */

// A streaming response must not be cached or statically analysed.
export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 25_000;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const loaded = loadAuthorizedProfile(request, id);
  if (loaded instanceof NextResponse) return loaded;

  const { profile } = loaded;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // The client went away between our check and the write.
          closed = true;
        }
      };

      // Tell the client where the profile is right now, so a watcher that
      // connects after a change it missed still converges.
      send(
        `event: change\ndata: ${JSON.stringify({
          profileId: id,
          version: profile.version,
        })}\n\n`,
      );

      const unsubscribe = subscribeToProfile(id, (change) => {
        send(`event: change\ndata: ${JSON.stringify(change)}\n\n`);
      });

      // Comment frames keep proxies from timing the connection out.
      const heartbeat = setInterval(
        () => send(`: keep-alive\n\n`),
        HEARTBEAT_MS,
      );

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // Already closed by the runtime.
        }
      };

      request.signal.addEventListener("abort", cleanup);
    },
  });

  return new NextResponse(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Nginx-style proxies buffer streamed bodies unless told not to.
      "X-Accel-Buffering": "no",
    },
  });
}
