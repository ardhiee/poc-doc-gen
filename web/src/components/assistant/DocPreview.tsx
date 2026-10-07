"use client";

import { Markdown } from "@kitn.ai/ui/react";
import { Download, FileText, Minus, Plus, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

export interface DocPreviewProps {
  url: string;
  filename: string;
  onClose: () => void;
}

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 3;
const ZOOM_STEP = 0.1;
const DEFAULT_ZOOM = 0.7;

type Kind = "docx" | "markdown" | "html";

function kindOf(filename: string): Kind {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".md")) return "markdown";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "html";
  return "docx";
}

/** Renders a generated file inline instead of letting the browser's default
 *  link navigation just force a raw download — covers whatever any agent
 *  produces, not a fixed list. `.docx` goes through docx-preview (client-side
 *  only, real Word rendering); `.md` artifacts render as plain markdown text
 *  via the same Markdown component the chat thread itself uses; `.html`
 *  (e.g. frontend-designer's self-contained prototypes) renders in a
 *  sandboxed iframe. */
export function DocPreview({ url, filename, onClose }: DocPreviewProps) {
  const kind = kindOf(filename);
  const isMarkdown = kind === "markdown";
  const isHtml = kind === "html";

  const bodyRef = useRef<HTMLDivElement>(null);
  const styleRef = useRef<HTMLDivElement>(null);
  const scaleRef = useRef<HTMLDivElement>(null);
  const pageWidthRef = useRef<number | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [textContent, setTextContent] = useState("");
  const [zoom, setZoom] = useState(1);

  // Fit the rendered page (a fixed-pixel-width Word page, e.g. 816px for
  // Letter) to the panel's actual width — `zoom` (not transform:scale) so the
  // layout box shrinks with it instead of leaving dead space around it.
  const fitToWidth = useCallback(() => {
    const natural = pageWidthRef.current;
    if (!natural || !scaleRef.current) return;
    const available = scaleRef.current.clientWidth - 32; // breathing room either side
    setZoom(Math.min(1, available / natural));
  }, []);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;

    setStatus("loading");

    (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error("Failed to load the file");

        if (isMarkdown || isHtml) {
          const text = await res.text();
          if (cancelled) return;
          setTextContent(text);
          setStatus("ready");
          return;
        }

        const blob = await res.blob();
        if (cancelled) return;

        objectUrl = URL.createObjectURL(blob);
        setBlobUrl(objectUrl);

        const { renderAsync } = await import("docx-preview");
        if (!bodyRef.current || !styleRef.current) return;
        await renderAsync(blob, bodyRef.current, styleRef.current, { inWrapper: true });
        if (cancelled) return;

        const page = bodyRef.current.querySelector<HTMLElement>(".docx-wrapper > section");
        pageWidthRef.current = page?.getBoundingClientRect().width ?? null;
        setZoom(DEFAULT_ZOOM);

        setStatus("ready");
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setStatus("error");
        }
      }
    })();

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url, isMarkdown, isHtml]);

  // Re-fit when the panel itself is resized (e.g. opening/closing the rail,
  // or the window shrinking) — not just once at load. ResizeObserver fires
  // once immediately on observe() with the current size; skip that first
  // call or it'd stomp the DEFAULT_ZOOM the moment this effect mounts.
  // Only docx uses the zoom canvas at all — markdown/html just flow naturally.
  useEffect(() => {
    if (kind !== "docx" || !scaleRef.current) return;
    let first = true;
    const observer = new ResizeObserver(() => {
      if (first) {
        first = false;
        return;
      }
      fitToWidth();
    });
    observer.observe(scaleRef.current);
    return () => observer.disconnect();
  }, [fitToWidth, kind]);

  useEffect(() => {
    if (kind === "docx" && scaleRef.current) scaleRef.current.style.zoom = String(zoom);
  }, [zoom, kind]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const zoomIn = () => setZoom((z) => Math.min(ZOOM_MAX, Number((z + ZOOM_STEP).toFixed(2))));
  const zoomOut = () => setZoom((z) => Math.max(ZOOM_MIN, Number((z - ZOOM_STEP).toFixed(2))));

  return (
    <div className="doc-preview-overlay">
      <div className="doc-preview-panel">
        <div className="doc-preview-header">
          <div className="doc-preview-title">
            <FileText size={16} className="doc-preview-file-icon" />
            <span className="doc-preview-filename">{filename}</span>
          </div>
          <div className="doc-preview-actions">
            <a
              href={blobUrl ?? url}
              download={filename}
              className={blobUrl || kind !== "docx" ? "doc-preview-download" : "doc-preview-download is-disabled"}
              aria-disabled={!blobUrl && kind === "docx"}
            >
              <Download size={14} />
              Download
            </a>
            <button onClick={onClose} aria-label="Close preview" className="doc-preview-close">
              <X size={16} />
            </button>
          </div>
        </div>
        <div className="doc-preview-body">
          {status === "loading" ? (
            <div className="doc-preview-status">
              <div className="doc-preview-spinner" />
              <span>Rendering preview…</span>
            </div>
          ) : null}
          {status === "error" ? (
            <div className="doc-preview-status doc-preview-error">
              Couldn&apos;t render a preview — {error}. You can still download the file above.
            </div>
          ) : null}

          {isMarkdown && status === "ready" ? (
            <div className="doc-preview-markdown">
              <Markdown content={textContent} proseSize="sm" />
            </div>
          ) : null}

          {isHtml && status === "ready" ? (
            <iframe
              className="doc-preview-iframe"
              srcDoc={textContent}
              sandbox="allow-scripts allow-forms allow-popups"
              title={filename}
            />
          ) : null}

          {kind === "docx" ? (
            <>
              <div className="doc-preview-scale" ref={scaleRef} hidden={status !== "ready"}>
                <div ref={styleRef} />
                <div ref={bodyRef} />
              </div>
              {status === "ready" ? (
                <div className="doc-preview-zoom">
                  <button onClick={zoomOut} aria-label="Zoom out" disabled={zoom <= ZOOM_MIN}>
                    <Minus size={14} />
                  </button>
                  <button onClick={fitToWidth} className="doc-preview-zoom-pct" aria-label="Reset zoom to fit">
                    {Math.round(zoom * 100)}%
                  </button>
                  <button onClick={zoomIn} aria-label="Zoom in" disabled={zoom >= ZOOM_MAX}>
                    <Plus size={14} />
                  </button>
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
