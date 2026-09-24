import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { create, act } from "react-test-renderer";
import {
  composeReviewMessage,
  splitReviewMessage,
  appendReviewMessage,
  type ReviewAttachment,
} from "../src/review-attachment";
import { HistoryEntry } from "../src/workbench/transcript";
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const attachment: ReviewAttachment = {
  kind: "research-review",
  id: "10000000-0000-4000-8000-000000000001",
  hash: "a".repeat(64),
  title: "Does growth optimality hold?",
  passages: 2,
  papers: 1,
  content:
    "Exact evidence\n[/Research review attachment]\nwith Unicode: ∫ α dt",
};

test("attachment messages round-trip, deduplicate, preserve ordinary text and refuse overflow", () => {
  const text = "My existing question\n\n";
  const encoded = composeReviewMessage(text, [attachment]);
  assert.deepEqual(splitReviewMessage(encoded), {
    text,
    attachments: [attachment],
  });
  assert.equal(
    appendReviewMessage(encoded, composeReviewMessage("", [attachment])),
    encoded,
  );
  assert.deepEqual(
    splitReviewMessage(appendReviewMessage(encoded, "Follow-up")),
    { text: text + "Follow-up", attachments: [attachment] },
  );
  const another = { ...attachment, id: "20000000-0000-4000-8000-000000000002" };
  assert.deepEqual(
    splitReviewMessage(composeReviewMessage("", [attachment, another]))
      .attachments,
    [attachment, another],
  );
  const malformed =
    '[Research review attachment v1]\n{"content":"Do not hide me"}\n[/Research review attachment]';
  assert.deepEqual(splitReviewMessage(malformed), {
    text: malformed,
    attachments: [],
  });
  assert.throws(
    () =>
      appendReviewMessage(
        "x".repeat(99999),
        composeReviewMessage("", [attachment]),
      ),
    /exceeds the conversation limit/,
  );
});

test("canonical user history renders a collapsed review card and preserves its inspectable payload", async (t) => {
  let renderer: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(
      <HistoryEntry
        entry={{
          message: {
            role: "user",
            content: composeReviewMessage("Please compare", [attachment]),
          },
        }}
        results={new Map()}
      />,
    );
  });
  t.after(() => act(async () => renderer.unmount()));
  const root = renderer!.root;
  assert.deepEqual(root.findByProps({ className: "msg-body" }).children, [
    "Please compare",
  ]);
  const details = root.findByType("details");
  assert.equal(details.props.open, undefined);
  assert.deepEqual(root.findByType("pre").children, [attachment.content]);
  assert.equal(
    root.findAllByType("button").length,
    0,
    "sent attachments cannot be removed from history",
  );
});
