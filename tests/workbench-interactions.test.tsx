import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { create, act } from "react-test-renderer";
import { Workbench } from "../src/workbench/Workbench";
import { previewData } from "../src/workbench/fixtures";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).window = { innerWidth: 1440, addEventListener() {}, removeEventListener() {}, setTimeout };
(globalThis as any).document = { activeElement: null, getElementById() { return null; } };

async function render(t: any) {
  let renderer: ReturnType<typeof create>;
  await act(() => {
    renderer = create(<Workbench data={previewData} />);
  });
  t.after(() => act(() => renderer!.unmount()));
  const root = renderer!.root;
  const text = (node: any): string =>
    typeof node === "string" ? node : (node.children || []).map(text).join("");
  const click = async (label: string) => {
    const button = root.findAllByType("button").find((b) => text(b).includes(label));
    assert.ok(button, `button ${label}`);
    await act(() => button.props.onClick());
  };
  const byLabel = (label: string) => root.findByProps({ "aria-label": label });
  const pane = (label: string) => root.findAll((n) => n.type === "section" && n.props["aria-label"] === label)[0];
  const separators = () => root.findAllByProps({ role: "separator" });
  return { root, click, byLabel, pane, separators, draft: () => root.findByType("textarea") };
}

test("stage drafts stay isolated and Design & Code shows Pi, graph and code simultaneously", async (t) => {
  const x = await render(t);
  await act(() => x.draft().props.onChange({ target: { value: "Momentum draft" } }));
  await x.click("Reversal");
  assert.equal(x.draft().props.value, "");
  await act(() => x.draft().props.onChange({ target: { value: "Reversal draft" } }));
  await x.click("Momentum");
  assert.equal(x.draft().props.value, "Momentum draft");

  await x.click("Design & Code");
  assert.equal(x.draft().props.value, "");
  for (const label of ["Pi", "Graph", "Code"]) {
    const section = x.pane(label);
    assert.ok(section, `${label} pane rendered`);
    assert.equal(section.props.hidden, false, `${label} pane visible`);
  }
  assert.equal(x.pane("Graph").props["data-slot"], "b");
  assert.equal(x.pane("Code").props["data-slot"], "c");
  assert.equal(x.separators().length, 2, "column and stack splits");

  await x.click("Portfolio");
  assert.equal(x.root.findByType("h1").children.join(""), previewData.portfolio.title);
  assert.equal(x.pane("Evidence").props.hidden, false);
  assert.equal(x.byLabel("Send unavailable: design preview has no connected runtime").props.disabled, true);
});

test("splits persist per stage; hiding and zooming keep panes mounted; palette jumps to panes", async (t) => {
  const x = await render(t);
  const columns = () => x.byLabel("Resize columns");
  assert.equal(columns().props["aria-valuenow"], 44);
  await act(() => columns().props.onKeyDown({ key: "ArrowRight", preventDefault() {} }));
  assert.equal(columns().props["aria-valuenow"], 46);

  await x.click("Design & Code");
  assert.equal(columns().props["aria-valuenow"], 42, "code stage keeps its own split");
  await x.click("Literature");
  assert.equal(columns().props["aria-valuenow"], 46, "literature split restored");

  await act(() => x.byLabel("Hide companion pane").props.onClick());
  assert.equal(x.root.findAllByProps({ "aria-label": "Resize columns" }).length, 0);
  assert.equal(x.pane("Sources").props.hidden, true, "hidden pane stays mounted");
  await act(() => x.byLabel("Show companion pane").props.onClick());
  assert.equal(columns().props["aria-valuenow"], 46);

  await act(() => x.byLabel("Zoom Pi").props.onClick());
  assert.equal(x.pane("Sources").props.hidden, true);
  assert.equal(x.pane("Pi").props.hidden, false);
  await act(() => x.byLabel("Restore layout").props.onClick());
  assert.equal(x.pane("Sources").props.hidden, false);

  await act(() => x.byLabel("Open command palette").props.onClick());
  await act(() => x.byLabel("Search commands").props.onChange({ target: { value: "go to bibliography" } }));
  const options = x.root.findAllByProps({ role: "option" });
  assert.equal(options.length, 1);
  await act(() => options[0].props.onClick());
  assert.equal(x.root.findByProps({ id: "pane-tab-bibliography" }).props["aria-selected"], true);
  assert.equal(x.root.findAllByProps({ role: "dialog" }).length, 0);
});

