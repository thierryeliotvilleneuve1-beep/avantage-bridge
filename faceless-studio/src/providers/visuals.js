import fs from "node:fs";
import path from "node:path";
import { ffmpeg } from "../lib/ffmpeg.js";
import { log } from "../lib/log.js";

/**
 * A visual asset for one beat.
 * @typedef {{kind:"video"|"image", file:string, credit:string|null, source:string}} Asset
 */

async function download(url, dest, tries = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 2048) throw new Error(`reponse trop petite (${buf.length} octets)`);
      fs.writeFileSync(dest, buf);
      return dest;
    } catch (e) {
      lastErr = e;
      if (attempt < tries) await new Promise((r) => setTimeout(r, 800 * attempt));
    }
  }
  throw new Error(`Telechargement echoue apres ${tries} essais (${url.slice(0, 90)}...): ${lastErr.message}`);
}

/* ------------------------------------------------------------------ */
/* Pexels                                                              */
/* ------------------------------------------------------------------ */

async function pexelsSearch(kind, query, minSeconds) {
  const key = process.env.PEXELS_API_KEY;
  if (!key) throw new Error("PEXELS_API_KEY manquant");

  const base = kind === "video"
    ? "https://api.pexels.com/videos/search"
    : "https://api.pexels.com/v1/search";
  const url = `${base}?query=${encodeURIComponent(query)}&orientation=portrait&per_page=20`;

  const res = await fetch(url, { headers: { authorization: key } });
  if (!res.ok) throw new Error(`Pexels ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();

  if (kind === "video") {
    return (json.videos || [])
      .filter((v) => v.duration >= Math.max(3, Math.ceil(minSeconds)))
      .map((v) => {
        // Prefer the smallest file that still covers a 1080-wide vertical frame.
        const file = (v.video_files || [])
          .filter((f) => f.file_type === "video/mp4" && f.width && f.height)
          .sort((a, b) => a.width * a.height - b.width * b.height)
          .find((f) => Math.min(f.width, f.height) >= 1080)
          ?? (v.video_files || []).sort((a, b) => b.width * b.height - a.width * a.height)[0];
        return file && { id: `pexels-video-${v.id}`, url: file.link, credit: v.user?.name || null };
      })
      .filter(Boolean);
  }

  return (json.photos || [])
    .map((p) => ({
      id: `pexels-photo-${p.id}`,
      url: p.src?.portrait || p.src?.large2x || p.src?.original,
      credit: p.photographer || null,
    }))
    .filter((p) => p.url);
}

async function fromPexels(beat, ctx) {
  const wantVideo = ctx.format.visualSource === "video";
  const kind = wantVideo ? "video" : "image";
  const queries = [beat.visualQuery, ...fallbackQueries(beat, ctx)];

  for (const query of queries) {
    let hits = [];
    try {
      hits = await pexelsSearch(kind, query, ctx.seconds);
    } catch (e) {
      log.warn(`Pexels "${query}": ${e.message}`);
      continue;
    }
    const pick = hits.find((h) => !ctx.used.has(h.id));
    if (!pick) continue;
    ctx.used.add(pick.id);
    const ext = kind === "video" ? "mp4" : "jpg";
    const dest = path.join(ctx.dir, `${ctx.index}-${pick.id}.${ext}`);
    await download(pick.url, dest);
    return { kind: wantVideo ? "video" : "image", file: dest, credit: pick.credit, source: `Pexels (${query})` };
  }
  return null;
}

/** Broaden a failed search: the format's visual language, then the raw topic. */
function fallbackQueries(beat, ctx) {
  const styleWords = String(ctx.format.visualStyle).split(/,\s*/)[0];
  return [
    beat.visualQuery.split(/\s+/).slice(-2).join(" "),
    styleWords,
    ctx.fallbackTerm,
  ].filter(Boolean);
}

/* ------------------------------------------------------------------ */
/* Pollinations - keyless AI images                                    */
/* ------------------------------------------------------------------ */

async function fromPollinations(beat, ctx) {
  const prompt = `${beat.visualPrompt}. ${ctx.format.visualStyle}. vertical composition, no text, no words, no letters, no watermark`;
  const seed = Math.abs(hash(`${ctx.slug}-${ctx.index}`)) % 1_000_000;
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}`
    + `?width=1080&height=1920&nologo=true&model=flux&seed=${seed}`;
  const dest = path.join(ctx.dir, `${ctx.index}-ai.jpg`);
  await download(url, dest, 4);
  return { kind: "image", file: dest, credit: null, source: "Pollinations (flux)" };
}

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

/* ------------------------------------------------------------------ */
/* Solid - offline placeholder so the render path is testable           */
/* ------------------------------------------------------------------ */

const PALETTE = ["#12232e", "#1d3c45", "#2a1b3d", "#3a2618", "#14342b", "#241f31"];

async function fromSolid(beat, ctx) {
  const colour = PALETTE[ctx.index % PALETTE.length];
  const dest = path.join(ctx.dir, `${ctx.index}-solid.png`);
  await ffmpeg([
    "-f", "lavfi",
    "-i", `color=c=${colour}:s=1080x1920`,
    "-vf", "noise=alls=12:allf=t+u,gblur=sigma=8",
    "-frames:v", "1", dest,
  ]);
  return { kind: "image", file: dest, credit: null, source: "placeholder local" };
}

/* ------------------------------------------------------------------ */

const PROVIDERS = { pexels: fromPexels, pollinations: fromPollinations, solid: fromSolid };

export function visualsProviderName(format) {
  if (format?.visualSource === "ai") return "pollinations";
  return (process.env.VISUALS_PROVIDER || "pexels").toLowerCase();
}

/**
 * Fetch the visual for one beat, falling back to a local placeholder rather
 * than aborting a whole render over one missing clip.
 * @returns {Promise<Asset>}
 */
export async function fetchVisual(beat, ctx) {
  const name = visualsProviderName(ctx.format);
  const fn = PROVIDERS[name];
  if (!fn) throw new Error(`VISUALS_PROVIDER inconnu: ${name} (attendu: ${Object.keys(PROVIDERS).join(", ")})`);

  try {
    const asset = await fn(beat, ctx);
    if (asset) return asset;
    log.warn(`Aucun visuel trouve pour "${beat.visualQuery}" - placeholder utilise`);
  } catch (e) {
    log.warn(`Visuel beat ${ctx.index} (${name}): ${e.message} - placeholder utilise`);
  }
  return fromSolid(beat, ctx);
}
