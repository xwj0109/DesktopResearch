import { useEffect, useRef, useState } from "react";

export interface Command {
  id: string;
  label: string;
  detail: string;
  /** Leading glyph (single character). */
  glyph?: string;
  group?: string;
  /** Keyboard hint shown on the right, e.g. "⌘1". */
  hint?: string;
  run: () => void;
}

/** Walker-style launcher: scrim, bordered card, prompt input, grouped rows. */
export function CommandPalette({
  commands,
  onClose,
  initialQuery = "",
}: {
  commands: Command[];
  onClose: () => void;
  initialQuery?: string;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const needle = query.trim().toLowerCase();
  const filtered = commands.filter((command) =>
    `${command.label} ${command.detail}`.toLowerCase().includes(needle),
  );
  useEffect(() => {
    const previous = (globalThis.document?.activeElement ??
      null) as HTMLElement | null;
    input.current?.focus();
    return () => previous?.focus?.();
  }, []);
  useEffect(() => {
    globalThis.document
      ?.getElementById(`command-${filtered[active]?.id}`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [active, filtered]);
  const choose = (command: Command) => {
    onClose();
    command.run();
  };
  let lastGroup: string | undefined;
  return (
    <div
      className="palette-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialog}
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onKeyDown={(event) => {
          const move = (step: number) => {
            event.preventDefault();
            setActive((index) =>
              filtered.length
                ? (index + step + filtered.length) % filtered.length
                : 0,
            );
          };
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          } else if (event.key === "ArrowDown") move(1);
          else if (event.key === "ArrowUp") move(-1);
          else if (event.ctrlKey && (event.key === "n" || event.key === "j"))
            move(1);
          else if (event.ctrlKey && (event.key === "p" || event.key === "k"))
            move(-1);
          else if (event.key === "Enter" && filtered[active]) {
            event.preventDefault();
            choose(filtered[active]);
          } else if (event.key === "Tab") event.preventDefault();
        }}
      >
        <div className="palette-input">
          <input
            ref={input}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            placeholder="stages, materials, layout, themes…"
            aria-label="Search commands"
            role="combobox"
            aria-expanded="true"
            aria-controls="command-results"
            aria-autocomplete="list"
            aria-activedescendant={
              filtered[active] ? `command-${filtered[active].id}` : undefined
            }
            spellCheck={false}
          />
          <kbd>esc</kbd>
        </div>
        <div
          className="palette-list"
          id="command-results"
          role="listbox"
          aria-label="Commands"
        >
          {filtered.map((command, index) => {
            const heading =
              command.group && command.group !== lastGroup ? (
                <div className="palette-group" aria-hidden="true">
                  {command.group}
                </div>
              ) : null;
            lastGroup = command.group;
            return (
              <div key={command.id}>
                {heading}
                <div
                  id={`command-${command.id}`}
                  role="option"
                  aria-selected={active === index}
                  className="palette-item"
                  onMouseMove={() => setActive(index)}
                  onClick={() => choose(command)}
                >
                  <span className="g">{command.glyph ?? "›"}</span>
                  <span className="label">{command.label}</span>
                  <span className="detail">{command.hint ?? command.detail}</span>
                </div>
              </div>
            );
          })}
          {!filtered.length && (
            <p className="palette-empty">
              no match — try “literature”, “map” or “theme”
            </p>
          )}
        </div>
        <footer className="palette-foot">
          <span>↑↓ navigate</span>
          <span>↵ run</span>
          <span>esc close</span>
        </footer>
      </div>
    </div>
  );
}
