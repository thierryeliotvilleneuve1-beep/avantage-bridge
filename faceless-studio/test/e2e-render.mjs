/**
 * End-to-end check of the render path with a stubbed script: no Claude call,
 * no network. Exercises TTS assembly, timeline maths, caption burn-in and the
 * full ffmpeg filter graph.
 *
 *   TTS_PROVIDER=silent VISUALS_PROVIDER=solid node test/e2e-render.mjs
 */
process.env.TTS_PROVIDER ||= "silent";
process.env.VISUALS_PROVIDER ||= "solid";

import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { loadConfig } from "../src/lib/config.js";
import { Store } from "../src/lib/state.js";
import { probeDuration, available } from "../src/lib/ffmpeg.js";
import { STATE_DIR } from "../src/lib/paths.js";

const SCRIPT = {
  title: "Why Waiting Rooms Make People Ruder",
  hook: "Watch what a two minute delay does to people.",
  beats: [
    { text: "Watch what a two minute delay does to people.", visualQuery: "waiting room chairs", visualPrompt: "empty waiting room" },
    { text: "Researchers timed how long strangers waited before a receptionist looked up.", visualQuery: "reception desk", visualPrompt: "reception desk" },
    { text: "Under thirty seconds, almost everyone stayed polite.", visualQuery: "person waiting patiently", visualPrompt: "person waiting" },
    { text: "Past two minutes, complaints tripled and voices got louder.", visualQuery: "frustrated man queue", visualPrompt: "frustrated person" },
    { text: "The delay was not the problem. Not knowing how long it would last was.", visualQuery: "clock on wall", visualPrompt: "wall clock" },
    { text: "Tell people the wait, and the rudeness mostly disappears.", visualQuery: "digital queue display", visualPrompt: "queue display" },
  ],
  description: "A short look at how uncertainty, not delay, drives impatience.",
  hashtags: ["psychology", "behaviour", "queues"],
  tags: ["psychology", "human behaviour", "queueing", "patience", "uncertainty"],
  thumbnailText: "The Wait Effect",
  sourceNote: "Documented pattern in queueing psychology: perceived wait rises with uncertainty.",
  aiDisclosureNeeded: false,
};

import { produce } from "../src/steps/produce.js";

if (!(await available())) {
  console.error("ffmpeg indisponible - test ignore");
  process.exit(1);
}

const cfg = loadConfig("config/channel.mindloop.json");
const store = new Store("__test__");
store.data = { ideas: [], videos: [] };

const idea = {
  id: "test-1", slug: "test", formatId: "mechanism",
  title: SCRIPT.title, angle: "Uncertainty, not delay, drives impatience.",
  hook: SCRIPT.hook, payoff: "Announce the wait.", topicSeed: "the psychology of waiting, queues and delay",
  groundedIn: "queueing psychology",
};

let res;
try {
  res = await produce(cfg, store, idea, { keepWork: true, script: SCRIPT });
} finally {
  fs.rmSync(path.join(STATE_DIR, "__test__.json"), { force: true });
}

const duration = await probeDuration(res.outFile);
const expected = res.meta.beats.at(-1).end;

console.log("");
console.log("  mp4          :", path.basename(res.outFile));
console.log("  duree rendue :", duration.toFixed(2), "s (timeline:", expected.toFixed(2), "s)");
console.log("  taille       :", (fs.statSync(res.outFile).size / 1e6).toFixed(2), "Mo");
console.log("  beats        :", res.meta.beats.length);
console.log("  cover        :", fs.existsSync(path.join(res.dir, "cover.jpg")) ? "ok" : "MANQUANTE");

const ass = fs.readFileSync(path.join(res.dir, "work", "captions.ass"), "utf8");
const events = ass.split("\n").filter((l) => l.startsWith("Dialogue:")).length;
console.log("  evenements   :", events, "lignes de sous-titres");

assert.ok(Math.abs(duration - expected) < 0.6, `derive de duree trop grande: ${duration} vs ${expected}`);
assert.ok(events > 20, `trop peu d'evenements de sous-titres: ${events}`);
assert.ok(fs.existsSync(path.join(res.dir, "PUBLISH.md")), "PUBLISH.md manquant");
assert.equal(res.meta.beats.length, SCRIPT.beats.length);
assert.ok(res.meta.attribution.every((a) => a.source), "attribution incomplete");

console.log("\n  TOUS LES CONTROLES PASSENT\n");
