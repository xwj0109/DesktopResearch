import type {
  DesktopBridge,
  DesktopContext,
  RequestRecord,
} from "../desktop/contracts.ts";
export class NativeClient {
  readonly base: string;
  private active = new Set<Promise<unknown>>();
  private barrierErrors = new Map<string, Error>();
  constructor(
    readonly bridge: DesktopBridge,
    readonly context: DesktopContext,
    private beforeWrite: () => Promise<void>,
  ) {
    this.base = `/api/${context.scope.kind === "strategy" ? "strategies" : "portfolios"}/${"id" in context.scope ? context.scope.id : ""}`;
  }
  async read<T = any>(tail: string): Promise<T> {
    return this.call(tail, "GET");
  }
  write<T = any>(
    tail: string,
    value: unknown,
    id = crypto.randomUUID(),
  ): Promise<T> {
    const task = (async () => {
      await this.beforeWrite();
      return this.call<T>(tail, "POST", value, id);
    })();
    this.active.add(task);
    void task.finally(() => this.active.delete(task)).catch(() => {});
    return task;
  }
  track<T>(task: Promise<T>, barrierKey?: string) {
    this.active.add(task);
    void task
      .catch((error) => {
        if (barrierKey)
          this.barrierErrors.set(
            barrierKey,
            error instanceof Error ? error : new Error(String(error)),
          );
      })
      .finally(() => this.active.delete(task));
    return task;
  }
  acknowledgeBarrier(key: string) {
    this.barrierErrors.delete(key);
  }
  async drain() {
    while (this.active.size) await Promise.allSettled([...this.active]);
    if (this.barrierErrors.size)
      throw new Error(
        "Unacknowledged terminal input remains; cancel close and inspect the editor before continuing",
      );
  }
  records(): Promise<RequestRecord[]> {
    return this.bridge.readRequests?.() ?? Promise.resolve([]);
  }
  upload(file: File, revision: number) {
    const task = this.performUpload(file, revision);
    this.active.add(task);
    void task.finally(() => this.active.delete(task)).catch(() => {});
    return task;
  }
  private async performUpload(file: File, revision: number) {
    await this.beforeWrite();
    const response = await this.bridge.lab({
      path: this.base + "/artifacts",
      method: "POST",
      requestId: crypto.randomUUID(),
      headers: {
        "content-type": "application/octet-stream",
        "x-filename": encodeURIComponent(file.name),
        "x-revision": String(revision),
      },
      body: new Uint8Array(await file.arrayBuffer()),
    });
    return this.decode(response);
  }
  async bytes(tail: string) {
    const res = await this.bridge.lab({
      path: this.base + tail,
      method: "GET",
      headers: {},
    });
    if (res.status >= 400) throw new Error("Document could not be opened");
    return res;
  }
  private async call<T>(
    tail: string,
    method: "GET" | "POST",
    value?: unknown,
    requestId?: string,
  ): Promise<T> {
    const response = await this.bridge.lab({
      path: this.base + tail,
      method,
      headers: method === "GET" ? {} : { "content-type": "application/json" },
      ...(method === "GET"
        ? {}
        : { requestId, body: new TextEncoder().encode(JSON.stringify(value)) }),
    });
    return this.decode(response);
  }
  private decode(response: { status: number; body: Uint8Array }) {
    const body = JSON.parse(new TextDecoder().decode(response.body));
    if (response.status >= 400)
      throw Object.assign(new Error(body.error ?? "Request failed"), {
        status: response.status,
        ...(body.refusal ? { refusal: body.refusal } : {}),
      });
    return body;
  }
}
export function messageText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value))
    return value.map(messageText).filter(Boolean).join("\n");
  if (!value || typeof value !== "object") return "";
  const v = value as any;
  if (v.type === "image") return "[Image in canonical session]";
  if (v.type === "toolCall")
    return `${v.name}\n${JSON.stringify(v.arguments ?? {}, null, 2)}`;
  if (typeof v.text === "string") return v.text;
  if (typeof v.thinking === "string") return v.thinking;
  if (v.content) return messageText(v.content);
  return "";
}
