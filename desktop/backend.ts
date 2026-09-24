import { spawn } from "node:child_process";
import { childSchema } from "./contracts.ts";
import { cleanEnvironment } from "./config.ts";
export interface BackendOptions {
  node: string;
  pi: string;
  root: string;
  assets: string;
  entry: string;
  handoffLauncher: string;
  startupTimeout?: number;
  shutdownNoticeTimeout?: number;
  onBlocked?: (message: string) => void;
}
export async function launchBackend(options: BackendOptions) {
  const child = spawn(options.node, [options.entry], {
    shell: false,
    cwd: options.root,
    env: {
      ...cleanEnvironment(),
      LAB_PI_NODE: options.node,
      LAB_PI_EXECUTABLE: options.pi,
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    // Lifecycle messages cross Electron/system-Node V8 versions. Use portable JSON.
    serialization: "json",
  });
  let exited = false,
    ready = false,
    stopping: Promise<void> | undefined;
  let rejectReady: (reason: Error) => void = () => {};
  const actualExit = new Promise<void>((resolve) => {
    child.once("close", () => {
      exited = true;
      rejectReady(new Error("Backend exited before ready"));
      resolve();
    });
  });
  // Drain but never forward backend diagnostics/capabilities to renderer/logs.
  child.stdout?.resume();
  child.stderr?.resume();
  child.on("error", () =>
    rejectReady(new Error("System Node backend could not start")),
  );
  const stop = () =>
    (stopping ??= (async () => {
      if (exited) return;
      if (child.connected)
        child.send({ version: 1, type: "shutdown" }, () => {});
      else child.kill("SIGTERM");
      // Keep the actual-exit barrier, but surface a bounded blocked state to main.
      const notice = setTimeout(
        () =>
          options.onBlocked?.(
            "Backend shutdown is blocked. Ownership remains held; do not restart or delete writer locks.",
          ),
        options.shutdownNoticeTimeout ?? 10000,
      );
      try {
        await actualExit;
      } finally {
        clearTimeout(notice);
      }
    })());
  try {
    const credentials = await new Promise<{
      origin: string;
      rootToken: string;
    }>((resolve, reject) => {
      rejectReady = reject;
      const timer = setTimeout(
        () => reject(new Error("Backend readiness timed out")),
        options.startupTimeout ?? 20000,
      );
      void actualExit.then(() => clearTimeout(timer));
      child.on("message", (message) => {
        const parsed = childSchema.safeParse(message);
        if (!parsed.success) {
          clearTimeout(timer);
          reject(new Error("Invalid backend protocol"));
          void stop();
          return;
        }
        if (parsed.data.type === "ready") {
          if (ready) {
            void stop();
            return;
          }
          ready = true;
          clearTimeout(timer);
          resolve(parsed.data);
        } else if (parsed.data.type === "fatal") {
          clearTimeout(timer);
          reject(new Error(parsed.data.message));
          void stop();
        }
        // closed is advisory only. actualExit is the ownership reuse barrier.
      });
      child.send(
        {
          version: 1,
          type: "boot",
          root: options.root,
          assets: options.assets,
          executable: options.pi,
          handoffLauncher: options.handoffLauncher,
        },
        (error) => {
          if (error) reject(new Error("Backend boot channel failed"));
        },
      );
    });
    return { ...credentials, stop, actualExit, pid: child.pid! };
  } catch (error) {
    options.onBlocked?.(
      error instanceof Error ? error.message : "Backend startup failed",
    );
    await stop();
    throw error;
  }
}
export type Backend = Awaited<ReturnType<typeof launchBackend>>;
/** Quit requested during boot must join readiness/cleanup before inspecting its owner. */
export async function shutdownAfterStartup(
  starting: Promise<Pick<Backend, "stop">> | undefined,
  prepare: () => Promise<boolean>,
) {
  const owned = await starting?.catch(() => undefined);
  if (!(await prepare())) return false;
  await owned?.stop();
  return true;
}
