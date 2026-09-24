import { appendReviewMessage } from "../src/review-attachment";
import test from "node:test";
import assert from "node:assert/strict";
import React, { useState } from "react";
import { create, act } from "react-test-renderer";
import { ResearchProvider } from "../src/workbench/research";
import { ReviewPane, reviewStatus } from "../src/workbench/panes/ReviewPane";
import { reviewPrompt } from "../src/review-format";
import { researchRequest } from "../desktop/research-routes.ts";
import { researchDTO } from "../desktop/protocol.ts";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const id = "10000000-0000-4000-8000-000000000001";
const paper = { id, name: "Growth optimality.pdf", hash: "a".repeat(64) };
const note = {
  id: "20000000-0000-4000-8000-000000000002",
  artifactId: id,
  anchor: { page: 2, quote: "Growth optimality needs additional assumptions." },
  comment: "Compare the drawdown condition",
};
const batch: any = {
  id: "30000000-0000-4000-8000-000000000003",
  hash: "b".repeat(64),
  instruction: "Does this generalize?",
  destination: "Ideas",
  status: "draft",
  created: "2026-09-24T01:00:00Z",
  annotations: [note],
  documents: [paper],
  prompt: "EXACT SNAPSHOT",
  response: "",
};
const text = (node: any): string =>
  typeof node === "string" ? node : (node.children ?? []).map(text).join("");

test("review preparation, filtering and handoff preserve the existing conversation draft", async (t) => {
  let composer = "Existing unsent question",
    writes: any[] = [];
  let renderer: ReturnType<typeof create>;
  function Harness() {
    const [picked, setPicked] = useState<string[]>([]),
      [instruction, setInstruction] = useState("");
    const [batches, setBatches] = useState<any[]>([]);
    const scope: any = {
      view: { revision: 4, artifacts: [paper], annotations: [note], batches },
      stage: "ideas",
      drafts: {},
      setDraft() {},
      refresh: async () => {},
      appendComposer: (value: string) => {
        composer = appendReviewMessage(composer, value);
      },
      client: {
        write: async (path: string, body: any) => {
          writes.push({ path, body });
          if (path.endsWith("review_delete")) { setBatches([]); return { deleted: batch.id, revision: 5 }; }
          setBatches([batch]);
          return { review: batch };
        },
      },
    };
    return (
      <ResearchProvider value={scope}>
        <ReviewPane
          picked={picked}
          setPicked={setPicked}
          instruction={instruction}
          setInstruction={setInstruction}
          openArtifact={() => {}}
          choosePaper={() => {}}
        />
      </ResearchProvider>
    );
  }
  await act(async () => {
    renderer = create(<Harness />);
  });
  t.after(() => act(async () => renderer.unmount()));
  const root = renderer!.root;
  const button = (label: string) =>
    root.findAllByType("button").find((b) => text(b) === label)!;
  assert.equal(button("Prepare review").props.disabled, true);
  await act(async () =>
    root
      .findByProps({ "aria-label": "Search review evidence" })
      .props.onChange({ target: { value: "no matches" } }),
  );
  assert.match(text(root), /No passages match/);
  await act(async () => button("Reset filters").props.onClick());
  await act(async () => button("Select all in this paper").props.onClick());
  await act(async () =>
    root
      .findByProps({
        placeholder:
          "Compare these assumptions and identify where they disagree.",
      })
      .props.onChange({ target: { value: "Does this generalize?" } }),
  );
  assert.equal(button("Prepare review").props.disabled, false);
  await act(async () => button("Prepare review").props.onClick());
  assert.equal(writes[0].path, "/native/reviews/review_prepare");
  assert.deepEqual(writes[0].body.annotationIds, [note.id]);
  assert.match(text(root), /Review prepared/);
  await act(async () => button("Add to conversation").props.onClick());
  assert.ok(composer.startsWith("Existing unsent question\n"));
  assert.match(composer, /Growth optimality needs additional assumptions/);
  assert.doesNotMatch(composer, /EXACT SNAPSHOT/);
  assert.equal(batch.status, "draft", "composer handoff is not delivery");
  await act(async () => button("Duplicate as new review").props.onClick());
  assert.match(text(root), /Reusing the exact evidence/);
  await act(async () => button("Prepare review").props.onClick());
  assert.equal(writes[1].path, "/native/reviews/review_duplicate");
  assert.equal(writes[1].body.expectedHash, batch.hash);
  await act(async () => button("Delete review…").props.onClick());
  assert.equal(writes.length, 2, "opening confirmation must not delete");
  await act(async () => button("Cancel").props.onClick());
  assert.equal(writes.length, 2);
  await act(async () => button("Delete review…").props.onClick());
  await act(async () => button("Delete review").props.onClick());
  assert.equal(writes[2].path, "/native/reviews/review_delete");
  assert.equal(writes[2].body.expectedHash, batch.hash);
  assert.equal(root.findAllByProps({ id: `review-${batch.id}` }).length, 0);
  assert.equal(root.findAllByProps({ "aria-label": "Review prepared" }).length, 0);
  assert.match(composer, /Growth optimality needs additional assumptions/, "existing attachment stays intact");

});

test("review desktop routes accept only shared contracts and project safe result fields", () => {
  const scope: any = { kind: "strategy", id };
  const path = `/api/strategies/${id}/native/reviews/review_prepare`;
  const request: any = {
    method: "POST",
    path,
    headers: { "content-type": "application/json" },
    body: {
      revision: 1,
      instruction: "Question",
      destination: "Ideas",
      annotationIds: [note.id],
    },
  };
  // The desktop bridge receives encoded JSON bodies.
  request.body = new TextEncoder().encode(JSON.stringify(request.body));
  assert.equal(researchRequest(scope, request), true);
  assert.equal(
    researchRequest({ kind: "portfolio", id } as any, request),
    false,
  );
  assert.deepEqual(
    researchDTO({ review: batch, revision: 2, token: "secret" }, path),
    { review: batch, revision: 2 },
  );
  assert.equal(reviewStatus(batch), "Prepared");
  assert.equal(
    reviewStatus({ ...batch, status: "completed", response: "Answer" }),
    "Response available",
  );
});

test("compact review handoff keeps exact evidence and reference without internal metadata", () => {
  const review = {
    ...batch,
    instruction: "Compare these assumptions.\nExplain the difference.",
    annotations: [
      {
        ...note,
        anchor: {
          ...note.anchor,
          quote: "First line\nSecond line",
          rect: [0.1, 0.2, 0.3, 0.4],
          rotation: 0,
        },
      },
      {
        ...note,
        id: "another-note",
        anchor: { ...note.anchor, page: 7, quote: "Another passage" },
        comment: "Highlight",
      },
    ],
  };
  const prompt = reviewPrompt(review);
  assert.ok(prompt.includes(review.instruction));
  assert.match(prompt, /> First line\n> Second line/);
  assert.match(prompt, /Page 7\n> Another passage/);
  assert.match(prompt, /Comment: Compare the drawdown condition/);
  assert.match(prompt, /Selected region: \[0.1, 0.2, 0.3, 0.4\]/);
  assert.ok(prompt.includes(`${batch.id}@${batch.hash}`));
  assert.equal(
    prompt.split("### Growth optimality.pdf").length,
    2,
    "paper named once",
  );
  assert.doesNotMatch(
    prompt,
    /Comment: Highlight|EXACT SNAPSHOT|sessionId|artifactId/,
  );
  assert.equal(
    review.prompt,
    "EXACT SNAPSHOT",
    "canonical snapshot is untouched",
  );
});
