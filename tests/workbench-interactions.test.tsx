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
  await act(() => x.byLabel("Search commands").props.onChange({ target: { value: "go to sources" } }));
  const options = x.root.findAllByProps({ role: "option" });
  assert.equal(options.length, 1);
  await act(() => options[0].props.onClick());
  assert.equal(x.root.findByProps({ id: "pane-tab-sources" }).props["aria-selected"], true);
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

test("Literature focus: pick a pursued idea, then sections, keys and new papers apply to it; the overview lists pursued ideas", async (t) => {
  const { ResearchProvider } = await import("../src/workbench/research");
  const { SourcesPane } = await import("../src/workbench/panes/SourcesPane");
  const { researchRequest } = await import("../desktop/research-routes");
  const paper = (id: string, name: string) => ({ id, name, hash: id.padEnd(64, "0"), bytes: 2048, kind: "pdf", mime: "application/pdf", created: "2026-09-24T10:00:00Z" });
  const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222";
  const artifacts = [paper("a1", "Busseti 2016.pdf"), paper("b2", "Vera-Marun 2026.pdf"), paper("c3", "Kardaras 2012.pdf")];
  const pursued = [
    {
      target: `r:${A}`, title: "Kelly with a drawdown cap", version: 3, pursuedOnVersion: 1, reason: "Clean test", pendingEdits: false, ranks: { c3: "primary", a1: "secondary" },
      coverage: { papers: { primary: 1, secondary: 1, withNotes: 1 }, notes: { supports: 2, contradicts: 0, refines: 1, unclassified: 0, total: 3 }, stale: 0, gaps: [{ code: "no-contradicting", text: "Supporting evidence only: nothing contradicts it yet" }], next: "Look for evidence that could contradict it" },
    },
    {
      target: `r:${B}`, title: "Vol-managed crypto", version: 1, pursuedOnVersion: 1, reason: "Cheap data", pendingEdits: true, ranks: {},
      coverage: { papers: { primary: 0, secondary: 0, withNotes: 0 }, notes: { supports: 0, contradicts: 0, refines: 0, unclassified: 0, total: 0 }, stale: 0, gaps: [{ code: "no-papers", text: "No primary or secondary papers yet" }, { code: "no-evidence", text: "No evidence noted yet" }], next: "Find papers for this idea" },
    },
  ];
  const writes: any[] = [];
  const drafts: Record<string, string> = {};
  let bump = () => {};
  function Host() {
    const [, setN] = React.useState(0);
    bump = () => setN((n) => n + 1);
    const scope: any = {
      client: { bytes: () => new Promise(() => {}), read: async () => ({}), write: async (path: string, body: any) => (writes.push([path, body]), body), bridge: {} },
      portfolio: false, stage: "literature", view: { artifacts, annotations: [], batches: [], importance: { b2: "primary" }, pursued }, loadError: "",
      refresh: async () => {}, drafts, setDraft: (k: string, v: string) => ((drafts[k] = v), bump()), setComposer() {}, appendComposer() {},
      companion: { open: [], pinned: [], active: null }, setCompanion() {},
    };
    return <ResearchProvider value={scope}><SourcesPane initialMode="library" /></ResearchProvider>;
  }
  let renderer: ReturnType<typeof create>;
  await act(() => { renderer = create(<Host />); });
  t.after(() => act(() => renderer!.unmount()));
  const root = renderer!.root;
  const text = (n: any): string => (typeof n === "string" ? n : (n.children ?? []).map(text).join(""));
  const host = (n: any) => typeof n.type === "string";
  const groups = () => root.findAll((n) => n.props.role === "group" && host(n)).map((n) => n.props["aria-label"]);
  const order = () => root.findAll((n) => n.props.role === "option" && host(n)).map((n) => n.props.id.replace("source-row-", ""));
  const list = () => root.findByProps({ role: "listbox", "aria-label": "Sources" });
  const press = (key: string) => act(async () => { const el = list(); el.props.onKeyDown({ key, target: el, currentTarget: el, preventDefault() {}, stopPropagation() {} }); });

  // Overview: pursued ideas with their counts; the library keeps its library-wide sections.
  const overview = root.findByProps({ role: "list", "aria-label": "Pursued ideas" });
  assert.match(text(overview), /Kelly with a drawdown cap.*v3.*2 papers · 3 notes: 2 supports, 1 refines.*Look for evidence that could contradict it/);
  assert.match(text(overview), /Vol-managed crypto.*v1 · edits.*0 papers · 0 notes.*Find papers for this idea/);
  const tabs = () => root.findAll((n) => n.type === "button" && n.props.role === "tab" && n.parent?.props["aria-label"] === "Literature focus idea").map((n) => [text(n).trim(), n.props["aria-selected"]]);
  assert.deepEqual(tabs(), [["All ideas 2", true], ["Kelly with a drawdown cap", false], ["Vol-managed crypto", false]]);
  assert.deepEqual(groups(), ["Primary sources · 1", "Other sources · 2"]);

  // Focus an idea from the overview: its ranks drive the sections.
  await act(async () => overview.findAll((n) => n.type === "button")[0].props.onClick());
  assert.equal(drafts["idea:current"], `r:${A}`, "the focus is the window's current idea");
  assert.deepEqual(tabs()[1], ["Kelly with a drawdown cap", true]);
  assert.match(text(root.findByProps({ "aria-label": "Literature focus" })), /v3 · pursued since v1.*“Clean test”.*2 papers · 3 notes.*Next: Look for evidence that could contradict it/, "the focused idea shows its evidence and one next step");
  assert.deepEqual(groups(), ["Primary sources · 1", "Secondary sources · 1", "Other sources · 1"]);
  assert.deepEqual(order(), ["c3", "a1", "b2"]);

  // Keys rank for the focus idea, never library-wide.
  await press("ArrowDown");
  await press("End");
  await press("1");
  assert.deepEqual(writes.at(-1), ["/native/source-importance", { artifactId: "b2", importance: "primary", idea: `r:${A}` }]);

  // Back to the overview via the "All ideas" tab.
  await act(async () => root.find((n) => n.type === "button" && n.props.role === "tab" && text(n).startsWith("All ideas")).props.onClick());
  assert.ok(root.findByProps({ role: "list", "aria-label": "Pursued ideas" }));

  // The window may report its focus to agents (desktop allowlist).
  const sid = "12345678-1234-4234-8234-123456789abc";
  const ctx = (q: string) => researchRequest({ kind: "strategy", id: sid }, { path: `/api/strategies/${sid}/native/view-context?${q}`, method: "GET", headers: {} });
  assert.equal(ctx(`active=&page=&idea=&open=&focus=r:${A}`), true);
  assert.equal(ctx(`active=&page=&idea=&open=&focus=`), true);
  assert.equal(ctx(`active=&page=&idea=&open=`), true, "older windows without focus still work");
  assert.equal(ctx(`active=&page=&idea=&open=&focus=d:${A}`), false, "only saved ideas");
});

