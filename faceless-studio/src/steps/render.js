import path from "node:path";
import { ffmpeg } from "../lib/ffmpeg.js";
import { ffPath, FONTS_DIR } from "../lib/paths.js";
import fs from "node:fs";

/**
 * Assemble the final vertical video in a single ffmpeg pass.
 *
 * One pass rather than per-scene intermediates: the concat *filter* enforces
 * matching geometry itself, so there is no chance of the concat demuxer
 * silently stitching mismatched clips.
 */
export async function renderVideo({ scenes, voiceFile, musicFile, assFile, outFile, cfg, totalSeconds }) {
  const { width, height, fps, codec } = cfg.video;
  const inputs = [];
  const chains = [];
  const labels = [];

  scenes.forEach((scene, i) => {
    const d = scene.duration.toFixed(3);
    if (scene.asset.kind === "image") {
      inputs.push("-loop", "1", "-framerate", String(fps), "-t", d, "-i", scene.asset.file);
      chains.push(`${imageChain(i, scene, cfg)}`);
    } else {
      inputs.push("-stream_loop", "-1", "-t", d, "-i", scene.asset.file);
      chains.push(`${videoChain(i, scene, cfg)}`);
    }
    labels.push(`[v${i}]`);
  });

  const voiceIdx = scenes.length;
  inputs.push("-i", voiceFile);

  let musicIdx = null;
  if (musicFile) {
    musicIdx = voiceIdx + 1;
    inputs.push("-stream_loop", "-1", "-t", totalSeconds.toFixed(3), "-i", musicFile);
  }

  const subtitle = `subtitles=filename='${ffPath(assFile)}'`
    + (hasFonts() ? `:fontsdir='${ffPath(FONTS_DIR)}'` : "");

  const graph = [
    ...chains,
    `${labels.join("")}concat=n=${scenes.length}:v=1:a=0[vcat]`,
    `[vcat]${subtitle},format=yuv420p[vout]`,
    audioGraph(cfg, voiceIdx, musicIdx, totalSeconds),
  ].join(";");

  await ffmpeg([
    ...inputs,
    "-filter_complex", graph,
    "-map", "[vout]", "-map", "[aout]",
    "-c:v", codec.vcodec, "-preset", codec.preset, "-crf", String(codec.crf),
    "-pix_fmt", "yuv420p", "-r", String(fps),
    "-c:a", codec.acodec, "-b:a", codec.abitrate, "-ar", "44100", "-ac", "2",
    "-movflags", "+faststart",
    "-t", totalSeconds.toFixed(3),
    outFile,
  ]);

  return outFile;
}

/** Ken Burns on stills, direction alternating so a run of images does not pulse in sync. */
function imageChain(i, scene, cfg) {
  const { width, height, fps } = cfg.video;
  const frames = Math.max(2, Math.round(scene.duration * fps));
  const amount = 0.18;
  const rate = (amount / frames).toFixed(7);
  const z = i % 2 === 0
    ? `min(1+${rate}*on,${(1 + amount).toFixed(3)})`
    : `max(${(1 + amount).toFixed(3)}-${rate}*on,1.0)`;

  // Oversample first: zoompan crops from the input, so a 2x source keeps the
  // zoomed frame sharp instead of upscaling a 1080-wide crop.
  return `[${i}:v]scale=${width * 2}:${height * 2}:force_original_aspect_ratio=increase,`
    + `crop=${width * 2}:${height * 2},`
    + `zoompan=z='${z}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${width}x${height}:fps=${fps},`
    + `setsar=1,format=yuv420p[v${i}]`;
}

function videoChain(i, scene, cfg) {
  const { width, height, fps } = cfg.video;
  return `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,`
    + `crop=${width}:${height},fps=${fps},setsar=1,format=yuv420p,`
    + `trim=duration=${scene.duration.toFixed(3)},setpts=PTS-STARTPTS[v${i}]`;
}

function audioGraph(cfg, voiceIdx, musicIdx, total) {
  const a = cfg.audio;
  const voice = `[${voiceIdx}:a]aresample=44100,volume=${a.voiceGainDb}dB[vo]`;

  if (musicIdx === null) {
    return `${voice};[vo]loudnorm=${cfg.video.loudnessTarget}[aout]`;
  }

  const fadeOutStart = Math.max(0, total - (a.musicFadeOutSeconds ?? 1.2)).toFixed(3);
  const music = `[${musicIdx}:a]aresample=44100,volume=${a.musicGainDb}dB,`
    + `afade=t=in:st=0:d=${a.musicFadeInSeconds ?? 0.6},`
    + `afade=t=out:st=${fadeOutStart}:d=${a.musicFadeOutSeconds ?? 1.2}[mu]`;

  // normalize=0 is load-bearing: amix otherwise divides every input by the
  // input count and silently undoes the mix levels set above.
  return `${voice};${music};[vo][mu]amix=inputs=2:duration=first:normalize=0[mix];`
    + `[mix]loudnorm=${cfg.video.loudnessTarget}[aout]`;
}

function hasFonts() {
  try {
    return fs.readdirSync(FONTS_DIR).some((f) => /\.(ttf|otf|ttc)$/i.test(f));
  } catch {
    return false;
  }
}

/** Grab a clean frame for the cover / first-frame check. */
export async function extractCover(videoFile, atSeconds, outFile) {
  await ffmpeg(["-ss", atSeconds.toFixed(2), "-i", videoFile, "-frames:v", "1", "-q:v", "3", outFile]);
  return outFile;
}