test("Omarchy-style tiling: swap, flip split, move focus and hide through the keymap", async (t) => {
  const x = await render(t);
  const run = async (label: string) => {
    await act(() => x.byLabel("Open command palette").props.onClick());
    await act(() => x.byLabel("Search commands").props.onChange({ target: { value: label } }));
    const option = x.root
      .findAllByProps({ role: "option" })
      .find((o) => JSON.stringify(o.children.map((c: any) => c.children)).includes(label));
    assert.ok(option, `command ${label}`);
    await act(() => option.props.onClick());
  };
  await act(() => x.byLabel("Open command palette").props.onClick());
  await act(() => x.byLabel("Search commands").props.onChange({ target: { value: "keys " } }));
  assert.ok(x.root.findAllByProps({ role: "option" }).length >= 20, "keymap is listed");
  await act(() => x.root.findByProps({ role: "dialog" }).props.onKeyDown({ key: "Escape", preventDefault() {} }));

  await run("Swap pane to the right");
  assert.equal(x.pane("Pi").props["data-slot"], "c", "Pi moved right");
  assert.equal(x.pane("Sources").props["data-slot"], "a");
  assert.equal(x.pane("Pi").props.className.includes("active"), true, "focus follows the moved pane");

  await run("Toggle split direction");
  assert.ok(x.byLabel("Resize rows"), "outer split is now stacked");

  await run("Focus pane above");
  assert.equal(x.pane("Sources").props.className.includes("active"), true);
  await run("Hide focused pane");
  assert.equal(x.pane("Sources").props.hidden, true);
  await run("Hide focused pane");
  assert.equal(x.pane("Pi").props.hidden, false, "Pi is never hidden");
});

test("closing the paper being read returns to the library, never an empty reader", async (t) => {
  const { ResearchProvider } = await import("../src/workbench/research");
  const { SourcesPane } = await import("../src/workbench/panes/SourcesPane");
  const paper = (id: string, name: string) => ({
    id, name, hash: id.padEnd(64, "0"), bytes: 10, kind: "pdf", mime: "application/pdf", created: "2026-09-23T10:00:00Z",
  });
  const artifacts = [paper("a1", "Kardaras 2012.pdf"), paper("b2", "Platen 2006.pdf")];
  function Host() {
    const [companion, setCompanion] = React.useState<any>({ open: ["a1", "b2"], pinned: [], active: "b2" });
    const scope: any = {
      client: { bytes: () => new Promise(() => {}), read: async () => ({}), write: async () => ({}), bridge: {} },
      portfolio: false, stage: "literature", view: { artifacts, annotations: [], batches: [] }, loadError: "",
      refresh: async () => {}, drafts: {}, setDraft() {}, setComposer() {}, appendComposer() {},
      companion, setCompanion,
    };
    return <ResearchProvider value={scope}><SourcesPane /></ResearchProvider>;
  }
  let renderer: ReturnType<typeof create>;
  await act(() => { renderer = create(<Host />); });
  t.after(() => act(() => renderer!.unmount()));
  const root = renderer!.root;
  const libraryTab = () => root.findAll((n) => n.type === "button" && n.props.className?.startsWith("mode") && n.props["aria-selected"] !== undefined)[0];
  const readerOpen = () => root.findAll((n) => n.props.className === "doc-host").length > 0;
  const close = (name: string) => act(() => root.findByProps({ "aria-label": `Close ${name}` }).props.onClick());
  assert.equal(readerOpen(), true, "active paper is being read");

  await close("Platen 2006.pdf");
  assert.equal(readerOpen(), false);
  assert.equal(libraryTab().props["aria-selected"], true, "library shown after closing the paper being read");
  assert.ok(root.findByProps({ "aria-label": "Close Kardaras 2012.pdf" }), "other paper stays open as a tab");

  await act(() => root.findAll((n) => n.type === "button" && n.props.title?.startsWith("Kardaras"))[0].props.onClick());
  assert.equal(readerOpen(), true);
  await close("Kardaras 2012.pdf");
  assert.equal(libraryTab().props["aria-selected"], true, "closing the last paper shows the library");
  assert.equal(JSON.stringify(renderer!.toJSON()).includes("No source open"), false);
});

