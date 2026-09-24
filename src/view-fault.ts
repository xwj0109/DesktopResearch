/** The app asset an error came from ("xterm", "workbench", …): a bounded
 * diagnostic code, never the message. */
export function faultSource(where: string) {
  const m = /\/assets\/([A-Za-z]+)[-.]/.exec(where);
  return m ? m[1].toLowerCase().slice(0, 20) : "unknown";
}
