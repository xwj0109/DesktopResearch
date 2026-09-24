import { app, protocol, dialog, Menu, BrowserWindow } from "electron";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { prospectiveRealpath } from "../server/lifecycle.ts";
import { desktopConfig, selectedRoot } from "./config.ts";
import {
  launchBackend,
  shutdownAfterStartup,
  type Backend,
} from "./backend.ts";
import { Windows } from "./windows.ts";
import { diagnostics } from "./diagnostics.ts";
import { StartupGate } from "./startup.ts";
import { assetHeaders } from "./protocol.ts";

protocol.registerSchemesAsPrivileged([
  {
    scheme: "pi-research",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);
app.setName("Pi Research");
const productData = path.join(app.getPath("appData"), "Pi Research");
const researchDataRoot = path.join(app.getPath("home"), "Pi Research Data");
let profileFailure = false;
try {
  if (fs.existsSync(productData) && fs.lstatSync(productData).isSymbolicLink())
    throw new Error("Unsafe product profile");
  fs.mkdirSync(productData, { recursive: true, mode: 0o700 });
  app.setPath("userData", productData);
} catch {
  profileFailure = true;
  console.error("Pi Research product profile unavailable");
}
let record: (code: string) => void = () => {};
try {
  if (!profileFailure)
    record = diagnostics(path.join(productData, "diagnostics"));
} catch {
  console.error("Pi Research diagnostics unavailable");
}
const diagnose = (code: string) => {
  try {
    record(code);
  } catch {
    console.error("Pi Research diagnostic write failed");
  }
};
const gate = new StartupGate();
let backend: Backend | undefined,
  launching: Promise<Backend> | undefined,
  windows: Windows | undefined;
let activeRoot: string | undefined;
let quitting = false,
  quitPending = false,
  status: BrowserWindow | undefined,
  statusClosing = false;
const acquired = app.requestSingleInstanceLock();
if (!acquired) {
  gate.requestQuit();
  quitting = true;
  app.quit();
}
app.on("second-instance", (_event, argv) => {
  if (quitPending || quitting) return;
  try {
    if (
      !activeRoot ||
      prospectiveRealpath(
        selectedRoot(argv, researchDataRoot),
      ) !== activeRoot
    )
      throw new Error("Different root");
    void windows?.focusLauncher().catch(() => diagnose("focus-failed"));
  } catch {
    dialog.showErrorBox(
      "Pi Research already running",
      "An existing instance owns another root or is still starting. Quit it normally before opening this root. No requested workspace was opened.",
    );
  }
});
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => app.quit());
app.on("before-quit", (event) => {
  if (quitting) return;
  event.preventDefault();
  if (quitPending) return;
  quitPending = true;
  gate.requestQuit();
  diagnose("quit-requested");
  void shutdownAfterStartup(launching, async () =>
    windows ? windows.prepareQuit() : true,
  )
    .then((stopped) => {
      if (!stopped) {
        quitPending = false;
        gate.cancelQuit();
        diagnose("quit-cancelled");
        return;
      }
      diagnose("backend-exit-barrier-passed");
      quitting = true;
      windows?.destroy();
      statusClosing = true;
      status?.destroy();
      app.quit();
    })
    .catch(() => {
      quitPending = false;
      diagnose("shutdown-blocked");
      dialog.showErrorBox(
        "Pi Research shutdown blocked",
        "The owned backend has not exited. Do not restart or remove writer locks.",
      );
    });
});
app.on("window-all-closed", () => {
  if (!statusClosing && !quitting) app.quit();
});
app.on("activate", () => {
  if (gate.mayStart)
    void windows?.focusLauncher().catch(() => diagnose("focus-failed"));
});

// No top-level await: Electron must finish evaluating the entry module before ready.
void app.whenReady().then(async () => {
  if (!gate.mayStart || !acquired) return;
  diagnose("app-ready");
  // A real visible native status surface, not a silent/modal-only startup failure.
  protocol.handle("pi-research", (request) => {
    if (
      request.method !== "GET" ||
      !["pi-research://app/startup", "pi-research://app/failure"].includes(
        request.url,
      )
    )
      return new Response(null, { status: 403 });
    const failed = request.url.endsWith("/failure");
    return new Response(
      `<!doctype html><html><head><meta charset="utf-8"><title>Pi Research</title></head><body style="font:16px system-ui;background:#f7f8f5;color:#29332d;padding:44px"><h1>Pi Research</h1><h2>${failed ? "Desktop startup failed" : "Opening your research workbench…"}</h2><p>${failed ? "No action was replayed. Check the startup error dialog and private startup diagnostics. Quit before retrying; never delete live writer locks." : "Validating installed system Node/Pi and opening the owned local service. Pi is not being connected."}</p><p>Close this window or use Pi Research → Quit to exit safely.</p></body></html>`,
      {
        headers: {
          ...assetHeaders,
          "Content-Type": "text/html; charset=utf-8",
        },
      },
    );
  });
  try {
    status = new BrowserWindow({
      width: 700,
      height: 380,
      title: "Pi Research",
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        webviewTag: false,
      },
    });
    status.webContents.session.setPermissionCheckHandler(() => false);
    status.webContents.session.setPermissionRequestHandler((_w, _p, done) =>
      done(false),
    );
    status.webContents.session.setDevicePermissionHandler(() => false);
    status.webContents.session.on("will-download", (e) => e.preventDefault());
    status.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    status.webContents.on("will-navigate", (e) => e.preventDefault());
    status.webContents.on("will-redirect", (e) => e.preventDefault());
    status.webContents.on("will-attach-webview", (e) => e.preventDefault());
    status.on("close", (e) => {
      if (!quitting && !statusClosing) {
        e.preventDefault();
        app.quit();
      }
    });
    await status.loadURL("pi-research://app/startup");
    if (!gate.mayStart) return;
    if (profileFailure) throw new Error("Product profile unavailable");
    const root = fileURLToPath(new URL("../", import.meta.url));
    const config = desktopConfig(
      process.argv,
      path.join(root, "dist"),
      process.env,
      researchDataRoot,
    );
    activeRoot = config.root;
    diagnose("config-validated");
    launching = gate.launch(() =>
      launchBackend({
        ...config,
        entry: path.join(root, "backend/desktop-entry.mjs"),
        handoffLauncher: path.join(root, "scripts/desktop-pi-handoff.mjs"),
        onBlocked: () => {
          diagnose("backend-blocked");
          // Do not block the main event loop: it still needs to observe backend
          // exit and complete a quit that is already in progress.
          void dialog.showMessageBox({
            type: "warning",
            title: quitPending ? "Pi Research is still closing" : "Pi Research startup blocked",
            message: quitPending ? "The backend is taking longer than expected to stop." : "The backend could not finish starting.",
            detail: quitPending
              ? "The app will close automatically when cleanup finishes. You do not need to quit again."
              : "Quit the app before retrying. Do not remove writer locks.",
            buttons: ["OK"],
          }).catch(() => diagnose("backend-notice-failed"));
        },
      }),
    );
    if (!launching) return;
    diagnose("backend-spawned");
    backend = await launching;
    diagnose("backend-ready");
    if (!gate.mayStart) {
      await backend.stop();
      return;
    }
    windows = new Windows(
      {
        ...config,
        preload: path.join(root, "desktop/preload.cjs"),
        diagnose,
        ptyModule: path.join(root, "backend/pty.cjs"),
        piExtension: path.join(root, "backend/pi-research-extension.mjs"),
      },
      backend,
    );
    void backend.actualExit.then(() => {
      if (!quitPending && !quitting) {
        diagnose("backend-unexpected-exit");
        dialog.showErrorBox(
          "Pi Research service stopped",
          "The owned service exited. No operation was replayed. Quit before restarting.",
        );
        app.quit();
      }
    });
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: app.name,
          submenu: [
            { role: "about" },
            {
              label: "Workspace launcher",
              click: () =>
                void windows
                  ?.focusLauncher()
                  .catch(() => diagnose("focus-failed")),
            },
            { type: "separator" },
            { role: "quit" },
          ],
        },
        {
          label: "Edit",
          submenu: [
            { role: "undo" },
            { role: "redo" },
            { type: "separator" },
            { role: "cut" },
            { role: "copy" },
            { role: "paste" },
            { role: "selectAll" },
          ],
        },
        {
          label: "View",
          submenu: [
            { role: "resetZoom" },
            { role: "zoomIn" },
            { role: "zoomOut" },
            { role: "togglefullscreen" },
          ],
        },
        {
          label: "Window",
          submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "close" }],
        },
      ]),
    );
    await windows.restore();
    if (!gate.mayStart) return;
    statusClosing = true;
    status.destroy();
    status = undefined;
    statusClosing = false;
    diagnose("workbench-ready");
  } catch (error) {
    diagnose("startup-failed");
    if (!quitting && !quitPending) {
      if (status && !status.isDestroyed())
        await status
          .loadURL("pi-research://app/failure")
          .catch(() => diagnose("status-load-failed"));
      dialog.showErrorBox(
        "Pi Research cannot start",
        "Desktop startup failed. Select an installed system Node >=22.19 with LAB_PI_NODE and installed Pi with LAB_PI_EXECUTABLE; invalid configured paths never fall back. Use a separate absolute data root outside legacy/Projects/package directories. Check storage ownership and built assets. Never delete live locks.",
      );
    }
    await backend?.stop();
    // Remain visibly failed until the user quits, unless quit was already requested.
  }
});
