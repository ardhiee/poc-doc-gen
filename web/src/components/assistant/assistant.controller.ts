/**
 * assistant, the framework-neutral controller.
 *
 * The contract (spec 2026-09-02 section 3.2):
 *
 *   createController(deps) => { state(): State; actions: Actions; subscribe(fn): () => void }
 *
 * Everything the imperative `assistant.js` did to the DOM is now either a
 * field of `State` (bound onto an element with `.prop=` / `:attr=`) or an
 * `actions` entry (bound with `@kai-event=`). The ONLY DOM this file touches
 * is through `deps.refs()`, and only to call an element METHOD that has no
 * declarative equivalent: the composer's clear().
 *
 * WHAT THIS BLOCK ADDED TO THE CONTRACT'S EVIDENCE, over support-widget's
 * conversion:
 *
 * 1. The rail's search filter WAS a DOM query. `assistant.js` read
 *    `item.textContent` off every rendered row and set `item.hidden`, which
 *    the contract forbids for good reason: it reaches past the state the
 *    renderers agree about into whatever the browser happened to lay out. It
 *    is now `query` plus a `conversationRows` list that is already filtered,
 *    which is what "State is a view model" means in practice. The rows the
 *    filter drops are not rendered at all rather than rendered hidden, so the
 *    block's stylesheet no longer needs its `[hidden]` rule either.
 * 2. `.prop` on a LEAF element with no navigation. `models` and
 *    `currentModel` drive kai-model-switcher; there is no view stack on this
 *    page and no ref for one.
 */
import { createAssistantStream } from '@kitn.ai/ui/state';
import type { ChatMessage, AssistantStream } from '@kitn.ai/ui/state';
import { readOpenAIStream } from '@kitn.ai/ui/wire';
import {
  localStorageStore,
  createConversationController,
  isConversationUnread,
  type ConversationSummary,
} from '@kitn.ai/ui/stores';
import type { KaiPromptInputElement } from '@kitn.ai/ui/web-components';
import { SUGGESTIONS, MODELS, type ModelOption } from './mock';

// KNOWN RESIDUAL: the "2m ago" formatter is internal to the Solid layer and
// is not exported from @kitn.ai/ui/stores, so the block restates it. Delete
// this when the kit ships it beside byRecency.
/** "2.0k" past 1000, plain integer below — matches the Claude Code status
 *  line style this was asked to mirror. */
