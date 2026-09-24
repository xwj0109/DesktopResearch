/** Browser projection of Pi's effective key configuration. Unknown actions stay
 * with the runtime; an explicitly empty binding disables the default. */
export type RuntimeKeys = Record<string, string | string[]>;
type KeyEvent = {
  key: string;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
};
export const defaultRuntimeKeys: RuntimeKeys = {
  "tui.input.submit": "enter",
  "tui.input.newLine": ["shift+enter", "ctrl+j"],
  "tui.input.tab": "tab",
  "tui.select.up": "up",
  "tui.select.down": "down",
  "tui.select.cancel": ["escape", "ctrl+c"],
  "tui.editor.cursorLeft": ["left", "ctrl+b"],
  "tui.editor.cursorRight": ["right", "ctrl+f"],
  "tui.editor.cursorWordLeft": ["alt+left", "ctrl+left", "alt+b"],
  "tui.editor.cursorWordRight": ["alt+right", "ctrl+right", "alt+f"],
  "tui.editor.cursorLineStart": ["home", "ctrl+home", "ctrl+a"],
  "tui.editor.cursorLineEnd": ["end", "ctrl+end", "ctrl+e"],
  "tui.editor.deleteCharBackward": "backspace",
  "tui.editor.deleteCharForward": ["delete", "ctrl+d"],
  "tui.editor.deleteWordBackward": ["ctrl+w", "alt+backspace"],
  "tui.editor.deleteWordForward": ["alt+d", "alt+delete"],
  "tui.editor.deleteToLineStart": "ctrl+u",
  "tui.editor.deleteToLineEnd": "ctrl+k",
  "tui.editor.yank": "ctrl+y",
  "tui.editor.yankPop": "alt+y",
  "tui.editor.undo": "ctrl+-",
  "tui.editor.jumpForward": "ctrl+]",
  "tui.editor.jumpBackward": "ctrl+alt+]",
  "tui.editor.pageUp": ["pageup", "ctrl+pageup"],
  "tui.editor.pageDown": ["pagedown", "ctrl+pagedown"],
  "tui.editor.cursorUp": "up",
  "tui.editor.cursorDown": "down",
  "tui.editor.historyPrevious": [],
  "tui.editor.historyNext": [],
  "app.model.select": "ctrl+l",
  "app.model.cycleForward": "ctrl+p",
  "app.model.cycleBackward": "ctrl+shift+p",
  "app.thinking.cycle": "shift+tab",
  "app.thinking.toggle": "ctrl+t",
  "app.tools.expand": "ctrl+o",
  "app.editor.external": "ctrl+g",
  "app.message.copy": "ctrl+x",
  "app.message.followUp": "alt+enter",
  "app.message.dequeue": "alt+up",
  "app.interrupt": "escape",
  "app.clear": "ctrl+c",
  "app.exit": "ctrl+d",
  "app.session.tree": [],
  "app.session.new": [],
  "app.session.resume": [],
  "app.session.fork": [],
};
const aliases: Record<string, string> = {
  arrowup: "up",
  arrowdown: "down",
  arrowleft: "left",
  arrowright: "right",
  esc: "escape",
  " ": "space",
  meta: "super",
  cmd: "super",
  control: "ctrl",
};
function canonical(value: string) {
  const parts = value
    .toLowerCase()
    .split("+")
    .map((part) => aliases[part] ?? part);
  return parts.sort().join("+");
}
export function matchesRuntimeKey(
  event: KeyEvent,
  action: string,
  bindings?: RuntimeKeys,
) {
  const configured =
    bindings && Object.hasOwn(bindings, action)
      ? bindings[action]
      : defaultRuntimeKeys[action];
  const keys = Array.isArray(configured)
    ? configured
    : configured
      ? [configured]
      : [];
  const value = [
    event.ctrlKey && "ctrl",
    event.altKey && "alt",
    event.metaKey && "super",
    event.shiftKey && "shift",
    aliases[event.key.toLowerCase()] ?? event.key.toLowerCase(),
  ]
    .filter(Boolean)
    .join("+");
  return keys.some((key) => canonical(key) === canonical(value));
}
