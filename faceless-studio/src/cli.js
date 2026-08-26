#!/usr/bin/env node
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./lib/config.js";
import { Store } from "./lib/state.js";
import { log, fail } from "./lib/log.js";
import { FFMPEG, FFPROBE, available, run } from "./lib/ffmpeg.js";
import { ROOT, MUSIC_DIR, FONTS_DIR, OUT_DIR } from "./lib/paths.js";
import { ttsProviderName } from "./providers/tts.js";
import { visualsProviderName } from "./providers/visuals.js";
import { listTracks } from "./providers/music.js";
import { ideate } from "./steps/ideate.js";
import { produce } from "./steps/produce.js";
import { buildReview } from "./steps/review.js";

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) { out[key] = next; i++; }
      else out[key] = true;
    } else out._.push(a);
  }
  return out;
}

const USAGE = `
faceless-studio - production automatisee de Shorts faceless

  npm run doctor                       verifie l'environnement et les cles
  npm run ideas -- --count 12          genere et banque des idees (rotation de formats forcee)
  npm run make                         produit la prochaine idee en attente
  npm run make -- --idea <id|slug>     produit une idee precise
  npm run batch -- --count 3           produit N videos d'affilee
  npm run list                         etat de la banque d'idees et des videos
  npm run review                       (re)genere out/review.html

Options communes
  --config <chemin>   config de chaine (defaut: $CHANNEL_CONFIG ou config/channel.mindloop.json)
  --keep-work         conserve les fichiers intermediaires (beats, visuels, .ass)
`;

/* ------------------------------------------------------------------ */

async function cmdDoctor(args) {
  log.title("Environnement");
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  nodeMajor >= 20 ? log.ok(`node ${process.versions.node}`) : log.err(`node ${process.versions.node} - v20+ requis`);

  if (await available()) {
    const v = (await run(FFMPEG, ["-version"])).split("\n")[0];
    log.ok(v.slice(0, 60));
    log.dim(`ffmpeg : ${FFMPEG}`);
    log.dim(`ffprobe: ${FFPROBE}`);
  } else {
    log.err("ffmpeg/ffprobe introuvables. `npm install` installe ffmpeg-static, ou definir FFMPEG_PATH/FFPROBE_PATH.");
  }

  log.title("Configuration");
  const cfg = loadConfig(args.config);
  log.ok(`${cfg.channel.name} (${cfg.channel.slug}) - ${cfg.formats.length} formats, ${cfg.topicSeeds.length} graines de sujets`);
  log.dim(path.relative(ROOT, cfg.__path));

  log.title("Cles API");
  if (process.env.ANTHROPIC_API_KEY) log.ok("ANTHROPIC_API_KEY presente");
  else {
    // The SDK also resolves an `ant auth login` profile, so an unset variable
    // is not proof that there are no credentials.
    log.warn("ANTHROPIC_API_KEY absente - le SDK tentera un profil `ant auth login`");
  }

  const tts = ttsProviderName();
  const ttsKey = { elevenlabs: "ELEVENLABS_API_KEY", openai: "OPENAI_API_KEY", silent: null }[tts];
  if (tts === "silent") log.warn("TTS_PROVIDER=silent - piste muette, mode test du rendu uniquement");
  else if (!ttsKey) log.err(`TTS_PROVIDER inconnu: ${tts}`);
  else if (!process.env[ttsKey]) log.err(`${ttsKey} absente (TTS_PROVIDER=${tts})`);
  else {
    log.ok(`TTS ${tts}`);
    if (tts === "elevenlabs" && !process.env.ELEVENLABS_VOICE_ID) log.err("ELEVENLABS_VOICE_ID absente");
    if (tts !== "elevenlabs") log.warn(`${tts} ne fournit pas de timings - sous-titres estimes`);
  }

  const vis = visualsProviderName(null);
  if (vis === "pexels" && !process.env.PEXELS_API_KEY) log.err("PEXELS_API_KEY absente (VISUALS_PROVIDER=pexels)");
  else log.ok(`Visuels ${vis}`);
  if (cfg.formats.some((f) => f.visualSource === "ai")) log.dim("format(s) 'ai' -> Pollinations, sans cle");

  log.title("Assets");
  const tracks = listTracks();
  tracks.length
    ? log.ok(`${tracks.length} piste(s) musicales`)
    : log.warn(`aucune piste dans ${path.relative(ROOT, MUSIC_DIR)} - rendu sans musique`);

  const fonts = fs.existsSync(FONTS_DIR) ? fs.readdirSync(FONTS_DIR).filter((f) => /\.(ttf|otf|ttc)$/i.test(f)) : [];
  fonts.length
    ? log.ok(`${fonts.length} police(s) locale(s)`)
    : log.warn(`aucune police dans ${path.relative(ROOT, FONTS_DIR)} - fallback "${cfg.captions.fontFallbacks?.[0] ?? "systeme"}"`);

  log.title("Banque");
  const store = new Store(cfg.channel.slug);
  log.info(`${store.pendingIdeas().length} idee(s) en attente, ${store.data.videos.length} video(s) produite(s)`);
  const recent = store.recentFormatIds(cfg.variation.avoidLastNFormats ?? 3);
  if (recent.length) log.dim(`derniers formats utilises: ${recent.join(" -> ")}`);
  console.log("");
}