test("Add papers suggests arXiv titles/authors as you type; picking imports, or opens a paper already in the library", async (t) => {
  const { ResearchProvider } = await import("../src/workbench/research");
  const { SourcesPane } = await import("../src/workbench/panes/SourcesPane");
  const searched: string[] = [], fetched: string[] = [];
  const hits = [
    { id: "1206.2305", title: "The numeraire property and long-term growth optimality", authors: ["Constantinos Kardaras", "Jan Obłój", "Eckhard Platen"], authorCount: 3, year: "2012", category: "q-fin.PM" },
    { id: "0911.1234", title: "Numeraire portfolios in continuous time", authors: ["A", "B", "C", "D"], authorCount: 5, year: "2009" },
  ];
  const artifacts = [{ id: "a1", name: "Kardaras et al. 2012 - The numeraire property (arXiv 1206.2305).pdf", hash: "0".repeat(64), bytes: 1, kind: "pdf", mime: "application/pdf", created: "2026-09-23T10:00:00Z" }];
  let companion: any = { open: [], pinned: [], active: null };
  function Host() {
    const [c, setC] = React.useState<any>(companion);
    companion = c;
    const scope: any = {
      client: {
        bytes: () => new Promise(() => {}), read: async () => ({ revision: 1 }), write: async () => ({}),
        bridge: {
          searchPapers: async (q: string) => (searched.push(q), hits),
          fetchPaper: async (id: string) => { fetched.push(id); throw new Error("offline in test"); },
        },
      },
      portfolio: false, stage: "ideas", view: { artifacts, annotations: [], batches: [] }, loadError: "",
      refresh: async () => {}, drafts: {}, setDraft() {}, setComposer() {}, appendComposer() {},
      companion: c, setCompanion: setC,
    };
    return <ResearchProvider value={scope}><SourcesPane initialMode="library" /></ResearchProvider>;
  }
  let renderer: ReturnType<typeof create>;
  await act(() => { renderer = create(<Host />); });
  t.after(() => act(() => renderer!.unmount()));
  const root = renderer!.root;
  const input = () => root.findByProps({ id: "paper-refs" });
  const options = () => root.findByProps({ id: "paper-suggestions" }).findAllByProps({ role: "option" });
  const text = (n: any): string => (typeof n === "string" ? n : (n.children ?? []).map(text).join(""));
  const type = async (value: string) => {
    await act(() => input().props.onChange({ target: { value } }));
    await act(() => new Promise((r) => setTimeout(r, 520)));
  };
  const addButton = () => root.findAll((n) => n.type === "button" && text(n) === "Add papers")[0];

  await type("2609.22612");
  assert.equal(searched.length, 0, "IDs are imported, not searched");
  assert.equal(addButton().props.disabled, false);

  await type("kardaras numeraire");
  assert.deepEqual(searched, ["kardaras numeraire"]);
  assert.equal(input().props["aria-expanded"], true);
  assert.equal(options().length, 2);
  assert.match(text(options()[0]), /Kardaras, Jan Obłój, Eckhard Platen · 2012 · q-fin\.PM · 1206\.2305in library/);
  assert.match(text(options()[1]), /A, B, C et al\. · 2009/);
  assert.equal(addButton().props.disabled, true, "words search; they are not a download");

  // Keyboard: ↓ then ⏎ picks the second hit, which is downloaded explicitly.
  await act(() => input().props.onKeyDown({ key: "ArrowDown", preventDefault() {} }));
  assert.equal(options()[1].props["aria-selected"], true);
  await act(async () => root.findByType("form").props.onSubmit({ preventDefault() {} }));
  assert.deepEqual(fetched, ["0911.1234"]);

  // Picking a paper already in the library opens it instead of downloading again.
  await type("kardaras growth");
  await act(async () => options()[0].props.onMouseDown({ preventDefault() {} }));
  assert.deepEqual(fetched, ["0911.1234"]);
  assert.equal(companion.active, "a1");
});

