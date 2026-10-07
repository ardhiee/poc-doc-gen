import { createOpencodeClient } from "@opencode-ai/sdk";

const DEFAULT_MODEL = {
  providerID: "litellm",
  modelID: process.env.LITELLM_MODEL ?? "gemini-3.8-flash",
};

function sessionFolder(sessionId: string) {
  return `sessions/${sessionId}`;
}

/** The one rule every agent in this workspace must obey, regardless of its own
 *  prompt/persona — kept separate from systemPrompt() so a delegated named agent
 *  (see AGENT_MENTION_RE) can be scoped without having the generic doc-gen
 *  persona forced on top of its own instructions. */
function sandboxClause(sessionId: string) {
  const folder = sessionFolder(sessionId);
  return (
    `Your workspace is shared with other sessions — you must only read AND write files inside "${folder}/" ` +
    `(run: mkdir -p ${folder} first, without mentioning it). ` +
    `Every other folder under "sessions/" belongs to a DIFFERENT conversation — some may belong to a ` +
    "different requester entirely, so treat them as confidential and off-limits even if the name/ticket " +
    "looks related to your own task. Never read, list, write, or otherwise touch anything under " +
    `"sessions/" other than "${folder}/" itself — not even to reuse an earlier draft as a template. ` +
    "You may read genuine shared reference material that sits directly in the workspace root (not inside " +
    "any other session's folder) if relevant to the user's request, but never write or modify anything " +
    "outside your own folder."
  );
}

function systemPrompt(sessionId: string) {
  const folder = sessionFolder(sessionId);
  return (
    "You are a document generation assistant. " +
    "For a plain conversational message (a greeting, a question you can just answer, small talk) — " +
    "skip planning entirely and reply directly with no preamble, no bullet points, nothing before the answer. " +
    "Only when the request actually requires multiple steps (searching, reading files, generating or " +
    "converting a document) — write a brief plan FIRST, as the very first thing you output — 1-3 short " +
    "bullet points covering what you'll do, described in generic functional terms (e.g. \"search the " +
    "knowledge base\", \"convert to Word format\") — NEVER name the specific underlying tool, software, " +
    "or brand you use for it (never say Cognee, LibreOffice, soffice, bash, or similar). Write this plan " +
    "ONCE, then execute it without any further step-by-step narration (no \"I will create...\", \"now " +
    "converting...\" commentary) — just do it silently and report only the final result. " +
    sandboxClause(sessionId) +
    " For a normal chat question, just answer in markdown text — no files, no conversion steps. " +
    "Only when the user explicitly asks for a document file: " +
    "write it as clean semantic HTML to a temp file, then convert with EXACTLY one of these two " +
    "commands (the filter name must be given exactly as shown — bare 'docx' has no export filter " +
    "and silently fails on this install; never try a different filter name, format, or troubleshooting command): " +
    `For Word: soffice --headless --convert-to 'docx:MS Word 2007 XML' --outdir ${folder} <temp>.html. ` +
    `For PDF: soffice --headless --convert-to pdf --outdir ${folder} <temp>.html. ` +
    "Produce ONLY the format(s) actually requested — if they ask for Word, run only the Word command; " +
    "if PDF, run only the PDF command; if they just say \"a document\" with no format named, default to " +
    "Word only. Never generate a format nobody asked for, and never produce or mention the " +
    "intermediate HTML file as a deliverable. " +
    "When finished, give one short sentence summarizing what was created, then list each generated " +
    `file's full path exactly as \`${folder}/<filename>\` wrapped in single backticks, on its own ` +
    "line — this exact format is required, it's how the app turns it into a clickable attachment. " +
    "List only the file(s) actually requested — nothing more (no step narration, no formats nobody asked for)."
  );
}

function getClient() {
  const baseUrl = process.env.OPENCODE_BASE_URL ?? "http://localhost:4096";
  return createOpencodeClient({ baseUrl });
}

export async function createDocSession(title: string) {
  const client = getClient();
  const { data, error } = await client.session.create({ body: { title } });
  if (error || !data) throw new Error("Failed to create opencode session");
  return data;
}

