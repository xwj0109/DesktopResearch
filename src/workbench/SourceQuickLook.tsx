import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { Artifact } from "../shared";
import { useResearch } from "./research";
import { PdfViewer } from "./PdfViewer";

/** Finder-style Quick Look for a library source: Space opens and closes it,
 * ↑/↓ switch to the neighbouring source, Enter opens it for work, Esc closes.
 * Read-only: no notes are created from a preview. */
export function SourceQuickLook({
  artifact,
  position,
  total,
  onClose,
  onOpen,
  onStep,
}: {
  artifact: Artifact;
  position: number;
  total: number;
  onClose: () => void;
  onOpen: () => void;
  onStep: (delta: number) => void;
}) {
  const { client } = useResearch();
  const [body, setBody] = useState<{ id: string; bytes: Uint8Array } | null>(null);
  const [error, setError] = useState("");
  const card = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let alive = true;
    setError("");
    void client.bytes("/artifacts/" + artifact.id).then(
      (r: { body: Uint8Array }) => alive && setBody({ id: artifact.id, bytes: r.body }),
      (e: unknown) => alive && setError(String(e instanceof Error ? e.message : e)),
    );
    return () => {
      alive = false;
    };
  }, [artifact.id, client]);
  const [imageUrl, setImageUrl] = useState("");
  useEffect(() => {
    if (!body || body.id !== artifact.id || artifact.kind !== "image") return setImageUrl("");
    const url = URL.createObjectURL(new Blob([body.bytes as BlobPart], { type: artifact.mime }));
    setImageUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [body, artifact.id, artifact.kind, artifact.mime]);

  /** Keys work whether focus is on the library list or inside the preview. */
  const onKeyDown = (e: KeyboardEvent) => {
    const typing = (e.target as HTMLElement).closest?.("input, textarea");
    if (typing) return;
    if (e.key === " " || e.key === "Escape") onClose();
    else if (e.key === "Enter") onOpen();
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") onStep(e.key === "ArrowDown" ? 1 : -1);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  const ready = body?.id === artifact.id ? body : null;
  return (
    <div className="palette-scrim quicklook-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={card} className="quicklook" role="dialog" aria-label={`Preview of ${artifact.name}`} tabIndex={-1} onKeyDown={onKeyDown}>
        <header>
          <span className="count">
            {position} / {total}
          </span>
          <span className="name" title={artifact.name}>
            {artifact.name}
          </span>
          <span className="keys">↑↓ next · space close · ⏎ open</span>
          <button className="btn small primary" onClick={onOpen}>
            Open ⏎
          </button>
          <button className="icon-btn" aria-label="Close preview" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="quicklook-body">
          {error && <p className="notice error">{error}</p>}
          {!ready && !error && <p className="note">Loading preview…</p>}
          {ready && artifact.kind === "pdf" && (
            <PdfViewer key={artifact.id} bytes={ready.bytes} marks={[]} readOnly onAnnotate={async () => {}} />
          )}
          {ready && artifact.kind === "text" && (
            <pre className="quicklook-text">{new TextDecoder().decode(ready.bytes.slice(0, 200_000))}</pre>
          )}
          {ready && artifact.kind === "image" && imageUrl && <img className="quicklook-image" src={imageUrl} alt={artifact.name} />}
        </div>
      </div>
    </div>
  );
}
