import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

let client;
function anthropic() {
  if (!client) client = new Anthropic();
  return client;
}

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const IdeaSchema = z.object({
  formatId: z.string().describe("The format id you were assigned for this slot. Copy it exactly."),
  title: z.string().describe("YouTube Shorts title, <= 70 chars, no clickbait the video cannot pay off, no emoji."),
  angle: z.string().describe("One sentence: the specific claim this video makes. Must be falsifiable, not a vibe."),
  hook: z.string().describe("The first spoken line, <= 12 words, written in the format's hook pattern."),
  payoff: z.string().describe("One sentence: what the viewer can DO or NOTICE after watching."),
  topicSeed: z.string().describe("Which topic seed from the list this comes from."),
  groundedIn: z.string().describe("The named mechanism, effect, study or documented pattern this rests on. If it is a general principle with no single source, say so plainly."),
});

const IdeasSchema = z.object({
  ideas: z.array(IdeaSchema),
});

const BeatSchema = z.object({
  text: z.string().describe("Spoken narration for this beat. One or two short sentences. Plain spoken English, no stage directions, no emoji, no markdown."),
  visualQuery: z.string().describe("2-4 word stock footage search term for this beat. Concrete and filmable: 'crowded subway platform', not 'feeling of isolation'."),
  visualPrompt: z.string().describe("A full image-generation prompt for this beat, matching the format's visual style. One sentence, concrete, no text in the image."),
});

const ScriptSchema = z.object({
  title: z.string().describe("Final YouTube Shorts title, <= 70 chars, no emoji."),
  hook: z.string().describe("The exact first spoken line. This is also beats[0].text."),
  beats: z.array(BeatSchema).describe("The full narration in order, including the hook as the first beat."),
  description: z.string().describe("2-3 sentence YouTube description. States what the video claims and where it comes from. No links."),
  hashtags: z.array(z.string()).describe("Hashtags without the # symbol, lowercase, no spaces."),
  tags: z.array(z.string()).describe("10-15 YouTube tags, lowercase."),
  thumbnailText: z.string().describe("3-5 words for a cover frame."),
  sourceNote: z.string().describe("The named effect, study or documented pattern behind the claim, or an honest statement that it is a general principle."),
  aiDisclosureNeeded: z.boolean().describe("True only if the video contains realistic synthetic depictions of real people or events that a viewer could mistake for real footage."),
});

/* ------------------------------------------------------------------ */
/* Prompts                                                             */
/* ------------------------------------------------------------------ */

