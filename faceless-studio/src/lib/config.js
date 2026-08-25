import fs from "node:fs";
import { resolveFromRoot } from "./paths.js";
import { fail } from "./log.js";

export function loadConfig(explicitPath) {
  const rel = explicitPath || process.env.CHANNEL_CONFIG || "config/channel.mindloop.json";
  const abs = resolveFromRoot(rel);
  if (!fs.existsSync(abs)) fail(`Config introuvable: ${abs}`);
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(abs, "utf8"));
  } catch (e) {
    fail(`Config JSON invalide (${abs}): ${e.message}`);
  }
  cfg.__path = abs;
  validate(cfg);
  return cfg;
}

function validate(cfg) {
  const missing = [];
  if (!cfg.channel?.slug) missing.push("channel.slug");
  if (!Array.isArray(cfg.formats) || cfg.formats.length === 0) missing.push("formats[]");
  if (!Array.isArray(cfg.topicSeeds) || cfg.topicSeeds.length === 0) missing.push("topicSeeds[]");
  if (!cfg.video?.width || !cfg.video?.height) missing.push("video.width/height");
  if (missing.length) fail(`Config incomplete, champs manquants: ${missing.join(", ")}`);

  const ids = new Set();
  for (const f of cfg.formats) {
    if (!f.id) fail("Chaque format doit avoir un id.");
    if (ids.has(f.id)) fail(`Format duplique: ${f.id}`);
    ids.add(f.id);
  }
}