test("reading in Literature with a focus: notes get stance buttons for the focus idea, new notes link to it, other links show as chips", async (t) => {
  const { ResearchProvider } = await import("../src/workbench/research");
  const { SourcesPane } = await import("../src/workbench/panes/SourcesPane");
  const { NativeDocument } = await import("../src/workbench/NativeDocument");
  const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222";
  const art = { id: "a1", name: "Busseti 2016.pdf", hash: "a".repeat(64), bytes: 2048, kind: "pdf", mime: "application/pdf", created: "2026-09-24T10:00:00Z" };
  const note = (id: string, quote: string) => ({ id, artifactId: "a1", hash: art.hash, anchor: { page: 2, quote, rotation: 0 }, comment: "Highlight", status: "draft", author: "x", created: "2026-09-24T10:00:00Z", updated: "2026-09-24T10:00:00Z", version: 1 });
  let annotations = [note("n1", "linear drawdown constraint"), note("n2", "growth optimal")];
  const pursued = [{ target: `r:${A}`, title: "Kelly with a drawdown cap", version: 3, pursuedOnVersion: 1, reason: "Clean", pendingEdits: false, ranks: {} }];
  const setDrafts: [string, string][] = [], stages: [string, string | undefined][] = [];
  const noteLinks: any = { n1: { [A]: { stance: "supports", version: 1, hash: "b".repeat(64), at: "2026-09-24T10:00:00Z" }, [B]: { stance: "contradicts", version: 2, hash: "c".repeat(64), at: "2026-09-24T10:00:00Z" } } };
  const writes: any[] = [];
  function Host() {
    const scope: any = {
      client: {
        bytes: () => new Promise(() => {}),
        read: async () => ({ revision: 4, annotations }),
        write: async (path: string, body: any) => {
          writes.push([path, body]);
          if (path === "/annotations") {
            annotations = [...annotations, note("n3", body.annotation.anchor.quote)];
            return { annotations };
          }
          return body;
        },
        bridge: {},
      },
      portfolio: false, stage: "literature", loadError: "",
      view: { artifacts: [art], annotations, batches: [], pursued, noteLinks, ideaTitles: { [A]: "Kelly with a drawdown cap", [B]: "Vol-managed crypto" }, science: { state: { versions: [{ kind: "idea", id: B, version: 2 }] } } },
      refresh: async () => {}, drafts: { "literature:focus": `r:${A}` }, setDraft: (k: string, v: string) => setDrafts.push([k, v]), setComposer() {}, appendComposer() {},
      companion: { open: ["a1"], pinned: [], active: "a1" }, setCompanion() {},
      goToStage: (s: string, p?: string) => stages.push([s, p]),
    };
    return <ResearchProvider value={scope}><SourcesPane initialMode="read" /></ResearchProvider>;
  }
  let renderer: ReturnType<typeof create>;
  await act(() => { renderer = create(<Host />); });
  t.after(() => act(() => renderer!.unmount()));
  const root = renderer!.root;
  const text = (n: any): string => (typeof n === "string" ? n : (n.children ?? []).map(text).join(""));
  const noteEl = (id: string) => root.find((n) => n.type === "article" && n.props.id === `note-${id}`);
  const stanceGroup = (id: string) => noteEl(id).find((n) => n.props.role === "group");

  assert.equal(root.find((n) => n.type === "button" && n.props.role === "tab" && n.props["aria-selected"] === true && n.parent?.props["aria-label"] === "Literature focus idea").props.title, "Kelly with a drawdown cap · v3", "the focus stays visible while reading");
  // n1: supports the focus idea (judged on v1, idea now v3) + a chip for the other idea.
  const g1 = stanceGroup("n1");
  assert.match(text(g1), /Kelly with a drawdown capv1→v3/);
  assert.equal(g1.find((n) => n.type === "button" && text(n) === "supports").props["aria-pressed"], true);
  assert.match(text(noteEl("n1")), /contradicts · Vol-managed crypto/);
  // n2: not linked yet; a stance click links it with that stance.
  assert.match(text(stanceGroup("n2")), /link: Kelly/);
  await act(async () => stanceGroup("n2").find((n) => n.type === "button" && text(n) === "refines").props.onClick());
  assert.deepEqual(writes.at(-1), ["/native/note-links", { noteId: "n2", idea: `r:${A}`, stance: "refines" }]);
  // Clicking the active stance clears it (keeps the link); × unlinks.
  await act(async () => g1.find((n) => n.type === "button" && text(n) === "supports").props.onClick());
  assert.deepEqual(writes.at(-1)[1], { noteId: "n1", idea: `r:${A}`, stance: "unclassified" });
  await act(async () => g1.find((n) => n.props["aria-label"] === "Unlink from Kelly with a drawdown cap").props.onClick());
  assert.deepEqual(writes.at(-1)[1], { noteId: "n1", idea: `r:${A}`, stance: "none" });

  // "this idea" filter lists the notes linked to the focus idea.
  const filter = root.find((n) => n.type === "button" && n.props.role === "tab" && text(n).startsWith("this idea"));
  assert.match(text(filter), /this idea 1/);

  // A new highlight made during the focus is linked to it (stance to be judged).
  const doc = root.findByType(NativeDocument);
  await act(async () => { await doc.props.onAnnotate({ artifactId: "a1", anchor: { page: 1, quote: "new passage", rotation: 0 }, comment: "Highlight", status: "draft" }); });
  assert.deepEqual(writes.slice(-2).map((w) => w[0]), ["/annotations", "/native/note-links"]);
  assert.deepEqual(writes.at(-1)[1], { noteId: "n3", idea: `r:${A}`, stance: "unclassified" });
  // Editing an existing note never creates links.
  const n = writes.length;
  await act(async () => { await doc.props.onAnnotate({ id: "n2", artifactId: "a1", anchor: { page: 2, quote: "growth optimal", rotation: 0 }, comment: "Edited", status: "draft" }); });
  assert.deepEqual(writes.slice(n).map((w) => w[0]), ["/annotations"]);

  // "Revise idea": the note goes into the focus idea as an unsaved revision, and Ideas opens it.
  const revise = noteEl("n1").find((x) => x.type === "button" && text(x) === "Revise idea");
  await act(async () => {
    revise.props.onClick();
    await new Promise((r) => setTimeout(r, 5));
  });
  assert.deepEqual(writes.at(-1), ["/native/idea-note", { noteId: "n1", idea: `r:${A}`, show: false }]);
  assert.deepEqual(setDrafts.at(-1), ["ideas:active", `r:${A}`]);
  assert.deepEqual(stages.at(-1), ["ideas", "idea"]);
});