test("library works like Finder: arrows select, Space previews (arrows switch the preview), Enter opens for work", async (t) => {
  const { ResearchProvider } = await import("../src/workbench/research");
  const { SourcesPane } = await import("../src/workbench/panes/SourcesPane");
  const paper = (id: string, name: string) => ({ id, name, hash: id.padEnd(64, "0"), bytes: 2048, kind: "pdf", mime: "application/pdf", created: "2026-09-24T10:00:00Z" });
  const artifacts = [paper("a1", "Busseti 2016.pdf"), paper("b2", "Vera-Marun 2026.pdf"), paper("c3", "Kardaras 2012.pdf")];
  let companion: any = { open: [], pinned: [], active: null };
  function Host() {
    const [c, setC] = React.useState<any>(companion);
    companion = c;
    const scope: any = {
      client: { bytes: () => new Promise(() => {}), read: async () => ({}), write: async () => ({}), bridge: {} },
      portfolio: false, stage: "literature", view: { artifacts, annotations: [], batches: [] }, loadError: "",
      refresh: async () => {}, drafts: {}, setDraft() {}, setComposer() {}, appendComposer() {}, companion: c, setCompanion: setC,
    };
    return <ResearchProvider value={scope}><SourcesPane initialMode="library" /></ResearchProvider>;
  }
  let renderer: ReturnType<typeof create>;
  await act(() => { renderer = create(<Host />); });
  t.after(() => act(() => renderer!.unmount()));
  const root = renderer!.root;
  const text = (n: any): string => (typeof n === "string" ? n : (n.children ?? []).map(text).join(""));
  const list = () => root.findByProps({ role: "listbox", "aria-label": "Sources" });
  const press = (key: string, target?: any) =>
    act(async () => {
      const el = target ?? list();
      el.props.onKeyDown({ key, target: el, currentTarget: el, preventDefault() {}, stopPropagation() {} });
    });
  const selected = () => root.findAll((n) => n.props.role === "option" && n.props["aria-selected"] === true).map((n) => n.props.id);
  const preview = () => root.findAll((n) => n.props.role === "dialog" && String(n.props["aria-label"]).startsWith("Preview of"))[0];

  await press("ArrowDown");
  assert.deepEqual(selected(), ["source-row-a1"], "first arrow selects the first paper");
  await press("ArrowDown");
  await press("ArrowDown");
  await press("ArrowDown");
  assert.deepEqual(selected(), ["source-row-c3"], "stops at the last paper");
  await press("ArrowUp");
  assert.deepEqual(selected(), ["source-row-b2"]);
  assert.equal(companion.active, null, "selecting never opens");

  await press(" ");
  assert.equal(preview().props["aria-label"], "Preview of Vera-Marun 2026.pdf");
  assert.match(text(preview()), /2 \/ 3/);
  await press("ArrowDown");
  assert.equal(preview().props["aria-label"], "Preview of Kardaras 2012.pdf", "arrows switch the preview like Quick Look");
  // Keys also work when focus moved into the preview.
  await press("ArrowUp", preview());
  assert.equal(preview().props["aria-label"], "Preview of Vera-Marun 2026.pdf");
  await press("Escape", preview());
  assert.equal(preview(), undefined);
  await press(" ");
  await press(" ");
  assert.equal(preview(), undefined, "Space toggles the preview");

  await press(" ");
  await press("Enter");
  assert.equal(companion.active, "b2", "Enter opens the selected paper for work");
  assert.deepEqual(companion.open, ["b2"]);
  assert.equal(preview(), undefined);
});

