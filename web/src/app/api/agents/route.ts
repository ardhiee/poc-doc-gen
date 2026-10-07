import { NextResponse } from "next/server";
import { listAgents } from "@/lib/opencode";

export const dynamic = "force-dynamic";

export async function GET() {
  const agents = await listAgents();

  const items = agents
    .filter((a) => a.mode === "subagent")
    .map((a) => ({
      id: a.name,
      label: a.name,
      description: a.description,
      promptText: `@${a.name} `,
    }));

  return NextResponse.json({ items });
}