test("Research Development: the bar says which idea is developed; Files, Changes (checkpoint) and Documents read its workspace", async (t) => {
  const { ResearchProvider } = await import("../src/workbench/research");
  const { ResearchIdeaBar, FilesPane, ChangesPane, DocumentsPane, developingIdea } = await import("../src/workbench/panes/ResearchDev");
  const A = "r:11111111-1111-4111-8111-111111111111", B = "r:22222222-2222-4222-8222-222222222222";
  const pursued = [
    { target: A, title: "Robust age-invariant Kelly", version: 2, pursuedOnVersion: 1, reason: "Clean test", pendingEdits: false },
    { target: B, title: "Vol-managed crypto", version: 1, pursuedOnVersion: 1, reason: "Cheap data", pendingEdits: false },
  ];
  const files = [
    { path: "README.md", bytes: 90, modified: "2026-09-25T08:00:00Z", kind: "text", document: true },
    { path: "report.md", bytes: 40, modified: "2026-09-25T10:00:00Z", kind: "text", document: true },
    { path: "src/kelly.py", bytes: 50, modified: "2026-09-25T09:00:00Z", kind: "text", document: false },
    { path: "figs/equity.png", bytes: 5, modified: "2026-09-25T11:00:00Z", kind: "image", document: true },
  ];
  const reads: string[] = [], writes: any[] = [];
  const drafts: Record<string, string> = {};
  let bump = () => {};
  function Host() {
    const [, setN] = React.useState(0);
    bump = () => setN((n) => n + 1);
    const scope: any = {
      client: {
        read: async (p: string) => {
          reads.push(p);
          if (p.startsWith("/native/rd/files")) return { idea: A, files };
          if (p.startsWith("/native/rd/file?")) {
            const path = decodeURIComponent(p.split("&path=")[1]);
            return path.endsWith(".png") ? { path, kind: "image", bytes: 5, mime: "image/png", base64: "iVBORw0K" } : { path, kind: "text", bytes: 10, text: path === "report.md" ? "# Result\n\nGrowth is **linear**." : "def kelly(mu, var):\n    return mu / var\n" };
          }
          if (p.startsWith("/native/rd/changes")) return { files: [{ path: "src/kelly.py", status: "M", added: 1, removed: 1, binary: false }], added: 1, removed: 1 };
          if (p.startsWith("/native/rd/diff")) return { path: "src/kelly.py", diff: "diff --git a/src/kelly.py b/src/kelly.py\n--- a/src/kelly.py\n+++ b/src/kelly.py\n@@ -1,2 +1,2 @@\n def kelly(mu, var):\n-    return mu / var\n+    return min(0.5, mu / var)\n", truncated: false, binary: false };
          if (p.startsWith("/native/rd/history")) return p.includes("&sha=") ? { sha: "a".repeat(40), files: [{ path: "README.md", status: "A", added: 1, removed: 0, binary: false }], added: 1, removed: 0 } : { checkpoints: [{ sha: "a".repeat(40), at: "2026-09-25T07:00:00Z", message: "Workspace created", stat: "2 files changed" }] };
          return {};
        },
        write: async (p: string, body: any) => (writes.push([p, body]), { sha: "b".repeat(40), at: "2026-09-25T12:00:00Z", message: body.message, stat: "" }),
        bridge: {},
      },
      portfolio: false, stage: "research", loadError: "", view: { artifacts: [], annotations: [], batches: [], pursued },
      refresh: async () => {}, drafts, setDraft: (k: string, v: string) => ((drafts[k] = v), bump()), setComposer() {}, appendComposer() {},
      companion: { open: [], pinned: [], active: null }, setCompanion() {},
    };
    return (
      <ResearchProvider value={scope}>
        <ResearchIdeaBar />
        <FilesPane />
        <ChangesPane />
        <DocumentsPane />
      </ResearchProvider>
    );
  }
  let renderer: ReturnType<typeof create>;
  await act(async () => { renderer = create(<Host />); await new Promise((r) => setTimeout(r, 10)); });
  t.after(() => act(() => renderer!.unmount()));
  const root = renderer!.root;
  const text = (n: any): string => (typeof n === "string" ? n : (n.children ?? []).map(text).join(""));
  const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 10)); });

  // The whole stage states which idea it develops (default: the first pursued idea).
  assert.equal(developingIdea({ pursued }, {})?.target, A);
  const bar = root.findByProps({ "aria-label": "Idea in development" });
  assert.match(text(bar), /developing.*Robust age-invariant Kelly.*Vol-managed crypto.*v2 · pursued since v1/);

  // Files: folders first, README shown by default; clicking a file views it.
  const tree = root.findByProps({ "aria-label": "Workspace files" });
  assert.deepEqual(tree.findAll((n) => n.type === "button").map((b) => text(b).trim()), ["▾ figs/", "▧ equity.png", "▾ src/", "λ kelly.py", "≡ README.md", "≡ report.md"]);
  await act(async () => tree.findAll((n) => n.type === "button").find((b) => text(b).includes("kelly.py"))!.props.onClick());
  await settle();
  assert.ok(reads.some((r) => r === `/native/rd/file?idea=${A}&path=src%2Fkelly.py`));

  // Changes: files with counts, the selected file's diff, and recording a checkpoint.
  assert.match(text(root.findByProps({ className: "summary" })), /1 file · \+1 −1 since “Workspace created”/);
  assert.match(text(root.findByProps({ "aria-label": "Changed files" })), /src\/.*M.*kelly\.py.*\+1.*−1/);
  assert.match(text(root.findByProps({ className: "chg-lines" })), /-    return mu \/ var.*\+    return min\(0\.5, mu \/ var\)/);
  const input = root.findByProps({ "aria-label": "Checkpoint message" });
  await act(async () => input.props.onChange({ target: { value: "Cap the Kelly fraction" } }));
  await act(async () => { root.findByProps({ className: "rd-checkpoint" }).props.onSubmit({ preventDefault() {} }); await new Promise((r) => setTimeout(r, 10)); });
  assert.deepEqual(writes.at(-1), ["/native/rd/checkpoint", { idea: A, message: "Cap the Kelly fraction" }]);

  // Documents: produced documents, newest first (README excluded); the newest is shown.
  const docs = root.findByProps({ "aria-label": "Documents" });
  assert.deepEqual(docs.findAll((n) => n.type === "button").map((b) => b.props.title), ["figs/equity.png", "report.md"]);

  // Choosing another idea switches every pane to its workspace.
  await act(async () => root.findByProps({ "aria-label": "Idea to develop" }).findAll((n) => n.type === "button")[1].props.onClick());
  assert.equal(drafts["idea:current"], B, "one current idea for the window");
  await settle();
  assert.ok(reads.some((r) => r === `/native/rd/files?idea=${B}`));
});

