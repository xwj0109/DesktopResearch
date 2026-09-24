import type { DesktopBridge } from "../desktop/contracts";
import { faultSource } from "./view-fault";
declare global {
  interface Window {
    piResearchDesktop?: DesktopBridge;
  }
}
async function start() {
  const bridge = window.piResearchDesktop;
  const root = document.getElementById("root")!;
  if (bridge) {
    // An error that leaves the view empty (startup, or a React render crash,
    // which unmounts the root) means the view failed. A stray error in a
    // callback while the view keeps working is recorded, not a stop.
    const failed = (fault: "error" | "rejection", where: string) =>
      setTimeout(() => {
        const empty = !root.firstElementChild;
        void bridge.reportViewStatus(empty ? "failed" : { fault, source: faultSource(where) }).catch(() => {});
      }, 0);
    window.addEventListener("error", (e) => failed("error", `${e.filename ?? ""}\n${e.error?.stack ?? ""}`));
    window.addEventListener("unhandledrejection", (e) => failed("rejection", String(e.reason?.stack ?? "")));
    // The main process already selected canonical-root/scope profile. Get identity
    // and drafts before importing any workspace UI or initializing view state.
    let flush = async () => {};
    bridge.onPrepareClose(() => flush());
    const context = await bridge.bootstrap();
    const initial = await bridge.readView();
    // App-wide theme lives in main; read it before first paint.
    const theme = (await bridge.readTheme?.().catch(() => null)) ?? null;
    const [{ createRoot }, { createElement }, { NativeApp, ViewWriter }] =
      await Promise.all([
        import("react-dom/client"),
        import("react"),
        import("./native"),
      ]);
    const writer = new ViewWriter(bridge);
    flush = () => writer.prepare();
    bridge.onCloseCancelled(writer.cancel);
    createRoot(root).render(
      createElement(NativeApp, { bridge, context, initial, writer, theme }),
    );
  } else if (
    new URLSearchParams(location.search).get("design-preview") === "1"
  ) {
    const [{ createRoot }, { createElement }, { Workbench }, { previewData }] =
      await Promise.all([
        import("react-dom/client"),
        import("react"),
        import("./workbench/Workbench"),
        import("./workbench/fixtures"),
      ]);
    createRoot(root).render(createElement(Workbench, { data: previewData }));
  } else {
    root.textContent =
      "Pi Research browser development server. Open ?design-preview=1 for explicitly synthetic design fixtures. This is not desktop delivery.";
  }
}
import "./workbench/styles.css";
void start().catch(() => {
  void window.piResearchDesktop?.reportViewStatus("failed").catch(() => {});
  document.getElementById("root")!.textContent =
    "Pi Research view could not initialize. Saved drafts were not replaced. Quit and reopen the desktop; no action was replayed.";
});