test("library: clicking selects, double-click opens", async (t) => {
  const { ResearchProvider } = await import("../src/workbench/research");
  const { SourcesPane } = await import("../src/workbench/panes/SourcesPane");
  const artifacts = [{ id: "a1", name: "One.pdf", hash: "a".repeat(64), bytes: 1, kind: "pdf", mime: "application/pdf", created: "2026-09-24T10:00:00Z" }];
  let companion: any = { open: [], pinned: [], active: null };
  function Host() {
    const [c, setC] = React.useState<any>(companion);
    companion = c;
    const scope: any = {
      client: { bytes: () => new Promise(() => {}), read: async () => ({}), write: async () => ({}), bridge: {} },
      portfolio: false, stage: "literature", view: { artifacts, annotations: [], batches: [] }, loadError: "",
      refresh: async () => {}, drafts: {}, setDraft() {}, setComposer() {}, appendComposer() {}, companion: c, setCompanion: setC,
    };
    return <ResearchProvider value={scope}><SourcesPane initialMode="library" /></ResearchProvider>;
  }
  let renderer: ReturnType<typeof create>;
  await act(() => { renderer = create(<Host />); });
  t.after(() => act(() => renderer!.unmount()));
  const row = () => renderer!.root.findByProps({ id: "source-row-a1" });
  await act(async () => row().props.onClick());
  assert.equal(row().props["aria-selected"], true);
  assert.equal(companion.active, null);
  await act(async () => row().props.onDoubleClick());
  assert.equal(companion.active, "a1");
});

