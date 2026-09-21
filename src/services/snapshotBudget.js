// Photo hebdomadaire du contrôle budgétaire par projet (entité SnapshotBudget de Manoeuvre).
//
// Le contrôle budgétaire de Manoeuvre est une PHOTO à l'instant : il dit « où j'en suis »,
// pas « ma marge s'érode-t-elle ». Ce service prend une photo par projet une fois par semaine
// et l'archive, ce qui donne :
//   • WIP (travaux en cours)      = dépense − facturé   → cash immobilisé / financement du client
//   • récupération (VAC engagée)  = budget − coût        → marge restante
//   • ratio de coût               = coût / budget        → cadrage projeté (base engagée)
// et surtout la TENDANCE de ces chiffres semaine après semaine (érosion de marge détectable
// bien avant le dépassement).
//
// Idempotent : une seule photo par projet par semaine ISO. Relancer le même jour met à jour
// la photo de la semaine courante au lieu d'en créer une deuxième.

const { apiGetAll, upsert, idOf } = require('../writers/base44-writer');

function budgetDe(d) { return d.montant_revise || d.budget_prevu || d.montant_initial || 0; }

// Semaine ISO 8601 (ex. « 2026-W38 »). Le lundi ancre la semaine ; robuste au passage d'année.
function semaineISO(dt) {
  const t = new Date(Date.UTC(dt.getFullYear(), dt.getMonth(), dt.getDate()));
  const jour = t.getUTCDay() || 7;            // dimanche = 7
  t.setUTCDate(t.getUTCDate() + 4 - jour);    // jeudi de la semaine courante
  const debutAnnee = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const sem = Math.ceil((((t - debutAnnee) / 86400000) + 1) / 7);
  return t.getUTCFullYear() + '-W' + String(sem).padStart(2, '0');
}

// Agrège le contrôle budgétaire par projet en une photo (lignes réelles seulement,
// projets archivés/fermés exclus).
function calculer(divisions, projets, semaine) {
  const parProjet = new Map();
  for (const d of (divisions || [])) {
    if (d.type_ligne) continue;               // odc, avenants… : pas des lignes de budget réel
    const pid = d.projet_id;
    if (!pid) continue;
    let a = parProjet.get(pid);
    if (!a) { a = { projet_id: pid, budget: 0, budget_revenus: 0, depense: 0, engage: 0, mo: 0, facture: 0, risque: 0 }; parProjet.set(pid, a); }
    const budget = budgetDe(d);
    a.budget += budget;
    a.budget_revenus += (d.budget_revenus || 0);
    a.depense += (d.depense || 0);
    a.engage += (d.engage || 0);
    a.mo += (d.mo_total || 0);
    a.facture += (d.facture || 0);
    const cout = (d.depense || 0) + (d.engage || 0);
    if (budget > 0 && cout / budget >= 0.9) a.risque++;
  }
  const projMap = new Map((projets || []).map(p => [(p._id || p.id), p]));
  const out = [];
  for (const a of parProjet.values()) {
    const p = projMap.get(a.projet_id);
    if (p && p.statut && /(archiv|ferm|clos|inactif|termine|annule)/i.test(p.statut)) continue;
    if (a.budget <= 0) continue;
    const cout = a.depense + a.engage;
    out.push({
      projet_id: a.projet_id,
      code_projet: p ? p.code_projet : '',
      nom: p ? p.nom : '',
      semaine,
      date_snapshot: new Date().toISOString(),
      budget: Math.round(a.budget),
      budget_revenus: Math.round(a.budget_revenus),
      depense: Math.round(a.depense),
      engage: Math.round(a.engage),
      cout: Math.round(cout),
      mo: Math.round(a.mo),
      facture: Math.round(a.facture),
      recuperation: Math.round(a.budget - cout),
      wip: Math.round(a.depense - a.facture),
      ratio_cout: Math.round((cout / a.budget) * 1000) / 1000,
      nb_divisions_risque: a.risque,
    });
  }
  return out;
}

// Prend la photo de la semaine courante et l'écrit dans Manoeuvre (une par projet/semaine).
// ctx optionnel {divisions, projets} pour réutiliser ce qui est déjà chargé par le sync.
async function prendreSnapshot(ctx) {
  const semaine = semaineISO(new Date());
  const divisions = (ctx && ctx.divisions) || await apiGetAll('ControleBudgetaire');
  const projets = (ctx && ctx.projets) || await apiGetAll('Projet');
  const photos = calculer(divisions, projets, semaine);
  if (!photos.length) return { ok: true, semaine, projets: 0, created: 0, updated: 0, unchanged: 0, note: 'aucun projet à photographier' };

  // Photos déjà prises cette semaine (idempotence) : clé projet_id|semaine.
  // On charge tout et on filtre côté bridge : indépendant du support de filtre serveur,
  // et le volume reste modeste (≈ nb_projets × 52 semaines/an).
  const existantes = await apiGetAll('SnapshotBudget');
  const parCle = new Map();
  existantes.forEach(x => { if (x.semaine === semaine) parCle.set(x.projet_id + '|' + x.semaine, x); });

  let created = 0, updated = 0, errors = 0;
  for (const photo of photos) {
    const ex = parCle.get(photo.projet_id + '|' + photo.semaine);
    const r = await upsert('SnapshotBudget', ex ? idOf(ex) : null, photo);
    if (r.ok) { ex ? updated++ : created++; } else errors++;
  }
  return { ok: errors === 0, semaine, projets: photos.length, created, updated, errors };
}

module.exports = { calculer, prendreSnapshot, semaineISO, budgetDe };
