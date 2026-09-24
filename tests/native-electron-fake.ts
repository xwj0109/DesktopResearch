// Authored Electron facade: tests validate shell orchestration, not native rendering.
import { EventEmitter } from "node:events";
export const calls: {
  profiles: string[];
  windows: BrowserWindow[];
  errors: string[];
  confirmations: number[];
} = { profiles: [], windows: [], errors: [], confirmations: [] };
export const ipcMain = new EventEmitter() as EventEmitter & {
  handlers: Map<string, Function>;
  handle: (name: string, fn: Function) => void;
};
ipcMain.handlers = new Map();
ipcMain.handle = (name, fn) => {
  ipcMain.handlers.set(name, fn);
};
class FakeSession extends EventEmitter {
  protocol = {
    handlers: new Map<string, Function>(),
    handle: (name: string, fn: Function) =>
      this.protocol.handlers.set(name, fn),
  };
  permissions: Function[] = [];
  webRequest = {
    onBeforeRequest: (fn: Function) => {
      this.requestFilter = fn;
    },
  };
  requestFilter?: Function;
  setPermissionCheckHandler(fn: Function) {
    this.permissions.push(fn);
  }
  setPermissionRequestHandler(fn: Function) {
    this.permissions.push(fn);
  }
  setDevicePermissionHandler(fn: Function) {
    this.permissions.push(fn);
  }
  flushStorageData() {}
}
export const session = {
  fromPath: (path: string) => {
    calls.profiles.push(path);
    return new FakeSession();
  },
};
export const screen = {
  getAllDisplays: () => [
    { workArea: { x: 0, y: 0, width: 1440, height: 900 } },
  ],
};
export const dialog = {
  showErrorBox: (title: string) => calls.errors.push(title),
  showMessageBox: async () => ({ response: calls.confirmations.shift() ?? 0 }),
};
let nextId = 1;
export class BrowserWindow extends EventEmitter {
  destroyed = false;
  shown = 0;
  focused = 0;
  minimized = false;
  options: any;
  onPrepare?: () => Promise<void>;
  prepareCount = 0;
  cancelledCount = 0;
  sent: [string, unknown][] = [];
  webContents: any;
  constructor(options: any) {
    super();
    this.options = options;
    const web: any = new EventEmitter();
    Object.assign(web, {
      id: nextId++,
      session: options.webPreferences.session,
      mainFrame: { url: "" },
      isDestroyed: () => this.destroyed,
      setWindowOpenHandler: (fn: Function) => {
        web.openHandler = fn;
      },
      send: async (channel: string, nonce: string) => {
        this.sent.push([channel, nonce]);
        if (channel === "pi-research:close-cancelled") this.cancelledCount++;
        if (channel === "pi-research:prepare-close") {
          this.prepareCount++;
          try {
            await this.onPrepare?.();
            ipcMain.emit(
              "pi-research:prepared",
              { sender: web, senderFrame: web.mainFrame },
              { nonce, ok: true },
            );
          } catch {
            ipcMain.emit(
              "pi-research:prepared",
              { sender: web, senderFrame: web.mainFrame },
              { nonce, ok: false },
            );
          }
        }
      },
    });
    this.webContents = web;
    calls.windows.push(this);
  }
  async loadURL(url: string) {
    this.webContents.mainFrame.url = url;
    await ipcMain.handlers.get("pi-research:view-status")!(
      { sender: this.webContents, senderFrame: this.webContents.mainFrame },
      "ready",
    );
  }
  isDestroyed() {
    return this.destroyed;
  }
  isMinimized() {
    return this.minimized;
  }
  restore() {
    this.minimized = false;
  }
  show() {
    this.shown++;
  }
  focus() {
    this.focused++;
  }
  maximize() {}
  isMaximized() {
    return false;
  }
  getNormalBounds() {
    return { x: 0, y: 0, width: 1280, height: 800 };
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("closed");
  }
}
export async function invoke(
  window: BrowserWindow,
  channel: string,
  input?: unknown,
  proof: any = {},
) {
  return ipcMain.handlers.get(channel)!(
    {
      sender: window.webContents,
      senderFrame: window.webContents.mainFrame,
      ...proof,
    },
    input,
  );
}
