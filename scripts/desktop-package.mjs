import { inventory } from "./desktop-inventory.mjs";
import { packager } from "@electron/packager";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import path from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
inventory(path.join(root, "desktop-build"));
const results = await packager({
  dir: root + "desktop-build",
  out: root + "desktop-release",
  name: "Pi Research",
  appBundleId: "local.pi.research.desktop",
  appVersion: "0.1.0",
  electronVersion: "44.4.3",
  platform: "darwin",
  arch: "arm64",
  asar: false,
  overwrite: true,
  prune: true,
  osxSign: undefined,
});
// Renaming Electron invalidates its original bundle resource seal. Produce and
// verify a fresh local ad-hoc signature; this is not distribution signing.
for (const result of results) {
  const app = path.join(result, "Pi Research.app");
  inventory(path.join(app, "Contents/Resources/app"));
  execFileSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", app], {
    stdio: "inherit",
  });
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], {
    stdio: "inherit",
  });
}
console.log(results.join("\n"));
console.log(
  "Local verified ad-hoc Electron artifact only; no notarization/distribution claim. Explicit disposable --lab-root required.",
);
