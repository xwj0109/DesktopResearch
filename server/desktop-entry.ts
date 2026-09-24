import { bootSchema, shutdownSchema } from "../desktop/contracts.ts";
import { startLabService } from "./lifecycle.ts";
if (!process.send || !process.connected)
  throw new Error("Desktop backend requires private parent IPC");
let service: Awaited<ReturnType<typeof startLabService>> | undefined;
let starting: Promise<void> | undefined, stopping: Promise<void> | undefined;
let booted = false;
const send = (message: object) => {
  if (process.connected) process.send!(message);
};
const stop = () =>
  (stopping ??= (async () => {
    await starting?.catch(() => {});
    try {
      await service?.close();
      send({ version: 1, type: "closed" });
      process.exit(0);
    } catch {
      send({
        version: 1,
        type: "fatal",
        message:
          "Backend cleanup completed with durability errors; inspect retained receipts before further writes.",
      });
      process.exit(1);
    }
    // Only actual exit releases Store's process-wide durability ownership.
  })());
const timer = setTimeout(() => void stop(), 15000);
timer.unref();
process.on("message", (message) => {
  if (shutdownSchema.safeParse(message).success) {
    void stop();
    return;
  }
  const boot = bootSchema.safeParse(message);
  if (booted || stopping || !boot.success) {
    send({
      version: 1,
      type: "fatal",
      message: "Invalid desktop lifecycle protocol",
    });
    void stop();
    return;
  }
  booted = true;
  clearTimeout(timer);
  starting = (async () => {
    service = await startLabService(boot.data);
    if (!stopping && process.connected)
      send({
        version: 1,
        type: "ready",
        origin: service.origin,
        rootToken: service.rootToken,
      });
  })();
  void starting.catch(() => {
    send({
      version: 1,
      type: "fatal",
      message:
        "Backend initialization failed; check storage ownership and built assets. Never delete live writer locks.",
    });
    void stop();
  });
});
process.once("disconnect", () => void stop());
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => void stop());
