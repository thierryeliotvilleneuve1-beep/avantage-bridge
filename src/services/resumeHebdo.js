// Résumé hebdomadaire par projet, rédigé par Claude, envoyé sur Teams.
//
// Le bridge fournit les chiffres (contrôle budgétaire par projet, lus dans Manoeuvre) ;
// Claude rédige un briefing court et hiérarchisé par risque. Envoyé une fois par semaine
// (cron) ou à la demande via /api/resume-hebdo.
//
// Appel HTTPS brut à l'API Anthropic (pas de SDK à installer sur le PC du bridge).
// Nécessite ANTHROPIC_API_KEY ; modèle configurable via ANTHROPIC_MODEL (défaut opus).

const https = require('https');
const { apiGetAll } = require('../writers/base44-writer');
const notificateur = require('./notificateur');

const MODELE = (process.env.ANTHROPIC_MODEL || 'claude-opus-5').trim();

function actif() {
  return process.env.RESUME_HEBDO_ACTIF !== 'false' && Boolean((process.env.ANTHROPIC_API_KEY || '').trim());
}

function budgetDe(d) { return d.budget_prevu || d.montant_revise || d.montant_initial || 0; }

// Agrège le contrôle budgétaire par projet (lignes réelles seulement).
function agreger(divisions, projets) {
  const parProjet = new Map();
  for (const d of (divisions || [])) {
    if (d.type_ligne) continue;
    const pid = d.projet_id;
    if (!pid) continue;
    let a = parProjet.get(pid);
    if (!a) { a = { projet_id: pid, budget: 0, depense: 0, engage: 0, mo: 0, facture: 0, budget_revenus: 0, divisions: [] }; parProjet.set(pid, a); }
    const budget = budgetDe(d);
    const cout = (d.depense || 0) + (d.engage || 0);
    a.budget += budget; a.depense += (d.depense || 0); a.engage += (d.engage || 0);
    a.mo += (d.mo_total || 0); a.facture += (d.facture || 0); a.budget_revenus += (d.budget_revenus || 0);
    if (budget > 0) a.divisions.push({ code: d.code_division, nom: d.nom_division, budget, cout, ratio: cout / budget });
  }
  const projMap = new Map((projets || []).map(p => [(p._id || p.id), p]));
  const out = [];
  for (const a of parProjet.values()) {
    const p = projMap.get(a.projet_id);
    if (p && p.statut && /(archiv|ferm|clos|inactif)/i.test(p.statut)) continue;
    const cout = a.depense + a.engage;
    a.risques = a.divisions.filter(x => x.ratio >= 0.9).sort((x, y) => y.ratio - x.ratio).slice(0, 3)
      .map(x => ({ code: x.code, nom: x.nom, pct: Math.round(x.ratio * 100) }));
    out.push({
      code_projet: p ? p.code_projet : a.projet_id, nom: p ? p.nom : '',
      budget: Math.round(a.budget), cout: Math.round(cout), mo: Math.round(a.mo),
      facture: Math.round(a.facture), budget_revenus: Math.round(a.budget_revenus),
      recuperation: Math.round(a.budget - cout), risques: a.risques,
    });
    delete a.divisions;
  }
  // Les plus à risque d'abord (récupération la plus faible).
  return out.filter(x => x.budget > 0).sort((x, y) => x.recuperation - y.recuperation).slice(0, 40);
}

function appelerClaude(systeme, contenu) {
  const cle = (process.env.ANTHROPIC_API_KEY || '').trim();
  const payload = JSON.stringify({
    model: MODELE,
    max_tokens: 4000,
    system: systeme,
    messages: [{ role: 'user', content: contenu }],
  });
  return new Promise((resolve, reject) => {
    const o = {
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: {
        'content-type': 'application/json', 'x-api-key': cle,
        'anthropic-version': '2023-06-01', 'content-length': Buffer.byteLength(payload),
      },
    };
    const req = https.request(o, (re) => {
      let d = ''; re.on('data', c => d += c);
      re.on('end', () => {
        if (re.statusCode < 200 || re.statusCode >= 300) return reject(new Error('Anthropic ' + re.statusCode + ': ' + d.slice(0, 300)));
        try {
          const j = JSON.parse(d);
          const txt = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
          resolve(txt || '(réponse vide)');
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(payload); req.end();
  });
}

const SYSTEME =
  "Tu es analyste financier senior en construction (cadre PMI, contrôle des coûts). " +
  "À partir des données de contrôle budgétaire par projet, rédige un résumé hebdomadaire " +
  "pour la direction de Construction Richard Champagne. Format Markdown, concis, sans " +
  "remplissage. Une courte section par projet (les plus à risque d'abord), 2-3 lignes max : " +
  "santé budgétaire (coût engagé vs budget), récupération/marge restante, et signale " +
  "explicitement tout dépassement ou division à surveiller. Montants en dollars canadiens. " +
  "Termine par une ligne « À surveiller cette semaine » listant les 3 projets prioritaires. " +
  "Distingue les faits (chiffres) de ton jugement professionnel.";

// Génère et envoie le résumé. ctx optionnel {divisions, projets} pour éviter un rechargement.
async function genererEtEnvoyer(ctx) {
  if (!actif()) return { ok: false, raison: 'RESUME_HEBDO inactif ou ANTHROPIC_API_KEY absent' };
  const divisions = (ctx && ctx.divisions) || await apiGetAll('ControleBudgetaire');
  const projets = (ctx && ctx.projets) || await apiGetAll('Projet');
  const data = agreger(divisions, projets);
  if (!data.length) return { ok: false, raison: 'aucun projet à résumer' };

  const contenu = 'Semaine du ' + new Date().toLocaleDateString('fr-CA') +
    '. Données de contrôle budgétaire par projet (JSON) :\n\n' + JSON.stringify(data, null, 1);
  const texte = await appelerClaude(SYSTEME, contenu);

  if (notificateur.disponible()) {
    await notificateur.envoyer('Résumé hebdomadaire des projets', texte, { emoji: '📊' });
  }
  return { ok: true, projets: data.length, texte };
}

module.exports = { agreger, genererEtEnvoyer, actif };
