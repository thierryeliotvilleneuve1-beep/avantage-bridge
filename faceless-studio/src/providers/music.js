import fs from "node:fs";
import path from "node:path";
import { MUSIC_DIR } from "../lib/paths.js";

const EXT = new Set([".mp3", ".m4a", ".wav", ".aac", ".ogg", ".flac"]);

export function listTracks() {
  if (!fs.existsSync(MUSIC_DIR)) return [];
  return fs.readdirSync(MUSIC_DIR)
    .filter((f) => EXT.has(path.extname(f).toLowerCase()))
    .sort()
    .map((f) => path.join(MUSIC_DIR, f));
}

/**
 * Rotate through the library so consecutive uploads do not share a bed track -
 * same reason as format rotation: consecutive videos must not feel identical.
 */
export function pickTrack(recentTracks = []) {
  const tracks = listTracks();
  if (!tracks.length) return null;
  const recent = new Set(recentTracks.filter(Boolean).map((t) => path.basename(t)));
  return tracks.find((t) => !recent.has(path.basename(t))) || tracks[0];
}
