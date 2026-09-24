import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import {
  directory,
  ownedDirectory,
  prospectiveRealpath,
} from "../server/lifecycle.ts";
import { discoverPi } from "../server/pi-runtime.ts";
export function cleanEnvironment(env: NodeJS.ProcessEnv = process.env) {
  const copy = { ...env };
  delete copy.ELECTRON_RUN_AS_NODE;
  delete copy.NODE_OPTIONS;
  delete copy.NODE_PATH;
  return copy;
}
function executable(
  name: string,
  selected: string | undefined,
  env: NodeJS.ProcessEnv,
) {
  const candidates =
    selected !== undefined
      ? [selected]
      : [
          ...(env.PATH ?? "")
            .split(path.delimiter)
            .filter((p) => path.isAbsolute(p))
            .map((p) => path.join(p, name)),
          `/opt/homebrew/bin/${name}`,
          `/usr/local/bin/${name}`,
          `/usr/bin/${name}`,
        ];
  const found = candidates.find((p) => {
    try {
      return (
        path.isAbsolute(p) &&
        fs.statSync(p).isFile() &&
        (fs.accessSync(p, fs.constants.X_OK), true)
      );
    } catch {
      return false;
    }
  });
  if (!found)
    throw new Error(
      `System ${name} unavailable. Set ${name === "node" ? "LAB_PI_NODE" : "LAB_PI_EXECUTABLE"} to an absolute installed executable; no replacement is installed.`,
    );
  return fs.realpathSync(found);
}
export function systemRuntime(env: NodeJS.ProcessEnv = process.env) {
  const node = executable("node", env.LAB_PI_NODE, env);
  const raw = execFileSync(
    node,
    [
      "--eval",
      "process.stdout.write(JSON.stringify({node:process.versions.node,electron:process.versions.electron??null}))",
    ],
    {
      env: cleanEnvironment(env),
      timeout: 5000,
      maxBuffer: 4096,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  const probe = JSON.parse(raw);
  if (
    probe.electron ||
    typeof probe.node !== "string" ||
    !/^\d+\.\d+\.\d+$/.test(probe.node) ||
    Number(probe.node.split(".")[0]) < 22 ||
    (Number(probe.node.split(".")[0]) === 22 &&
      Number(probe.node.split(".")[1]) < 19)
  )
    throw new Error(
      "A system Node >=22.19 is required; Electron is not an SDK runtime",
    );
  const pi = executable("pi", env.LAB_PI_EXECUTABLE, env);
  if (pi) discoverPi(pi, node); // filesystem-only exact-package shape validation; no SDK/resources start
  return { node, pi };
}
export function validateDesktopRoot(selected: string, assets: string) {
  if (!path.isAbsolute(selected)) throw new Error("Data root must be absolute");
  const real = prospectiveRealpath(selected),
    assetRoot = directory(assets),
    home = fs.realpathSync(os.homedir());
  const packageRoot = path.dirname(assetRoot),
    appPart = packageRoot.match(/^(.*?\.app)(?:\/|$)/)?.[1];
  const protectedRoots = [
    path.join(home, "herdr-lab"),
    path.join(home, "Projects"),
    path.join(home, ".pi"),
    packageRoot,
    ...(appPart ? [appPart] : []),
  ];
  if (
    real === home ||
    real === "/" ||
    protectedRoots.some(
      (p) =>
        real === p ||
        real.startsWith(p + path.sep) ||
        p.startsWith(real + path.sep),
    )
  )
    throw new Error(
      "Unsafe/live lab root; select a separate disposable directory",
    );
  return { real, assetRoot };
}
export function selectedRoot(argv: string[], defaultRoot?: string) {
  let selected = defaultRoot;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--lab-root") {
      if (!argv[i + 1] || argv[i + 1].startsWith("--"))
        throw new Error("--lab-root requires an absolute directory");
      selected = argv[++i];
    } else if (argv[i].startsWith("--lab-root=")) selected = argv[i].slice(11);
  }
  if (!selected || !path.isAbsolute(selected))
    throw new Error(
      "An absolute --lab-root or new product application-data default is required.",
    );
  return selected;
}
export function desktopConfig(
  argv: string[],
  assets: string,
  env: NodeJS.ProcessEnv = process.env,
  defaultRoot?: string,
) {
  const selected = selectedRoot(argv, defaultRoot);
  // Do not even mkdir the established live root; canonical aliases are rejected too.
  const { real, assetRoot } = validateDesktopRoot(selected, assets);
  const runtime = systemRuntime(env); // validate runtime before any storage mutation
  const root = directory(real, true);
  validateDesktopRoot(root, assets);
  ownedDirectory(root, ".runtime");
  ownedDirectory(root, "workspaces");
  const desktop = ownedDirectory(root, ".desktop");
  return { root, assets: assetRoot, desktop, ...runtime };
}
