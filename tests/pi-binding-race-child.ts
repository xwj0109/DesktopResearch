// Disposable cross-process ownership fixture. No Pi SDK, tools, or models are loaded.
import fs from "node:fs";
import path from "node:path";
import { PiBindings } from "../server/pi-bindings.ts";
const [root, mode] = process.argv.slice(2);
const bindings = new PiBindings(path.join(root, "bindings"));
let lease: ReturnType<PiBindings["acquire"]>["lease"] | undefined;
process.on("message", (message: any) => {
  if (message.type === "release" && lease) { bindings.release("workspace", "Ideas", lease); process.exit(0); }
  if (message.type !== "go") return;
  try {
    if (mode === "crash-coordination") {
      bindings.coordinator("workspace", "Ideas").run(() => { process.kill(process.pid, "SIGKILL"); });
    } else if (mode === "recover-crash-done") {
      const link = fs.linkSync;
      fs.linkSync = (from, to) => { if (String(to).endsWith(".done.json")) process.kill(process.pid, "SIGKILL"); link(from, to); };
      bindings.reconcile("workspace", "Ideas", "logical", path.join(root, "sessions"), message.request);
    } else {
      const acquired = bindings.acquire("workspace", "Ideas", "logical"); lease = acquired.lease;
      fs.mkdirSync(path.join(root, "sessions"), { recursive: true });
      const canonical = { id: "canonical", path: path.join(root, "sessions/canonical.jsonl") };
      if (!fs.existsSync(canonical.path)) fs.writeFileSync(canonical.path, JSON.stringify({ type: "session", id: canonical.id, cwd: root }) + "\n");
      bindings.bind("workspace", "Ideas", lease, canonical, path.join(root, "sessions"));
      process.send?.({ ok: true, lease, binding: bindings.get("workspace", "Ideas") });
    }
  } catch (error) { process.send?.({ ok: false, error: String(error) }, undefined, undefined, () => process.exit(0)); }
});
process.send?.({ ready: true });
