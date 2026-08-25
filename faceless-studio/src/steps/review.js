import fs from "node:fs";
import path from "node:path";
import { OUT_DIR } from "../lib/paths.js";

/**
 * Build a local review page over out/ - the human checkpoint in the pipeline.
 * Everything needed to approve and post lives on one screen: the video, the
 * hook, the copy-paste title/description/tags.
 */
export function buildReview() {
  if (!fs.existsSync(OUT_DIR)) return null;

  const items = fs.readdirSync(OUT_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(OUT_DIR, d.name))
    .filter((dir) => fs.existsSync(path.join(dir, "metadata.json")))
    .map((dir) => {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, "metadata.json"), "utf8"));
      const video = fs.readdirSync(dir).find((f) => f.endsWith(".mp4"));
      return { dir, name: path.basename(dir), meta, video };
    })
    .sort((a, b) => b.name.localeCompare(a.name));

  const html = page(items);
  const out = path.join(OUT_DIR, "review.html");
  fs.writeFileSync(out, html);
  return { file: out, count: items.length };
}

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function card(item) {
  const m = item.meta;
  const rel = (f) => `./${encodeURIComponent(item.name)}/${encodeURIComponent(f)}`;
  const disclosure = m.aiDisclosure?.required
    ? `<span class="pill warn">Divulgation IA requise</span>`
    : `<span class="pill">Divulgation IA non requise</span>`;

  return `
  <article class="card">
    <div class="player">
      ${item.video ? `<video src="${rel(item.video)}" controls preload="metadata" playsinline></video>` : `<div class="missing">mp4 absent</div>`}
    </div>
    <div class="body">
      <div class="meta">
        <span class="pill accent">${esc(m.formatLabel)}</span>
        <span class="pill">${m.durationSeconds}s</span>
        ${disclosure}
      </div>
      <h2>${esc(m.title)}</h2>
      <p class="hook">${esc(m.hook)}</p>

      <details><summary>Description</summary>
        <pre data-copy>${esc(m.description)}</pre></details>
      <details><summary>Tags (${m.tags?.length ?? 0})</summary>
        <pre data-copy>${esc((m.tags || []).join(", "))}</pre></details>
      <details><summary>Script beat par beat</summary>
        <ol class="beats">${(m.beats || []).map((b) => `<li><span>${b.start}s</span> ${esc(b.text)}</li>`).join("")}</ol></details>
      <details><summary>Fondement &amp; credits</summary>
        <p class="src">${esc(m.sourceNote)}</p>
        <ul>${(m.attribution || []).map((a) => `<li>Beat ${a.beat}: ${esc(a.source)}${a.credit ? ` - ${esc(a.credit)}` : ""}</li>`).join("")}</ul>
        <p class="src">Musique: ${esc(m.musicTrack || "aucune")}</p></details>
      <p class="links"><a href="${rel("PUBLISH.md")}">PUBLISH.md</a> &middot; <a href="${rel("metadata.json")}">metadata.json</a></p>
    </div>
  </article>`;
}

function page(items) {
  const formats = [...new Set(items.map((i) => i.meta.formatId))];
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Revue - faceless studio</title>
<style>
:root{--bg:#0d1117;--card:#161b22;--line:#262d36;--fg:#e6edf3;--dim:#8b949e;--accent:#3be8b0;--warn:#ffd166}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif}
header{padding:28px 24px 8px;max-width:1400px;margin:0 auto}
h1{margin:0 0 4px;font-size:22px}
.sub{color:var(--dim);font-size:13px}
main{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:20px;padding:20px 24px 60px;max-width:1400px;margin:0 auto}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;overflow:hidden;display:flex;flex-direction:column}
.player{background:#000;aspect-ratio:9/16;max-height:520px;display:flex;align-items:center;justify-content:center}
video{width:100%;height:100%;object-fit:contain}
.missing{color:var(--dim);font-size:13px}
.body{padding:14px 16px 16px}
.meta{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px}
.pill{font-size:11px;padding:3px 9px;border-radius:999px;background:#21262d;color:var(--dim);border:1px solid var(--line)}
.pill.accent{background:rgba(59,232,176,.12);color:var(--accent);border-color:rgba(59,232,176,.3)}
.pill.warn{background:rgba(255,209,102,.12);color:var(--warn);border-color:rgba(255,209,102,.3)}
h2{margin:0 0 6px;font-size:16px;line-height:1.35}
.hook{margin:0 0 12px;color:var(--dim);font-size:13px;font-style:italic}
details{border-top:1px solid var(--line);padding:8px 0}
summary{cursor:pointer;font-size:13px;color:var(--dim)}
summary:hover{color:var(--fg)}
pre{white-space:pre-wrap;background:#0d1117;border:1px solid var(--line);border-radius:8px;padding:10px;font-size:12px;margin:8px 0 0;cursor:copy}
pre:hover{border-color:var(--accent)}
pre.copied{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent) inset}
.beats{margin:8px 0 0;padding-left:18px;font-size:12.5px}
.beats li{margin-bottom:6px}.beats span{color:var(--accent);font-variant-numeric:tabular-nums;margin-right:6px}
.src{font-size:12px;color:var(--dim)}
.links{margin:12px 0 0;font-size:12px}
a{color:var(--accent)}
</style></head>
<body>
<header>
  <h1>Revue avant publication</h1>
  <p class="sub">${items.length} video(s) &middot; formats presents : ${formats.join(", ") || "aucun"} &middot; clic sur un bloc de texte pour le copier</p>
</header>
<main>${items.map(card).join("")}</main>
<script>
document.querySelectorAll("pre[data-copy]").forEach(function(el){
  el.addEventListener("click", function(){
    navigator.clipboard.writeText(el.textContent).then(function(){
      el.classList.add("copied");
      setTimeout(function(){ el.classList.remove("copied"); }, 900);
    });
  });
});
</script>
</body></html>`;
}
