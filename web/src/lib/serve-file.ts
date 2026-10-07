import { NextResponse } from "next/server";
import { opencodeBaseUrl } from "@/lib/opencode";

const MIME_TYPES: Record<string, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
  html: "text/html",
  md: "text/markdown",
};

/** Shared by both /api/files routes (by session id, and by conversation id)
 *  — proxies a file out of opencode's workspace, given a path already known
 *  to be safe (no "..", validated by the caller). */
export async function serveWorkspaceFile(relativePath: string, filename: string) {
  const ext = relativePath.split(".").pop() ?? "";

  const res = await fetch(
    `${opencodeBaseUrl()}/file/content?path=${encodeURIComponent(`/workspace/${relativePath}`)}`,
  );
  if (!res.ok) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  const data = (await res.json()) as {
    content: string;
    encoding?: "base64";
    mimeType?: string;
  };

  const buffer =
    data.encoding === "base64" ? Buffer.from(data.content, "base64") : Buffer.from(data.content);

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": data.mimeType ?? MIME_TYPES[ext] ?? "application/octet-stream",
      "Content-Disposition": `inline; filename="${filename}"`,
    },
  });
}
