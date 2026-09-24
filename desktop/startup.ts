/** Quit-before-ready must prevent work, not merely wait on a nonexistent launch promise. */
export class StartupGate {
  private closing = false;
  requestQuit() {
    this.closing = true;
  }
  cancelQuit() {
    this.closing = false;
  }
  get mayStart() {
    return !this.closing;
  }
  launch<T>(start: () => T): T | undefined {
    if (this.closing) return undefined;
    return start();
  }
}
