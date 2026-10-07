import { NextResponse } from "next/server";
import { deleteConversationSession } from "@/lib/session-map";

export const dynamic = "force-dynamic";

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await deleteConversationSession(id);
  return NextResponse.json({ ok: true });
}
