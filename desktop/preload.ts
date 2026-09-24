import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { DesktopBridge } from "./contracts.ts";
const channels = {
  exportFile: "pi-research:export-file",
  requests: "pi-research:requests",
  bootstrap: "pi-research:bootstrap",
  lab: "pi-research:lab",
  open: "pi-research:open",
  launcher: "pi-research:launcher",
  status: "pi-research:view-status",
  readView: "pi-research:read-view",
  saveView: "pi-research:save-view",
  prepare: "pi-research:prepare-close",
  prepared: "pi-research:prepared",
  cancelled: "pi-research:close-cancelled",
  readTheme: "pi-research:read-theme",
  saveTheme: "pi-research:save-theme",
  themeChanged: "pi-research:theme-changed",
  fetchPaper: "pi-research:fetch-paper",
  searchPapers: "pi-research:search-papers",
  terminalOpen: "pi-research:terminal-open",
  terminalRestart: "pi-research:terminal-restart",
  terminalInput: "pi-research:terminal-input",
  terminalResize: "pi-research:terminal-resize",
  terminalEvent: "pi-research:terminal-event",
  terminalTranscript: "pi-research:terminal-transcript",
  terminalHandoff: "pi-research:terminal-handoff",
} as const;
// Fixed channels only. No invoke/channel, filesystem, Node or arbitrary URL proxy exposed.
const bridge: DesktopBridge = {
  integratedTitlebar: process.platform === "darwin",
  exportFile: (value) => ipcRenderer.invoke(channels.exportFile, value),
  readRequests: () => ipcRenderer.invoke(channels.requests),
  bootstrap: () => ipcRenderer.invoke(channels.bootstrap),
  lab: (request) => ipcRenderer.invoke(channels.lab, request),
  openWorkspace: (scope) => ipcRenderer.invoke(channels.open, scope),
  focusLauncher: () => ipcRenderer.invoke(channels.launcher),
  reportViewStatus: (status) => ipcRenderer.invoke(channels.status, status),
  readView: () => ipcRenderer.invoke(channels.readView),
  saveView: (state) => ipcRenderer.invoke(channels.saveView, state),
  readTheme: () => ipcRenderer.invoke(channels.readTheme),
  fetchPaper: (source) => ipcRenderer.invoke(channels.fetchPaper, source),
  searchPapers: (text) => ipcRenderer.invoke(channels.searchPapers, text),
  terminalOpen: (stage, cols, rows) => ipcRenderer.invoke(channels.terminalOpen, { stage, cols, rows }),
  pathForFile: (file) => webUtils.getPathForFile(file),
  terminalTranscript: (stage, since) => ipcRenderer.invoke(channels.terminalTranscript, { stage, since }),
  terminalHandoff: (stage) => ipcRenderer.invoke(channels.terminalHandoff, { stage }),
  terminalRestart: (stage, cols, rows) => ipcRenderer.invoke(channels.terminalRestart, { stage, cols, rows }),
  terminalInput: (stage, data) => ipcRenderer.send(channels.terminalInput, { stage, data }),
  terminalResize: (stage, cols, rows) => ipcRenderer.send(channels.terminalResize, { stage, cols, rows }),
  onTerminal: (handler) => {
    const listener = (_event: Electron.IpcRendererEvent, value: unknown) => {
      const v = value as { stage?: unknown; type?: unknown; data?: unknown; code?: unknown };
      if (typeof v?.stage !== "string") return;
      if (v.type === "output" && typeof v.data === "string") handler({ stage: v.stage, type: "output", data: v.data });
      else if (v.type === "exit" && typeof v.code === "number") handler({ stage: v.stage, type: "exit", code: v.code });
    };
    ipcRenderer.on(channels.terminalEvent, listener);
    return () => ipcRenderer.removeListener(channels.terminalEvent, listener);
  },
  saveTheme: (theme) => ipcRenderer.invoke(channels.saveTheme, theme),
  onThemeChanged: (handler) => {
    const listener = (_event: Electron.IpcRendererEvent, theme: unknown) => {
      if (typeof theme === "string" && /^[a-z0-9-]{1,40}$/.test(theme)) handler(theme);
    };
    ipcRenderer.on(channels.themeChanged, listener);
    return () => ipcRenderer.removeListener(channels.themeChanged, listener);
  },
  onCloseCancelled: (handler) => {
    const listener = () => handler();
    ipcRenderer.on(channels.cancelled, listener);
    return () => ipcRenderer.removeListener(channels.cancelled, listener);
  },
  onPrepareClose: (handler) => {
    const listener = async (
      _event: Electron.IpcRendererEvent,
      nonce: unknown,
    ) => {
      if (typeof nonce !== "string" || !/^[a-f0-9]{32}$/.test(nonce)) return;
      try {
        await handler();
        ipcRenderer.send(channels.prepared, { nonce, ok: true });
      } catch {
        ipcRenderer.send(channels.prepared, { nonce, ok: false });
      }
    };
    ipcRenderer.on(channels.prepare, listener);
    return () => ipcRenderer.removeListener(channels.prepare, listener);
  },
};
contextBridge.exposeInMainWorld("piResearchDesktop", Object.freeze(bridge));
