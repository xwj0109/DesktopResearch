import { useEffect, useRef, useState } from "react";
import type { Terminal } from "@xterm/xterm";
import type { PiEvent } from "../pi-protocol";

/** Extension-owned terminal surfaces retain ANSI state, cursor movement and
 * keyboard input. The surrounding conversation remains graphical. */
export function RuntimeTerminal({
  surfaceId,
  events,
  columns,
  rows,
  input,
  resize,
  disabled,
  onError,
}: {
  surfaceId: string;
  events: PiEvent[];
  columns: number;
  rows: number;
  input: (data: string) => void;
  resize: (columns: number, rows: number) => void;
  disabled?: boolean;
  onError: (message: string) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | undefined>(undefined);
  const through = useRef(0);
  const callbacks = useRef({ input, resize, disabled, onError });
  callbacks.current = { input, resize, disabled, onError };
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!container.current) return;
    let disposed = false,
      cleanup = () => {};
    void Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")])
      .then(([{ Terminal }, { FitAddon }]) => {
        if (disposed || !container.current) return;
        const term = new Terminal({
          cols: columns,
          rows,
          fontSize: 13,
          fontFamily: "monospace",
          scrollback: 2000,
          allowProposedApi: false,
          disableStdin: !!callbacks.current.disabled,
        });
        const fit = new FitAddon();
        term.loadAddon(fit);
        term.open(container.current);
        terminal.current = term;
        const data = term.onData((value) => {
          if (!callbacks.current.disabled) callbacks.current.input(value);
        });
        let timer: ReturnType<typeof setTimeout> | undefined;
        const observer = new ResizeObserver(() => {
          clearTimeout(timer);
          timer = setTimeout(() => {
            if (disposed || !container.current?.offsetWidth) return;
            const dimensions = fit.proposeDimensions();
            if (!dimensions) return;
            const cols = Math.max(20, Math.min(400, dimensions.cols)),
              count = Math.max(5, Math.min(200, dimensions.rows));
            if (cols !== term.cols || count !== term.rows) {
              term.resize(cols, count);
              if (!callbacks.current.disabled)
                callbacks.current.resize(cols, count);
            }
          }, 100);
        });
        observer.observe(container.current);
        cleanup = () => {
          clearTimeout(timer);
          observer.disconnect();
          data.dispose();
          term.dispose();
          terminal.current = undefined;
        };
        setReady(true);
        if (!callbacks.current.disabled)
          callbacks.current.resize(columns, rows);
      })
      .catch((error) => {
        if (!disposed)
          callbacks.current.onError(
            `Extension terminal could not load: ${String(error)}`,
          );
      });
    return () => {
      disposed = true;
      cleanup();
    };
  }, [surfaceId]);
  useEffect(() => {
    if (terminal.current) terminal.current.options.disableStdin = !!disabled;
  }, [disabled, ready]);
  useEffect(() => {
    if (!terminal.current) return;
    for (const event of events) {
      if (
        event.type !== "terminal_frame" ||
        event.surfaceId !== surfaceId ||
        event.seq <= through.current
      )
        continue;
      terminal.current.write(String(event.data));
      through.current = event.seq;
    }
  }, [ready, events, surfaceId]);
  return (
    <div
      ref={container}
      className="runtime-terminal"
      aria-label="Extension terminal"
      style={{
        height: `${Math.min(30, Math.max(5, rows)) * 17}px`,
        minWidth: 0,
      }}
    />
  );
}
