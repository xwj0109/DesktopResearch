/** Bound terminal input by UTF-8 bytes, without splitting a Unicode character. */
export function terminalInputFrames(data: string, limit = 8192): string[] {
  const frames: string[] = [];
  let text = "", bytes = 0;
  for (const character of data) {
    const point = character.codePointAt(0)!;
    const size = point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
    if (bytes + size > limit) { frames.push(text); text = ""; bytes = 0; }
    text += character; bytes += size;
  }
  if (text) frames.push(text);
  return frames;
}