export async function promptSession(sessionId: string, text: string) {
  const client = getClient();
  const { data, error } = await client.session.prompt({
    path: { id: sessionId },
    body: {
      model: DEFAULT_MODEL,
      system: systemPrompt(sessionId),
      parts: [{ type: "text", text }],
    },
  });
  if (error || !data) throw new Error("Failed to get a response from opencode");

  const textParts = data.parts.filter(
    (part): part is Extract<typeof part, { type: "text" }> => part.type === "text",
  );
  const text_ = textParts.map((part) => part.text).join("\n\n");

  return { messageId: data.info.id, text: text_ };
}

const AGENT_MENTION = /^@([a-zA-Z0-9_-]+)\s+([\s\S]+)$/;

export async function listAgents() {
  const client = getClient();
  const { data, error } = await client.app.agents();
  if (error || !data) throw new Error("Failed to list agents");
  return data;
}

export async function promptSessionAsync(sessionId: string, text: string, agentOverride?: string) {
  const client = getClient();

  // "@agent-name rest of the prompt" routes this turn to that named agent
  // (see .opencode/agent/*.md) instead of the default doc-gen persona —
  // its own prompt/model/tools from config apply; we only layer the
  // write-scope rule on top, never the generic doc-gen instructions.
  // The UI's @-trigger pill passes agentOverride directly (already validated
  // against /api/agents); the regex is just a fallback for plain typed text.
  let agent: string | undefined = agentOverride;
  let prompt = text;
  if (!agent) {
    const match = AGENT_MENTION.exec(text.trim());
    if (match) {
      const [, name, rest] = match;
      const agents = await listAgents();
      if (agents.some((a) => a.name === name)) {
        agent = name;
        prompt = rest;
      }
    }
  }

  const { error } = await client.session.promptAsync({
    path: { id: sessionId },
    body: {
      model: DEFAULT_MODEL,
      ...(agent ? { agent, system: sandboxClause(sessionId) } : { system: systemPrompt(sessionId) }),
      parts: [{ type: "text", text: prompt }],
    },
  });
  if (error) throw new Error("Failed to start generation");
}

export function opencodeBaseUrl() {
  return process.env.OPENCODE_BASE_URL ?? "http://localhost:4096";
}

export async function listSessionMessages(sessionId: string) {
  const client = getClient();
  const { data, error } = await client.session.messages({ path: { id: sessionId } });
  if (error || !data) throw new Error("Failed to load session messages");

  return data
    .filter((m) => m.info.role === "user" || m.info.role === "assistant")
    .map((m) => ({
      role: m.info.role as "user" | "assistant",
      text: m.parts
        .filter((p): p is Extract<typeof p, { type: "text" }> => p.type === "text")
        .map((p) => p.text)
        .join("\n\n"),
    }))
    .filter((m) => m.text);
}

export async function readSessionFile(sessionId: string, filename: string) {
  // only ever allow reading a plain filename back out of this session's own folder
  if (filename.includes("/") || filename.includes("..")) {
    throw new Error("Invalid filename");
  }

  const path = `/workspace/${sessionFolder(sessionId)}/${filename}`;
  const res = await fetch(
    `${opencodeBaseUrl()}/file/content?path=${encodeURIComponent(path)}`,
  );
  if (!res.ok) throw new Error("Failed to read generated file");

  const data = (await res.json()) as {
    type: "text" | "binary";
    content: string;
    encoding?: "base64";
    mimeType?: string;
  };

  const buffer =
    data.encoding === "base64" ? Buffer.from(data.content, "base64") : Buffer.from(data.content);

  return { buffer, mimeType: data.mimeType ?? "application/octet-stream" };
}

export async function deleteSession(sessionId: string) {
  const client = getClient();
  await client.session.delete({ path: { id: sessionId } });
}

/**
 * Reject a pending permission prompt (e.g. "read outside the sandbox") so the
 * turn fails fast with a visible error instead of hanging forever — there is
 * no human operator to answer these in our headless API flow, and opencode
 * otherwise just waits indefinitely for a reply that will never come.
 */
/** Genuinely stops the agent's work server-side (not just the client
 *  disconnecting) — used by the composer's Stop button. Without this, "Stop"
 *  would only hide the stream in the browser while the agent kept running,
 *  writing files, and burning tokens invisibly in the background. */
export async function abortOpencodeSession(sessionId: string) {
  await fetch(`${opencodeBaseUrl()}/session/${sessionId}/abort`, { method: "POST" });
}

export async function rejectPermission(sessionId: string, permissionId: string) {
  await fetch(`${opencodeBaseUrl()}/session/${sessionId}/permissions/${permissionId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ response: "reject" }),
  });
}
