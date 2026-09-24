/** Transient app-owned CLI extension. Normal tools/resources remain enabled.
 * Managed handoff stays on its exact canonical file; leave the CLI to change ownership.
 */
export default function managedHandoffGuard(pi) {
  const refuse = (_event, ctx) => {
    try { ctx.ui.notify("Managed Herdr handoff is locked to this canonical session. Exit this CLI before New, Resume, Fork or Import; unmanaged writers bypass ownership protection.", "error"); } catch { /* a UI error must not turn cancellation into approval */ }
    return { cancel: true };
  };
  pi.on("session_before_switch", refuse);
  pi.on("session_before_fork", refuse);
}
