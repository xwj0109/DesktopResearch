// TEST ONLY. Never imported or selected by runtime configuration.
import { StringDecoder } from "node:string_decoder";
if (process.argv.includes("--stubborn")) process.on("SIGTERM", () => {});
const decoder = new StringDecoder("utf8");
let buffer = "";
const send = (x) => process.stdout.write(JSON.stringify(x) + "\n");
process.stdin.on("data", (bytes) => {
  buffer += decoder.write(bytes);
  let pos;
  while ((pos = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, pos);
    buffer = buffer.slice(pos + 1);
    const r = JSON.parse(line);
    const ack = (data) =>
      send({
        type: "response",
        id: r.id,
        command: r.type,
        success: true,
        data,
      });
    if (r.type === "no_reply") continue;
    if (r.type === "exit") process.exit(2);
    if (r.type === "null") {
      send(null);
      continue;
    }
    if (r.type === "scalar") {
      send(42);
      continue;
    }
    if (r.type === "missing_success") {
      send({ type: "response", id: r.id, command: r.type });
      continue;
    }
    if (r.type === "string_success") {
      send({ type: "response", id: r.id, command: r.type, success: "true" });
      continue;
    }
    if (r.type === "wrong_command") {
      send({ type: "response", id: r.id, command: "prompt", success: true });
      continue;
    }
    if (r.type === "bad_frame") {
      process.stdout.write("bad JSON\n");
      continue;
    }
    if (r.type === "big_frame") {
      process.stdout.write("x".repeat(1024 * 1024 + 1));
      continue;
    }
    if (r.type === "unicode") {
      const b = Buffer.from(
        JSON.stringify({
          type: "response",
          id: r.id,
          command: r.type,
          success: true,
          data: { text: "雪\u2028line\u2029end" },
        }) + "\n",
      );
      for (let i = 0; i < b.length; i++)
        process.stdout.write(b.subarray(i, i + 1));
      continue;
    }
    if (r.type === "get_state") {
      if (process.argv.includes("--slow-handshake"))
        setTimeout(() => ack({ isStreaming: false }), 80);
      else ack({ isStreaming: false });
      continue;
    }
    if (r.type === "get_available_models") {
      ack({
        models: [
          {
            provider: "test-only",
            id: "fixture",
            name: "Explicit test fixture",
          },
        ],
      });
      continue;
    }
    if (r.type === "prompt") {
      if (r.message.includes("[INVALID_ACK]")) {
        send({ type: "response", id: r.id, command: r.type, success: "true" });
        continue;
      }
      if (r.message.includes("[REJECT]")) {
        send({
          type: "response",
          id: r.id,
          command: r.type,
          success: false,
          error: "Rejected by deterministic fixture",
        });
        continue;
      }
      if (r.message.includes("[EXIT]")) {
        ack({});
        setTimeout(() => process.exit(3), 20);
        continue;
      }
      ack({});
      ack({}); // duplicate ACK must be harmless
      setTimeout(
        () => {
          send({ type: "agent_start" });
          const end = {
            type: "message_end",
            message: {
              id: r.id,
              role: "assistant",
              stopReason: r.message.includes("[FAIL]") ? "error" : "stop",
              errorMessage: r.message.includes("[FAIL]")
                ? "Fixture provider error"
                : undefined,
              content: r.message.includes("[EMPTY]")
                ? []
                : [
                    {
                      type: "text",
                      text: "Fixture response, not real inference.",
                    },
                  ],
            },
          };
          send(end);
          if (r.message.includes("[DUPLICATE]")) send(end);
          send({ type: "agent_settled" });
        },
        r.message.includes("[SLOW]") ? 180 : 30,
      );
      continue;
    }
    ack({});
  }
});
