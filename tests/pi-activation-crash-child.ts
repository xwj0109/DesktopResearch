// Deliberately crash a disposable owner between spawn and durable child-PID publication.
import fs from "node:fs";
import path from "node:path";
import { PiBindings } from "../server/pi-bindings.ts";
import { discoverPi, launchLinkedPi } from "../server/pi-runtime.ts";
import { handoff } from "../scripts/desktop-pi-handoff.ts";
const input = JSON.parse(process.argv[2]);
process.env.PI_CODING_AGENT_DIR = input.agentDir;
process.env.HERDR_FIXTURE_IMPORT_PROBE = input.importProbe;
PiBindings.prototype.setPid = function(_workspace, _tab, _lease, pid) {
  fs.writeFileSync(input.pidFile, String(pid));
  // Let the child fully boot while its parent is stalled BEFORE publishing PID.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
  process.kill(process.pid, "SIGKILL");
};
if (input.mode === "cli") await handoff(input.bindingFile, input.executable);
else {
  const bindings = new PiBindings(path.dirname(input.bindingFile)), saved = bindings.get(input.workspace, "Ideas")!;
  const { lease } = bindings.acquire(input.workspace, "Ideas", saved.logicalSessionId);
  const rpc = launchLinkedPi({ identity: discoverPi(input.executable), cwd: saved.canonical!.cwd!, sessionDir: path.dirname(saved.canonical!.path), session: saved.canonical!.path, generation: lease.generation });
  bindings.setPid(input.workspace, "Ideas", lease, rpc.child.pid!);
  await rpc.request("get_state");
}
