/** SDK owns delivery. This adapter keeps image payloads for editor recovery,
 * without replaying messages or implementing its own scheduling. */
export class RuntimeQueue {
  constructor(getSession) {
    this.getSession = getSession;
    this.pending = { steer: [], followUp: [] };
    this.sessionId = null;
  }
  sync() {
    const session = this.getSession();
    if (this.sessionId !== session.sessionId) {
      this.pending = { steer: [], followUp: [] };
      this.sessionId = session.sessionId;
    }
    for (const [kind, method] of [
      ["steer", "getSteeringMessages"],
      ["followUp", "getFollowUpMessages"],
    ]) {
      const previous = [...this.pending[kind]];
      // The SDK consumes oldest matches first. Match from the tail so duplicate
      // text cannot give a remaining message the images of a delivered one.
      this.pending[kind] = [...(session[method]?.() ?? [])].reverse().map((message) => {
        const at = previous.findLastIndex((item) => item.message === message);
        return at < 0 ? { message } : previous.splice(at, 1)[0];
      }).reverse();
    }
    return this.pending;
  }
  async submit({ message, behavior, images = [] }) {
    const session = this.getSession();
    if (!session.isStreaming)
      throw new Error(
        "The turn has finished; send this draft as a new message.",
      );
    if (
      !["steer", "followUp"].includes(behavior) ||
      typeof session[behavior] !== "function"
    )
      throw new Error("Installed runtime does not support this queue");
    if (
      typeof message !== "string" ||
      !message.trim() ||
      message.length > 100000
    )
      throw new Error("Invalid queued message");
    this.sync();
    const items = [...this.pending.steer, ...this.pending.followUp];
    if (
      items.length >= 8 ||
      Buffer.byteLength(JSON.stringify([...items, { message, images }])) >
        700_000
    )
      throw new Error(
        "Pending input limit reached; wait for delivery or retrieve queued messages.",
      );
    const read = () => behavior === "steer" ? session.getSteeringMessages() : session.getFollowUpMessages();
    const count = read().length;
    // Pi's public async methods synchronously expand and enqueue, then resolve.
    // Capture that addition before yielding to a polling snapshot or delivery.
    const accepted = session[behavior](message, images.map(image => ({ ...image, type: "image" })));
    const texts = read();
    if (texts.length > count) {
      this.pending[behavior] = this.pending[behavior].slice(0, count);
      this.pending[behavior].push({ message: texts.at(-1), ...(images.length ? { images } : {}) });
    }
    await accepted;
    this.sync();
  }
  snapshot() {
    this.sync();
    return {
      steering: this.pending.steer.map((item) => item.message),
      followUp: this.pending.followUp.map((item) => item.message),
    };
  }
  retrieve() {
    this.sync();
    const queue = [...this.pending.steer, ...this.pending.followUp];
    if (typeof this.getSession().clearQueue !== "function" && queue.length)
      throw new Error("Installed runtime cannot retrieve queued messages");
    this.getSession().clearQueue?.();
    this.pending = { steer: [], followUp: [] };
    return { queue };
  }
}
