import type { CSSProperties } from "react";

/** Palettes transcribed from Omarchy `themes/<name>/colors.toml`
 * (basecamp/omarchy d3cfd53, MIT). Only colour values are used; no Omarchy
 * artwork, logo or branding. Derived surfaces are computed in styles.css with
 * the same mixes Omarchy's pi.json/t3code.json templates use. */
export interface Palette {
  label: string;
  mode: "dark" | "light";
  accent: string;
  selection: string;
  muted: string;
  background: string;
  darkBackground: string;
  lighterBackground: string;
  foreground: string;
  darkForeground: string;
  brightForeground: string;
  red: string;
  yellow: string;
  orange: string;
  green: string;
  cyan: string;
  blue: string;
  magenta: string;
}

const p = (
  label: string,
  mode: Palette["mode"],
  c: [string, string, string, string, string, string, string, string, string],
  hues: [string, string, string, string, string, string, string],
): Palette => {
  const [accent, selection, muted, background, darkBackground] = c;
  const [lighterBackground, foreground, darkForeground, brightForeground] =
    c.slice(5);
  const [red, yellow, orange, green, cyan, blue, magenta] = hues;
  return {
    label,
    mode,
    accent,
    selection,
    muted,
    background,
    darkBackground,
    lighterBackground,
    foreground,
    darkForeground,
    brightForeground,
    red,
    yellow,
    orange,
    green,
    cyan,
    blue,
    magenta,
  };
};

// Order: accent, selection, muted, background, dark bg, lighter bg,
// foreground, dark fg, bright fg | red, yellow, orange, green, cyan, blue, magenta
export const themes = {
  "tokyo-night": p(
    "Tokyo Night",
    "dark",
    ["#7aa2f7", "#292e42", "#414868", "#1a1b26", "#13141c", "#24283b", "#a9b1d6", "#565f89", "#c0caf5"],
    ["#f7768e", "#e0af68", "#eb927b", "#9ece6a", "#449dab", "#7aa2f7", "#ad8ee6"],
  ),
  catppuccin: p(
    "Catppuccin",
    "dark",
    ["#89b4fa", "#45475a", "#585b70", "#1e1e2e", "#161622", "#313244", "#cdd6f4", "#6c7086", "#cdd6f4"],
    ["#f38ba8", "#f9e2af", "#f6b6ab", "#a6e3a1", "#94e2d5", "#89b4fa", "#f5c2e7"],
  ),
  gruvbox: p(
    "Gruvbox",
    "dark",
    ["#7daea3", "#504945", "#665c54", "#282828", "#1e1e1e", "#3c3836", "#d4be98", "#7c6f64", "#d4be98"],
    ["#ea6962", "#d8a657", "#e1875c", "#a9b665", "#89b482", "#7daea3", "#d3869b"],
  ),
  everforest: p(
    "Everforest",
    "dark",
    ["#7fbbb3", "#3d484d", "#475258", "#2d353b", "#21272c", "#343f44", "#d3c6aa", "#4f585e", "#d3c6aa"],
    ["#e67e80", "#dbbc7f", "#e09d7f", "#a7c080", "#83c092", "#7fbbb3", "#d699b6"],
  ),
  kanagawa: p(
    "Kanagawa",
    "dark",
    ["#dcd7ba", "#363646", "#54546d", "#1f1f28", "#17171e", "#223249", "#dcd7ba", "#727169", "#dcd7ba"],
    ["#c34043", "#c0a36e", "#c17158", "#76946a", "#6a9589", "#7e9cd8", "#957fb8"],
  ),
  nord: p(
    "Nord",
    "dark",
    ["#81a1c1", "#434c5e", "#4c566a", "#2e3440", "#222730", "#3b4252", "#d8dee9", "#667080", "#d8dee9"],
    ["#bf616a", "#ebcb8b", "#d5967a", "#a3be8c", "#88c0d0", "#81a1c1", "#b48ead"],
  ),
  "matte-black": p(
    "Matte Black",
    "dark",
    ["#e68e0d", "#2a2a2a", "#333333", "#121212", "#0d0d0d", "#1e1e1e", "#bebebe", "#555555", "#bebebe"],
    ["#d35f5f", "#b91c1c", "#c63d3d", "#ffc107", "#bebebe", "#e68e0d", "#d35f5f"],
  ),
  "osaka-jade": p(
    "Osaka Jade",
    "dark",
    ["#509475", "#32473b", "#53685b", "#111c18", "#0c1512", "#23372b", "#c1c497", "#81b8a8", "#f7e8b2"],
    ["#ff5345", "#459451", "#a2734b", "#549e6a", "#2dd5b7", "#509475", "#d2689c"],
  ),
  ristretto: p(
    "Ristretto",
    "dark",
    ["#f38d70", "#403e41", "#72696a", "#2c2525", "#211b1b", "#3d2f2a", "#e6d9db", "#72696a", "#e6d9db"],
    ["#fd6883", "#f9cc6c", "#fb9a77", "#adda78", "#85dacc", "#f38d70", "#a8a9eb"],
  ),
  "rose-pine": p(
    "Rosé Pine Dawn",
    "light",
    ["#56949f", "#dfdad9", "#cecacd", "#faf4ed", "#ede7e1", "#f2e9e1", "#575279", "#9893a5", "#575279"],
    ["#b4637a", "#ea9d34", "#cf8057", "#286983", "#d7827e", "#56949f", "#907aa9"],
  ),
  "catppuccin-latte": p(
    "Catppuccin Latte",
    "light",
    ["#1e66f5", "#ccd0da", "#acb0be", "#eff1f5", "#e3e4e8", "#dce0e8", "#4c4f69", "#9ca0b0", "#4c4f69"],
    ["#d20f39", "#df8e1d", "#d84e2b", "#40a02b", "#179299", "#1e66f5", "#ea76cb"],
  ),
  "flexoki-light": p(
    "Flexoki Light",
    "light",
    ["#205ea6", "#cecdc3", "#b7b5ac", "#fffcf0", "#f2efe4", "#e6e4d9", "#100f0f", "#878580", "#100f0f"],
    ["#d14d41", "#d0a215", "#d0772b", "#879a39", "#3aa99f", "#205ea6", "#ce5d97"],
  ),
} satisfies Record<string, Palette>;

