import fs from "node:fs";
import path from "node:path";
import { writeScript } from "../providers/claude.js";
import { synthesizeBeat, ttsProviderName } from "../providers/tts.js";
import { fetchVisual } from "../providers/visuals.js";
import { pickTrack } from "../providers/music.js";
import { buildAss, estimateWordTimings } from "../lib/ass.js";
import { renderVideo, extractCover } from "./render.js";
import { ffmpeg, probeDuration } from "../lib/ffmpeg.js";
import { OUT_DIR, ensureDir } from "../lib/paths.js";
import { log } from "../lib/log.js";
import { slugify } from "./ideate.js";

/**
 * @param opts.keepWork keep beat audio, visuals and the .ass file on disk
 * @param opts.script   supply a script instead of calling Claude - used to
 *                      re-render an existing video after a caption or visual
 *                      change without paying for a new generation
 */
export async function produce(cfg, store, idea, { keepWork = false, script: presetScript = null } = {}) {
  const format = cfg.formats.find((f) => f.id === idea.formatId);
  if (!format) throw new Error(`Format inconnu sur l'idee ${idea.id}: ${idea.formatId}`);

  const recentHooks = store.recentHooks(cfg.variation.avoidLastNHooks ?? 8);

  log.group(`Script (${format.label})`);
  const script = presetScript ?? await writeScript(cfg, idea, format, recentHooks);
  if (presetScript) log.dim("script fourni - appel Claude ignore");
  const spokenWords = script.beats.reduce((n, b) => n + b.text.split(/\s+/).filter(Boolean).length, 0);
  log.ok(`"${script.title}"`);
  log.dim(`${script.beats.length} beats, ${spokenWords} mots (~${(spokenWords / cfg.script.wordsPerSecond).toFixed(0)}s attendus)`);
  log.end();

  const stamp = new Date().toISOString().slice(0, 10);
  const slug = slugify(script.title) || idea.slug;
  const dir = ensureDir(path.join(OUT_DIR, `${stamp}_${slug}`));
  const work = ensureDir(path.join(dir, "work"));

  /* ---- narration --------------------------------------------------- */

  log.group(`Voix off (${ttsProviderName()})`);
  const gap = cfg.audio.beatGapSeconds ?? 0.22;
  const tail = cfg.audio.tailSeconds ?? 0.6;
  const clips = [];

  for (let i = 0; i < script.beats.length; i++) {
    const beat = script.beats[i];
    const file = path.join(work, `beat-${String(i).padStart(2, "0")}.mp3`);
    const clip = await synthesizeBeat(beat.text, file);
    clips.push(clip);
    log.dim(`beat ${i + 1}/${script.beats.length}  ${clip.duration.toFixed(2)}s`);
  }

  // Absolute timeline: each beat plus the pause that follows it.
  let cursor = 0;
  const timeline = clips.map((clip, i) => {
    const pad = i === clips.length - 1 ? tail : gap;
    const entry = { start: cursor, audioEnd: cursor + clip.duration, end: cursor + clip.duration + pad, pad, clip };
    cursor = entry.end;
    return entry;
  });
  const totalSeconds = cursor;

  const voiceFile = path.join(work, "voice.m4a");
  await concatVoice(timeline, voiceFile);
  const voiceProbed = await probeDuration(voiceFile);
  if (Math.abs(voiceProbed - totalSeconds) > 0.25) {
    log.warn(`Derive audio: piste ${voiceProbed.toFixed(2)}s vs timeline ${totalSeconds.toFixed(2)}s`);
  }
  log.ok(`${totalSeconds.toFixed(1)}s de narration`);
  log.end();

  const [minSec, maxSec] = cfg.video.targetSeconds;
  if (totalSeconds < minSec - 6 || totalSeconds > maxSec + 8) {
    log.warn(`Duree hors cible (${totalSeconds.toFixed(1)}s vs ${minSec}-${maxSec}s). Ajuster script.wordsPerSecond ou targetSeconds.`);
  }

  /* ---- captions ---------------------------------------------------- */

  const words = [];
  let estimated = 0;
  timeline.forEach((entry, i) => {
    if (entry.clip.words?.length) {
      for (const w of entry.clip.words) {
        words.push({ word: w.word, start: entry.start + w.start, end: entry.start + w.end, beat: i });
      }
    } else {
      estimated++;
      words.push(...estimateWordTimings([
        { text: script.beats[i].text, start: entry.start, end: entry.audioEnd, index: i },
      ]));
    }
  });

  const caps = { ...cfg.captions, activeColour: format.captionAccent || cfg.captions.activeColour };
  const assFile = path.join(work, "captions.ass");
  fs.writeFileSync(assFile, buildAss(words, caps, cfg.video));
  log.info(estimated
    ? `Sous-titres: ${words.length} mots (${estimated}/${timeline.length} beats en timing estime - passer a ElevenLabs pour du mot-a-mot exact)`
    : `Sous-titres: ${words.length} mots, timing exact du TTS`);

  /* ---- visuals ----------------------------------------------------- */

  log.group("Visuels");
  const used = new Set();
  const scenes = [];
  for (let i = 0; i < timeline.length; i++) {
    const entry = timeline[i];
    const duration = entry.end - entry.start;
    const asset = await fetchVisual(script.beats[i], {
      index: i, dir: work, format, slug, used, seconds: duration,
      fallbackTerm: idea.topicSeed || cfg.channel.niche,
    });
    scenes.push({ asset, duration, start: entry.start });
    log.dim(`beat ${i + 1}: ${asset.source}`);
  }
  log.end();

  /* ---- render ------------------------------------------------------ */

  const musicFile = pickTrack(store.recentVideos(3).map((v) => v.musicTrack));
  if (!musicFile) log.warn("Aucune piste dans assets/music - rendu sans musique de fond");

  log.group("Rendu FFmpeg");
  const outFile = path.join(dir, `${slug}.mp4`);
  await renderVideo({ scenes, voiceFile, musicFile, assFile, outFile, cfg, totalSeconds });
  const finalDuration = await probeDuration(outFile);
  const coverFile = path.join(dir, "cover.jpg");
  await extractCover(outFile, Math.min(1.4, finalDuration / 3), coverFile);
  log.ok(`${path.basename(outFile)} - ${finalDuration.toFixed(1)}s, ${(fs.statSync(outFile).size / 1e6).toFixed(1)} Mo`);
  log.end();

  /* ---- package ----------------------------------------------------- */

  const meta = {
    title: script.title,
    hook: script.hook,
    description: buildDescription(cfg, script, scenes),
    tags: script.tags,
    hashtags: script.hashtags,
    thumbnailText: script.thumbnailText,
    sourceNote: script.sourceNote,
    formatId: format.id,
    formatLabel: format.label,
    durationSeconds: Number(finalDuration.toFixed(2)),
    aiDisclosure: {
      required: script.aiDisclosureNeeded === true,
      syntheticVoice: cfg.channel.aiDisclosure?.syntheticVoice ?? true,
      note: cfg.channel.aiDisclosure?.note ?? null,
    },
    attribution: scenes.map((s, i) => ({ beat: i + 1, source: s.asset.source, credit: s.asset.credit })),
    musicTrack: musicFile ? path.basename(musicFile) : null,
    beats: script.beats.map((b, i) => ({
      n: i + 1, text: b.text, visualQuery: b.visualQuery,
      start: Number(timeline[i].start.toFixed(2)), end: Number(timeline[i].end.toFixed(2)),
    })),
    idea: { id: idea.id, angle: idea.angle, groundedIn: idea.groundedIn, payoff: idea.payoff },
    generatedAt: new Date().toISOString(),
  };

  fs.writeFileSync(path.join(dir, "metadata.json"), JSON.stringify(meta, null, 2));
  fs.writeFileSync(path.join(dir, "PUBLISH.md"), publishSheet(cfg, meta));
  fs.writeFileSync(path.join(dir, "script.txt"), script.beats.map((b, i) => `[${i + 1}] ${b.text}`).join("\n\n"));

  if (!keepWork) fs.rmSync(work, { recursive: true, force: true });

  store.markIdea(idea.id, "produced", { producedAt: meta.generatedAt, outDir: dir });
  store.addVideo({
    id: idea.id, slug, title: meta.title, hook: meta.hook, formatId: format.id,
    durationSeconds: meta.durationSeconds, musicTrack: meta.musicTrack,
    outDir: dir, createdAt: meta.generatedAt, published: false,
  });

  return { dir, outFile, meta };
}

