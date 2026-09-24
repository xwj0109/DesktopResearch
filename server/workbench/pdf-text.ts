/** Server-side PDF text extraction for workbench tools (no window needed).
 *
 * pdf.js runs in-process with its worker bundled; text extraction never
 * renders, so a minimal DOMMatrix stand-in is enough when the optional native
 * canvas package is absent (as in the bundled backend). Pages are cached per
 * immutable artifact hash. */

let lib: Promise<any> | undefined;
async function pdfjs() {
  return (lib ??= (async () => {
    (globalThis as any).DOMMatrix ??= class DOMMatrix {
      a = 1; b = 0; c = 0; d = 1; e = 0; f = 0;
      multiplySelf() { return this; }
      preMultiplySelf() { return this; }
      translateSelf() { return this; }
      scaleSelf() { return this; }
      invertSelf() { return this; }
      translate() { return this; }
      scale() { return this; }
    };
    const worker = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
    (globalThis as any).pdfjsWorker ??= worker;
    return import("pdfjs-dist/legacy/build/pdf.mjs");
  })());
}

interface Doc {
  pages: number;
  text: Map<number, string[]>;
  doc: any;
}
const MAX_DOCS = 3;
export class PdfText {
  private docs = new Map<string, Promise<Doc>>();
  private async open(hash: string, bytes: () => Buffer): Promise<Doc> {
    let entry = this.docs.get(hash);
    if (!entry) {
      entry = (async () => {
        const { getDocument } = await pdfjs();
        const doc = await getDocument({
          data: new Uint8Array(bytes()),
          isEvalSupported: false,
          disableFontFace: true,
          useSystemFonts: false,
          verbosity: 0,
        }).promise;
        return { pages: doc.numPages, text: new Map(), doc };
      })();
      this.docs.set(hash, entry);
      entry.catch(() => this.docs.delete(hash));
      while (this.docs.size > MAX_DOCS) {
        const [oldest, old] = this.docs.entries().next().value!;
        this.docs.delete(oldest);
        void old.then((d) => d.doc.destroy()).catch(() => {});
      }
    }
    return entry;
  }
  async pageCount(hash: string, bytes: () => Buffer) {
    return (await this.open(hash, bytes)).pages;
  }
  /** Text-layer pieces of one page (the same pieces the viewer matches against). */
  async pieces(hash: string, bytes: () => Buffer, page: number): Promise<string[]> {
    const d = await this.open(hash, bytes);
    if (!Number.isInteger(page) || page < 1 || page > d.pages)
      throw new Error(`Page ${page} is outside this PDF (${d.pages} pages).`);
    let pieces = d.text.get(page);
    if (!pieces) {
      const content = await (await d.doc.getPage(page)).getTextContent();
      pieces = content.items.map((i: any) => i.str ?? "");
      d.text.set(page, pieces!);
    }
    return pieces!;
  }
  async close() {
    for (const entry of this.docs.values()) void entry.then((d) => d.doc.destroy()).catch(() => {});
    this.docs.clear();
  }
}
