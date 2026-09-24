import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";

export const themeIdSchema = z.string().regex(/^[a-z0-9-]{1,40}$/);
const preferencesSchema = z.object({ version: z.literal(1), theme: themeIdSchema.optional() }).strict();
// Accept old files so removing the connection option does not discard a saved theme.
const storedPreferencesSchema = preferencesSchema.extend({ autoConnect: z.boolean().optional() });
export type Preferences = z.infer<typeof preferencesSchema>;
const MAX_BYTES = 64 * 1024;

/** App-wide desktop presentation preferences (not Pi configuration).
 * One file for the whole app, written atomically; unreadable files fall back
 * to defaults rather than blocking startup. */
export class PreferenceStore {
  private file: string;
  constructor(private directory: string) {
    this.file = path.join(directory, "preferences.json");
  }
  read(): Preferences {
    try {
      if (!fs.existsSync(this.file)) return { version: 1 };
      const stat = fs.lstatSync(this.file);
      if (stat.isSymbolicLink() || stat.size > MAX_BYTES) return { version: 1 };
      const { autoConnect: _ignored, ...preferences } = storedPreferencesSchema.parse(JSON.parse(fs.readFileSync(this.file, "utf8")));
      return preferences;
    } catch {
      return { version: 1 };
    }
  }
  update(patch: Partial<Omit<Preferences, "version">>): Preferences {
    const next = preferencesSchema.parse({ ...this.read(), ...patch, version: 1 });
    const tmp = this.file + "." + randomBytes(8).toString("hex") + ".tmp";
    const fd = fs.openSync(
      tmp,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
    try {
      fs.writeFileSync(fd, JSON.stringify(next));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.renameSync(tmp, this.file);
    } finally {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    }
    return next;
  }
}
