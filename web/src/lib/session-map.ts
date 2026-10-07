import fs from "fs";
import path from "path";
import { createDocSession, deleteSession } from "@/lib/opencode";
import { workspaceRoot } from "@/lib/workspace";

// local dev process only — maps the kitn.ai block's own conversation id to an
// opencode session id; restarting the server just means a new session gets created
const conversationToSession = new Map<string, string>();

/** Read-only lookup — used to resolve a file link back to the real opencode
 *  session id, for any agent's output regardless of which one wrote it. */
export function getSessionIdForConversation(conversationId: string) {
  return conversationToSession.get(conversationId);
}

export async function getOrCreateSession(conversationId: string, title: string) {
  const existing = conversationToSession.get(conversationId);
  if (existing) return existing;

  const session = await createDocSession(title);
  conversationToSession.set(conversationId, session.id);
  return session.id;
}

/** Deletes the opencode session AND its session folder on disk (generated
 *  files, fsd-data.json, artifacts — everything), not just the mapping
 *  entry. Silently no-ops if this conversation never minted a session. */
export async function deleteConversationSession(conversationId: string) {
  const sessionId = conversationToSession.get(conversationId);
  if (!sessionId) return;

  conversationToSession.delete(conversationId);
  await deleteSession(sessionId).catch(() => {});

  const sessionDir = path.join(workspaceRoot(), "sessions", sessionId);
  fs.rmSync(sessionDir, { recursive: true, force: true });
}
