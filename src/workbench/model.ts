export type StageId =
  | "ideas"
  | "literature"
  | "research"
  | "data"
  | "code"
  | "backtests"
  | "results";
export type MaterialTab = "note" | "code" | "graph" | "evidence";
export interface Stage {
  id: StageId;
  label: string;
  icon: string;
}
export interface Thread {
  title: string;
  subtitle: string;
  prompt: string;
  introduction: string;
  points: { title: string; text: string }[];
  closing: string;
  activities: { title: string; detail: string }[];
}
export interface Workspace {
  id: string;
  name: string;
  shortName: string;
  description: string;
  threads: Record<StageId, Thread>;
}
export interface Material {
  filename: string;
  title: string;
  eyebrow: string;
  author: string;
  abstract: string;
  sections: { title: string; body: string }[];
  quote: string;
  code: string;
  nodes: { id: string; title: string; subtitle: string; detail: string }[];
  evidence: { label: string; value: string }[];
}
export interface WorkbenchData {
  stages: Stage[];
  workspaces: Workspace[];
  materials: Record<string, Material>;
  portfolio: Thread;
}

export function sessionKey(workspace: string, stage: StageId): string {
  return `${workspace}:${stage}`;
}
export function updateDraft(
  drafts: Record<string, string>,
  key: string,
  value: string,
): Record<string, string> {
  return { ...drafts, [key]: value };
}
