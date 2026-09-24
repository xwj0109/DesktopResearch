import { z } from "zod";
import type { Batch } from "./shared";
import { reviewPrompt } from "./review-format";

const attachmentSchema = z
  .object({
    kind: z.literal("research-review"),
    id: z.uuid(),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    title: z.string().min(1).max(40000),
    passages: z.number().int().min(1).max(100),
    papers: z.number().int().min(1).max(100),
    content: z.string().min(1).max(200000),
  })
  .strict();
export type ReviewAttachment = z.infer<typeof attachmentSchema>;
const START = "[Research review attachment v1]";
const END = "[/Research review attachment]";

/** Portable text envelope: the runtime receives the evidence, while the desktop
 * displays a card. JSON escaping prevents source text from closing the envelope.
 * This is presentation, not an authority or a new attachment upload protocol. */
export function reviewAttachment(review: Batch): ReviewAttachment {
  return attachmentSchema.parse({
    kind: "research-review",
    id: review.id,
    hash: review.hash,
    title: review.instruction,
    passages: review.annotations.length,
    papers: review.documents.length,
    content: reviewPrompt(review),
  });
}
export function composeReviewMessage(
  text: string,
  attachments: ReviewAttachment[],
): string {
  return (
    text +
    (text && attachments.length ? "\n\n" : "") +
    attachments
      .map(
        (a) => `${START}\n${JSON.stringify(attachmentSchema.parse(a))}\n${END}`,
      )
      .join("\n\n")
  );
}
export function splitReviewMessage(message: string): {
  text: string;
  attachments: ReviewAttachment[];
} {
  const attachments: ReviewAttachment[] = [];
  const text = message.replace(
    /(^|\n\n)\[Research review attachment v1\]\n([^\n]*)\n\[\/Research review attachment\](?=\n\n|$)/g,
    (block, _prefix, json) => {
      try {
        const parsed = attachmentSchema.safeParse(JSON.parse(json));
        if (!parsed.success) return block;
        attachments.push(parsed.data);
        return "";
      } catch {
        return block;
      }
    },
  );
  return { text, attachments };
}
export function appendReviewMessage(current: string, addition: string): string {
  const a = splitReviewMessage(current),
    b = splitReviewMessage(addition);
  const attachments = [...a.attachments];
  for (const next of b.attachments)
    if (
      !attachments.some((old) => old.id === next.id && old.hash === next.hash)
    )
      attachments.push(next);
  const text =
    a.text + (a.text && b.text && !a.text.endsWith("\n") ? "\n" : "") + b.text;
  const result = composeReviewMessage(text, attachments);
  if (result.length > 100000)
    throw new Error(
      "This message exceeds the conversation limit. Remove an attachment or prepare a smaller review; your existing draft is unchanged.",
    );
  return result;
}
