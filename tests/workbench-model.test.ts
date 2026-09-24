import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionKey, updateDraft } from '../src/workbench/model.ts';
import { previewData } from '../src/workbench/fixtures.ts';
import { activeTab, clampRatio, stageLayouts, PANE_MIN_PX } from '../src/workbench/layouts.ts';
import { graphDiff, autoLayout } from '../src/workbench/panes/GraphPane.tsx';
import { lineDiff } from '../src/workbench/panes/CodePane.tsx';
import { viewStateSchema, emptyView } from '../desktop/contracts.ts';

test('drafts are isolated by workspace and stage without mutating previous state', () => {
  const original = {};
  const first = updateDraft(original, sessionKey('momentum', 'literature'), 'A timing question');
  const second = updateDraft(first, sessionKey('momentum', 'code'), 'Code thoughts');
  const third = updateDraft(second, sessionKey('reversion', 'literature'), 'A separate idea');
  const final = updateDraft(third, 'portfolio:review', 'Frozen-source review');
  assert.deepEqual(original, {});
  assert.equal(final['momentum:literature'], 'A timing question');
  assert.equal(final['reversion:literature'], 'A separate idea');
  assert.equal(final['portfolio:review'], 'Frozen-source review');
  assert.equal(Object.keys(first).length, 1);
});

test('stage layouts honour the pane contract; Design & Code is Pi / graph / code', () => {
  for (const layout of Object.values(stageLayouts)) assert.deepEqual(layout.a, ['pi']);
  assert.deepEqual(stageLayouts.code.b, ['graph']);
  assert.deepEqual(stageLayouts.code.c, ['code']);
  assert.deepEqual(stageLayouts.research.b, ['sources']);
  assert.ok(stageLayouts.ideas.c.includes('sources'));
  assert.equal(activeTab('c', stageLayouts.results, { tabs: { c: 'conclusion' } }), 'conclusion');
  assert.equal(activeTab('c', stageLayouts.results, { tabs: { c: 'graph' } }), 'results', 'foreign tab ignored');
});

test('split ratios keep both panes usable at the target viewports', () => {
  for (const width of [1280 - 248, 1440 - 248]) {
    const lo = clampRatio(0, width), hi = clampRatio(1, width);
    assert.ok(lo * width >= PANE_MIN_PX - 1);
    assert.ok((1 - hi) * width >= PANE_MIN_PX - 1);
  }
  assert.equal(clampRatio(0.5, 400), 0.5, 'too narrow for two minimums: centre');
  assert.equal(clampRatio(0.05), 0.2);
  assert.equal(clampRatio(0.95), 0.8);
});

test('graph diff is semantic: positions never count, contract and edge changes do', () => {
  const a = { id: 'a', label: 'Prices', stage: 'data', inputs: [], outputs: ['close'], assumptions: [], code: [], evidence: [] };
  const b = { ...a, id: 'b', label: 'Signal', stage: 'signal', inputs: ['close'], outputs: [] };
  const base = { spec: { id: 's', hash: 'h' }, nodes: [a, b], edges: [] as any[] };
  assert.deepEqual(graphDiff(base, structuredClone(base)), []);
  const moved = autoLayout(base.nodes, { a: { x: 400, y: 400 } });
  assert.equal(moved.a.x, 400);
  assert.deepEqual(graphDiff(base, structuredClone(base)), [], 'layout is not part of the graph');
  const next = structuredClone(base);
  next.nodes[1].inputs = ['close', 'volume'];
  next.edges.push({ from: 'a', to: 'b', label: 'close' });
  const changes = graphDiff(base, next);
  assert.deepEqual(changes.map((c) => c.kind).sort(), ['added', 'changed']);
  assert.match(changes.find((c) => c.kind === 'changed')!.what, /Inputs/);
});

test('line diff reports additions and removals against the base version', () => {
  const d = lineDiff('a\nb\nc', 'a\nc\nd')!;
  assert.deepEqual(d.map((x) => x.op + x.text), [' a', '-b', ' c', '+d']);
  assert.equal(lineDiff('x\n'.repeat(3000), 'y\n'.repeat(3000)), null, 'bounded');
});

test('saved view accepts per-stage layouts and a shared source companion', () => {
  const id = '12345678-1234-1234-1234-123456789abc';
  const view = viewStateSchema.parse({
    ...emptyView(),
    layouts: { code: { split: 0.5, stack: 0.4, tabs: { c: 'code' }, hidden: ['b'], zoom: null } },
    companion: { open: [id], pinned: [id], active: id },
  });
  assert.equal(view.layouts!.code!.split, 0.5);
  assert.throws(() => viewStateSchema.parse({ ...emptyView(), layouts: { code: { split: 2 } } }));
  assert.throws(() => viewStateSchema.parse({ ...emptyView(), companion: { open: ['../x'], pinned: [], active: null } }));
});

test('each preview strategy exposes all seven stage sessions', () => {
  assert.deepEqual(previewData.stages.map((stage) => stage.id), ['ideas', 'literature', 'research', 'data', 'code', 'backtests', 'results']);
  for (const workspace of previewData.workspaces)
    for (const stage of previewData.stages) assert.ok(workspace.threads[stage.id].title);
});

import { effectiveLayout, swapSlots, tileRects, neighbor, tileOrder, resizeTile, piSlot } from '../src/workbench/layouts.ts';

