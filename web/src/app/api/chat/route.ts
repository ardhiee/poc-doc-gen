import { abortOpencodeSession, opencodeBaseUrl, promptSessionAsync, rejectPermission } from "@/lib/opencode";
import { getOrCreateSession } from "@/lib/session-map";
import { renderFsdForSession } from "@/lib/fsd-render";

export const dynamic = "force-dynamic";

interface OpencodeEvent {
  type: string;
  properties: Record<string, unknown>;
}

export async function POST(request: Request) {
  const { text, conversationId, title, agent } = (await request.json()) as {
    text: string;
    conversationId: string;
    title?: string;
    agent?: string;
  };

  const sessionId = await getOrCreateSession(conversationId, title ?? text.slice(0, 60));

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (payload: Record<string, unknown>) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      };
      const finish = () => {
        if (closed) return;
        closed = true;
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      };

      const upstream = await fetch(`${opencodeBaseUrl()}/event`, {
        headers: { Accept: "text/event-stream" },
      });
      if (!upstream.body) {
        send({ choices: [{ delta: {}, finish_reason: "stop" }] });
        finish();
        return;
      }

      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      // The Stop button aborts the client's fetch, which signals here — genuinely
      // stop the agent server-side too, not just our own relaying. Without this,
      // "Stop" would only hide the stream in the browser while opencode kept
      // running, writing files, and burning tokens invisibly in the background.
      request.signal.addEventListener("abort", () => {
        abortOpencodeSession(sessionId).catch((err) => console.error("Failed to abort session", err));
        reader.cancel().catch(() => {});
      });

      // Every step's text streams live as it's generated — no buffering, no waiting to
      // see whether a later step follows. A multi-step tool-calling turn (e.g. an
      // upfront plan, then a final summary) just appears as one continuously growing
      // visible answer instead of hiding earlier steps in a collapsible box.
      const assistantMessageIds = new Set<string>();

      const turnStartMs = Date.now();
      try {
        await promptSessionAsync(sessionId, text, agent);

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let frameEnd = buffer.indexOf("\n\n");
          while (frameEnd !== -1) {
            const frame = buffer.slice(0, frameEnd);
            buffer = buffer.slice(frameEnd + 2);
            frameEnd = buffer.indexOf("\n\n");

            const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
            if (!dataLine) continue;

            let evt: OpencodeEvent;
            try {
              evt = JSON.parse(dataLine.slice(5).trim());
            } catch {
              continue;
            }

            if (evt.properties.sessionID !== sessionId) continue;

            if (evt.type === "message.updated") {
              const info = evt.properties.info as Record<string, unknown>;
              if (info.role === "assistant") assistantMessageIds.add(info.id as string);
            }

            if (evt.type === "message.part.updated") {
              const part = evt.properties.part as Record<string, unknown>;
              if (part.type === "tool") {
                const state = part.state as Record<string, unknown>;
                const status = state?.status as string;
                const kaiState =
                  status === "completed"
                    ? "output-available"
                    : status === "error"
                      ? "output-error"
                      : "input-available";
                // custom, non-standard field — readOpenAIStream ignores frames without
                // a recognized "choices" shape, so this safely rides the same SSE stream
                send({
                  kai_tool: {
                    toolCallId: part.id as string,
                    type: part.tool as string,
                    state: kaiState,
                    input: state?.input,
                    output: state?.output ? { result: state.output } : undefined,
                    errorText: status === "error" ? JSON.stringify(state?.output ?? "error") : undefined,
                  },
                });
              }
            }

            if (evt.type === "permission.updated") {
              // No human operator exists to answer this in our headless API
              // flow — left alone, opencode waits forever for a reply that
              // never comes. Reject immediately so the turn fails fast with
              // a visible error instead of silently hanging.
              const permissionId = evt.properties.id as string;
              rejectPermission(sessionId, permissionId).catch((err) =>
                console.error("Failed to reject permission", err),
              );
            }

            if (
              evt.type === "message.part.delta" &&
              evt.properties.field === "text" &&
              assistantMessageIds.has(evt.properties.messageID as string)
            ) {
              const delta = evt.properties.delta as string;
              send({ choices: [{ delta: { content: delta }, finish_reason: null }] });
            }

            if (evt.type === "session.idle") {
              let fsdFilename: string | undefined;
              try {
                fsdFilename = renderFsdForSession(sessionId, turnStartMs);
              } catch (err) {
                console.error("FSD render failed", err);
              }
              if (fsdFilename) {
                const fileRef = "\n\n`sessions/" + sessionId + "/" + fsdFilename + "`";
                send({ choices: [{ delta: { content: fileRef }, finish_reason: null }] });
              }

              send({ choices: [{ delta: {}, finish_reason: "stop" }] });
              finish();
              await reader.cancel().catch(() => {});
              return;
            }
          }
        }
        send({ choices: [{ delta: {}, finish_reason: "stop" }] });
      } catch (err) {
        send({ error: { message: err instanceof Error ? err.message : String(err) } });
      } finally {
        finish();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