test("Research Development Data tab: snapshots with a chart and table, fetching in the background with progress and cancel", async (t) => {
  const { ResearchProvider } = await import("../src/workbench/research");
  const { DataSnapshotsPane } = await import("../src/workbench/panes/DataSnapshots");
  const snap = { name: "binance-btcusdt-1m-2024-01-01-2024-12-31", title: "binance BTCUSDT 1m 2024", file: "binance-btcusdt-1m-2024-01-01-2024-12-31.parquet", format: "parquet", source: { kind: "binance", symbol: "BTCUSDT", interval: "1m" }, query: { start: "2024-01-01", end: "2024-12-31" }, createdAt: "2026-09-25T10:00:00Z", rows: 527040, columns: ["time", "open", "high", "low", "close", "volume"], first: "2024-01-01T00:00:00.000Z", last: "2024-12-31T23:59:00.000Z", bytes: 21_000_000, sha256: "c".repeat(64) };
  const row = (i: number) => [`2024-01-01T00:0${i}:00.000Z`, "100", "101", "99", String(100 + i), "5"];
  const preview = { ...snap, preview: { head: Array.from({ length: 20 }, (_, i) => row(i % 10)), tail: Array.from({ length: 20 }, (_, i) => row(i % 10)), series: [["2024-01-01", 42000], ["2024-06-01", 67000], ["2024-12-31", 93000]], valueColumn: "close" } };
  let jobs: any[] = [];
  const writes: any[] = [];
  function Host() {
    const scope: any = {
      client: {
        read: async (p: string) => (p === "/native/data/snapshots" ? { snapshots: [snap] } : p === "/native/data/jobs" ? { jobs } : p.startsWith("/native/data/preview") ? preview : {}),
        write: async (p: string, body: any) => {
          writes.push([p, body]);
          if (p === "/native/data/fetch") jobs = [{ id: "j1", title: "binance ETHUSDT 1m", status: "running", rows: 120000, progress: 0.4, message: "Fetched 120,000 bars, up to 2024-03-12" }];
          return {};
        },
        bridge: {},
      },
      portfolio: false, stage: "research", loadError: "", view: { artifacts: [], annotations: [], batches: [], pursued: [{ target: "r:11111111-1111-4111-8111-111111111111", title: "Kelly", version: 1, pursuedOnVersion: 1, reason: "x", pendingEdits: false }] },
      refresh: async () => {}, drafts: {}, setDraft() {}, setComposer() {}, appendComposer() {},
      companion: { open: [], pinned: [], active: null }, setCompanion() {},
    };
    return <ResearchProvider value={scope}><DataSnapshotsPane /></ResearchProvider>;
  }
  let renderer: ReturnType<typeof create>;
  await act(async () => { renderer = create(<Host />); await new Promise((r) => setTimeout(r, 20)); });
  t.after(() => act(() => renderer!.unmount()));
  const root = renderer!.root;
  const text = (n: any): string => (typeof n === "string" ? n : (n.children ?? []).map(text).join(""));

  assert.match(text(root.findByProps({ "aria-label": "Data snapshots" })), /binance BTCUSDT 1m 2024.*binance BTCUSDT · 1m · 527,040 rows/);
  const detail = root.findByProps({ className: "rd-viewer-body data-detail" });
  assert.match(text(detail), /527,040.*2024-01-01 00:00 → 2024-12-31 23:59.*time, open, high, low, close, volume.*data\/binance-btcusdt-1m-2024-01-01-2024-12-31\.parquet · 20\.0 MiB/);
  assert.match(text(detail), /pl\.read_parquet\("data\/binance-btcusdt-1m-2024-01-01-2024-12-31\.parquet"\)/);
  const { polarsSnippet } = await import("../src/workbench/panes/DataSnapshots");
  assert.equal(polarsSnippet({ file: "binance-um-trades-btcusdt-2025-01-01-2025-01-31/" }), 'pl.scan_parquet("data/binance-um-trades-btcusdt-2025-01-01-2025-01-31/*.parquet")', "tick folders are scanned lazily");
  assert.ok(root.findByProps({ className: "line" }).props.d.startsWith("M"), "the series is charted");
  assert.match(text(detail), /… 527,024 more rows …/, "first and last rows as a table");

  // Fetch in the background (bars via the API here; the archive is the default source).
  await act(async () => root.findAll((n) => n.type === "button" && text(n) === "+ Fetch data")[0].props.onClick());
  const form = root.findByProps({ "aria-label": "Fetch data" });
  assert.equal(form.findAll((n) => n.type === "select")[0].props.value, "binance-archive", "tick-level archive is the default");
  await act(async () => form.findAll((n) => n.type === "select")[0].props.onChange({ target: { value: "binance" } }));
  await act(async () => form.findAll((n) => n.type === "input")[0].props.onChange({ target: { value: "ethusdt" } }));
  await act(async () => { await form.props.onSubmit({ preventDefault() {} }); await new Promise((r) => setTimeout(r, 20)); });
  assert.equal(writes[0][0], "/native/data/fetch");
  assert.deepEqual({ ...writes[0][1], start: "x", end: "x" }, { source: "binance", symbol: "ETHUSDT", interval: "1m", start: "x", end: "x" });
  const job = root.findByProps({ "aria-label": "Fetches" });
  assert.match(text(job), /binance ETHUSDT 1m.*Fetched 120,000 bars, up to 2024-03-12/);
  await act(async () => job.findAll((n) => n.type === "button" && text(n) === "Cancel")[0].props.onClick());
  assert.deepEqual(writes.at(-1), ["/native/data/cancel", { job: "j1" }]);
});

