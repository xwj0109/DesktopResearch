/** Small stateful editor operations for Pi bindings. Native mouse selection,
 * IME and the platform clipboard remain the browser's responsibility. */
export class EditorActions {
  private kills: string[] = [];
  private yank?: { start: number; end: number; index: number };
  private undo: { text: string; start: number; end: number }[] = [];
  private jump?: boolean;
  private lastAction = "";
  private graphemes = new Intl.Segmenter(undefined, {
    granularity: "grapheme",
  });
  remember(text: string, start: number, end = start) {
    if (this.undo.at(-1)?.text !== text) this.undo.push({ text, start, end });
    if (this.undo.length > 100) this.undo.shift();
  }
  apply(
    action: string,
    text: string,
    start: number,
    end: number,
    character?: string,
  ) {
    const previousAction = this.lastAction;
    this.lastAction = action;
    if (action !== "yankPop" && action !== "yank") this.yank = undefined;
    const before = () =>
      [...this.graphemes.segment(text.slice(0, start))].at(-1)?.index ?? 0;
    const after = () =>
      end +
      ([...this.graphemes.segment(text.slice(end))][0]?.segment.length ?? 0);
    const state = (position: number, value = text) => ({
      text: value,
      start: position,
      end: position,
    });
    const replace = (from: number, to: number, value: string, kill = false) => {
      this.remember(text, start, end);
      if (kill && from !== to) {
        const removed = text.slice(from, to);
        if (previousAction === "kill" && this.kills.length)
          this.kills[0] =
            from < start ? removed + this.kills[0] : this.kills[0] + removed;
        else this.kills.unshift(removed);
        this.kills.length = Math.min(this.kills.length, 32);
        this.lastAction = "kill";
      }
      return state(
        from + value.length,
        text.slice(0, from) + value + text.slice(to),
      );
    };
    if (this.jump !== undefined && character?.length === 1) {
      const position = this.jump
        ? text.indexOf(character, end + 1)
        : text.lastIndexOf(character, start - 1);
      this.jump = undefined;
      return state(position < 0 ? start : position);
    }
    const left = () => {
      const found = /(?:[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]+)?\s*$/u.exec(
        text.slice(0, start),
      );
      return start - (found?.[0].length ?? 0);
    };
    const right = () => {
      const found = /^\s*(?:[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]+)?/u.exec(
        text.slice(end),
      );
      return end + (found?.[0].length ?? 0);
    };
    const lineStart = start === 0 ? 0 : text.lastIndexOf("\n", start - 1) + 1;
    const nextBreak = text.indexOf("\n", end),
      lineEnd = nextBreak < 0 ? text.length : nextBreak;
    switch (action) {
      case "cursorLeft":
        return state(start === end ? before() : start);
      case "cursorRight":
        return state(start === end ? after() : end);
      case "cursorWordLeft":
        return state(left());
      case "cursorWordRight":
        return state(right());
      case "cursorLineStart":
        return state(lineStart);
      case "cursorLineEnd":
        return state(lineEnd);
      case "cursorUp":
      case "cursorDown":
      case "pageUp":
      case "pageDown": {
        const lines = text.split("\n");
        const row = text.slice(0, start).split("\n").length - 1;
        const delta =
          action === "cursorUp"
            ? -1
            : action === "cursorDown"
              ? 1
              : action === "pageUp"
                ? -10
                : 10;
        const target = Math.min(lines.length - 1, Math.max(0, row + delta));
        return state(
          lines.slice(0, target).reduce((n, line) => n + line.length + 1, 0) +
            Math.min(start - lineStart, lines[target].length),
        );
      }
      case "deleteCharBackward":
        return replace(start === end ? before() : start, end, "");
      case "deleteCharForward":
        return replace(start, start === end ? after() : end, "");
      case "deleteWordBackward":
        return replace(start === end ? left() : start, end, "", true);
      case "deleteWordForward":
        return replace(start, start === end ? right() : end, "", true);
      case "deleteToLineStart":
        return replace(
          start === end && start === lineStart
            ? Math.max(0, start - 1)
            : lineStart,
          end,
          "",
          true,
        );
      case "deleteToLineEnd":
        return replace(
          start,
          end === lineEnd && text[end] === "\n" ? end + 1 : lineEnd,
          "",
          true,
        );
      case "yank": {
        const value = this.kills[0];
        if (!value) return state(start);
        this.yank = { start, end: start + value.length, index: 0 };
        return replace(start, end, value);
      }
      case "yankPop": {
        const previous = this.yank;
        if (!previous || end !== previous.end || !this.kills.length)
          return state(start);
        const index = (previous.index + 1) % this.kills.length,
          value = this.kills[index];
        this.yank = {
          start: previous.start,
          end: previous.start + value.length,
          index,
        };
        return replace(previous.start, previous.end, value);
      }
      case "undo":
        return this.undo.pop() ?? { text, start, end };
      case "jumpForward":
        this.jump = true;
        return state(start);
      case "jumpBackward":
        this.jump = false;
        return state(start);
      default:
        return undefined;
    }
  }
}
