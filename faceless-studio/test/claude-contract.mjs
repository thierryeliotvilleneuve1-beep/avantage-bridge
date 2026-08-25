/**
 * Exercises the Claude layer against a local stand-in for the Messages API.
 * No key and no network needed: this checks the request we actually build
 * (model, effort, structured-output schema, prompt assembly) and that a valid
 * response round-trips into parsed_output.
 *
 *   node test/claude-contract.mjs
 */
import http from "node:http";
import assert from "node:assert/strict";
import { loadConfig } from "../src/lib/config.js";

const captured = [];

const IDEAS_REPLY = {
  ideas: [
    { formatId: "mechanism", title: "The Real Reason People Interrupt You", angle: "Interruption tracks perceived status, not rudeness.", hook: "Notice who gets interrupted in your meetings.", payoff: "Read the room's hierarchy from who talks over whom.", topicSeed: "status and social hierarchy in everyday interactions", groundedIn: "documented turn-taking asymmetry in conversation analysis" },
    { formatId: "experiment", title: "The Study That Broke Trust In Four Minutes", angle: "Trust collapses faster than it rebuilds, asymmetrically.", hook: "Two strangers. One envelope. Four minutes.", payoff: "Repair trust with acts, not explanations.", topicSeed: "trust, betrayal and repair between people", groundedIn: "trust-game experimental economics" },
  ],
};

const SCRIPT_REPLY = {
  title: "The Real Reason People Interrupt You",
  hook: "Notice who gets interrupted in your meetings.",
  beats: [
    { text: "Notice who gets interrupted in your meetings.", visualQuery: "office meeting table", visualPrompt: "a meeting room mid-discussion" },
    { text: "It is almost never the loudest person.", visualQuery: "person speaking group", visualPrompt: "one person speaking" },
    { text: "It is whoever the room ranks lowest.", visualQuery: "empty conference chair", visualPrompt: "an empty chair at a full table" },
  ],
  description: "Interruption maps the hierarchy in a room.",
  hashtags: ["psychology", "work", "status"],
  tags: ["psychology", "workplace", "status", "conversation", "hierarchy"],
  thumbnailText: "Who Gets Interrupted",
  sourceNote: "Turn-taking asymmetry documented in conversation analysis.",
  aiDisclosureNeeded: false,
};

function replyFor(body) {
  const schemaKeys = Object.keys(body.output_config?.format?.schema?.properties ?? {});
  return schemaKeys.includes("ideas") ? IDEAS_REPLY : SCRIPT_REPLY;
}

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => { raw += d; });
  req.on("end", () => {
    const body = JSON.parse(raw);
    captured.push({ path: req.url, body });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "msg_test", type: "message", role: "assistant", model: body.model,
      content: [{ type: "text", text: JSON.stringify(replyFor(body)) }],
      stop_reason: "end_turn", stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 200 },
    }));
  });
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const { port } = server.address();
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
process.env.ANTHROPIC_API_KEY = "sk-ant-test";

const { generateIdeas, writeScript } = await import("../src/providers/claude.js");
const cfg = loadConfig("config/channel.mindloop.json");

/* ---- ideation ---------------------------------------------------- */

const plan = [{ formatId: "mechanism" }, { formatId: "experiment" }];
const ideas = await generateIdeas(cfg, plan, ["An Old Title Already Covered"]);

const ideaReq = captured[0].body;
console.log("\n  requete ideation");
console.log("    model        :", ideaReq.model);
console.log("    effort       :", ideaReq.output_config?.effort);
console.log("    thinking     :", ideaReq.thinking?.type);
console.log("    format       :", ideaReq.output_config?.format?.type);
console.log("    champs schema:", Object.keys(ideaReq.output_config.format.schema.properties.ideas.items.properties).join(", "));

assert.equal(captured[0].path, "/v1/messages");
assert.equal(ideaReq.model, cfg.script.model);
assert.equal(ideaReq.output_config.effort, cfg.script.effort);
assert.equal(ideaReq.thinking.type, "adaptive");
assert.equal(ideaReq.output_config.format.type, "json_schema");
assert.ok(!("budget_tokens" in (ideaReq.thinking ?? {})), "budget_tokens est rejete par les modeles courants");
assert.ok(!ideaReq.messages.some((m) => m.role === "assistant"), "pas de prefill assistant");

const prompt = ideaReq.messages[0].content;
for (const f of ["mechanism", "experiment"]) assert.ok(prompt.includes(`"${f}"`), `format ${f} absent du prompt`);
assert.ok(prompt.includes("An Old Title Already Covered"), "la liste anti-doublon n'est pas passee");
assert.ok(prompt.includes(cfg.topicSeeds[0]), "les graines de sujets ne sont pas passees");
assert.ok(ideaReq.system.includes(cfg.channel.promise), "la bible de chaine n'est pas dans le system prompt");
assert.ok(ideaReq.system.includes(cfg.channel.forbidden[0]), "les interdits ne sont pas dans le system prompt");

assert.equal(ideas.length, 2);
assert.equal(ideas[0].formatId, "mechanism");
console.log("    -> ", ideas.length, "idees parsees");

/* ---- script ------------------------------------------------------ */

const format = cfg.formats.find((f) => f.id === "mechanism");
const script = await writeScript(cfg, { ...ideas[0] }, format, ["A recent hook to avoid"]);

const scriptReq = captured[1].body;
const sp = scriptReq.messages[0].content;
console.log("\n  requete script");
console.log("    champs schema:", Object.keys(scriptReq.output_config.format.schema.properties).join(", "));

assert.ok(sp.includes(format.structure), "la structure du format n'est pas imposee");
assert.ok(sp.includes(format.visualStyle), "le langage visuel n'est pas passe");
assert.ok(sp.includes("A recent hook to avoid"), "les hooks recents ne sont pas passes");
const [minSec, maxSec] = cfg.video.targetSeconds;
assert.ok(sp.includes(String(Math.round(minSec * cfg.script.wordsPerSecond))), "le budget de mots n'est pas calcule");
assert.equal(script.beats.length, 3);
assert.equal(script.aiDisclosureNeeded, false);
console.log("    -> script parse:", script.beats.length, "beats");

/* ---- erreur de refus --------------------------------------------- */

server.close();
const refuser = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    id: "msg_r", type: "message", role: "assistant", model: "claude-opus-5",
    content: [], stop_reason: "refusal",
    stop_details: { type: "refusal", category: null, explanation: "test" },
    usage: { input_tokens: 1, output_tokens: 0 },
  }));
});
await new Promise((r) => refuser.listen(port, "127.0.0.1", r));

await assert.rejects(
  () => generateIdeas(cfg, plan, []),
  /n'a pas retourne d'idees exploitables/,
  "un refus doit remonter une erreur claire, pas un crash sur parsed_output null",
);
console.log("\n  refus API -> erreur explicite: ok");
refuser.close();

console.log("\n  CONTRAT CLAUDE OK\n");
