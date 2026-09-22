// Synchronise les NOMS DE PROJETS (et le code client) depuis CONTRA d'Avantage, lue en clair
// via la passerelle SDK (maintcp). LECTURE SEULE côté Avantage.
//
// Prudence (non destructif) : on ne met à jour le nom d'un projet Manoeuvre QUE s'il est
// générique (vide, ou égal au code). Un projet déjà nommé par l'équipe n'est jamais écrasé.
//
// CONTRA (colonnes, ordre confirmé sur données réelles) :
//   [0] CONUM (n° contrat, 10 chiffres)  [1] CONOM (nom du projet)  [5] COCLI (code client)

const { interroger, parseCsv, actif } = require('./maintcpClient');
const { upsert, idOf, apiGetAll, sleep } = require('../writers/base44-writer');

const COL_CONUM = parseInt(process.env.AVANTAGE_SDK_COL_CONUM, 10) || 0;
const COL_CONOM = parseInt(process.env.AVANTAGE_SDK_COL_CONOM, 10) || 1;
const COL_COCLI = parseInt(process.env.AVANTAGE_SDK_COL_COCLI, 10) || 5;

// Charge tous les contrats CONTRA en une seule session → Map(CONUM → {nom, client}).
async function chargerContrats() {
  const r = await interroger({ op: 'R01', mnemonique: 'CNT', index: 'CONUM' });
  if (!r.ok) return { ok: false, erreur: r.erreur };
  const map = new Map();
  for (const ligne of r.lignes) {
    const c = parseCsv(ligne);
    const conum = String(c[COL_CONUM] || '').trim();
    if (conum) map.set(conum, { nom: String(c[COL_CONOM] || '').trim(), client: String(c[COL_COCLI] || '').trim() });
  }
  return { ok: true, map, count: map.size };
}

// Un nom Manoeuvre est « générique » (donc remplaçable) s'il est vide ou n'est qu'un code projet.
function estGenerique(nom, code_projet) {
  const a = String(nom || '').trim();
  if (!a) return true;
  if (code_projet && a === String(code_projet).trim()) return true;
  return /^P?0*\d+$/.test(a); // ex. "26008", "P26008", "0000026008"
}

// Met à jour les noms des projets ACTIFS présents dans Manoeuvre à partir de CONTRA.
async function synchroniser(ctx) {
  if (!actif()) return { ok: false, raison: 'AVANTAGE_SDK_ACTIF≠true ou identifiants absents' };
  const projets = (ctx && ctx.projets) || await apiGetAll('Projet');
  const c = await chargerContrats();
  if (!c.ok) return { ok: false, erreur: c.erreur };

  let vus = 0, maj = 0, inchange = 0, introuvable = 0, erreurs = 0;
  for (const p of projets) {
    const code = parseInt(String(p.code_projet || '').replace(/^P/i, '').trim(), 10);
    if (!code) continue;
    if (p.statut && /(termine|annule|archiv|ferm|clos|inactif)/i.test(p.statut)) continue;
    vus++;
    const rec = c.map.get(String(code).padStart(10, '0'));
    if (!rec || !rec.nom) { introuvable++; continue; }
    if (!estGenerique(p.nom, p.code_projet)) { inchange++; continue; } // déjà bien nommé → respecté
    if (String(p.nom || '').trim() === rec.nom) { inchange++; continue; }
    const r = await upsert('Projet', idOf(p), { nom: rec.nom, sync_avantage_ts: new Date().toISOString() });
    if (r.ok) maj++; else erreurs++;
    await sleep(60);
  }
  return { ok: true, contrats_avantage: c.count, projets_actifs: vus, noms_mis_a_jour: maj, deja_nommes: inchange, introuvables: introuvable, erreurs };
}

// Diagnostic : pour chaque projet ACTIF de Manœuvre, indique s'il matche un contrat CONTRA
// et le nom trouvé. Sert à identifier les projets « introuvables » (code sans correspondance).
async function diagnostiquer(ctx) {
  if (!actif()) return { ok: false, raison: 'AVANTAGE_SDK_ACTIF≠true ou identifiants absents' };
  const projets = (ctx && ctx.projets) || await apiGetAll('Projet');
  const c = await chargerContrats();
  if (!c.ok) return { ok: false, erreur: c.erreur };

  const introuvables = [], apparies = [];
  for (const p of projets) {
    if (p.statut && /(termine|annule|archiv|ferm|clos|inactif)/i.test(p.statut)) continue;
    const brut = String(p.code_projet || '').trim();
    const code = parseInt(brut.replace(/^P/i, ''), 10);
    const conum = code ? String(code).padStart(10, '0') : null;
    const rec = conum ? c.map.get(conum) : null;
    const ligne = { code_projet: brut, nom_manoeuvre: p.nom || '', conum };
    if (rec && rec.nom) apparies.push(Object.assign(ligne, { nom_contra: rec.nom, client: rec.client }));
    else introuvables.push(Object.assign(ligne, { raison: !code ? 'code non numérique' : 'aucun contrat CONTRA pour ce numéro' }));
  }
  return { ok: true, contrats_avantage: c.count, projets_actifs: apparies.length + introuvables.length, apparies: apparies.length, introuvables };
}

module.exports = { synchroniser, diagnostiquer, chargerContrats, estGenerique, actif };
