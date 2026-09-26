import type { Stage } from "./model";
/** Ideas → Explore → Develop → Release (docs/WORKFLOW-REDESIGN-PLAN.md §5.1).
 * Design & Code, Backtests and Results hold the earlier record system; they are
 * shown only with "Show legacy stages" (palette), so old records stay readable. */
export const stages: Stage[] = [
  { id: "ideas", label: "Ideas", icon: "spark" },
  { id: "literature", label: "Explore", icon: "book" },
  { id: "research", label: "Develop", icon: "flask" },
  { id: "data", label: "Release", icon: "database" },
  { id: "code", label: "Design & Code", icon: "code", legacy: true },
  { id: "backtests", label: "Backtests", icon: "play", legacy: true },
  { id: "results", label: "Results", icon: "chart", legacy: true },
];
/** Window draft: "1" while the legacy stages are shown. */
export const LEGACY_STAGES = "ui:legacy-stages";