test("the fetch form suggests tickers as you type (from what the chosen market and dataset hold)", async (t) => {
  const { ResearchProvider } = await import("../src/workbench/research");
  const { DataSnapshotsPane } = await import("../src/workbench/panes/DataSnapshots");
  const reads: string[] = [];
  function Host() {
    const scope: any = {
      client: {
        read: async (p: string) => {
          reads.push(p);
          if (p.startsWith("/native/data/symbols")) {
            const q = decodeURIComponent(/q=([^&]*)/.exec(p)![1]);
            const all = ["SOLUSDT", "SOLUSDC", "SOLBTC", "BTCUSDT"].filter((s) => s.startsWith(q));
            return { symbols: all.map((symbol) => ({ symbol })), total: 1234 };
          }
          if (p.startsWith("/native/data/estimate")) return { files: 1, bytes: 1e6, missingCount: 0, freeBytes: 1e12, first: "2025-01-01", last: "2025-01-01" };
          return p === "/native/data/snapshots" ? { snapshots: [] } : { jobs: [] };
        },
        write: async () => ({}),
        bridge: {},
      },
      portfolio: false, stage: "research", loadError: "", view: { artifacts: [], annotations: [], batches: [], pursued: [] },
      refresh: async () => {}, drafts: {}, setDraft() {}, setComposer() {}, appendComposer() {}, companion: { open: [], pinned: [], active: null }, setCompanion() {},
    };
    return <ResearchProvider value={scope}><DataSnapshotsPane /></ResearchProvider>;
  }
  let renderer: ReturnType<typeof create>;
  await act(async () => { renderer = create(<Host />); await new Promise((r) => setTimeout(r, 10)); });
  t.after(() => act(() => renderer!.unmount()));
  const root = renderer!.root;
  const text = (n: any): string => (typeof n === "string" ? n : (n.children ?? []).map(text).join(""));
  await act(async () => root.findAll((n) => n.type === "button" && text(n) === "+ Fetch data")[0].props.onClick());
  const input = () => root.findByProps({ role: "combobox" });
  await act(async () => { input().props.onFocus(); });
  await act(async () => { input().props.onChange({ target: { value: "sol" } }); });
  await act(async () => { await new Promise((r) => setTimeout(r, 250)); });
  assert.ok(reads.some((r) => r === "/native/data/symbols?source=binance-archive&q=SOL&market=um&dataset=trades"), `asks for the chosen market and dataset: ${reads.filter((r) => r.includes("symbols")).join(" ")}`);
  const list = () => root.findByProps({ role: "listbox", "aria-label": "Ticker suggestions" });
  assert.deepEqual(list().findAll((n) => n.props.role === "option").map((o) => text(o)), ["SOLUSDT", "SOLUSDC", "SOLBTC"]);
  assert.match(text(list()), /1,234 tickers/);
  await act(async () => input().props.onKeyDown({ key: "ArrowDown", preventDefault() {} }));
  await act(async () => input().props.onKeyDown({ key: "Enter", preventDefault() {} }));
  assert.equal(input().props.value, "SOLUSDC", "↓ then Enter picks the second suggestion");
  assert.equal(root.findAll((n) => n.props.role === "listbox" && n.props["aria-label"] === "Ticker suggestions").length, 0, "the list closes");
});

