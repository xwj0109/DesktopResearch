// Owned payload backend smoke only. Does NOT launch Electron, SDK, Pi, extensions or models.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { inventory } from "./desktop-inventory.mjs";
const source = path.resolve(process.argv[2] ?? "desktop-build");
inventory(source);
const temporary = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "pi-research-package-smoke-")),
);
const payload = path.join(temporary, "relocated-payload"),
  root = path.join(temporary, "disposable-data");
fs.cpSync(source, payload, { recursive: true });
fs.mkdirSync(root);
let owner;
async function launch() {
  const child = spawn(
    "/opt/homebrew/bin/node",
    [path.join(payload, "backend/desktop-entry.mjs")],
    {
      cwd: root,
      env: {
        PATH: "/opt/homebrew/bin:/usr/bin:/bin",
        LAB_PI_EXECUTABLE: "",
        LAB_PI_NODE: "/opt/homebrew/bin/node",
      },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      serialization: "json",
    },
  );
  owner = child;
  const exited = new Promise((resolve) =>
    child.once("close", (code, signal) => resolve({ code, signal })),
  );
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Backend readiness timeout")),
      10000,
    );
    child.once("error", reject);
    child.on("message", (message) => {
      if (message.type === "ready" && message.version === 1) {
        clearTimeout(timer);
        resolve(message);
      } else if (message.type === "fatal") {
        clearTimeout(timer);
        reject(new Error("Backend smoke fatal"));
      }
    });
    child.send({
      version: 1,
      type: "boot",
      root,
      assets: path.join(payload, "dist"),
      executable: "",
      handoffLauncher: path.join(payload, "scripts/desktop-pi-handoff.mjs"),
    });
  });
  async function request(route, name) {
    const res = await fetch(ready.origin + route, {
      method: name ? "POST" : "GET",
      headers: {
        Authorization: "Bearer " + ready.rootToken,
        Origin: ready.origin,
        ...(name ? { "content-type": "application/json" } : {}),
      },
      ...(name ? { body: JSON.stringify({ name }) } : {}),
    });
    if (!res.ok) throw new Error("Smoke API failed");
    return res.json();
  }
  async function stop() {
    child.send({ version: 1, type: "shutdown" });
    const result = await exited;
    if (result.code !== 0 || result.signal)
      throw new Error("Backend did not exit cleanly");
    owner = undefined;
  }
  return { request, stop };
}
try {
  const first = await launch();
  const strategy = await first.request(
    "/api/strategies",
    "Disposable relocation strategy",
  );
  const portfolio = await first.request(
    "/api/portfolios",
    "Disposable relocation portfolio",
  );
  await first.stop();
  const second = await launch();
  if (
    !(await second.request("/api/strategies")).some(
      (s) => s.id === strategy.id,
    ) ||
    !(await second.request("/api/portfolios")).some(
      (p) => p.id === portfolio.id,
    )
  )
    throw new Error("Reopen persistence failed");
  await second.stop();
  console.log(
    "PASS: relocated payload backend ready → create/list → actual exit 0 → reopen persisted strategy/portfolio → actual exit 0. No Pi/SDK connected. Native GUI NOT verified.",
  );
} finally {
  if (owner) {
    const child = owner;
    const exited = new Promise((resolve) => child.once("close", resolve));
    if (child.connected) child.send({ version: 1, type: "shutdown" });
    else child.kill("SIGTERM");
    await exited;
  }
  fs.rmSync(temporary, { recursive: true, force: true });
}
