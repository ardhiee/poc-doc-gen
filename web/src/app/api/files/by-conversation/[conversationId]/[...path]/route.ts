import { NextResponse } from "next/server";
import { getSessionIdForConversation } from "@/lib/session-map";
import { serveWorkspaceFile } from "@/lib/serve-file";

/**
 * Resolves a file link reported RELATIVE to an agent's own session folder
 * (e.g. `artifacts/feature/X/02-design.md`, no `sessions/<id>/` prefix —
 * every SDLC agent's bash calls run with their own folder as `workdir`, so
 * they never include it themselves) to the real session id, then proxies
 * the same way /api/files/[...path] does. Not tied to any one agent — any
 * conversation's output resolves the same way.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ conversationId: string; path: string[] }> },
) {
  const { conversationId, path: segments } = await params;

  if (segments.some((s) => s.includes(".."))) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

  const sessionId = getSessionIdForConversation(conversationId);
  if (!sessionId) {
    return NextResponse.json({ error: "Unknown conversation" }, { status: 404 });
  }

  const relativePath = `sessions/${sessionId}/${segments.join("/")}`;
  return serveWorkspaceFile(relativePath, segments[segments.length - 1]);
}