function channelBible(cfg) {
  const ch = cfg.channel;
  return [
    `You write for "${ch.name}", a faceless short-form video channel.`,
    ``,
    `Niche: ${ch.niche}`,
    `Promise to the viewer: ${ch.promise}`,
    `Audience: ${ch.audience}`,
    `Voice: ${ch.voiceOfChannel}`,
    ``,
    `Hard rules - never break these:`,
    ...ch.forbidden.map((f) => `- Never: ${f}`),
    `- Every claim must rest on a named mechanism, effect, study, or a plainly-labelled general principle. If you cannot name what it rests on, pick a different claim.`,
    `- Write for the ear, not the eye. Short sentences. No subordinate clause pile-ups. No lists read aloud as "number one, number two".`,
    `- Second person. The viewer is the subject.`,
    `- Do not open with "Did you know", "Here's why", "Scientists have discovered" or any variant.`,
    ``,
    `Why this matters commercially: YouTube demonetises content it judges "inauthentic" - `,
    `templated videos reproduced at scale with no real authorial input. Two videos from this `,
    `channel must not feel like the same video with the nouns swapped. Structure, rhythm and `,
    `the shape of the argument must genuinely differ.`,
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/* Calls                                                               */
/* ------------------------------------------------------------------ */

/**
 * @param {object} cfg channel config
 * @param {{formatId:string}[]} assignments one slot per idea, format already rotated by the caller
 * @param {string[]} avoidTitles titles already banked or shipped
 */
export async function generateIdeas(cfg, assignments, avoidTitles) {
  const formatsById = new Map(cfg.formats.map((f) => [f.id, f]));
  const slots = assignments.map((a, i) => {
    const f = formatsById.get(a.formatId);
    return [
      `Slot ${i + 1} - formatId: "${f.id}" (${f.label})`,
      `  structure: ${f.structure}`,
      `  hook pattern: ${f.hookPattern}`,
    ].join("\n");
  });

  const user = [
    `Generate exactly ${assignments.length} video ideas, one per slot below.`,
    `Each idea MUST follow the structure and hook pattern of its assigned format.`,
    ``,
    slots.join("\n\n"),
    ``,
    `Topic seeds to draw from (pick freely, spread across several):`,
    ...cfg.topicSeeds.map((s) => `- ${s}`),
    ``,
    avoidTitles.length
      ? `Already covered on this channel - do not repeat these angles, and do not produce a near-synonym of any of them:\n${avoidTitles.map((t) => `- ${t}`).join("\n")}`
      : `Nothing has shipped yet, so nothing is off limits.`,
    ``,
    `Return ${assignments.length} ideas in slot order.`,
  ].join("\n");

  const res = await anthropic().messages.parse({
    model: cfg.script.model || "claude-opus-5",
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    cache_control: { type: "ephemeral" },
    system: channelBible(cfg),
    output_config: {
      effort: cfg.script.effort || "high",
      format: zodOutputFormat(IdeasSchema),
    },
    messages: [{ role: "user", content: user }],
  });

  if (!res.parsed_output) {
    throw new Error(`Claude n'a pas retourne d'idees exploitables (stop_reason: ${res.stop_reason})`);
  }
  return res.parsed_output.ideas;
}

/**
 * @param {object} cfg
 * @param {object} idea a banked idea record
 * @param {object} format the format definition for this idea
 * @param {string[]} avoidHooks recent hooks, so openings do not converge
 */
export async function writeScript(cfg, idea, format, avoidHooks) {
  const [minBeats, maxBeats] = cfg.script.beatCount;
  const [minSec, maxSec] = cfg.video.targetSeconds;
  const wps = cfg.script.wordsPerSecond;
  const wordBudget = [Math.round(minSec * wps), Math.round(maxSec * wps)];

  const user = [
    `Write the full script for this video.`,
    ``,
    `Title direction: ${idea.title}`,
    `The claim: ${idea.angle}`,
    `Proposed hook: ${idea.hook}`,
    `The payoff the viewer walks away with: ${idea.payoff}`,
    `Grounded in: ${idea.groundedIn}`,
    ``,
    `Format: ${format.label} (${format.id})`,
    `Structure you must follow: ${format.structure}`,
    `Hook pattern: ${format.hookPattern}`,
    `Visual language for this format: ${format.visualStyle}`,
    ``,
    `Hard constraints:`,
    `- ${minBeats} to ${maxBeats} beats. Beat 1 IS the hook and must be <= ${cfg.script.hookMaxWords} words.`,
    `- Total narration ${wordBudget[0]}-${wordBudget[1]} words. That is a hard ceiling: at ${wps} words/second it lands the video at ${minSec}-${maxSec} seconds. Count your words.`,
    `- Each beat needs a visualQuery that a stock footage library can actually match, and a visualPrompt in this format's visual language.`,
    `- The last beat must land the payoff. Do not end on "so next time you..." or ask the viewer to like and subscribe.`,
    ``,
    avoidHooks.length
      ? `Recent openings on this channel. Do not reuse their sentence shape:\n${avoidHooks.map((h) => `- ${h}`).join("\n")}`
      : `No recent openings to avoid.`,
  ].join("\n");

  const res = await anthropic().messages.parse({
    model: cfg.script.model || "claude-opus-5",
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    cache_control: { type: "ephemeral" },
    system: channelBible(cfg),
    output_config: {
      effort: cfg.script.effort || "high",
      format: zodOutputFormat(ScriptSchema),
    },
    messages: [{ role: "user", content: user }],
  });

  if (!res.parsed_output) {
    throw new Error(`Claude n'a pas retourne de script exploitable (stop_reason: ${res.stop_reason})`);
  }
  return res.parsed_output;
}