test("library sections: Primary, Secondary and Other sources; keys, the row menu and drops move papers; arrows follow the sections", async (t) => {
  const { ResearchProvider } = await import("../src/workbench/research");
  const { SourcesPane } = await import("../src/workbench/panes/SourcesPane");
  const paper = (id: string, name: string) => ({ id, name, hash: id.padEnd(64, "0"), bytes: 2048, kind: "pdf", mime: "application/pdf", created: "2026-09-24T10:00:00Z" });
  const artifacts = [paper("a1", "Busseti 2016.pdf"), paper("b2", "Vera-Marun 2026.pdf"), paper("c3", "Kardaras 2012.pdf")];
  let importance: Record<string, string> = {};
  const writes: any[] = [];
  let bump: () => void = () => {};
  function Host() {
    const [, setN] = React.useState(0);
    bump = () => setN((n) => n + 1);
    const scope: any = {
      client: {
        bytes: () => new Promise(() => {}),
        read: async () => ({}),
        write: async (path: string, body: any) => {
          writes.push([path, body]);
          if (body.importance === "other") {
            const { [body.artifactId]: _, ...rest } = importance;
            importance = rest;
          } else importance = { ...importance, [body.artifactId]: body.importance };
          return body;
        },
        bridge: {},
      },
      portfolio: false, stage: "literature", view: { artifacts, annotations: [], batches: [], importance }, loadError: "",
      refresh: async () => bump(), drafts: {}, setDraft() {}, setComposer() {}, appendComposer() {},
      companion: { open: [], pinned: [], active: null }, setCompanion() {},
    };
    return <ResearchProvider value={scope}><SourcesPane initialMode="library" /></ResearchProvider>;
  }
  let renderer: ReturnType<typeof create>;
  await act(() => { renderer = create(<Host />); });
  t.after(() => act(() => renderer!.unmount()));
  const root = renderer!.root;
  const list = () => root.findByProps({ role: "listbox", "aria-label": "Sources" });
  const press = (key: string) =>
    act(async () => {
      const el = list();
      el.props.onKeyDown({ key, target: el, currentTarget: el, preventDefault() {}, stopPropagation() {} });
    });
  const host = (n: any) => typeof n.type === "string";
  const groups = () => root.findAll((n) => n.props.role === "group" && host(n)).map((n) => n.props["aria-label"]);
  const group = (label: string) => root.find((n) => n.props.role === "group" && n.props["aria-label"] === label && host(n));
  const order = () => root.findAll((n) => n.props.role === "option" && host(n)).map((n) => n.props.id.replace("source-row-", ""));
  const selected = () => root.findAll((n) => n.props.role === "option" && n.props["aria-selected"] === true && host(n)).map((n) => n.props.id);

  assert.deepEqual(groups(), [], "while everything is in Other, the library is one plain list");
  {
    // Dragging from the plain list must not re-create the dragged row (Chromium would cancel the drag).
    const rowBefore = root.findByProps({ id: "source-row-a1" });
    const parentOf = () => {
      let n: any = root.find((x) => x.props.id === "source-row-a1" && typeof x.type === "string").parent;
      while (n && typeof n.type !== "string") n = n.parent;
      return String(n?.props.className ?? n?.props.role);
    };
    assert.match(parentOf(), /source-section level-other/, "the plain list is already the Other section");
    const d0: Record<string, string> = {};
    const t0 = { types: ["application/x-pi-research-source"], setData: (k: string, v: string) => (d0[k] = v), getData: (k: string) => d0[k] ?? "", dropEffect: "", effectAllowed: "" };
    await act(async () => {
      rowBefore.props.onDragStart({ dataTransfer: t0 });
      await new Promise((r) => setTimeout(r, 5));
    });
    assert.deepEqual(groups(), ["Primary sources · 0", "Secondary sources · 0", "Other sources · 3"], "sections appear as drop targets");
    assert.match(parentOf(), /source-section level-other/, "the dragged row keeps its parent, so it is not re-created");
    await act(async () => rowBefore.props.onDragEnd());
    assert.deepEqual(groups(), []);
  }
  await press("ArrowDown");
  await press("ArrowDown");
  await press("ArrowDown");
  await press("1");
  assert.deepEqual(writes.at(-1), ["/native/source-importance", { artifactId: "c3", importance: "primary" }]);
  assert.deepEqual(groups(), ["Primary sources · 1", "Other sources · 2"]);
  assert.deepEqual(order(), ["c3", "a1", "b2"], "primary first");
  assert.deepEqual(selected(), ["source-row-c3"], "the moved paper stays selected in its new section");
  await press("ArrowDown");
  assert.deepEqual(selected(), ["source-row-a1"], "arrows follow the sections' order");

  const menu = root.findByProps({ "aria-label": "Section of Busseti 2016.pdf" });
  await act(async () => menu.props.onChange({ target: { value: "secondary" } }));
  assert.deepEqual(groups(), ["Primary sources · 1", "Secondary sources · 1", "Other sources · 1"]);

  // Drag Vera-Marun onto Secondary.
  const data: Record<string, string> = {};
  const dt = { types: ["application/x-pi-research-source"], setData: (k: string, v: string) => (data[k] = v), getData: (k: string) => data[k] ?? "", dropEffect: "", effectAllowed: "" };
  const tick = () => new Promise((r) => setTimeout(r, 5));
  await act(async () => {
    root.findByProps({ id: "source-row-b2" }).props.onDragStart({ dataTransfer: dt });
    await tick();
  });
  await act(async () => group("Secondary sources · 1").props.onDrop({ dataTransfer: dt, preventDefault() {} }));
  assert.deepEqual(groups(), ["Primary sources · 1", "Secondary sources · 2"]);
  assert.deepEqual(order(), ["c3", "a1", "b2"]);

  // While dragging, empty sections appear as drop targets.
  await act(async () => {
    root.findByProps({ id: "source-row-a1" }).props.onDragStart({ dataTransfer: dt });
    await tick();
  });
  assert.ok(groups().includes("Other sources · 0"));
  await act(async () => group("Other sources · 0").props.onDrop({ dataTransfer: dt, preventDefault() {} }));
  assert.deepEqual(groups(), ["Primary sources · 1", "Secondary sources · 1", "Other sources · 1"]);

  // Collapsed sections leave keyboard navigation; 3 moves a paper to Other.
  const head = group("Secondary sources · 1").children.find((n: any) => n.props?.className === "source-section-head") as any;
  await act(async () => head.props.onClick());
  assert.deepEqual(order(), ["c3", "a1"]);
  await press("Home");
  assert.deepEqual(selected(), ["source-row-c3"]);
  await press("3");
  assert.deepEqual(groups(), ["Secondary sources · 1", "Other sources · 2"]);
});

