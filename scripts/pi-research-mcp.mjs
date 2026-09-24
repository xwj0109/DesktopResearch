#!/usr/bin/env node
// Stdio MCP bridge to a running Pi Research app, for agents such as Claude
// Code, Codex or Cursor:
//
//   node pi-research-mcp.mjs --strategy <strategy-id> [--data "<Pi Research Data>"]
//
// Relays newline-delimited JSON-RPC between stdin/stdout and the app's
// /mcp/<strategy> endpoint. Connection details come from the access file the
// app writes when "external agents" is enabled for that strategy; it is read
// on every message, so restarting the app or revoking access needs no change
// here. Nothing is cached and no credentials are printed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const strategy = arg("--strategy");
const data = arg("--data") ?? path.join(os.homedir(), "Pi Research Data");
if (!strategy || !/^[0-9a-f-]{36}$/.test(strategy)) {
  process.stderr.write("Usage: pi-research-mcp.mjs --strategy <strategy-id> [--data <Pi Research Data folder>]\n");
  process.exit(2);
}
const accessFile = path.join(data, ".runtime", "mcp", `${strategy}.json`);
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const fail = (id, message) => id !== undefined && send({ jsonrpc: "2.0", id, error: { code: -32002, message } });

async function relay(message) {
  let access;
  try {
    access = JSON.parse(fs.readFileSync(accessFile, "utf8"));
  } catch {
    return fail(message?.id, "Pi Research is not reachable: open the app and enable external agents for this strategy.");
  }
  try {
    const response = await fetch(`${access.origin}/mcp/${strategy}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${access.token}` },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(180_000),
    });
    if (response.status === 202) return;
    const body = await response.json();
    if (Array.isArray(body)) body.forEach(send);
    else send(body);
  } catch {
    fail(message?.id, "Pi Research did not answer. Is the app still open?");
  }
}

const queue = [];
let busy = false;
async function drain() {
  if (busy) return;
  busy = true;
  while (queue.length) await relay(queue.shift());
  busy = false;
}
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  try {
    queue.push(JSON.parse(line));
  } catch {
    return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  }
  void drain();
});