async function cmdIdeas(args) {
  const cfg = loadConfig(args.config);
  const store = new Store(cfg.channel.slug);
  const count = Number(args.count || 10);
  log.title(`Generation de ${count} idees pour ${cfg.channel.name}`);
  const fresh = await ideate(cfg, store, count);
  console.log("");
  for (const i of fresh) {
    console.log(`  [${i.formatId}] ${i.title}`);
    console.log(`      ${i.angle}`);
    console.log(`      hook: "${i.hook}"`);
    console.log(`      base: ${i.groundedIn}\n`);
  }
  log.ok(`${fresh.length} idee(s) en banque - lancer "npm run make" pour produire`);
}

async function cmdMake(args) {
  const cfg = loadConfig(args.config);
  const store = new Store(cfg.channel.slug);

  let idea;
  if (args.idea) {
    idea = store.findIdea(args.idea);
    if (!idea) fail(`Idee introuvable: ${args.idea}`);
  } else {
    idea = store.pendingIdeas()[0];
    if (!idea) fail(`Aucune idee en attente. Lancer d'abord: npm run ideas -- --count 10`);
  }

  log.title(`Production: ${idea.title}`);
  const res = await produce(cfg, store, idea, { keepWork: Boolean(args["keep-work"]) });
  const review = buildReview();
  console.log("");
  log.ok(`Livre dans ${path.relative(ROOT, res.dir)}`);
  if (review) log.info(`Revue: ${path.relative(ROOT, review.file)}`);
  return res;
}

async function cmdBatch(args) {
  const cfg = loadConfig(args.config);
  const store = new Store(cfg.channel.slug);
  const count = Number(args.count || 3);

  if (store.pendingIdeas().length < count) {
    log.info(`Banque insuffisante (${store.pendingIdeas().length}/${count}) - generation d'idees`);
    await ideate(cfg, store, count - store.pendingIdeas().length);
  }

  const results = [];
  const failures = [];
  for (let n = 0; n < count; n++) {
    const idea = store.pendingIdeas()[0];
    if (!idea) { log.warn("Plus d'idees en attente"); break; }
    log.title(`[${n + 1}/${count}] ${idea.title}`);
    try {
      results.push(await produce(cfg, store, idea, { keepWork: Boolean(args["keep-work"]) }));
    } catch (e) {
      log.err(e.message);
      store.markIdea(idea.id, "failed", { error: e.message });
      failures.push({ idea: idea.title, error: e.message });
    }
  }

  const review = buildReview();
  console.log("");
  log.ok(`${results.length}/${count} video(s) produite(s)`);
  if (failures.length) {
    log.warn(`${failures.length} echec(s):`);
    for (const f of failures) log.dim(`${f.idea} - ${f.error.split("\n")[0]}`);
  }
  if (review) log.info(`Revue: ${path.relative(ROOT, review.file)}`);
  if (failures.length && !results.length) process.exitCode = 1;
}

async function cmdList(args) {
  const cfg = loadConfig(args.config);
  const store = new Store(cfg.channel.slug);

  log.title(`Idees (${store.data.ideas.length})`);
  const byStatus = store.data.ideas.reduce((m, i) => ({ ...m, [i.status]: (m[i.status] || 0) + 1 }), {});
  log.info(Object.entries(byStatus).map(([k, v]) => `${k}: ${v}`).join("  |  ") || "vide");
  for (const i of store.pendingIdeas().slice(0, 15)) console.log(`  ${i.id}  [${i.formatId}]  ${i.title}`);

  log.title(`Videos (${store.data.videos.length})`);
  for (const v of store.recentVideos(15)) {
    console.log(`  ${v.createdAt.slice(0, 10)}  [${v.formatId}]  ${v.durationSeconds}s  ${v.title}`);
  }
  console.log("");
}

async function cmdReview() {
  const review = buildReview();
  if (!review) return log.warn(`Rien dans ${path.relative(ROOT, OUT_DIR)}`);
  log.ok(`${review.count} video(s) -> ${path.relative(ROOT, review.file)}`);
}

/* ------------------------------------------------------------------ */

const COMMANDS = { doctor: cmdDoctor, ideas: cmdIdeas, make: cmdMake, batch: cmdBatch, list: cmdList, review: cmdReview };

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];

if (!cmd || cmd === "help" || args.help) {
  console.log(USAGE);
  process.exit(0);
}

const fn = COMMANDS[cmd];
if (!fn) {
  console.error(`Commande inconnue: ${cmd}`);
  console.log(USAGE);
  process.exit(1);
}

try {
  await fn(args);
} catch (e) {
  log.err(e.message);
  if (process.env.DEBUG) console.error(e);
  process.exit(1);
}
