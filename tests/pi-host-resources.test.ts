import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const modulePath = "../server/pi-host-resources.mjs", fakePath = "./fake-installed-pi.mjs";
const { readThroughSettings, assertSettingsHealthy, preflightExplicitResources } = await import(modulePath), { SettingsManager } = await import(fakePath);
function fixture(t: any) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "herdr-resources-"))), agentDir = path.join(root, "agent"), cwd = path.join(root, "workspace");
  fs.mkdirSync(agentDir); fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let global: any = {}, project: any = {}, trusted = false;
  const settings = { getGlobalSettings: () => global, getProjectSettings: () => project, isProjectTrusted: () => trusted };
  return { root, agentDir, cwd, global: (v: any) => global = v, project: (v: any) => project = v, trust: () => trusted = true, run: () => preflightExplicitResources({ settings, agentDir, cwd, minimatch: path.matchesGlob }) };
}
test("queued malformed/unreadable settings errors are gates, not silently empty harnesses", t => {
  const x = fixture(t), file = path.join(x.agentDir, "settings.json");
  for (const contents of ["{bad", "[]", ""]) {
    fs.writeFileSync(file, contents);
    const settings = SettingsManager.fromStorage(readThroughSettings(x.cwd, x.agentDir));
    assert.deepEqual(settings.getGlobalSettings(), {});
    assert.throws(() => assertSettingsHealthy(settings), /settings failed/);
  }
  fs.unlinkSync(file); fs.mkdirSync(file);
  assert.throws(() => assertSettingsHealthy(SettingsManager.fromStorage(readThroughSettings(x.cwd, x.agentDir))), /settings failed/);
});

test("untrusted project settings are not read; errors surface before using newly trusted resources", t => {
  const x = fixture(t); fs.writeFileSync(path.join(x.agentDir, "settings.json"), "{}"); fs.writeFileSync(path.join(x.cwd, ".pi/settings.json"), "{bad");
  const settings = SettingsManager.fromStorage(readThroughSettings(x.cwd, x.agentDir));
  assert.doesNotThrow(() => assertSettingsHealthy(settings)); settings.setProjectTrusted(true);
  assert.throws(() => assertSettingsHealthy(settings), /project/);
});

test("explicit resource preflight follows filter/exclusion/force precedence without expanding settings globs", t => {
  const x = fixture(t);
  x.global({ extensions: ["nested/missing.js", "!missing.js"] }); assert.deepEqual(x.run(), []);
  x.global({ extensions: ["nested/missing.js", "!*.js", "+./nested/missing.js"] }); assert.throws(x.run, /Missing\/unreadable/);
  x.global({ extensions: ["nested/missing.js", "!*.js", "+./nested/missing.js", "-nested/missing.js"] }); assert.deepEqual(x.run(), []);
  x.global({ extensions: ["missing.js", "*.md"] }); assert.deepEqual(x.run(), []);
  x.global({ extensions: ["*.js", "!excluded.js", "+missing.js", "-missing.js"] }); assert.deepEqual(x.run(), []);
  x.global({ skills: ["team/SKILL.md", "!team"] }); assert.deepEqual(x.run(), []);
  x.global({ skills: ["team/SKILL.md", "!team", "+team"] }); assert.throws(x.run, /skills/);
  x.global({ skills: ["team/SKILL.md", "!team", "+team", "-team"] }); assert.deepEqual(x.run(), []);
  x.global({ extensions: ["literal[1].js"] }); assert.throws(x.run, /literal\[1\]/);
  fs.writeFileSync(path.join(x.agentDir, "literal[1].js"), "fixture"); assert.equal(x.run().length, 1);
  x.global({ extensions: ["missing-directory", "*.js"] }); assert.throws(x.run, /missing-directory/);
});

for (const kind of ["extensions", "skills", "prompts", "themes"]) test(`missing enabled ${kind} resource fails; project paths use cwd/.pi only after trust`, t => {
  const x = fixture(t); x.global({ [kind]: ["missing.resource"] }); assert.throws(x.run, new RegExp(kind));
  x.global({}); x.project({ [kind]: ["project.resource"] }); assert.deepEqual(x.run(), []);
  fs.writeFileSync(path.join(x.cwd, "project.resource"), "wrong base"); x.trust(); assert.throws(x.run, /project/);
  fs.writeFileSync(path.join(x.cwd, ".pi/project.resource"), "correct base"); assert.equal(x.run()[0].path, path.join(x.cwd, ".pi/project.resource"));
});