test("deleting a data snapshot asks first, shows the code that reads it, and frees the space", async (t) => {
  const { ResearchProvider } = await import("../src/workbench/research");
  const { DataSnapshotsPane } = await import("../src/workbench/panes/DataSnapshots");
  const A = "r:11111111-1111-4111-8111-111111111111";
  let snaps = [
    { name: "ticks", title: "DOGE ticks", file: "ticks/", format: "parquet", source: { kind: "binance-archive", market: "spot", dataset: "trades", symbol: "DOGEUSDT" }, createdAt: "2026-09-25T10:00:00Z", rows: 2620129, columns: ["id", "price"], bytes: 15_500_000, sha256: "a".repeat(64), files: 1 },
    { name: "fred", title: "DGS10", file: "fred.parquet", format: "parquet", source: { kind: "fred", symbol: "DGS10" }, createdAt: "2026-09-24T10:00:00Z", rows: 259, columns: ["date", "value"], bytes: 1000, sha256: "b".repeat(64) },
  ];
  const writes: any[] = [];
  function Host() {
    const scope: any = {
      client: {
        read: async (p: string) =>
          p === "/native/data/snapshots" ? { snapshots: snaps } : p === "/native/data/jobs" ? { jobs: [] } : p.startsWith("/native/data/preview?name=") ? { ...snaps.find((s) => s.name === p.split("=")[1]), references: p.endsWith("=ticks") ? [{ idea: A, path: "src/fit.py" }] : [] } : {},
        write: async (p: string, body: any) => {
          writes.push([p, body]);
          snaps = snaps.filter((s) => s.name !== body.name);
          return { deleted: body.name, bytes: 15_500_000, references: [] };
        },
        bridge: {},
      },
      portfolio: false, stage: "research", loadError: "", view: { artifacts: [], annotations: [], batches: [], pursued: [{ target: A, title: "Microstructure", version: 1, pursuedOnVersion: 1, reason: "x", pendingEdits: false }] },
      refresh: async () => {}, drafts: {}, setDraft() {}, setComposer() {}, appendComposer() {}, companion: { open: [], pinned: [], active: null }, setCompanion() {},
    };
    return <ResearchProvider value={scope}><DataSnapshotsPane /></ResearchProvider>;
  }
  let renderer: ReturnType<typeof create>;
  await act(async () => { renderer = create(<Host />); await new Promise((r) => setTimeout(r, 20)); });
  t.after(() => act(() => renderer!.unmount()));
  const root = renderer!.root;
  const text = (n: any): string => (typeof n === "string" ? n : (n.children ?? []).map(text).join(""));
  // ⌘⌫ in the list opens the confirmation (never deletes directly).
  await act(async () => { root.findByProps({ "aria-label": "Data snapshots" }).props.onKeyDown({ metaKey: true, key: "Backspace", preventDefault() {} }); await new Promise((r) => setTimeout(r, 20)); });
  const confirm = root.findByProps({ role: "alertdialog" });
  assert.match(text(confirm), /Delete “DOGE ticks” for good\? Frees 14\.8 MiB/);
  assert.match(text(confirm), /Code that reads it will stop working:.*Microstructure · src\/fit\.py/);
  assert.equal(writes.length, 0);
  await act(async () => { confirm.findAll((n) => n.type === "button" && text(n) === "Delete for good")[0].props.onClick(); await new Promise((r) => setTimeout(r, 20)); });
  assert.deepEqual(writes, [["/native/data/delete", { name: "ticks" }]]);
  assert.match(text(root.findByProps({ role: "status" })), /Deleted “DOGE ticks” · freed 14\.8 MiB/);
  assert.deepEqual(root.findByProps({ "aria-label": "Data snapshots" }).findAll((n) => n.type === "button").map((b) => b.props.title), ["fred.parquet"], "the next snapshot is selected");
  // Cancel keeps it.
  await act(async () => { root.findAll((n) => n.type === "button" && text(n) === "Delete…")[0].props.onClick(); await new Promise((r) => setTimeout(r, 20)); });
  assert.match(text(root.findByProps({ role: "alertdialog" })), /No code in the idea workspaces mentions data\/fred\.parquet/);
  await act(async () => root.findByProps({ role: "alertdialog" }).findAll((n) => n.type === "button" && text(n) === "Cancel")[0].props.onClick());
  assert.equal(root.findAll((n) => n.props.role === "alertdialog").length, 0);
  assert.equal(writes.length, 1);
});

