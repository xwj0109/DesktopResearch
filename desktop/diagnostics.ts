import fs from "node:fs";
import path from "node:path";
/** Codes only: never exception strings, roots, tokens, URLs, environment, or child output. */
export function diagnostics(directory: string) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, "startup.jsonl");
  if (
    fs.existsSync(file) &&
    (fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > 32768)
  ) {
    if (fs.lstatSync(file).isSymbolicLink())
      throw new Error("Unsafe diagnostics file");
    fs.unlinkSync(file);
  }
  let count = 0;
  return (code: string) => {
    if (++count > 128 || !/^[a-z-]{1,48}$/.test(code)) return;
    const fd = fs.openSync(
      file,
      fs.constants.O_WRONLY |
        fs.constants.O_APPEND |
        fs.constants.O_CREAT |
        fs.constants.O_NOFOLLOW,
      0o600,
    );
    try {
      fs.writeFileSync(
        fd,
        JSON.stringify({ version: 1, at: new Date().toISOString(), code }) +
          "\n",
      );
    } finally {
      fs.closeSync(fd);
    }
  };
}
