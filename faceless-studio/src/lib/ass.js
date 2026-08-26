/**
 * Builds an ASS subtitle track with word-level highlighting - the caption style
 * that carries short-form retention: 2-4 words on screen, the spoken word lit up.
 */

/** ASS colours are &HAABBGGRR - byte-reversed from web hex. */
function assColour(hexRRGGBB, alpha = "00") {
  const h = String(hexRRGGBB).replace("#", "").padStart(6, "0").toUpperCase();
  return `&H${alpha}${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`;
}

function ts(seconds) {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}:${String(m).padStart(2, "0")}:${sec.toFixed(2).padStart(5, "0")}`;
}

/** Text inside a Dialogue line: braces start override blocks, so neutralise them. */
function escapeText(t) {
  return String(t).replace(/\{/g, "(").replace(/\}/g, ")").replace(/\r?\n/g, " ").trim();
}

/**
 * Group words for display. A group never straddles a sentence end or a beat
 * boundary - "LOOKED UP. UNDER" on one line reads as a single broken thought
 * and is the fastest way to lose a viewer mid-scroll.
 */
function groupWords(words, size) {
  const groups = [];
  let current = [];
  for (let i = 0; i < words.length; i++) {
    current.push(words[i]);
    const next = words[i + 1];
    const endsSentence = /[.!?:;]["')\]]?$/.test(words[i].raw);
    const beatChanges = next && next.beat !== words[i].beat;
    if (current.length >= size || endsSentence || beatChanges || !next) {
      groups.push(current);
      current = [];
    }
  }
  if (current.length) groups.push(current);
  return groups;
}

/**
 * @param {{word:string,start:number,end:number}[]} words
 * @param {object} caps  config.captions (activeColour may be overridden per format)
 * @param {{width:number,height:number}} video
 * @returns {string} ASS file content
 */
export function buildAss(words, caps, video) {
  const primary = assColour(caps.primaryColour || "FFFFFF");
  const active = assColour(caps.activeColour || "3BE8B0");
  const outline = assColour("000000");
  const back = assColour("000000", "A0");
  const font = caps.fontName || "Arial Black";

  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${video.width}`,
    `PlayResY: ${video.height}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "YCbCr Matrix: TV.709",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Cap,${font},${caps.fontSize || 92},${primary},${primary},${outline},${back},-1,0,0,0,100,100,1,0,1,${caps.outlinePx ?? 7},${caps.shadowPx ?? 3},2,70,70,${caps.marginBottomPx ?? 620},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];

  const clean = words
    .filter((w) => w && String(w.word).trim())
    .map((w) => {
      const raw = String(w.word).trim();
      return {
        raw,
        word: caps.uppercase === false ? raw : raw.toUpperCase(),
        start: Number(w.start) || 0,
        end: Number(w.end) || 0,
        beat: w.beat ?? 0,
      };
    })
    .filter((w) => w.end > w.start);

  const groups = groupWords(clean, Math.max(1, caps.wordsPerGroup || 3));
  const events = [];

  for (const group of groups) {
    for (let i = 0; i < group.length; i++) {
      const w = group[i];
      // Hold the last word of a group until the next group starts, so the line
      // never blinks out during a pause in the narration.
      const isLast = i === group.length - 1;
      const end = isLast ? Math.max(w.end, group[group.length - 1].end) : group[i + 1].start;

      const rendered = group
        .map((g, j) =>
          j === i
            ? `{\\c${active}\\fscx108\\fscy108}${escapeText(g.word)}{\\c${primary}\\fscx100\\fscy100}`
            : escapeText(g.word),
        )
        .join(" ");

      const intro = i === 0 ? "{\\fad(70,0)}" : "";
      events.push(`Dialogue: 0,${ts(w.start)},${ts(end)},Cap,,0,0,0,,${intro}${rendered}`);
    }
  }

  return `${header.join("\n")}\n${events.join("\n")}\n`;
}

/**
 * Fallback timing when the TTS provider returns no character alignment:
 * distribute each beat's duration across its words, weighted by word length
 * (longer words genuinely take longer to say) plus a fixed per-word cost.
 */
export function estimateWordTimings(beats) {
  const out = [];
  for (const beat of beats) {
    const words = String(beat.text).split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    const weights = words.map((w) => 1.6 + w.replace(/[^A-Za-z0-9']/g, "").length);
    const total = weights.reduce((a, b) => a + b, 0);
    const span = Math.max(0.2, beat.end - beat.start);
    let t = beat.start;
    for (let i = 0; i < words.length; i++) {
      const d = (weights[i] / total) * span;
      out.push({ word: words[i], start: t, end: t + d, beat: beat.index ?? 0 });
      t += d;
    }
  }
  return out;
}
