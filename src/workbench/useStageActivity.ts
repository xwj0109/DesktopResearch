import { useEffect, useState } from "react";
import type { NativeClient } from "../native-client";
import type { NativeSnapshot } from "../native-contract";

export interface StageActivity {
  pending: number;
  running: boolean;
  connected: boolean;
}

/** Read-only background view of other stages' sessions, so a pending Pi
 * dialog is visible from anywhere. Uses the same bounded snapshot GET as the
 * conversation view with incremental cursors; it never connects or starts Pi. */
export function useStageActivity(client: NativeClient | undefined, stages: string[], current: string) {
  const [activity, setActivity] = useState<Record<string, StageActivity>>({});
  const key = stages.join(",");
  useEffect(() => {
    if (!client) return;
    let alive = true,
      busy = false;
    const cursors: Record<string, { through: number; generation: number }> = {};
    const poll = async () => {
      if (busy) return;
      busy = true;
      try {
        for (const stage of stages) {
          if (!alive) return;
          if (stage === current) continue;
          const c = cursors[stage];
          try {
            const s = await client.read<NativeSnapshot>(
              `/native/conversations/${stage}` + (c ? `?after=${c.through}&generation=${c.generation}` : ""),
            );
            cursors[stage] = { through: s.through, generation: s.generation };
            const next: StageActivity = {
              pending: s.ui?.pending?.length ?? 0,
              running: !!s.runtimeState?.isStreaming,
              connected: !!s.connected,
            };
            if (alive)
              setActivity((old) =>
                JSON.stringify(old[stage]) === JSON.stringify(next) ? old : { ...old, [stage]: next },
              );
          } catch {
            // Background awareness is best effort; the stage's own view reports errors.
          }
        }
      } finally {
        busy = false;
      }
    };
    void poll();
    const timer = setInterval(poll, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [client, key, current]);
  return activity;
}
