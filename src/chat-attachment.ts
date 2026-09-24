import { z } from "zod";
import { composeReviewMessage, splitReviewMessage, type ReviewAttachment } from "./review-attachment";

/** Chat attachments as portable text envelopes (like review attachments): any
 * runtime receives plain text it can act on, while the desktop renders cards.
 *
 * - source: a paper in the strategy library, by reference. The agent reads it
 *   with the workbench tools (paper_read, paper_find), identical for every
 *   runtime, so the conversation stays small and the evidence stays exact.
 * - file: a text file's content, inlined.
 *
 * Images are not text; they travel as the prompt's portable `images` field. */
const sourceSchema = z
  .object({
    kind: z.literal("source"),
    id: z.uuid(),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    name: z.string().min(1).max(300),
  })
  .strict();
/** File metadata; the content follows as plain text (stored once). */
const fileMetaSchema = z
  .object({ kind: z.literal("file"), name: z.string().min(1).max(300), mime: z.string().max(100), truncated: z.boolean() })
  .strict();
const metaSchema = z.discriminatedUnion("kind", [sourceSchema, fileMetaSchema]);
export type ChatAttachment = z.infer<typeof sourceSchema> | (z.infer<typeof fileMetaSchema> & { content: string });
const START = "[Chat attachment v1]";
const END = "[/Chat attachment]";
// Content can never close its own envelope.
const guard = (text: string) => text.replaceAll(END, "[/Chat attachment\u200b]");

function block(a: ChatAttachment) {
  if (a.kind === "source")
    return `${START}\n${JSON.stringify(sourceSchema.parse(a))}\nAttached source: "${a.name}" (artifactId ${a.id}, sha256 ${a.hash.slice(0, 12)}). Read it with paper_read / paper_find using that artifactId.\n${END}`;
  const { content, ...meta } = a;
  return `${START}\n${JSON.stringify(fileMetaSchema.parse(meta))}\nAttached file "${a.name}"${a.truncated ? " (truncated)" : ""}:\n${guard(content)}\n${END}`;
}
export function composeChatMessage(text: string, attachments: ChatAttachment[], reviews: ReviewAttachment[] = []) {
  const blocks = attachments.map(block);
  return composeReviewMessage(text + (text && blocks.length ? "\n\n" : "") + blocks.join("\n\n"), reviews);
}
export function splitChatMessage(message: string): { text: string; attachments: ChatAttachment[]; reviews: ReviewAttachment[] } {
  const { text: withoutReviews, attachments: reviews } = splitReviewMessage(message);
  const attachments: ChatAttachment[] = [];
  const text = withoutReviews.replace(
    /(^|\n\n?)\[Chat attachment v1\]\n([^\n]*)\n([\s\S]*?)\n\[\/Chat attachment\](?=\n|$)/g,
    (whole, _prefix, json, body: string) => {
      try {
        const meta = metaSchema.safeParse(JSON.parse(json));
        if (!meta.success) return whole;
        if (meta.data.kind === "source") attachments.push(meta.data);
        else attachments.push({ ...meta.data, content: body.slice(body.indexOf("\n") + 1) });
        return "";
      } catch {
        return whole;
      }
    },
  );
  // Text appended after attachments (e.g. "Ask Pi") keeps one clean paragraph break.
  return { text: attachments.length ? text.replace(/\n{3,}/g, "\n\n").replace(/^\n+|\n+$/g, "") : text, attachments, reviews };
}
export const sourceAttachment = (a: { id: string; hash: string; name: string }): ChatAttachment => ({
  kind: "source",
  id: a.id,
  hash: a.hash,
  name: a.name.slice(0, 300),
});
export function fileAttachment(name: string, mime: string, content: string, budget = 90000): ChatAttachment {
  const limit = Math.max(0, Math.min(budget, 90000));
  return { kind: "file", name: name.slice(0, 300), mime: mime.slice(0, 100), truncated: content.length > limit, content: content.slice(0, limit) };
}
/** Text-like files that can be inlined. */
export const isTextFile = (f: { name: string; type: string }) =>
  f.type.startsWith("text/") ||
  /\/(json|xml|x-yaml|yaml|csv|x-tex|x-python|javascript|typescript|x-sh|toml)$/.test(f.type) ||
  /\.(md|markdown|txt|csv|tsv|json|ya?ml|toml|tex|bib|py|r|jl|m|ipynb|js|ts|tsx|sql|log|ini|cfg|sh)$/i.test(f.name);