test('swapped slots must be a permutation of the stage panes; swap exchanges contents and tabs', () => {
  const code = stageLayouts.code;
  assert.equal(effectiveLayout(code, { slots: { a: ['code'], c: ['pi'] } }).a[0], 'code');
  assert.equal(effectiveLayout(code, { slots: { a: ['results'] } }), code, 'foreign pane rejected');
  assert.equal(effectiveLayout(code, { slots: { a: ['pi'], b: ['pi'] } }), code, 'duplicate rejected');
  const swapped = swapSlots(stageLayouts.results, { tabs: { c: 'conclusion' } }, 'a', 'c');
  const l = effectiveLayout(stageLayouts.results, swapped);
  assert.deepEqual(l.a, ['results', 'conclusion']);
  assert.deepEqual(l.c, ['pi']);
  assert.equal(swapped.tabs?.a, 'conclusion');
  assert.equal(piSlot(l), 'c');
});

test('directional focus follows rendered geometry, including flipped splits', () => {
  const code = stageLayouts.code;
  let r = tileRects(code, {}, true);
  assert.equal(neighbor(r, 'a', 'right'), 'c');
  assert.equal(neighbor(r, 'a', 'down'), 'b');
  assert.equal(neighbor(r, 'b', 'up'), 'a');
  assert.equal(neighbor(r, 'a', 'left'), 'rail');
  assert.equal(neighbor(r, 'c', 'left'), 'a', 'larger facing overlap wins');
  assert.equal(neighbor(r, 'c', 'right'), undefined);
  assert.deepEqual(tileOrder(r), ['a', 'c', 'b']);
  r = tileRects(code, { outer: 'column', inner: 'row' }, false);
  assert.equal(neighbor(r, 'a', 'right'), 'b');
  assert.equal(neighbor(r, 'a', 'down'), 'c');
  assert.equal(neighbor(r, 'c', 'up'), 'a');
  r = tileRects(code, { hidden: ['b'] }, false);
  assert.equal(neighbor(r, 'a', 'down'), undefined, 'hidden panes are skipped');
  r = tileRects(code, { zoom: 'c' }, true);
  assert.deepEqual(Object.keys(r).sort(), ['c', 'rail']);
});

test('resizing grows the focused pane by moving the split that bounds it', () => {
  const code = stageLayouts.code;
  assert.equal(resizeTile(code, {}, 'a', 'x', 0.05).split, 0.47);
  assert.equal(resizeTile(code, {}, 'c', 'x', 0.05).split, 0.37);
  assert.equal(resizeTile(code, {}, 'b', 'y', 0.05).stack, 0.51);
  assert.deepEqual(resizeTile(stageLayouts.data, {}, 'c', 'y', 0.05), {}, 'no split on that axis');
  assert.equal(resizeTile(code, { split: 0.79 }, 'a', 'x', 0.05).split, 0.8, 'clamped');
});

test('saved layouts accept swaps and split directions', () => {
  const v = viewStateSchema.parse({
    ...emptyView(),
    layouts: { code: { slots: { a: ['code'], c: ['pi'] }, outer: 'column', inner: 'row', hidden: ['a'] } },
  });
  assert.equal(v.layouts!.code!.outer, 'column');
  assert.throws(() => viewStateSchema.parse({ ...emptyView(), layouts: { code: { outer: 'diagonal' } } }));
});

import { latestDecision } from '../src/workbench/research.tsx';
test('version status shows the latest explicit decision, including idea decisions', () => {
  const v = { id: 'i1', hash: 'h1' };
  const science = {
    approvals: [{ target: v, decision: 'approve', at: '2026-01-01T00:00:00Z' }],
    decisions: [{ target: v, decision: 'pursue', at: '2026-01-02T00:00:00Z' }, { target: { id: 'i1', hash: 'other' }, decision: 'reject', at: '2026-01-03T00:00:00Z' }],
  };
  assert.equal(latestDecision(science, v), 'pursue');
  assert.equal(latestDecision({ approvals: [], decisions: [] }, v), undefined);
});

test('idea save: an evidence item added but left blank is dropped; partial items get plain-language errors', async () => {
  const { pruneBlankItems, initialValue } = await import('../src/workbench/ResearchForm.tsx');
  const { formatIssues } = await import('../src/workbench/research.tsx');
  const { ideaSchema, versionInput } = await import('../src/platform.ts');
  const idea = { title: 't', rationale: 'r', universe: 'u', horizon: 'h', falsification: 'f', uncertainty: 'cited' };
  const blank = initialValue((ideaSchema as any).shape.evidence.element);
  const ref = { id: '12345678-1234-4234-8234-123456789abc', hash: 'a'.repeat(64) };
  const filled = { category: 'cited', reference: ref, description: 'Theorem 3.1' };

  // The reported case: one untouched evidence row blocks an otherwise complete idea.
  const pruned = pruneBlankItems(ideaSchema, { ...idea, evidence: [blank, filled, { ...blank }] });
  assert.deepEqual(pruned.evidence, [filled]);
  assert.equal(versionInput.safeParse({ kind: 'idea', content: pruned }).success, true);

  // Partly filled rows are kept and explained, 1-based, without schema jargon.
  const partial = pruneBlankItems(ideaSchema, { ...idea, evidence: [{ ...blank, description: 'Kelly criterion' }] });
  assert.equal(partial.evidence.length, 1);
  const r = versionInput.safeParse({ kind: 'idea', content: partial });
  assert.equal(r.success, false);
  assert.equal(formatIssues(r.error), 'Evidence 1 / Reference: pick a source or saved record from the list');
  const noText = versionInput.safeParse({ kind: 'idea', content: { ...idea, title: '', evidence: [{ ...filled, description: '' }] } });
  assert.equal(formatIssues(noText.error), 'Title: required · Evidence 1 / Description: required');
  // Items without any text fields are never treated as blank.
  const { z } = await import('zod');
  assert.deepEqual(pruneBlankItems(z.object({ xs: z.array(z.object({ w: z.number() })) }), { xs: [{ w: 0 }] }), { xs: [{ w: 0 }] });
});
