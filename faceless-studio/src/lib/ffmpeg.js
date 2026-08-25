import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function resolveBin(pkg, fallback) {
  try {
    const mod = require(pkg);
    const p = typeof mod === "string" ? mod : mod.path || mod.default?.path || mod.default;
    if (p && fs.existsSync(p)) return p;
  } catch { /* package not installed - fall through to PATH */ }
  return fallback;
}

export const FFMPEG = process.env.FFMPEG_PATH || resolveBin("ffmpeg-static", "ffmpeg");
export const FFPROBE = process.env.FFPROBE_PATH || resolveBin("ffprobe-static", "ffprobe");

/** Run a binary, resolve stdout, reject with the tail of stderr (where ffmpeg puts the real error). */
export function run(bin, args, { quiet = true } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => {
      err += d;
      if (!quiet) process.stderr.write(d);
    });
    child.on("error", (e) => reject(new Error(`${bin} n'a pas pu demarrer: ${e.message}`)));
    child.on("close", (code) => {
      if (code === 0) return resolve(out.trim());
      const tail = err.trim().split("\n").slice(-14).join("\n");
      reject(new Error(`${bin} a echoue (code ${code})\n${tail}`));
    });
  });
}

export const ffmpeg = (args, opts) => run(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", ...args], opts);

export async function probeDuration(file) {
  const out = await run(FFPROBE, [
    "-v", "error", "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1", file,
  ]);
  const d = Number.parseFloat(out);
  if (!Number.isFinite(d)) throw new Error(`Duree illisible pour ${file}`);
  return d;
}

export async function available() {
  try {
    await run(FFMPEG, ["-version"]);
    await run(FFPROBE, ["-version"]);
    return true;
  } catch {
    return false;
  }
}
