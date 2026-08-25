import fs from "node:fs";
import { ffmpeg, probeDuration } from "../lib/ffmpeg.js";

/**
 * Every provider exposes the same contract:
 *   synth(text, outMp3) -> { words: {word,start,end}[] | null }
 * `words` is relative to the start of THIS clip. null means the provider gave
 * no timing data and the caller must estimate.
 */

/* ------------------------------------------------------------------ */
/* ElevenLabs - the only provider that returns real character timings  */
/* ------------------------------------------------------------------ */

const ELEVEN_MODEL = process.env.ELEVENLABS_MODEL_ID || "eleven_multilingual_v2";

async function elevenlabs(text, outMp3) {
  const key = process.env.ELEVENLABS_API_KEY;
  const voice = process.env.ELEVENLABS_VOICE_ID;
  if (!key) throw new Error("ELEVENLABS_API_KEY manquant");
  if (!voice) throw new Error("ELEVENLABS_VOICE_ID manquant");

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}/with-timestamps?output_format=mp3_44100_128`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "xi-api-key": key, "content-type": "application/json" },
    body: JSON.stringify({
      text,
      model_id: ELEVEN_MODEL,
      voice_settings: { stability: 0.42, similarity_boost: 0.75, style: 0.25, use_speaker_boost: true },
    }),
  });

  if (!res.ok) {
    throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 400)}`);
  }

  const payload = await res.json();
  if (!payload.audio_base64) throw new Error("ElevenLabs n'a pas retourne d'audio");
  fs.writeFileSync(outMp3, Buffer.from(payload.audio_base64, "base64"));

  const align = payload.normalized_alignment || payload.alignment;
  return { words: align ? charsToWords(align) : null };
}

/** Collapse per-character timings into per-word timings. */
function charsToWords(alignment) {
  const chars = alignment.characters || [];
  const starts = alignment.character_start_times_seconds || [];
  const ends = alignment.character_end_times_seconds || [];
  const words = [];
  let buf = "", start = null, end = null;

  const flush = () => {
    if (buf.trim() && start !== null) words.push({ word: buf.trim(), start, end: end ?? start });
    buf = ""; start = null; end = null;
  };

  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (/\s/.test(c)) { flush(); continue; }
    if (start === null) start = starts[i] ?? 0;
    end = ends[i] ?? start;
    buf += c;
  }
  flush();
  return words;
}

/* ------------------------------------------------------------------ */
/* OpenAI - cheaper, no timings                                        */
/* ------------------------------------------------------------------ */

async function openai(text, outMp3) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY manquant");

  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts",
      voice: process.env.OPENAI_TTS_VOICE || "onyx",
      input: text,
      response_format: "mp3",
    }),
  });

  if (!res.ok) throw new Error(`OpenAI TTS ${res.status}: ${(await res.text()).slice(0, 400)}`);
  fs.writeFileSync(outMp3, Buffer.from(await res.arrayBuffer()));
  return { words: null };
}

/* ------------------------------------------------------------------ */
/* Silent - offline dry run of the render path                          */
/* ------------------------------------------------------------------ */

async function silent(text, outMp3) {
  const words = text.split(/\s+/).filter(Boolean).length;
  const seconds = Math.max(1, words / 2.6);
  await ffmpeg([
    "-f", "lavfi", "-i", `anullsrc=r=44100:cl=mono`,
    "-t", seconds.toFixed(3), "-c:a", "libmp3lame", "-q:a", "5", outMp3,
  ]);
  return { words: null };
}

const PROVIDERS = { elevenlabs, openai, silent };

export function ttsProviderName() {
  return (process.env.TTS_PROVIDER || "elevenlabs").toLowerCase();
}

/**
 * Synthesize one beat. Returns absolute-file info plus relative word timings.
 * @returns {Promise<{file:string, duration:number, words:{word:string,start:number,end:number}[]|null}>}
 */
export async function synthesizeBeat(text, outMp3) {
  const name = ttsProviderName();
  const fn = PROVIDERS[name];
  if (!fn) throw new Error(`TTS_PROVIDER inconnu: ${name} (attendu: ${Object.keys(PROVIDERS).join(", ")})`);
  const { words } = await fn(text, outMp3);
  const duration = await probeDuration(outMp3);
  return { file: outMp3, duration, words };
}