export type ThemeId = keyof typeof themes;
export const defaultTheme: ThemeId = "tokyo-night";
export const themeIds = Object.keys(themes) as ThemeId[];
export const isThemeId = (value: unknown): value is ThemeId =>
  typeof value === "string" && value in themes;
export const resolveTheme = (value: unknown): ThemeId =>
  isThemeId(value) ? value : defaultTheme;

/** CSS custom properties for a theme; everything else derives from these. */
export function themeStyle(id: ThemeId): CSSProperties {
  const t: Palette = themes[id];
  return {
    colorScheme: t.mode,
    "--accent": t.accent,
    "--selection": t.selection,
    "--muted": t.muted,
    "--bg": t.background,
    "--bg-dark": t.darkBackground,
    "--bg-light": t.lighterBackground,
    "--fg": t.foreground,
    "--fg-dark": t.darkForeground,
    "--fg-bright": t.brightForeground,
    "--red": t.red,
    "--yellow": t.yellow,
    "--orange": t.orange,
    "--green": t.green,
    "--cyan": t.cyan,
    "--blue": t.blue,
    "--magenta": t.magenta,
  } as CSSProperties;
}

/** Per-profile convenience for surfaces without saved view state (launcher). */
export function storedTheme(): ThemeId {
  try {
    return resolveTheme((globalThis as any).window?.localStorage?.getItem("pi-research-theme"));
  } catch {
    return defaultTheme;
  }
}
export function storeTheme(id: ThemeId) {
  try {
    (globalThis as any).window?.localStorage?.setItem("pi-research-theme", id);
  } catch {}
}
