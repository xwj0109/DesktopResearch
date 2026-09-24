import type { WorkbenchData, Thread, StageId } from "./model";
import { stages } from "./stages";
export function disconnectedWorkspace(id: string, name: string): WorkbenchData {
  const thread = (title: string): Thread => ({
    title,
    subtitle: "Disconnected · no conversation loaded",
    prompt: "",
    introduction: "",
    points: [],
    closing: "",
    activities: [],
  });
  return {
    stages,
    workspaces: [
      {
        id,
        name,
        shortName: name,
        description: "Local workspace",
        threads: Object.fromEntries(
          stages.map((s) => [s.id, thread(s.label)]),
        ) as Record<StageId, Thread>,
      },
    ],
    materials: {},
    portfolio: thread("Portfolio evidence review"),
  };
}
