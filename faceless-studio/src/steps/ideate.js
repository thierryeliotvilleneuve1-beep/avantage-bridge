import { generateIdeas } from "../providers/claude.js";
import { log } from "../lib/log.js";

/**
 * Choose which format each new idea should use.
 *
 * Rotation is enforced in code, not left to the model: the whole point is that
 * consecutive uploads differ structurally, and a model asked to "vary things"
 * drifts back to its favourite shape within a few calls.
 */
export function planFormats(cfg, store, count) {
  const avoid = cfg.variation.avoidLastNFormats ?? 3;
  // Read back further than the avoid window: least-recently-used only balances
  // if every format has a position in the history. With a short window most
  // formats tie at "never seen" and the tiebreak silently favours whichever is
  // listed first in the config.
  const lookback = Math.max(avoid + 1, cfg.formats.length * 3);
  const plan = [];
  const window = store.recentFormatIds(lookback);

  for (let i = 0; i < count; i++) {
    const eligible = cfg.formats.filter((f) => !window.slice(-avoid).includes(f.id));
    const pool = eligible.length ? eligible : cfg.formats;

    // Least-recently-used within the pool, so the rotation stays even over time.
    const scored = pool
      .map((f) => ({ f, lastUsed: window.lastIndexOf(f.id) }))
      .sort((a, b) => a.lastUsed - b.lastUsed);

    const chosen = scored[0].f;
    plan.push({ formatId: chosen.id });
    window.push(chosen.id);
  }
  return plan;
}

export function slugify(s) {
  return String(s)
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export async function ideate(cfg, store, count) {
  const plan = planFormats(cfg, store, count);
  const counts = plan.reduce((m, p) => ({ ...m, [p.formatId]: (m[p.formatId] || 0) + 1 }), {});
  log.info(`Rotation des formats: ${Object.entries(counts).map(([k, v]) => `${k}x${v}`).join(", ")}`);

  const avoidTitles = store.knownTopics(cfg.variation.avoidLastNTopics ?? 40);
  const ideas = await generateIdeas(cfg, plan, avoidTitles);

  if (ideas.length !== plan.length) {
    log.warn(`${ideas.length} idees retournees pour ${plan.length} demandees`);
  }

  const stamped = ideas.map((idea, i) => ({
    id: `${Date.now().toString(36)}-${i}`,
    slug: slugify(idea.title),
    status: "pending",
    createdAt: new Date().toISOString(),
    ...idea,
    // Trust the plan over the model if it echoed the wrong slot.
    formatId: plan[Math.min(i, plan.length - 1)].formatId,
  }));

  const fresh = store.addIdeas(stamped);
  const dropped = stamped.length - fresh.length;
  if (dropped) log.warn(`${dropped} idee(s) ecartee(s) - deja en banque`);
  return fresh;
}
