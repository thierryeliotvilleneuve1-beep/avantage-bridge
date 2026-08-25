import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Repo root of faceless-studio (src/lib -> src -> root). */
export const ROOT = path.resolve(here, "..", "..");

export const OUT_DIR = path.join(ROOT, "out");
export const STATE_DIR = path.join(ROOT, "state");
export const CACHE_DIR = path.join(ROOT, ".cache");
export const MUSIC_DIR = path.join(ROOT, "assets", "music");
export const FONTS_DIR = path.join(ROOT, "assets", "fonts");

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function resolveFromRoot(p) {
  return path.isAbsolute(p) ? p : path.join(ROOT, p);
}

/**
 * FFmpeg filter arguments are colon/comma delimited and, on Windows, paths
 * contain a drive colon and backslashes. Escape for use inside a filter value.
 */
export function ffPath(p) {
  return p.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
}