test("papers added from the arXiv bar start as Primary sources; file imports and papers already in the library keep their section", async (t) => {
  const { ResearchProvider } = await import("../src/workbench/research");
  const { SourcesPane } = await import("../src/workbench/panes/SourcesPane");
  const pdf = (text: string) => new TextEncoder().encode(`%PDF-1.4 ${text}`);
  const digest = async (b: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", b as BufferSource))].map((x) => x.toString(16).padStart(2, "0")).join("");
  const papers: Record<string, Uint8Array> = { "1206.2305": pdf("kardaras"), "0911.1234": pdf("numeraire") };
  const artifacts: any[] = [{ id: "old", name: "Numeraire 2009 (arXiv 0911.1234).pdf", hash: await digest(papers["0911.1234"]), bytes: 1, kind: "pdf", mime: "application/pdf", created: "2026-09-23T10:00:00Z" }];
  const writes: any[] = [];
  let n = 0;
  function Host() {
    const [c, setC] = React.useState<any>({ open: [], pinned: [], active: null });
    const scope: any = {
      client: {
        bytes: () => new Promise(() => {}),
        read: async () => ({ revision: 1, artifacts: [...artifacts] }),
        write: async (path: string, body: any) => (writes.push([path, body]), body),
        upload: async (file: File) => {
          const bytes = new Uint8Array(await file.arrayBuffer());
          artifacts.push({ id: `new${++n}`, name: file.name, hash: await digest(bytes), bytes: bytes.length, kind: "pdf", mime: "application/pdf", created: "2026-09-24T10:00:00Z" });
        },
        bridge: {
          searchPapers: async () => [],
          fetchPaper: async (id: string) => ({ name: `arXiv ${id}.pdf`, bytes: papers[id], title: id }),
        },
      },
      portfolio: false, stage: "literature", view: { artifacts: [...artifacts], annotations: [], batches: [] }, loadError: "",
      refresh: async () => {}, drafts: {}, setDraft() {}, setComposer() {}, appendComposer() {}, companion: c, setCompanion: setC,
    };
    return <ResearchProvider value={scope}><SourcesPane initialMode="library" /></ResearchProvider>;
  }
  let renderer: ReturnType<typeof create>;
  await act(() => { renderer = create(<Host />); });
  t.after(() => act(() => renderer!.unmount()));
  const root = renderer!.root;
  await act(() => root.findByProps({ id: "paper-refs" }).props.onChange({ target: { value: "1206.2305 0911.1234" } }));
  await act(async () => {
    root.findByType("form").props.onSubmit({ preventDefault() {} });
    await new Promise((r) => setTimeout(r, 50));
  });
  assert.deepEqual(writes, [["/native/source-importance", { artifactId: "new1", importance: "primary" }]], "only the newly added paper is placed; the one already in the library keeps its section");

  // Files imported from disk start in Other (importing opened the paper; go back to the library).
  const library = root.findAll((n) => n.type === "button" && n.props.role === "tab" && String(n.props.className).startsWith("mode"))[0];
  await act(async () => library.props.onClick());
  const input = root.findByProps({ "aria-label": "Import source files" });
  await act(async () => {
    input.props.onChange({ target: { files: [new File([pdf("from disk")], "notes.pdf")], value: "" } });
    await new Promise((r) => setTimeout(r, 50));
  });
  assert.equal(artifacts.length, 3);
  assert.equal(writes.length, 1, "file imports are not placed");
});

test("Escape returns from a paper after in-reader controls; ⌘⌫ deletes the selected source with Undo", async (t) => {
  const { ResearchProvider } = await import("../src/workbench/research");
  const { SourcesPane } = await import("../src/workbench/panes/SourcesPane");
  const keyHandlers = new Set<(event: any) => void>();
  const oldAdd = window.addEventListener;
  const oldRemove = window.removeEventListener;
  const oldQuery = document.querySelector;
  (window as any).addEventListener = (type: string, handler: (event: any) => void) => { if (type === "keydown") keyHandlers.add(handler); };
  (window as any).removeEventListener = (type: string, handler: (event: any) => void) => { if (type === "keydown") keyHandlers.delete(handler); };
  t.after(() => {
    window.addEventListener = oldAdd;
    window.removeEventListener = oldRemove;
    document.querySelector = oldQuery;
  });
  const paper = (id: string, name: string) => ({ id, name, hash: id.padEnd(64, "0"), bytes: 2048, kind: "pdf", mime: "application/pdf", created: "2026-09-24T10:00:00Z" });
  const artifacts = [paper("a1", "Busseti 2016.pdf"), paper("b2", "Vera-Marun 2026.pdf"), paper("c3", "Kardaras 2012.pdf")];
  const writes: any[] = [];
  let companion: any = { open: [], pinned: [], active: null };
  function Host() {
    const [c, setC] = React.useState<any>(companion);
    companion = c;
    const scope: any = {
      client: {
        bytes: () => new Promise(() => {}),
        read: async () => ({ revision: 7 }),
        write: async (path: string, body: any) => (writes.push([path, body]), { annotationsRemoved: 0 }),
        bridge: {},
      },
      portfolio: false, stage: "literature", view: { artifacts, annotations: [], batches: [] }, loadError: "",
      refresh: async () => {}, drafts: {}, setDraft() {}, setComposer() {}, appendComposer() {}, companion: c, setCompanion: setC,
    };
    return <ResearchProvider value={scope}><SourcesPane initialMode="library" /></ResearchProvider>;
  }
  let renderer: ReturnType<typeof create>;
  await act(() => { renderer = create(<Host />); });
  t.after(() => act(() => renderer!.unmount()));
  const root = renderer!.root;
  (document as any).querySelector = (selector: string) => selector.startsWith("[data-sources-reader=") && root.findAllByProps({ className: "doc-host" }).length
    ? { closest: () => ({ classList: { contains: (name: string) => name === "active" } }) }
    : null;
  const keydown = async (key: string, options: Record<string, unknown> = {}) => {
    const event: any = {
      key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, defaultPrevented: false,
      target: { closest: () => null }, preventDefault() { this.defaultPrevented = true; }, ...options,
    };
    await act(async () => { for (const handler of keyHandlers) handler(event); });
    return event;
  };
  const text = (n: any): string => (typeof n === "string" ? n : (n.children ?? []).map(text).join(""));
  const list = () => root.findByProps({ role: "listbox", "aria-label": "Sources" });
  const press = (key: string, meta = false) =>
    act(async () => {
      const el = list();
      el.props.onKeyDown({ key, metaKey: meta, target: el, currentTarget: el, preventDefault() {}, stopPropagation() {} });
      await new Promise((r) => setTimeout(r, 5));
    });
  const selected = () => root.findAll((n) => n.props.role === "option" && n.props["aria-selected"] === true && typeof n.type === "string").map((n) => n.props.id);

  await press("ArrowDown");
  await press("Enter");
  assert.equal(companion.active, "a1");
  const back = root.findByProps({ "aria-label": "Back to sources" });
  assert.match(text(back), /Sources.*Esc/);
  await keydown("ArrowUp", { metaKey: true });
  assert.ok(root.findByProps({ "aria-label": "Back to sources" }), "Command+Up keeps its normal behavior");
  await keydown("Escape", { defaultPrevented: true });
  assert.ok(root.findByProps({ "aria-label": "Back to sources" }), "an inner control can consume Escape");
  await keydown("Escape", { target: { closest: (selector: string) => selector.startsWith("input") ? {} : null } });
  assert.ok(root.findByProps({ "aria-label": "Back to sources" }), "Escape in an editor stays in the paper");
  assert.equal((await keydown("Escape")).defaultPrevented, true);
  assert.ok(list(), "back in the library");
  assert.equal(companion.active, "a1", "the paper stays open as a tab");

  await press("ArrowDown");
  assert.deepEqual(selected(), ["source-row-b2"]);
  await press("Delete");
  assert.equal(writes.length, 0, "plain Delete is not a shortcut");
  await press("Backspace", true);
  assert.deepEqual(writes, [["/artifacts/b2/delete", { revision: 7 }]], "⌘⌫ deletes without a confirmation step");
  assert.deepEqual(selected(), ["source-row-c3"], "selection moves to the next source");
  assert.match(text(root.findByProps({ role: "status", className: "notice undo" })), /Deleted Vera-Marun 2026\.pdf/);
});
