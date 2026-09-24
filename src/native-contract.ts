import { z } from "zod";
import { stageIds } from "../desktop/contracts.ts";
import { envelopeSchema, portfolioEnvelopeSchema } from "./platform.ts";
import type { PiSnapshot } from "./pi-protocol.ts";
export const conversationStages = [...stageIds, "portfolio"] as const;
export const intentSchema = z
  .object({
    id: z.uuid(),
    generation: z.number().int().nonnegative(),
    context: z.string().max(128).nullable(),
    sessionId: z.string().min(1).max(128).optional(),
  })
  .strict();
export const CHAT_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
/** At most 4 images and ~4 MB of base64 in one message (fits the backend's JSON limit). */
export const chatImagesSchema = z
  .array(
    z
      .object({
        mimeType: z.enum(CHAT_IMAGE_TYPES),
        data: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/).max(4_000_000),
      })
      .strict(),
  )
  .max(4)
  .refine((images) => images.reduce((n, i) => n + i.data.length, 0) <= 4_000_000, "Images exceed 4 MB in total");
export const nativeOperationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("queue"), message: z.string().trim().min(1).max(100000), behavior: z.enum(["steer", "followUp"]), images: chatImagesSchema.optional() }).strict(),
  z.object({ type: z.literal("retrieve_queue") }).strict(),
  z.object({ type: z.literal("shortcut"), key: z.string().min(1).max(100) }).strict(),
  z.object({ type: z.literal("cycle_model"), direction: z.enum(["forward", "backward"]) }).strict(),
  z.object({ type: z.literal("connect") }).strict(),
  z.object({ type: z.literal("stop") }).strict(),
  z
    .object({
      type: z.literal("prompt"),
      message: z.string().trim().min(1).max(100000),
      /** Portable image attachments; each runtime adapter maps them to its own input. */
      images: chatImagesSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("command"),
      name: z.string().regex(/^[^\s/\u0000-\u001f]{1,128}$/u),
      args: z.string().max(100000).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("set_model"),
      provider: z.string().max(200),
      modelId: z.string().max(300),
    })
    .strict(),
  z
    .object({ type: z.literal("set_thinking"), level: z.string().max(64) })
    .strict(),
  z
    .object({
      type: z.literal("ui_response"),
      requestId: z.uuid(),
      cancelled: z.boolean().optional(),
      value: z.union([z.string().max(100000), z.boolean()]).optional(),
    })
    .strict(),
  z
    .object({ type: z.literal("editor_state"), text: z.string().max(100000) })
    .strict(),
  z
    .object({
      type: z.literal("terminal_input"),
      surfaceId: z.string().max(300),
      data: z.string().max(8192),
    })
    .strict(),
  z
    .object({
      type: z.literal("terminal_resize"),
      surfaceId: z.string().max(300),
      columns: z.number().int().min(20).max(400),
      rows: z.number().int().min(5).max(200),
    })
    .strict(),
  z
    .object({
      type: z.literal("terminal_cancel"),
      surfaceId: z.string().max(300),
    })
    .strict(),
  z.object({ type: z.literal("cancel") }).strict(),
  z.object({ type: z.literal("reload") }).strict(),
  z.object({ type: z.literal("resync_ui") }).strict(),
]);
export const nativeActionSchema = z
  .object({ intent: intentSchema, operation: nativeOperationSchema })
  .strict();
export type NativeAction = z.infer<typeof nativeActionSchema>;
export type NativeOperation = NativeAction["operation"];
export interface NativeHistory {
  mode: "active-branch" | "offline-append-log";
  context: string | null;
  entries: unknown[];
  cursor: number;
  next: number | null;
  truncated: boolean;
}
export type NativeSnapshot = Omit<PiSnapshot, "binding"> & {
  context: string | null;
  lastSubmission?: { id: string; status: string };
  models: { id: string; provider: string; name: string }[];
  commands: { name: string; description?: string }[];
};
export interface IntentReceipt {
  id: string;
  hash: string;
  status: "pending" | "acknowledged" | "uncertain" | "sealed";
  result?: unknown;
}
export { envelopeSchema, portfolioEnvelopeSchema };

export const completionQuerySchema = z.object({ text: z.string().max(400), generation: z.coerce.number().int().nonnegative() }).strict();
export type RuntimeCompletion = { label: string; detail?: string; insert: string; caret: number };
