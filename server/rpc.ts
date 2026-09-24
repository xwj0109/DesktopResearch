import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { limits } from "../src/shared.ts";
export class RpcRejected extends Error {}
interface Pending {
  command: string;
  resolve: (x: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}
export class Rpc extends EventEmitter {
  private decoder = new StringDecoder("utf8");
  private buffer = "";
  private pending = new Map<string, Pending>();
  private closed = false;
  private killTimer?: NodeJS.Timeout;
  private resolveExit!: () => void;
  public readonly exited: Promise<void>;
  public didExit = false;
  constructor(
    public child: ChildProcessWithoutNullStreams,
    private timeout = 15000,
    private killGrace = 2000,
  ) {
    super();
    this.exited = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
    // Writable errors are emitted independently of write callbacks (notably EPIPE).
    for (const stream of [child.stdin, child.stdout, child.stderr])
      stream.on("error", (error) => this.fail(error));
    if (child.channel) {
      child.on("message", (value) =>
        this.consume(Buffer.from(JSON.stringify(value) + "\n")),
      );
      child.stdout.on("data", (bytes: Buffer) => {
        if (bytes.length)
          this.fail(
            new Error(
              "Unsupported direct terminal output bypassed the Pi host UI bridge",
            ),
          );
      });
    } else child.stdout.on("data", (b: Buffer) => this.consume(b));
    child.on("error", (e) => this.fail(e));
    child.on("exit", (code, signal) =>
      this.fail(new Error(`Pi exited (${code ?? signal})`)),
    );
    child.once("close", () => {
      this.didExit = true;
      if (this.killTimer) clearTimeout(this.killTimer);
      this.resolveExit();
      try {
        this.emit("exited");
      } catch {
        /* observers cannot prevent reaping */
      }
    });
    let stderrBytes = 0;
    child.stderr.on("data", (b: Buffer) => {
      stderrBytes += b.length;
      if (stderrBytes > limits.event)
        this.fail(new Error("Pi stderr exceeded 1 MiB limit"));
    });
  }
  get isClosed() {
    return this.closed;
  }
  static launch(
    executable: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    return new Rpc(
      spawn(executable, args, {
        cwd,
        stdio: "pipe",
        shell: false,
        env: { ...env },
      }),
    );
  }
  consume(bytes: Buffer) {
    if (this.closed) return;
    try {
      this.buffer += this.decoder.write(bytes);
      if (
        Buffer.byteLength(this.buffer) > limits.event &&
        !this.buffer.includes("\n")
      )
        throw new Error("Pi frame exceeds 1 MiB");
      let i: number;
      while ((i = this.buffer.indexOf("\n")) >= 0 && !this.closed) {
        const line = this.buffer.slice(0, i);
        this.buffer = this.buffer.slice(i + 1);
        if (Buffer.byteLength(line) > limits.event)
          throw new Error("Pi frame exceeds 1 MiB");
        if (!line.trim()) continue;
        let v: any;
        try {
          v = JSON.parse(line);
        } catch {
          throw new Error("Pi emitted invalid JSONL");
        }
        if (
          !v ||
          typeof v !== "object" ||
          Array.isArray(v) ||
          typeof v.type !== "string"
        )
          throw new Error("Pi emitted invalid RPC envelope");
        if (v.type === "response") {
          if (typeof v.id !== "string")
            throw new Error("Pi response lacks correlation ID");
          const p = this.pending.get(v.id);
          if (!p) continue; // late/duplicate ACK is harmless
          if (typeof v.success !== "boolean" || v.command !== p.command)
            throw new Error("Pi emitted invalid correlated response");
          clearTimeout(p.timer);
          this.pending.delete(v.id);
          v.success
            ? p.resolve(v.data)
            : p.reject(
                new RpcRejected(
                  String(v.error ?? "Pi rejected request").slice(0, 1000),
                ),
              );
        } else this.emit("event", v);
      }
      if (Buffer.byteLength(this.buffer) > limits.event)
        throw new Error("Pi frame exceeds 1 MiB");
    } catch (error) {
      this.fail(
        error instanceof Error ? error : new Error("Pi event observer failed"),
      );
    }
  }
  request(
    type: string,
    fields: Record<string, unknown> = {},
    id: string = randomUUID(),
  ): Promise<any> {
    if (this.closed) return Promise.reject(new Error("Pi disconnected"));
    if (this.pending.size >= 16)
      return Promise.reject(new Error("RPC request limit"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC ${type} timeout; acceptance may be uncertain`));
      }, this.timeout);
      this.pending.set(id, { command: type, resolve, reject, timer });
      const envelope = {
        ...fields,
        ...(this.child.channel ? { version: 1 } : {}),
        type,
        id,
      };
      const written = (e?: Error | null) => {
        if (e) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(e);
        }
      };
      if (this.child.channel && this.child.connected)
        this.child.send(envelope, written);
      else this.child.stdin.write(JSON.stringify(envelope) + "\n", written);
    });
  }
  fail(e: Error) {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    this.pending.clear();
    try {
      this.emit("closed", e);
    } catch {
      /* observer failures must never bypass child termination */
    } finally {
      if (!this.didExit) {
        this.child.kill("SIGTERM");
        this.killTimer = setTimeout(() => {
          if (!this.didExit) this.child.kill("SIGKILL");
        }, this.killGrace);
        this.killTimer.unref();
      }
    }
  }
  close() {
    this.fail(new Error("Pi process stopped"));
    return this.exited;
  }
}
