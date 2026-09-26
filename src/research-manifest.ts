import { z } from "zod";

/** research.toml: a small manifest in an idea's workspace, written by the
 * agent like any other file. The app reads it to offer "Run ▸ <entry>" and to
 * know the environment lock; it is never the authority for results. Unknown
 * keys are kept and ignored (docs/WORKFLOW-REDESIGN-PLAN.md §6.3). */
export const MANIFEST_FILE = "research.toml";

const ENTRY_NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/;
export const manifestSchema = z
  .object({
    env: z.object({ lock: z.string().min(1).max(200).optional() }).passthrough().optional(),
    run: z
      .record(
        z.string(),
        z
          .object({
            command: z.string().trim().min(1).max(1000),
            description: z.string().max(500).optional(),
            inputs: z.array(z.string().max(200)).max(50).optional(),
            outputs: z.array(z.string().max(200)).max(50).optional(),
          })
          .passthrough(),
      )
      .superRefine((runs, ctx) => {
        for (const name of Object.keys(runs))
          if (!ENTRY_NAME.test(name)) ctx.addIssue({ code: "custom", path: [name], message: `entry names are lower-case letters, digits, - and _ (not "${name}")` });
      })
      .optional(),
    feature: z
      .array(
        z
          .object({
            name: z.string().min(1).max(120),
            source: z.string().max(200).optional(),
            lookback: z.string().max(60).optional(),
            available_after: z.string().max(60).optional(),
          })
          .passthrough(),
      )
      .max(500)
      .optional(),
  })
  .passthrough();
export type ResearchManifest = z.infer<typeof manifestSchema>;

type Value = string | number | boolean | Value[] | { [k: string]: Value };
type Table = { [k: string]: Value };

/** Parse the TOML subset a research manifest needs: [table] and [[array]]
 * headers, key = string | number | boolean | array (arrays may span lines),
 * and # comments. Anything else is refused with its line number. */
export function parseToml(text: string): Table {
  const root: Table = {};
  let table: Table = root;
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const fail = (n: number, why: string): never => {
    throw new Error(`${MANIFEST_FILE} line ${n + 1}: ${why}`);
  };
  const key = (raw: string, n: number) => {
    const k = raw.trim();
    if (/^[A-Za-z0-9_-]+$/.test(k)) return k;
    const q = /^"([^"\\]*)"$/.exec(k);
    return q ? q[1] : fail(n, `unsupported key ${k}`);
  };
  const path = (raw: string, n: number) => raw.split(".").map((p) => key(p, n));
  const descend = (keys: string[], n: number, array: boolean) => {
    let t = root;
    keys.forEach((k, i) => {
      const last = i === keys.length - 1;
      if (last && array) {
        const list = (t[k] ??= []) as Value;
        if (!Array.isArray(list)) fail(n, `${k} is not an array of tables`);
        const next: Table = {};
        (list as Value[]).push(next);
        t = next;
        return;
      }
      let next = t[k];
      if (Array.isArray(next)) next = next[next.length - 1];
      if (next === undefined) t[k] = next = {};
      if (typeof next !== "object" || Array.isArray(next)) fail(n, `${k} is not a table`);
      t = next as Table;
    });
    return t;
  };
  for (let n = 0; n < lines.length; n++) {
    let line = stripComment(lines[n]).trim();
    if (!line) continue;
    let m: RegExpExecArray | null;
    if ((m = /^\[\[([^\]]+)\]\]$/.exec(line))) table = descend(path(m[1], n), n, true);
    else if ((m = /^\[([^\]]+)\]$/.exec(line))) table = descend(path(m[1], n), n, false);
    else {
      const eq = line.indexOf("=");
      if (eq < 0) fail(n, "expected key = value");
      const k = key(line.slice(0, eq), n);
      let raw = line.slice(eq + 1).trim();
      const start = n;
      // Arrays may continue over several lines until their brackets close.
      while (raw.startsWith("[") && depth(raw) > 0 && n + 1 < lines.length) raw += " " + stripComment(lines[++n]).trim();
      if (k in table) fail(start, `${k} is defined twice`);
      table[k] = value(raw, start, fail);
    }
  }
  return root;
}
function stripComment(line: string) {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "#") return line.slice(0, i);
  }
  return line;
}
/** Open brackets outside strings. */
function depth(raw: string) {
  let d = 0,
    quote: string | null = null;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "[") d++;
    else if (c === "]") d--;
  }
  return d;
}
function value(raw: string, n: number, fail: (n: number, why: string) => never): Value {
  const s = raw.trim();
  if (s.startsWith('"')) {
    const m = /^"((?:[^"\\]|\\.)*)"$/.exec(s);
    if (!m) fail(n, "unterminated string");
    return m![1].replace(/\\(["\\nt])/g, (_, c) => (c === "n" ? "\n" : c === "t" ? "\t" : c));
  }
  if (s.startsWith("'")) {
    const m = /^'([^']*)'$/.exec(s);
    if (!m) fail(n, "unterminated string");
    return m![1];
  }
  if (s === "true" || s === "false") return s === "true";
  if (/^[+-]?(\d[\d_]*)(\.\d+)?([eE][+-]?\d+)?$/.test(s)) return Number(s.replace(/_/g, ""));
  if (s.startsWith("[")) {
    if (!s.endsWith("]") || depth(s) !== 0) fail(n, "unterminated array");
    const inner = s.slice(1, -1);
    const items: Value[] = [];
    let cur = "",
      quote: string | null = null,
      d = 0;
    for (let i = 0; i < inner.length; i++) {
      const c = inner[i];
      if (quote) {
        cur += c;
        if (c === "\\" && quote === '"') cur += inner[++i] ?? "";
        else if (c === quote) quote = null;
      } else if (c === '"' || c === "'") (quote = c), (cur += c);
      else if (c === "[") d++, (cur += c);
      else if (c === "]") d--, (cur += c);
      else if (c === "," && d === 0) {
        if (cur.trim()) items.push(value(cur, n, fail));
        cur = "";
      } else cur += c;
    }
    if (cur.trim()) items.push(value(cur, n, fail));
    return items;
  }
  return fail(n, `unsupported value ${s.slice(0, 40)} (use a quoted string, number, true/false or [array])`);
}

/** Read and check a manifest; errors are returned, not thrown, so a broken
 * manifest never blocks the rest of the workspace. */
export function readManifest(text: string | null): { manifest: ResearchManifest | null; error: string | null } {
  if (text === null) return { manifest: null, error: null };
  try {
    const parsed = manifestSchema.safeParse(parseToml(text));
    if (!parsed.success)
      return { manifest: null, error: `${MANIFEST_FILE}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "file"}: ${i.message}`).join("; ").slice(0, 400)}` };
    return { manifest: parsed.data, error: null };
  } catch (e) {
    return { manifest: null, error: String((e as Error).message ?? e).slice(0, 400) };
  }
}