test("Changes: many files grouped by folder with counts; one file's diff at a time; past checkpoints from the selector", async (t) => {
  const { ResearchProvider } = await import("../src/workbench/research");
  const { ChangesPane } = await import("../src/workbench/panes/ResearchDev");
  const files = [
    { path: ".gitignore", status: "M", added: 1, removed: 0, binary: false },
    { path: "analysis/oos_paths.csv", status: "A", added: 120000, removed: 0, binary: false },
    { path: "analysis/equity.png", status: "A", added: 0, removed: 0, binary: true },
    { path: "analysis/report.md", status: "A", added: 40, removed: 0, binary: false },
    { path: "walkforward.py", status: "A", added: 300, removed: 0, binary: false },
  ];
  const reads: string[] = [];
  function Host() {
    const scope: any = {
      client: {
        read: async (p: string) => {
          reads.push(p);
          if (p.startsWith("/native/rd/changes")) return { files, added: 120341, removed: 0 };
          if (p.startsWith("/native/rd/diff")) {
            const path = decodeURIComponent(/path=([^&]+)/.exec(p)![1]);
            return { path, diff: `diff --git a/${path} b/${path}\n@@ -0,0 +1 @@\n+line of ${path}\n`, truncated: path.endsWith(".csv"), binary: false };
          }
          if (p.startsWith("/native/rd/file")) return { path: "analysis/equity.png", kind: "image", mime: "image/png", base64: "iVBORw0K" };
          if (p.includes("&sha=")) return { sha: "a".repeat(40), files: [{ path: "README.md", status: "A", added: 3, removed: 0, binary: false }], added: 3, removed: 0 };
          return { checkpoints: [{ sha: "a".repeat(40), at: "2026-09-25T07:00:00Z", message: "Workspace created", stat: "" }] };
        },
        write: async () => ({}),
        bridge: {},
      },
      portfolio: false, stage: "research", loadError: "", view: { pursued: [{ target: "r:11111111-1111-4111-8111-111111111111", title: "K", version: 1, pursuedOnVersion: 1, reason: "x", pendingEdits: false }] },
      refresh: async () => {}, drafts: {}, setDraft() {}, setComposer() {}, appendComposer() {}, companion: { open: [], pinned: [], active: null }, setCompanion() {},
    };
    return <ResearchProvider value={scope}><ChangesPane /></ResearchProvider>;
  }
  let renderer: ReturnType<typeof create>;
  await act(async () => { renderer = create(<Host />); await new Promise((r) => setTimeout(r, 20)); });
  t.after(() => act(() => renderer!.unmount()));
  const root = renderer!.root;
  const text = (n: any): string => (typeof n === "string" ? n : (n.children ?? []).map(text).join(""));
  const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  assert.match(text(root.findByProps({ className: "summary" })), /5 files · \+120,341 −0 since “Workspace created”/);
  const list = () => root.findByProps({ "aria-label": "Changed files" });
  const buttons = () => list().findAll((n) => n.type === "button").map((b) => text(b).replace(/\s+/g, " ").trim());
  assert.deepEqual(buttons(), ["▾ analysis/ 3", "Aoos_paths.csv+120000", "Aequity.pngbin", "Areport.md+40", "M.gitignore+1", "Awalkforward.py+300"], "folders first, with status letters and counts");
  // The first file's diff is shown (capped per file); others load one at a time.
  assert.match(text(root.findByProps({ className: "chg-lines" })), /\+line of analysis\/oos_paths\.csv/);
  assert.match(text(root.findByProps({ className: "rd-viewer chg-diff" })), /Showing the first 512 KiB of this file's diff/);
  await act(async () => list().findAll((n) => n.type === "button").find((b) => text(b).includes("walkforward.py"))!.props.onClick());
  await settle();
  assert.match(text(root.findByProps({ className: "chg-lines" })), /\+line of walkforward\.py/);
  assert.ok(!reads.some((r) => r.includes("path=analysis%2Freport.md")), "unselected files are never fetched");
  // Images show as images.
  await act(async () => list().findAll((n) => n.type === "button").find((b) => text(b).includes("equity.png"))!.props.onClick());
  await settle();
  assert.equal(root.findByProps({ className: "rd-image" }).props.src, "data:image/png;base64,iVBORw0K");
  // Folders fold.
  await act(async () => list().findAll((n) => n.type === "button")[0].props.onClick());
  assert.deepEqual(buttons(), ["▸ analysis/ 3", "M.gitignore+1", "Awalkforward.py+300"]);
  // A past checkpoint: its files, no checkpoint form.
  await act(async () => { root.findByProps({ "aria-label": "Showing" }).props.onChange({ target: { value: "a".repeat(40) } }); await new Promise((r) => setTimeout(r, 20)); });
  assert.deepEqual(buttons(), ["AREADME.md+3"]);
  assert.equal(root.findAll((n) => n.props["aria-label"] === "Checkpoint message").length, 0);
  assert.ok(reads.some((r) => r.includes("/native/rd/diff?") && r.includes("path=README.md") && r.endsWith(`&sha=${"a".repeat(40)}`)));
});

test("the fetch form suggests tickers as you type (from what the chosen market and dataset hold)", async (t) => {
  const { ResearchProvider } = await import("../src/workbench/research");
  const { DataSnapshotsPane } = await import("../src/workbench/panes/DataSnapshots");
  const reads: string[] = [];
  function Host() {
    const scope: any = {
      client: {
        read: async (p: string) => {
          reads.push(p);
          if (p.startsWith("/native/data/symbols")) {
            const q = decodeURIComponent(/q=([^&]*)/.exec(p)![1]);
            const all = ["SOLUSDT", "SOLUSDC", "SOLBTC", "BTCUSDT"].filter((s) => s.startsWith(q));
            return { symbols: all.map((symbol) => ({ symbol })), total: 1234 };
          }
          if (p.startsWith("/native/data/estimate")) return { files: 1, bytes: 1e6, missingCount: 0, freeBytes: 1e12, first: "2025-01-01", last: "2025-01-01" };
          return p === "/native/data/snapshots" ? { snapshots: [] } : { jobs: [] };
        },
        write: async () => ({}),
        bridge: {},
      },
      portfolio: false, stage: "research", loadError: "", view: { artifacts: [], annotations: [], batches: [], pursued: [] },
      refresh: async () => {}, drafts: {}, setDraft() {}, setComposer() {}, appendComposer() {}, companion: { open: [], pinned: [], active: null }, setCompanion() {},
    };
    return <ResearchProvider value={scope}><DataSnapshotsPane /></ResearchProvider>;
  }
  let renderer: ReturnType<typeof create>;
  await act(async () => { renderer = create(<Host />); await new Promise((r) => setTimeout(r, 10)); });
  t.after(() => act(() => renderer!.unmount()));
  const root = renderer!.root;
  const text = (n: any): string => (typeof n === "string" ? n : (n.children ?? []).map(text).join(""));
  await act(async () => root.findAll((n) => n.type === "button" && text(n) === "+ Fetch data")[0].props.onClick());
  const input = () => root.findByProps({ role: "combobox" });
  await act(async () => { input().props.onFocus(); });
  await act(async () => { input().props.onChange({ target: { value: "sol" } }); });
  await act(async () => { await new Promise((r) => setTimeout(r, 250)); });
  assert.ok(reads.some((r) => r === "/native/data/symbols?source=binance-archive&q=SOL&market=um&dataset=trades"), `asks for the chosen market and dataset: ${reads.filter((r) => r.includes("symbols")).join(" ")}`);
  const list = () => root.findByProps({ role: "listbox", "aria-label": "Ticker suggestions" });
  assert.deepEqual(list().findAll((n) => n.props.role === "option").map((o) => text(o)), ["SOLUSDT", "SOLUSDC", "SOLBTC"]);
  assert.match(text(list()), /1,234 tickers/);
  await act(async () => input().props.onKeyDown({ key: "ArrowDown", preventDefault() {} }));
  await act(async () => input().props.onKeyDown({ key: "Enter", preventDefault() {} }));
  assert.equal(input().props.value, "SOLUSDC", "↓ then Enter picks the second suggestion");
  assert.equal(root.findAll((n) => n.props.role === "listbox" && n.props["aria-label"] === "Ticker suggestions").length, 0, "the list closes");
});

test("deleting a data snapshot asks first, shows the code that reads it, and frees the space", async (t) => {
  const { ResearchProvider } = await import("../src/workbench/research");
  const { DataSnapshotsPane } = await import("../src/workbench/panes/DataSnapshots");
  const A = "r:11111111-1111-4111-8111-111111111111";
  let snaps = [
    { name: "ticks", title: "DOGE ticks", file: "ticks/", format: "parquet", source: { kind: "binance-archive", market: "spot", dataset: "trades", symbol: "DOGEUSDT" }, createdAt: "2026-09-25T10:00:00Z", rows: 2620129, columns: ["id", "price"], bytes: 15_500_000, sha256: "a".repeat(64), files: 1 },
    { name: "fred", title: "DGS10", file: "fred.parquet", format: "parquet", source: { kind: "fred", symbol: "DGS10" }, createdAt: "2026-09-24T10:00:00Z", rows: 259, columns: ["date", "value"], bytes: 1000, sha256: "b".repeat(64) },
  ];
  const writes: any[] = [];
  function Host() {
    const scope: any = {
      client: {
        read: async (p: string) =>
          p === "/native/data/snapshots" ? { snapshots: snaps } : p === "/native/data/jobs" ? { jobs: [] } : p.startsWith("/native/data/preview?name=") ? { ...snaps.find((s) => s.name === p.split("=")[1]), references: p.endsWith("=ticks") ? [{ idea: A, path: "src/fit.py" }] : [] } : {},
        write: async (p: string, body: any) => {
          writes.push([p, body]);
          snaps = snaps.filter((s) => s.name !== body.name);
          return { deleted: body.name, bytes: 15_500_000, references: [] };
        },
        bridge: {},
      },
      portfolio: false, stage: "research", loadError: "", view: { artifacts: [], annotations: [], batches: [], pursued: [{ target: A, title: "Microstructure", version: 1, pursuedOnVersion: 1, reason: "x", pendingEdits: false }] },
      refresh: async () => {}, drafts: {}, setDraft() {}, setComposer() {}, appendComposer() {}, companion: { open: [], pinned: [], active: null }, setCompanion() {},
    };
    return <ResearchProvider value={scope}><DataSnapshotsPane /></ResearchProvider>;
  }
  let renderer: ReturnType<typeof create>;
  await act(async () => { renderer = create(<Host />); await new Promise((r) => setTimeout(r, 20)); });
  t.after(() => act(() => renderer!.unmount()));
  const root = renderer!.root;
  const text = (n: any): string => (typeof n === "string" ? n : (n.children ?? []).map(text).join(""));
  // ⌘⌫ in the list opens the confirmation (never deletes directly).
  await act(async () => { root.findByProps({ "aria-label": "Data snapshots" }).props.onKeyDown({ metaKey: true, key: "Backspace", preventDefault() {} }); await new Promise((r) => setTimeout(r, 20)); });
  const confirm = root.findByProps({ role: "alertdialog" });
  assert.match(text(confirm), /Delete “DOGE ticks” for good\? Frees 14\.8 MiB/);
  assert.match(text(confirm), /Code that reads it will stop working:.*Microstructure · src\/fit\.py/);
  assert.equal(writes.length, 0);
  await act(async () => { confirm.findAll((n) => n.type === "button" && text(n) === "Delete for good")[0].props.onClick(); await new Promise((r) => setTimeout(r, 20)); });
  assert.deepEqual(writes, [["/native/data/delete", { name: "ticks" }]]);
  assert.match(text(root.findByProps({ role: "status" })), /Deleted “DOGE ticks” · freed 14\.8 MiB/);
  assert.deepEqual(root.findByProps({ "aria-label": "Data snapshots" }).findAll((n) => n.type === "button").map((b) => b.props.title), ["fred.parquet"], "the next snapshot is selected");
  // Cancel keeps it.
  await act(async () => { root.findAll((n) => n.type === "button" && text(n) === "Delete…")[0].props.onClick(); await new Promise((r) => setTimeout(r, 20)); });
  assert.match(text(root.findByProps({ role: "alertdialog" })), /No code in the idea workspaces mentions data\/fred\.parquet/);
  await act(async () => root.findByProps({ role: "alertdialog" }).findAll((n) => n.type === "button" && text(n) === "Cancel")[0].props.onClick());
  assert.equal(root.findAll((n) => n.props.role === "alertdialog").length, 0);
  assert.equal(writes.length, 1);
});
