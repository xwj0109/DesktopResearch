import { z } from "zod";
export const strategyRenameSchema = z.object({
  expectedName: z.string().min(1).max(120),
  name: z.string().trim().min(1).max(120),
}).strict();
export const strategyDeleteSchema = z.object({
  expectedName: z.string().min(1).max(120),
}).strict();
