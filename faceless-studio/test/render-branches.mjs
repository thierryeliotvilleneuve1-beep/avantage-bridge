/**
 * Covers the two render branches the stubbed end-to-end test never reaches:
 * a *video* source asset (stream_loop + trim) and a background music bed
 * (amix with normalize=0 + fades).
 *
 *   node test/render-branches.mjs
 */
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { ffmpeg, probeDuration, run, FFPROBE } from "../src/lib/ffmpeg.js";
import { loadConfig } from "../src/lib/config.js";
import { buildAss } from "../src/lib/ass.js";
import { renderVideo } from "../src/steps/render.js";
import { ensureDir } from "../src/lib/paths.js";

const tmp = ensureDir(path.join(process.cwd(), "out", "__branchtest"));
const cfg = loadConfig("config/channel.mindloop.json");

// A landscape clip shorter than the scene: forces both the crop-to-vertical
// path and the stream_loop that fills the remaining time.
const clip = path.join(tmp, "src.mp4");
await ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30:duration=2",
  "-c:v", "libx264", "-crf", "28", "-pix_fmt", "yuv420p", clip]);

const music = path.join(tmp, "music.mp3");
await ffmpeg(["-f", "lavfi", "-i", "sine=frequency=220:duration=3",
  "-c:a", "libmp3lame", "-q:a", "6", music]);

const voice = path.join(tmp, "voice.m4a");
await ffmpeg(["-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-t", "9",
  "-c:a", "aac", "-b:a", "128k", voice]);

const still = path.join(tmp, "still.png");
await ffmpeg(["-f", "lavfi", "-i", "color=c=#2a1b3d:s=1080x1920", "-frames:v", "1", still]);

const scenes = [
  { asset: { kind: "video", file: clip }, duration: 5, start: 0 },   // 2s source, 5s scene -> must loop
  { asset: { kind: "image", file: still }, duration: 4, start: 5 },  // Ken Burns branch
];
const total = 9;

const assFile = path.join(tmp, "c.ass");
fs.writeFileSync(assFile, buildAss(
  [{ word: "looped", start: 0.5, end: 2, beat: 0 }, { word: "clip", start: 2, end: 4.5, beat: 0 },
   { word: "then", start: 5.2, end: 6.5, beat: 1 }, { word: "still", start: 6.5, end: 8.4, beat: 1 }],
  cfg.captions, cfg.video,
));

const out = path.join(tmp, "out.mp4");
await renderVideo({ scenes, voiceFile: voice, musicFile: music, assFile, outFile: out, cfg, totalSeconds: total });

const duration = await probeDuration(out);
const streams = JSON.parse(await run(FFPROBE, [
  "-v", "error", "-show_entries", "stream=codec_type,width,height,r_frame_rate,channels,sample_rate",
  "-of", "json", out,
]));

const v = streams.streams.find((s) => s.codec_type === "video");
const a = streams.streams.find((s) => s.codec_type === "audio");

console.log("");
console.log("  duree   :", duration.toFixed(2), "s (attendu ~", total, "s)");
console.log("  video   :", `${v.width}x${v.height}`, "@", v.r_frame_rate);
console.log("  audio   :", `${a.channels}ch`, `${a.sample_rate}Hz`);

assert.ok(Math.abs(duration - total) < 0.4, `duree ${duration} != ${total}`);
assert.equal(v.width, cfg.video.width);
assert.equal(v.height, cfg.video.height);
assert.equal(v.r_frame_rate, `${cfg.video.fps}/1`);
assert.equal(a.channels, 2);
assert.equal(Number(a.sample_rate), 44100);

// The music bed must actually be audible over a silent voice track.
const stats = await new Promise((resolve, reject) => {
  import("node:child_process").then(({ spawn }) => {
    const p = spawn(process.env.FFMPEG_PATH || "./node_modules/ffmpeg-static/ffmpeg",
      ["-hide_banner", "-i", out, "-af", "volumedetect", "-f", "null", "-"]);
    let err = "";
    p.stderr.on("data", (d) => { err += d; });
    p.on("close", () => resolve(err));
    p.on("error", reject);
  });
});
const mean = /mean_volume:\s*(-?[\d.]+) dB/.exec(stats)?.[1];
console.log("  volume moyen :", mean, "dB");
assert.ok(mean && Number(mean) > -60, `piste quasi muette (${mean} dB) - le mix musique n'a pas fonctionne`);

fs.rmSync(tmp, { recursive: true, force: true });
console.log("\n  BRANCHES VIDEO + MUSIQUE OK\n");
