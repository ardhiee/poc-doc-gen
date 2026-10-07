import { NextResponse } from "next/server";
import { serveWorkspaceFile } from "@/lib/serve-file";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path: segments } = await params;

  // only ever serve files out of a session's own folder
  if (segments[0] !== "sessions" || segments.some((s) => s.includes(".."))) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

  return serveWorkspaceFile(segments.join("/"), segments[segments.length - 1]);
}
