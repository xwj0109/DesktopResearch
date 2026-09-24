import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const directory = path.dirname(require.resolve("node-pty/package.json"));
const helper = path.join(
  directory,
  "prebuilds",
  `${process.platform}-${process.arch}`,
  "spawn-helper",
);
// Published prebuilds can lose their executable bit. No build or download needed.
if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