/* ------------------------------------------------------------------ */

async function concatVoice(timeline, outFile) {
  const inputs = [];
  const chains = [];
  const labels = [];
  timeline.forEach((entry, i) => {
    inputs.push("-i", entry.clip.file);
    chains.push(`[${i}:a]aresample=44100,apad=pad_dur=${entry.pad.toFixed(3)}[a${i}]`);
    labels.push(`[a${i}]`);
  });
  const graph = `${chains.join(";")};${labels.join("")}concat=n=${timeline.length}:v=0:a=1[out]`;
  await ffmpeg([...inputs, "-filter_complex", graph, "-map", "[out]", "-c:a", "aac", "-b:a", "192k", outFile]);
  return outFile;
}

function buildDescription(cfg, script, scenes) {
  const hashtags = script.hashtags.slice(0, cfg.publishing.hashtagCount).map((h) => `#${h.replace(/^#/, "")}`).join(" ");
  const credits = [...new Set(scenes.map((s) => s.asset.credit).filter(Boolean))];
  const sources = [
    script.sourceNote ? `Basis: ${script.sourceNote}` : null,
    credits.length ? `Footage: ${credits.join(", ")} via Pexels` : null,
  ].filter(Boolean).join("\n");

  return cfg.publishing.descriptionTemplate
    .replace("{hook}", script.hook)
    .replace("{summary}", script.description)
    .replace("{sources}", sources)
    .replace("{hashtags}", hashtags)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function publishSheet(cfg, meta) {
  const surfaces = cfg.publishing.surfaces.map((s) => `- [ ] ${s}`).join("\n");
  return [
    `# ${meta.title}`,
    ``,
    `Format: **${meta.formatLabel}** (${meta.formatId}) - ${meta.durationSeconds}s`,
    ``,
    `## Avant de publier`,
    `- [ ] Regarder les 2 premieres secondes: le hook tient-il ?`,
    `- [ ] Le dernier beat livre bien le payoff ?`,
    `- [ ] Sous-titres lisibles et synchro`,
    `- [ ] Aucun visuel qui contredit la narration`,
    meta.aiDisclosure.required
      ? `- [ ] **Cocher "Contenu alteré ou synthétique" sur YouTube** (le script signale un contenu synthetique realiste)`
      : `- [ ] Divulgation IA non requise (voix synthetique seulement, aucune representation realiste de personnes reelles)`,
    ``,
    `## Titre`,
    "```",
    meta.title,
    "```",
    ``,
    `## Description`,
    "```",
    meta.description,
    "```",
    ``,
    `## Tags`,
    "```",
    meta.tags.join(", "),
    "```",
    ``,
    `## Texte de vignette`,
    meta.thumbnailText,
    ``,
    `## Meilleurs creneaux (heure locale)`,
    cfg.publishing.bestPostTimesLocal.map((t) => `- ${t}`).join("\n"),
    ``,
    `## Surfaces`,
    surfaces,
    ``,
    `## Fondement de l'affirmation`,
    meta.sourceNote,
    ``,
    `## Credits`,
    meta.attribution.map((a) => `- Beat ${a.beat}: ${a.source}${a.credit ? ` - ${a.credit}` : ""}`).join("\n"),
    meta.musicTrack ? `- Musique: ${meta.musicTrack}` : `- Aucune musique de fond`,
    ``,
  ].join("\n");
}
