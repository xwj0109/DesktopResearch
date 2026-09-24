/** Node --import preload: no installed CLI/session/resource module runs until
 * its actual PID has been durably leased by the managed launcher. */
const nonce = process.env.HERDR_PI_ACTIVATE_NONCE;
delete process.env.HERDR_PI_ACTIVATE_NONCE;
if (!nonce || !process.send || !process.connected) throw new Error("Managed CLI activation owner unavailable");
await new Promise((resolve, reject) => {
  const finish = error => {
    clearTimeout(timer);
    process.off("message", activate); process.off("disconnect", disconnected);
    error ? reject(error) : resolve();
  };
  const activate = message => { if (message?.type === "herdr_activate_writer" && message.nonce === nonce) finish(); };
  const disconnected = () => finish(new Error("Managed launcher exited before writer activation"));
  const timer = setTimeout(() => finish(new Error("Managed CLI activation timed out")), 15000);
  process.on("message", activate); process.once("disconnect", disconnected);
  process.send({ type: "herdr_writer_waiting", nonce }, error => { if (error) finish(error); });
});
// Do not keep an otherwise-finished CLI alive merely for this control channel.
process.channel?.unref();
