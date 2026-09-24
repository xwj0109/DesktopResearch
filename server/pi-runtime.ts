import fs from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Rpc } from "./rpc.ts";
import type { PiRuntimeIdentity } from "../src/pi-protocol.ts";

/** Discovery is filesystem-only: never import Pi, initialize Store, or load extensions here. */
export function discoverPi(
  selected = process.env.LAB_PI_EXECUTABLE,
  selectedNode = process.env.LAB_PI_NODE,
): PiRuntimeIdentity {
  const executable =
    selected ??
    (process.env.PATH ?? "")
      .split(path.delimiter)
      .map((p) => path.join(p, "pi"))
      .find((p) => {
        try {
          fs.accessSync(p, fs.constants.X_OK);
          return true;
        } catch {
          return false;
        }
      });
  if (!executable || !path.isAbsolute(executable))
    throw new Error(
      "Installed Pi not found; configure an absolute LAB_PI_EXECUTABLE",
    );
  const real = fs.realpathSync(executable);
  let root = path.dirname(real);
  while (true) {
    const manifest = path.join(root, "package.json");
    if (fs.existsSync(manifest)) {
      const pkg = JSON.parse(fs.readFileSync(manifest, "utf8"));
      if (pkg.name === "@earendil-works/pi-coding-agent") {
        const require = createRequire(manifest);
        const sdk = path.join(root, "dist/core/sdk.js");
        for (const name of [
          "sdk",
          "agent-session-runtime",
          "agent-session-services",
          "settings-manager",
          "resource-loader",
          "project-trust",
          "package-manager",
          "session-manager",
        ])
          fs.accessSync(path.join(root, `dist/core/${name}.js`));
        const systemNode = (
          process.versions as Record<string, string | undefined>
        ).electron
          ? (process.env.PATH ?? "")
              .split(path.delimiter)
              .map((p) => path.join(p, "node"))
              .find((p) => {
                try {
                  fs.accessSync(p, fs.constants.X_OK);
                  return true;
                } catch {
                  return false;
                }
              })
          : process.execPath;
        const node = selectedNode ?? systemNode;
        if (!node)
          throw new Error(
            "System Node unavailable; configure LAB_PI_NODE (never use Electron as the SDK host)",
          );
        if (!path.isAbsolute(node))
          throw new Error("LAB_PI_NODE must be absolute");
        return {
          executable: real,
          packageRoot: root,
          version: String(pkg.version),
          node: fs.realpathSync(node),
          agentDir: path.resolve(
            process.env.PI_CODING_AGENT_DIR ??
              path.join(os.homedir(), ".pi/agent"),
          ),
          sdk,
          tui: require.resolve("@earendil-works/pi-tui"),
        };
      }
    }
    const parent = path.dirname(root);
    if (root === parent)
      throw new Error("Executable is not inside the installed Pi package");
    root = parent;
  }
}
export interface HostOptions {
  identity: PiRuntimeIdentity;
  cwd: string;
  sessionDir: string;
  session?: string;
  generation: number;
  noInference?: boolean;
  editorFile?: string;
  /** Workbench tool manifest (JSON Schema) and shared guidance, from the backend registry. */
  tools?: import("./workbench/tools.ts").ToolManifest[];
  toolInstructions?: string;
}
export function launchLinkedPi(options: HostOptions) {
  return new Rpc(
    spawn(
      options.identity.node,
      [fileURLToPath(new URL("./pi-host.mjs", import.meta.url))],
      {
        cwd: options.cwd,
        shell: false,
        stdio: ["pipe", "pipe", "pipe", "ipc"],
        env: { ...process.env, HERDR_PI_HOST: JSON.stringify(options) },
      },
    ) as ChildProcessWithoutNullStreams,
    120000,
    10000,
  );
}
