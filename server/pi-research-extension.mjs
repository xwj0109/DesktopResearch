// Pi extension: the Pi Research workbench tools inside the real Pi CLI.
//
// Loaded by the desktop's conversation pane with `pi -e <this file>`. It is a
// thin MCP client of the backend registry (the same tools every runtime gets):
// it lists the tools at startup and forwards each call to tools/call. Without
// the environment the pane provides it does nothing, so it is harmless when
// loaded elsewhere. No tool definitions or logic live here.
const url = process.env.PI_RESEARCH_MCP_URL;
const token = process.env.PI_RESEARCH_MCP_TOKEN;

async function rpc(method, params) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
    signal: AbortSignal.timeout(180_000),
  });
  const body = await response.json();
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

export default async function piResearch(pi) {
  if (!url || !token) return;
  let init, list;
  try {
    init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "pi-research-extension", version: "1" } });
    list = await rpc("tools/list", {});
  } catch {
    return; // App not reachable: Pi works as usual without the research tools.
  }
  const guidance = init?.instructions;
  list.tools.forEach((tool, index) =>
    pi.registerTool({
      name: tool.name,
      label: tool.title ?? tool.name,
      description: tool.description,
      promptSnippet: `${tool.name}: ${tool.description.split(". ")[0]}.`,
      // Shared guidance once; it names the tools it refers to.
      promptGuidelines: index === 0 && guidance ? [guidance] : [],
      parameters: tool.inputSchema,
      async execute(_id, params) {
        const result = await rpc("tools/call", { name: tool.name, arguments: params ?? {} });
        const text = (result.content ?? []).map((c) => c.text ?? "").join("\n");
        if (result.isError) throw new Error(text || "Workbench tool failed");
        return { content: [{ type: "text", text }], details: result.structuredContent ?? {} };
      },
    }),
  );
}
