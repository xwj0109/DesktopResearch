import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
export function installed(root: string, settings: object = {}) {
  const pkg = path.join(root, "installed"),
    agent = path.join(root, "agent"),
    cli = path.join(pkg, "dist/cli.js");
  fs.mkdirSync(path.join(pkg, "dist/core"), { recursive: true });
  fs.mkdirSync(agent);
  fs.writeFileSync(path.join(agent, "settings.json"), JSON.stringify(settings));
  fs.writeFileSync(
    path.join(pkg, "package.json"),
    JSON.stringify({
      name: "@earendil-works/pi-coding-agent",
      version: "0.84.1-fixture",
      type: "module",
    }),
  );
  fs.copyFileSync(
    fileURLToPath(new URL("./fake-installed-pi.mjs", import.meta.url)),
    path.join(pkg, "fixture.mjs"),
  );
  for (const name of [
    "sdk",
    "agent-session-runtime",
    "agent-session-services",
    "settings-manager",
    "resource-loader",
    "project-trust",
    "trust-manager",
    "package-manager",
    "session-manager",
    "model-runtime",
    "keybindings",
    "footer-data-provider",
  ])
    fs.writeFileSync(
      path.join(pkg, `dist/core/${name}.js`),
      'export * from "../../fixture.mjs";',
    );
  fs.mkdirSync(path.join(pkg, "dist/modes/interactive/theme"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(pkg, "dist/modes/interactive/theme/theme.js"),
    'export * from "../../../../fixture.mjs";',
  );
  const tui = path.join(pkg, "node_modules/@earendil-works/pi-tui");
  fs.mkdirSync(tui, { recursive: true });
  fs.writeFileSync(
    path.join(tui, "package.json"),
    '{"type":"module","main":"index.js"}',
  );
  fs.writeFileSync(
    path.join(tui, "index.js"),
    'export * from "../../../fixture.mjs";',
  );
  const minimatch = path.join(pkg, "node_modules/minimatch");
  fs.mkdirSync(minimatch, { recursive: true });
  // Authored fake dependency: platform matcher covers the fixture's basic glob cases.
  fs.writeFileSync(
    path.join(minimatch, "index.js"),
    "module.exports={minimatch:require('node:path').matchesGlob};",
  );
  const semver = path.join(pkg, "node_modules/semver");
  fs.mkdirSync(semver, { recursive: true });
  fs.writeFileSync(
    path.join(semver, "index.js"),
    "module.exports={validRange:r=>/^\\d/.test(r)?r:null,satisfies:(v,r)=>v===r};",
  );
  fs.writeFileSync(
    cli,
    'import fs from "node:fs"; fs.writeFileSync("handoff-args.json",JSON.stringify(process.argv.slice(2)));setTimeout(()=>{},250);',
  );
  fs.chmodSync(cli, 0o700);
  const executable = path.join(root, "pi");
  fs.symlinkSync(cli, executable);
  return { pkg, agent, cli, executable };
}
