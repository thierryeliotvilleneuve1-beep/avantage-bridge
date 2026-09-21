// Alertes budgétaires par exception (gestion Lean / contrôle des coûts PMI).
//
// À chaque cycle de sync, on regarde les divisions du contrôle budgétaire et on signale
// celles qui virent au rouge : dépassement (coût > budget) ou seuil d'avertissement atteint.
// Anti-spam : on garde en mémoire (fichier JSON) le niveau déjà signalé par division et on
// ne renotifie QUE sur une apparition ou une aggravation. Une division qui revient sous le
// seuil est retirée de l'état → un futur re-dépassement re-notifie.
//
// Coût = dépense + engagé (la MO est déjà dans la dépense, cf. TableauControleBudgetaire).

const fs = require('fs');
const path = require('path');
const notificateur = require('./notificateur');

const FICHIER_ETAT = path.resolve(__dirname, '../../data/alertes-budget.json');
const SEUIL_DEFAUT = parseFloat(process.env.BUDGET_ALERTE_SEUIL) || 0.9;

function budgetDe(d) { return d.budget_prevu || d.montant_revise || d.montant_initial || 0; }
function coutDe(d) { return (d.depense || 0) + (d.engage || 0); }
const fmt = (n) => new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 }).format(n || 0);

// Divisions en dépassement ou en avertissement. Ignore les lignes ODC/directives et les
// budgets nuls (sans budget, pas d'écart significatif).
function evaluer(divisions, seuil) {
  const s = seuil || SEUIL_DEFAUT;
  const out = [];
  for (const d of (divisions || [])) {
    if (d.type_ligne) continue;
    const budget = budgetDe(d);
    if (budget <= 0) continue;
    const cout = coutDe(d);
    const ratio = cout / budget;
    let niveau = null;
    if (cout > budget) niveau = 'depassement';
    else if (ratio >= s) niveau = 'avert';
    if (niveau) out.push({
      cle: (d.projet_id || '') + '|' + (d.id || d._id || d.code_division),
      projet_id: d.projet_id, code_division: d.code_division, nom_division: d.nom_division,
      budget, cout, ratio, niveau,
    });
  }
  return out;
}

function chargerEtat(fichier) {
  try { return JSON.parse(fs.readFileSync(fichier || FICHIER_ETAT, 'utf8')); } catch (e) { return {}; }
}
function sauverEtat(etat, fichier) {
  const f = fichier || FICHIER_ETAT;
  try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(etat, null, 2)); } catch (e) {}
}

const RANG = { avert: 1, depassement: 2 };

// Compare les écarts courants à l'état précédent. On notifie une apparition ou une
// aggravation (avert → dépassement). Renvoie {aNotifier, nouvelEtat}.
function filtrerNouveaux(breaches, etatPrecedent) {
  const nouvelEtat = {};
  const aNotifier = [];
  for (const b of breaches) {
    nouvelEtat[b.cle] = b.niveau;
    const avant = etatPrecedent[b.cle];
    if (!avant || RANG[b.niveau] > RANG[avant]) aNotifier.push(b);
  }
  return { aNotifier, nouvelEtat };
}

function libelleProjet(projets, projetId) {
  const p = (projets || []).find(x => (x._id || x.id) === projetId);
  return p ? (p.code_projet + (p.nom ? ' – ' + p.nom : '')) : projetId;
}

function messageAlertes(aNotifier, projets) {
  const parProjet = new Map();
  for (const b of aNotifier) {
    if (!parProjet.has(b.projet_id)) parProjet.set(b.projet_id, []);
    parProjet.get(b.projet_id).push(b);
  }
  const lignes = [];
  for (const [projetId, list] of parProjet) {
    lignes.push('**' + libelleProjet(projets, projetId) + '**');
    for (const b of list.sort((x, y) => y.ratio - x.ratio)) {
      const etiquette = b.niveau === 'depassement' ? '🔴 dépassé' : '🟠 à surveiller';
      lignes.push('• ' + etiquette + ' ' + (b.code_division || '') + ' ' + (b.nom_division || '') +
        ' — ' + Math.round(b.ratio * 100) + '% (coût ' + fmt(b.cout) + ' / budget ' + fmt(b.budget) + ')');
    }
    lignes.push('');
  }
  return lignes.join('\n').trim();
}

// Orchestration : évalue, diffère l'état, notifie les nouveautés. Ne notifie rien si le
// canal n'est pas configuré. Renvoie un résumé pour journalisation.
async function verifier(divisions, projets, opts) {
  const o = opts || {};
  if (process.env.ALERTES_ACTIF === 'false') return { actif: false };
  const breaches = evaluer(divisions, o.seuil);
  const etatPrecedent = chargerEtat(o.fichier);
  const { aNotifier, nouvelEtat } = filtrerNouveaux(breaches, etatPrecedent);
  sauverEtat(nouvelEtat, o.fichier);

  let notifie = 0;
  if (aNotifier.length && notificateur.disponible()) {
    const r = await notificateur.envoyer('Alertes budgétaires', messageAlertes(aNotifier, projets), { emoji: '⚠️' });
    if (r.ok) notifie = aNotifier.length;
  }
  return { actif: true, ecarts: breaches.length, nouveaux: aNotifier.length, notifie };
}

module.exports = { evaluer, filtrerNouveaux, chargerEtat, sauverEtat, messageAlertes, verifier };