export function formatApproxTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function relativeTimeShort(iso: string | undefined, now = Date.now()): string {
  if (!iso) return '';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const secs = Math.max(0, Math.round((now - then) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

const ASSISTANT_ACTIONS = ['copy', 'like', 'dislike'] as const;
const USER_ACTIONS = ['edit'] as const;

/** Rewrites backtick-quoted `sessions/<id>/<filename>.<ext>` paths the backend's
 *  doc-gen reply mentions into real markdown links — `[filename](/api/files/path)` —
 *  so Streamdown renders just the filename, as a normal clickable link to the
 *  download route, instead of a plain-text path in a code chip. */
function linkifyGeneratedFiles(text: string, conversationKey: string): string {
  // Backticks optional and path depth unconstrained — fsd-writer wraps a flat
  // `sessions/<id>/<file>` in backticks, but third-party agents (e.g.
  // requirements-analyst) list deeper artifact paths as plain text, with no
  // backticks at all. Match both uniformly.
  let out = text.replace(
    /`?(sessions\/[\w.-]+(?:\/[\w.-]+)*\.(?:docx|pdf|md))`?/g,
    (_match, path: string) => `[${path.split('/').pop()}](/api/files/${path})`,
  );
  // artifacts/... and docs/... — the SDLC agents (solution-architect,
  // frontend-designer, etc.) report paths relative to their OWN session
  // folder (their bash calls run with that as `workdir`), so these never
  // carry the sessions/<id>/ prefix themselves. Resolve by conversation
  // instead, since the client doesn't know the opencode session id directly.
  out = out.replace(
    /`((?:artifacts|docs)\/[\w.-]+(?:\/[\w.-]+)*\.(?:docx|pdf|md|html|png))`/g,
    (_match, path: string) => `[${path.split('/').pop()}](/api/files/by-conversation/${conversationKey}/${path})`,
  );
  return out;
}

/** Reads the second tee'd branch of /api/chat's SSE body for the custom, non-standard
 *  `kai_tool` frames (see route.ts) and turns each into a step chip via upsertTool —
 *  the normal OpenAI-shaped frames on the OTHER branch are left for readOpenAIStream,
 *  which already ignores frames lacking a recognized "choices" shape. */
const TOOL_DONE_STATES = new Set(['output-available', 'output-error']);
const TOOL_HIDE_DELAY_MS = 900;

/** Friendly label per opencode tool id for the turn-completion caption, e.g.
 *  "Read 2 files · Ran 1 command". Unlisted tool ids fall back to their raw
 *  name so a new/MCP tool still shows up as *something* rather than vanishing
 *  from the summary. */
const TOOL_LABELS: Record<string, (n: number) => string> = {
  read: (n) => `Read ${n} file${n === 1 ? '' : 's'}`,
  write: (n) => `Wrote ${n} file${n === 1 ? '' : 's'}`,
  edit: (n) => `Edited ${n} file${n === 1 ? '' : 's'}`,
  bash: (n) => `Ran ${n} command${n === 1 ? '' : 's'}`,
  glob: (n) => `Searched ${n} time${n === 1 ? '' : 's'}`,
  grep: (n) => `Searched ${n} time${n === 1 ? '' : 's'}`,
  task: (n) => `Ran ${n} subtask${n === 1 ? '' : 's'}`,
  webfetch: (n) => `Fetched ${n} page${n === 1 ? '' : 's'}`,
};

export function summarizeToolUsage(counts: Map<string, number>): string {
  return [...counts.entries()]
    .map(([type, n]) => (TOOL_LABELS[type] ?? ((m: number) => `Used ${type} ${m}x`))(n))
    .join(' · ');
}

/** Reads the second tee'd branch of /api/chat's SSE body for the custom, non-standard
 *  `kai_tool` frames (see route.ts) and turns each into a step chip via upsertTool —
 *  the normal OpenAI-shaped frames on the OTHER branch are left for readOpenAIStream,
 *  which already ignores frames lacking a recognized "choices" shape. Resolves with a
 *  tally of how many times each tool type completed, for the turn's summary caption. */
async function watchToolFrames(
  body: ReadableStream<Uint8Array>,
  stream: AssistantStream,
  getMessages: () => ChatMessage[],
  setMessages: (messages: ChatMessage[]) => void,
): Promise<Map<string, number>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const usageCounts = new Map<string, number>();

  const hideTool = (toolCallId: string) => {
    setMessages(
      getMessages().map((m) => {
        if (m.id !== stream.id) return m;
        return { ...m, parts: m.parts.filter((p) => !(p.type === 'tool' && p.tool.toolCallId === toolCallId)) };
      }),
    );
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let frameEnd = buffer.indexOf('\n\n');
    while (frameEnd !== -1) {
      const frame = buffer.slice(0, frameEnd);
      buffer = buffer.slice(frameEnd + 2);
      frameEnd = buffer.indexOf('\n\n');

      const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
      if (!dataLine) continue;
      const raw = dataLine.slice(5).trim();
      if (raw === '[DONE]') continue;

      try {
        const evt = JSON.parse(raw) as {
          kai_tool?: {
            toolCallId: string;
            state?: 'input-streaming' | 'input-available' | 'output-available' | 'output-error';
            [key: string]: unknown;
          };
        };
        if (evt.kai_tool) {
          const { toolCallId, ...patch } = evt.kai_tool;
          stream.upsertTool(toolCallId, patch);

          // Show the completed state briefly (so it's actually readable —
          // instant removal just looked like flicker) before it disappears,
          // rather than leaving a permanent "Completed" badge in the thread.
          if (patch.state && TOOL_DONE_STATES.has(patch.state)) {
            if (typeof patch.type === 'string') {
              usageCounts.set(patch.type, (usageCounts.get(patch.type) ?? 0) + 1);
            }
            setTimeout(() => hideTool(toolCallId), TOOL_HIDE_DELAY_MS);
          }
        }
      } catch {
        // not a kai_tool frame — ignore
      }
    }
  }
  return usageCounts;
}

/** One rendered row of the rail. Every field is already a string or a
 *  boolean, because `*for` bodies get bindings, not expressions. */
export interface ConversationRow {
  id: string;
  title: string;
  preview: string;
  previewHidden: boolean;
  time: string;
  unread: boolean;
}

/** Matches kai-prompt-input's `triggers` prop shape exactly (see TriggerDef in
 *  @kitn.ai/ui/react) — restated here only because the kit doesn't export the
 *  type standalone. */
export interface PromptTrigger {
  char: string;
  kind: string;
  items?: {
    id: string;
    label: string;
    icon?: string;
    description?: string;
    group?: string;
    kind?: string;
    promptText?: string;
    data?: Record<string, unknown>;
  }[];
}

export interface AssistantState {
  // thread
  messages: ChatMessage[];
  suggestions: string[] | undefined;
  loading: boolean;
  /** Live "Ns · ~tokens" readout while a turn is in flight — derived from the
   *  streaming message itself on a timer, not a separate counter wired into
   *  the stream parsing. Null whenever not loading. */
  loadingStats: { elapsedSeconds: number; approxTokens: number } | null;
  // the model switcher recipe
  models: ModelOption[];
  currentModel: string;
  // "@agent-name" autocomplete in the composer, sourced from /api/agents
  promptTriggers: PromptTrigger[];
  // the rail
  activeId: string | undefined;
  /** The rail's search box, lowercased and trimmed. A FIELD rather than a
   *  read of the input, because the controller owns no DOM: the rows below
   *  are already filtered by it. */
  query: string;
  /** The rows the rail renders: the summaries, projected and then FILTERED
   *  by `query`. The old script rendered them all and hid the misses. */
  conversationRows: ConversationRow[];
  /** The generated-file preview overlay (DocPreview), or null when closed. */
  previewFile: { url: string; filename: string } | null;
}

/** The element handles the controller calls methods on. Nullable because no
 *  framework has them at construction: React's ref is null through the first
 *  render, Vue's until mount. */
export interface AssistantRefs {
  prompt: KaiPromptInputElement | null;
}

export interface AssistantDeps {
  refs: () => AssistantRefs;
  /** Storage key; the block's default is its own id. */
  storageKey?: string;
}

export interface AssistantActions {
  /** `@kai-model-change` on the switcher. */
  modelChange(event: CustomEvent<{ modelId: string }>): void;
  /** `@kai-conversation-select` on the rail. */
  openConversation(event: CustomEvent<{ id: string }>): Promise<void>;
  /** `@kai-new-chat` on the rail. */
  newChat(): void;
  /** The row's own delete ("x") control — removes the conversation from the
   *  rail/local store AND deletes its opencode session + session folder on
   *  disk server-side. */
  deleteConversation(id: string): Promise<void>;
  /** `@kai-search` on the rail's built-in search box. */
  search(event: CustomEvent<{ query: string }>): void;
  /** `@kai-submit` on the prompt input. */
  submit(
    event: CustomEvent<{
      value: string;
      attachments?: unknown[];
      entities?: { kind: string; id: string }[];
    }>,
  ): Promise<void>;
  /** Mount hook: hydrate from storage. Not a binding - the host calls it. */
  boot(): Promise<void>;
  /** `@kai-stop` on the prompt input (the Stop button shown in place of Send
   *  while `loading`, via `stoppable`) — aborts the in-flight turn. */
  stop(): void;
  /** Open the inline preview for a generated-file link instead of letting the
   *  browser navigate/download it directly. */
  openFilePreview(url: string, filename: string): void;
  closeFilePreview(): void;
}

export interface AssistantController {
  state(): AssistantState;
  actions: AssistantActions;
  subscribe(listener: () => void): () => void;
}

export function createController(deps: AssistantDeps): AssistantController {
  const listeners = new Set<() => void>();

  let state: AssistantState = {
    messages: [],
    suggestions: SUGGESTIONS,
    loading: false,
    loadingStats: null,
    models: MODELS,
    currentModel: MODELS[0].id,
    promptTriggers: [],
    activeId: undefined,
    query: '',
    conversationRows: [],
    previewFile: null,
  };

  // A NEW state object every patch: the snapshot getter is compared by
  // identity by useSyncExternalStore, and the kai- reactivity contract wants a
  // new array reference for `messages` anyway.
  const patch = (next: Partial<AssistantState>): void => {
    state = { ...state, ...next };
    for (const l of listeners) l();
  };

  const setMessages = (messages: ChatMessage[]): void =>
    patch({ messages, suggestions: messages.length === 0 ? SUGGESTIONS : undefined });

  // The UNFILTERED projection, kept beside State rather than in it: nothing
  // binds it, and a field nothing binds is not part of the view model.
  let allRows: ConversationRow[] = [];

  /** The old script matched the row's whole `textContent`: the title, the
   *  preview line and the relative time, concatenated with NO separator. Same
   *  three fields here, read off the row model instead of off the DOM, and
   *  joined with spaces -- so a query is no longer able to match across a
   *  boundary the reader never sees ("just now" against a title ending in
   *  "ju"). That is a deliberate difference and the better behaviour. */
  const filterRows = (rows: ConversationRow[], query: string): ConversationRow[] =>
    query === ''
      ? rows
      : rows.filter((row) => `${row.title} ${row.preview} ${row.time}`.toLowerCase().includes(query));

  // Our own stable conversation key for the opencode session map — independent of
  // the store's id (which stays undefined until saveTurn mints one on the first turn).
  let conversationKey = crypto.randomUUID();

  const storageName = deps.storageKey ?? 'assistant';
  const store = localStorageStore(storageName);

  // localStorageStore (see @kitn.ai/ui/stores) has no delete op — this is its
  // exact key scheme (kai:<name>:threads index + kai:<name>:thread:<id> per
  // thread), restated here only because the kit doesn't expose one to call.
  function removeFromLocalStore(id: string) {
    try {
      const indexKey = `kai:${storageName}:threads`;
      const raw = localStorage.getItem(indexKey);
      if (raw) {
        const index = JSON.parse(raw) as { id: string }[];
        localStorage.setItem(indexKey, JSON.stringify(index.filter((c) => c.id !== id)));
      }
      localStorage.removeItem(`kai:${storageName}:thread:${id}`);
    } catch {
      // best-effort — a failed localStorage write here just leaves a stale row
      // until the next refresh re-derives the list from whatever did save
    }
  }

  const controller = createConversationController(store, {
    onMessagesLoad: (msgs) => setMessages(msgs),
    onSummariesChange: (summaries) => patch(projectSummaries(summaries)),
  });

  function projectSummaries(summaries: ConversationSummary[]): Partial<AssistantState> {
    allRows = summaries.map((s) => {
      // Display dedupe: the store titles a conversation from message text, so
      // the title and the trailing preview can be the same string.
      const preview = s.trailing && s.trailing !== s.title ? s.trailing : '';
      return {
        id: s.id,
        title: s.title,
        preview,
        previewHidden: preview === '',
        time: relativeTimeShort(s.updatedAt ?? s.lastMessageAt),
        unread: isConversationUnread(s),
      };
    });
    return { conversationRows: filterRows(allRows, state.query), activeId: controller.activeId() };
  }

  // Lives at this scope (not inside submit()) so the stop() action — fired
  // from a separate kai-stop event, not a return value submit() handed back —
  // can reach the controller for whichever turn is currently in flight.
  let activeAbort: AbortController | null = null;

  const respond = async (text: string, title?: string, agent?: string) => {
    activeAbort = new AbortController();
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, conversationId: conversationKey, title, agent }),
      signal: activeAbort.signal,
    });
    return res;
  };

  const actions: AssistantActions = {
    modelChange(event) {
      // The mock ignores the selection (it is a script); a real backend reads
      // state.currentModel inside submit and routes on it.
      patch({ currentModel: event.detail.modelId });
    },

    async openConversation(event) {
      conversationKey = event.detail.id;
      await controller.select(event.detail.id);
    },

    newChat() {
      conversationKey = crypto.randomUUID();
      controller.startNew();
    },

    async deleteConversation(id) {
      const wasActive = id === controller.activeId();
      removeFromLocalStore(id);
      await fetch(`/api/conversations/${id}`, { method: 'DELETE' }).catch(() => {});
      if (wasActive) {
        conversationKey = crypto.randomUUID();
        controller.startNew();
      }
      await controller.refresh();
    },

    stop() {
      activeAbort?.abort();
    },

    search(event) {
      const query = event.detail.query.trim().toLowerCase();
      patch({ query, conversationRows: filterRows(allRows, query) });
    },

    async submit(event) {
      const text = event.detail.value.trim();
      if (!text || state.loading) return;
      // The composer does not clear itself on submit - clearing is the host's
      // call, made through the element's public clear() method. That call is
      // the one DOM leak this controller has, and it is why it declares a ref.
      deps.refs().prompt?.clear();

      const userMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'user',
        actions: [...USER_ACTIONS],
        parts: [
          { type: 'text', text },
          ...((event.detail.attachments ?? []) as never[]).map((attachment) => ({
            type: 'file' as const,
            attachment,
          })),
        ],
      };
      setMessages([...state.messages, userMessage]);
      patch({ loading: true });

      const agent = event.detail.entities?.find((e) => e.kind === 'agent')?.id;
      const turnStart = performance.now();

      const stream = createAssistantStream((update) => setMessages(update(state.messages)));

      // Live "Ns · ~tokens" readout — derived from the streaming message's
      // own growing text each tick, not a separate counter wired into the
      // wire-format parsing.
      const statsTimer = setInterval(() => {
        const live = state.messages.find((m) => m.id === stream.id);
        const chars = live?.parts.reduce((n, p) => (p.type === 'text' ? n + p.text.length : n), 0) ?? 0;
        patch({
          loadingStats: {
            elapsedSeconds: Math.round((performance.now() - turnStart) / 1000),
            approxTokens: Math.round(chars / 4),
          },
        });
      }, 500);

      try {
        const response = await respond(text, text.slice(0, 60), agent);
        const [forWire, forTools] = response.body!.tee();
        const toolWatch = watchToolFrames(forTools, stream, () => state.messages, setMessages);
        await readOpenAIStream(
          new Response(forWire, { headers: response.headers }),
          stream,
        );
        const usageCounts = await toolWatch;
        stream.done();
        const elapsedSeconds = Math.round((performance.now() - turnStart) / 1000);
        const doneAt = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        const usageSummary = summarizeToolUsage(usageCounts);
        const caption = `*Generated for ${elapsedSeconds}s · done ${doneAt}${usageSummary ? ` · ${usageSummary}` : ''}*`;
        setMessages(
          state.messages.map((m) => {
            if (m.id !== stream.id) return m;
            return {
              ...m,
              actions: [...ASSISTANT_ACTIONS],
              // Tool steps are progress feedback for the live turn, not part of the
              // answer — once it settles, only the final text (and files) remain.
              parts: m.parts
                .filter((p) => p.type !== 'tool')
                .map((p) => (p.type === 'text' ? { ...p, text: `${linkifyGeneratedFiles(p.text, conversationKey)}\n\n${caption}` } : p)),
            };
          }),
        );
        // Mints the id on the first turn, saves, marks read while seen. We deliberately
        // keep using our own conversationKey afterwards (not the minted id) so this
        // chat keeps mapping to the same opencode session for the rest of the tab's life.
        await controller.saveTurn(state.messages);
      } catch (err) {
        const isUserStop = err instanceof DOMException && err.name === 'AbortError';
        stream.abort(isUserStop ? 'Stopped' : err instanceof Error ? err.message : String(err));
      } finally {
        activeAbort = null;
        clearInterval(statsTimer);
        patch({ loading: false, loadingStats: null });
      }
    },

    async boot() {
      setMessages([]);
      await controller.refresh();
      await controller.restore();
      conversationKey = controller.activeId() ?? conversationKey;

      try {
        const res = await fetch('/api/agents');
        const { items } = (await res.json()) as { items: PromptTrigger['items'] };
        patch({ promptTriggers: [{ char: '@', kind: 'agent', items }] });
      } catch {
        // autocomplete is a nicety — a failed fetch just leaves plain-text @mentions working
      }
    },

    openFilePreview(url, filename) {
      patch({ previewFile: { url, filename } });
    },

    closeFilePreview() {
      patch({ previewFile: null });
    },
  };

  return {
    state: () => state,
    actions,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
