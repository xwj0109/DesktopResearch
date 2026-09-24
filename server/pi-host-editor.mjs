import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
const require = createRequire(import.meta.url);
const loadPty = () =>
  fs.existsSync(new URL("./pty.cjs", import.meta.url))
    ? require("./pty.cjs")
    : require("node-pty");
/** A PTY only for the configured external editor. The conversation stays graphical. */
export class ExternalEditor {
  constructor(emit, cwd = process.cwd()) {
    this.emit = emit;
    this.cwd = cwd;
    this.active = null;
  }
  surfaces() {
    return this.active ? [this.active.descriptor] : [];
  }
  terminal(command) {
    const active = this.active;
    if (!active || command.surfaceId !== active.descriptor.surfaceId)
      return false;
    if (command.type === "terminal_input") active.child.write(command.data);
    if (command.type === "terminal_cancel") active.stop();
    if (command.type === "terminal_resize") {
      active.child.resize(command.columns, command.rows);
      active.descriptor.columns = command.columns;
      active.descriptor.rows = command.rows;
    }
    return true;
  }
  async run(command, content, signal) {
    if (this.active) throw new Error("An external editor is already open");
    if (signal?.aborted) throw new Error("External editor was cancelled");
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "pi-research-editor-"),
    );
    const file = path.join(directory, "prompt.md");
    const descriptor = {
      surfaceId: `external-editor:${randomUUID()}`,
      kind: "editor",
      columns: 80,
      rows: 24,
    };
    let subscription, stop;
    try {
      fs.writeFileSync(file, content, { mode: 0o600 });
      const [executable, ...args] = command.split(" ").filter(Boolean);
      if (!executable) throw new Error("No external editor configured");
      const child = loadPty().spawn(executable, [...args, file], {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd: this.cwd,
        env: process.env,
      });
      let killTimer;
      stop = () => {
        try {
          child.kill("SIGTERM");
        } catch {}
        killTimer ??= setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {}
        }, 2000);
      };
      const done = new Promise((resolve) =>
        child.onExit(({ exitCode, signal: exitSignal }) => {
          clearTimeout(killTimer);
          resolve({ exitCode, exitSignal });
        }),
      );
      this.active = { descriptor, child, stop, done };
      this.emit({ type: "terminal_open", ...descriptor });
      subscription = child.onData((data) => {
        for (let at = 0; at < data.length; at += 16000)
          this.emit({
            type: "terminal_frame",
            surfaceId: descriptor.surfaceId,
            data: data.slice(at, at + 16000),
          });
      });
      signal?.addEventListener("abort", stop, { once: true });
      const { exitCode, exitSignal } = await done;
      if (exitCode !== 0 || exitSignal || signal?.aborted)
        throw new Error(
          "External editor was cancelled or exited unsuccessfully; original draft retained",
        );
      if (fs.statSync(file).size > 100000)
        throw new Error("Edited draft exceeds the composer limit");
      return fs.readFileSync(file, "utf8").replace(/\n$/, "");
    } finally {
      if (stop) signal?.removeEventListener("abort", stop);
      subscription?.dispose();
      this.active = null;
      this.emit({ type: "terminal_closed", surfaceId: descriptor.surfaceId });
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
  async close() {
    const active = this.active;
    if (active) {
      active.stop();
      await active.done;
    }
  }
}
