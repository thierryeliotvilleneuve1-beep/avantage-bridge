/**
 * The format rotation is the anti-"inauthentic content" mechanism: consecutive
 * uploads must differ structurally. Assert it actually holds over a long run.
 *
 *   node test/rotation.mjs
 */
import assert from "node:assert/strict";
import { loadConfig } from "../src/lib/config.js";
import { planFormats, slugify } from "../src/steps/ideate.js";

const cfg = loadConfig("config/channel.mindloop.json");
const avoid = cfg.variation.avoidLastNFormats;

// Fake store: only the two methods planFormats touches.
const shipped = [];
const store = { recentFormatIds: (n) => shipped.slice(-n) };

// Simulate 60 uploads, planning in realistic batches of 1-4.
const sequence = [];
let i = 0;
while (sequence.length < 60) {
  const batch = planFormats(cfg, store, [1, 3, 2, 4][i++ % 4]);
  for (const p of batch) { sequence.push(p.formatId); shipped.push(p.formatId); }
}

// No format may repeat inside any window of `avoid + 1`.
for (let k = 0; k + avoid < sequence.length; k++) {
  const window = sequence.slice(k, k + avoid + 1);
  assert.equal(new Set(window).size, window.length,
    `format repete dans une fenetre de ${avoid + 1}: ${window.join(", ")} (position ${k})`);
}

const counts = sequence.reduce((m, f) => ({ ...m, [f]: (m[f] || 0) + 1 }), {});
const values = Object.values(counts);
const spread = Math.max(...values) - Math.min(...values);

console.log("\n  60 uploads simules");
console.log("   ", Object.entries(counts).map(([k, v]) => `${k}:${v}`).join("  "));
console.log("    ecart max-min :", spread);
console.log("    fenetre sans repetition :", avoid + 1);

assert.equal(Object.keys(counts).length, cfg.formats.length, "un format n'est jamais utilise");
assert.ok(spread <= 2, `rotation desequilibree (ecart ${spread})`);

assert.equal(slugify("Why  People *Interrupt* You!"), "why-people-interrupt-you");
assert.equal(slugify("Élève à l'école — déjà vu"), "eleve-a-l-ecole-deja-vu");
console.log("    slugify (accents, ponctuation) : ok");

console.log("\n  ROTATION OK\n");
