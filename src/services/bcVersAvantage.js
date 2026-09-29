// FLUX INVERSE : Bons de commande Manœuvre → Avantage (Voie A, boucle semi-automatique).
//
// Principe (aucune écriture dans Avantage — la règle « lecture seule » reste intacte) :
//   1. Un BC créé et VALIDÉ dans Manœuvre (bc_valide = vrai, type fournisseur) est « à saisir ».
//   2. On génère une FICHE DE SAISIE imprimable, champs dans l'ordre de l'écran Commande d'Avantage,
//      que la comptabilité saisit dans Avantage.
//   3. À chaque cycle, le bridge LIT COMMAN (via SDK) et RÉCONCILIE : quand un BC Avantage
//      correspond (fournisseur + montant + date), on écrit le n° Avantage dans le BC Manœuvre et
//      on le passe à « Confirmé Avantage ». Écart de montant ou BC non saisi depuis X jours → alerte.
//
// Rapprochement CONSERVATEUR : on ne confirme QUE sur correspondance unique et certaine
// (fournisseur + montant à la tolérance près). En cas de doute, on n'écrit rien et on signale.
// DRY-RUN PAR DÉFAUT côté écriture Manœuvre (opts.dryRun===false pour appliquer).

const { apiGetAll, upsert, idOf, inchange, sleep } = require('../writers/base44-writer');
const { lireEngage, actif } = require('./lectureEngage');
const fournisseurs = require('../sources/fournisseursSDK');
let notificateur; try { notificateur = require('./notificateur'); } catch (_) { notificateur = { envoyer: async () => {}, disponible: () => false }; }

const STALE_JOURS = parseInt(process.env.BC_SAISIE_DELAI_JOURS, 10) || 5;
const TOL_ABS = 1.00;      // tolérance absolue de rapprochement de montant ($)
const TOL_REL = 0.005;     // ou 0,5 % du montant

const CHAMPS_CONFIRM = ['numero_commande_avantage', 'reference_avantage', 'statut_avantage'];

function nombre(v) { const n = parseFloat(String(v == null ? '' : v).replace(/[^\d.-]/g, '')); return Number.isFinite(n) ? n : 0; }
function r2(n) { return Math.round((n || 0) * 100) / 100; }
function codeNum(p) { return parseInt(String(p.code_projet || '').replace(/^P/i, '').trim(), 10); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m])); }
function fmt(n) { return r2(n).toLocaleString('fr-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/ /g, ' ') + ' $'; }

// Un BC est « à pousser » : validé, fournisseur, non annulé, ORIGINE Manœuvre (pas reconstruit
// depuis Avantage) et pas encore rattaché à un n° Avantage.
function estEligible(bc) {
  if (bc.bc_valide !== true) return false;
  if (bc.type_bon_commande && bc.type_bon_commande !== 'fournisseur') return false;
  if (bc.statut === 'annule') return false;
  if (bc.source_bc === 'avantage-transactions') return false;     // origine Avantage
  if (/reconstruit|confirm/i.test(bc.statut_avantage || '')) return false;
  if ((bc.reference_avantage || '').trim() || (bc.numero_commande_avantage || '').trim()) return false;
  return true;
}

function joursDepuis(dateStr) {
  const s = String(dateStr || '').trim().replace(/\//g, '-');
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return null;
  return Math.floor((Date.now() - t) / 86400000);
}

// Normalise un BC Manœuvre en objet de travail (en-tête + lignes).
function normaliser(bc, divParId, projParId) {
  const proj = projParId.get(bc.projet_id) || {};
  const div = bc.controle_budgetaire_id ? divParId.get(bc.controle_budgetaire_id) : null;
  const lignesBrutes = Array.isArray(bc.lignes_commande) ? bc.lignes_commande : [];
  const lignes = lignesBrutes.map(l => ({
    description: l.description || l.libelle || '',
    quantite: nombre(l.quantite != null ? l.quantite : l.qte),
    unite: l.unite || l.unité || '',
    prix: nombre(l.prix_unitaire != null ? l.prix_unitaire : l.prix),
    montant: nombre(l.montant != null ? l.montant : (nombre(l.quantite) * nombre(l.prix_unitaire || l.prix))),
    code_division: (l.code_division || l.division || (div && div.code_division) || '').toString(),
  }));
  const sousTotalLignes = r2(lignes.reduce((s, l) => s + l.montant, 0));
  return {
    id: idOf(bc),
    numero_po: bc.numero_po || '',
    projet_id: bc.projet_id,
    projet_code: proj.code_projet || '',
    projet_nom: proj.nom || '',
    fournisseur: bc.fournisseur_avantage || bc.description || '',
    type_fournisseur: bc.type_fournisseur || '',
    code_division: (div && div.code_division) || '',
    nom_division: (div && div.nom_division) || '',
    date_commande: bc.date_commande || '',
    date_reception_prevue: bc.date_reception_prevue || '',
    conditions: bc.conditions || '',
    description: bc.description || '',
    montant_prevu: r2(nombre(bc.montant_prevu) || sousTotalLignes),
    lignes,
    age_jours: joursDepuis(bc.date_commande),
    _bc: bc,
  };
}

// ── 1) Liste des BC à saisir dans Avantage ──────────────────────────────────
async function listerASaisir(ctx) {
  const projets = (ctx && ctx.projets) || await apiGetAll('Projet');
  const bcs = (ctx && ctx.bcs) || await apiGetAll('BonDeCommande');
  const divisions = (ctx && ctx.divisions) || await apiGetAll('ControleBudgetaire');
  const projParId = new Map(projets.map(p => [idOf(p), p]));
  const divParId = new Map(divisions.map(d => [idOf(d), d]));
  const liste = bcs.filter(estEligible).map(bc => normaliser(bc, divParId, projParId));
  liste.sort((a, b) => (a.projet_code || '').localeCompare(b.projet_code || '') || (b.age_jours || 0) - (a.age_jours || 0));
  return { ok: true, nb: liste.length, bcs: liste };
}

// ── 2) Fiche de saisie imprimable (ordre de l'écran Commande d'Avantage) ─────
function ficheUneHTML(b) {
  const lignes = b.lignes.length ? b.lignes : [{ description: b.description || '(voir description)', quantite: 0, unite: '', prix: 0, montant: b.montant_prevu, code_division: b.code_division }];
  const rows = lignes.map(l => `      <tr>
        <td class="c">${esc(l.code_division || b.code_division)}</td>
        <td>${esc(l.description)}</td>
        <td class="r">${l.quantite ? l.quantite : ''}</td>
        <td class="c">${esc(l.unite)}</td>
        <td class="r">${l.prix ? fmt(l.prix) : ''}</td>
        <td class="r">${fmt(l.montant)}</td>
      </tr>`).join('\n');
  return `  <div class="fiche">
    <div class="fh">
      <div class="badge">CRC</div>
      <div><div class="t">Fiche de saisie — Commande d'achat Avantage</div>
      <div class="s">À saisir dans Avantage · écran Commande · le bridge confirmera le numéro automatiquement</div></div>
    </div>
    <table class="ent"><tbody>
      <tr><td class="k">Fournisseur</td><td>${esc(b.fournisseur)}${b.type_fournisseur ? ' — <em>' + esc(b.type_fournisseur) + '</em>' : ''}</td>
          <td class="k">Projet (contrat)</td><td>${esc(b.projet_code)} — ${esc(b.projet_nom)}</td></tr>
      <tr><td class="k">Date de commande</td><td>${esc((b.date_commande || '').replace(/-/g, '/'))}</td>
          <td class="k">Livraison prévue</td><td>${esc((b.date_reception_prevue || '').replace(/-/g, '/'))}</td></tr>
      <tr><td class="k">Réf. Manœuvre</td><td>${esc(b.numero_po || b.id)}</td>
          <td class="k">Conditions</td><td>${esc(b.conditions)}</td></tr>
    </tbody></table>
    <table class="lig"><thead>
      <tr><th class="c">Activité</th><th>Description</th><th class="r">Qté</th><th class="c">Unité</th><th class="r">Prix unit.</th><th class="r">Montant</th></tr>
    </thead><tbody>
${rows}
    </tbody><tfoot>
      <tr><td colspan="5" class="r k">SOUS-TOTAL (HT)</td><td class="r tot">${fmt(b.montant_prevu)}</td></tr>
    </tfoot></table>
    <div class="note">Taxes et conditions selon le gabarit Avantage. Une fois la commande saisie, ne rien réécrire dans Manœuvre : le bridge détecte le numéro Avantage et passe le BC à « Confirmé Avantage ».</div>
  </div>`;
}

function fichesHTML(liste) {
  const corps = liste.length ? liste.map(ficheUneHTML).join('\n<div class="pb"></div>\n')
    : '<div class="fiche"><div class="s">Aucun bon de commande validé en attente de saisie.</div></div>';
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8">
<title>Fiches de saisie BC — Avantage</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Montserrat:wght@300;500;800&display=swap');
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:'Montserrat',Calibri,sans-serif;background:#f0f0f0;color:#0A0A0A;padding:16px}
  .fiche{background:#fff;max-width:900px;margin:0 auto 16px;padding:22px 26px;border-top:5px solid #8D0005;box-shadow:0 2px 10px rgba(0,0,0,.08)}
  .pb{page-break-after:always}
  .fh{display:flex;align-items:center;gap:12px;margin-bottom:14px;padding-bottom:10px;border-bottom:2px solid #C4C4C4}
  .badge{width:38px;height:38px;background:#DD101B;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:13px;color:#fff;clip-path:polygon(0 0,85% 0,100% 15%,100% 100%,15% 100%,0 85%)}
  .t{font-size:15px;font-weight:800;color:#8D0005;text-transform:uppercase;letter-spacing:.5px}
  .s{font-size:9px;font-weight:300;color:#828182;margin-top:2px}
  table{width:100%;border-collapse:collapse}
  .ent{margin-bottom:12px} .ent td{padding:5px 8px;font-size:10px;border:1px solid #ececec;vertical-align:top}
  .ent td.k{font-weight:700;color:#828182;text-transform:uppercase;font-size:8px;letter-spacing:.4px;width:120px;background:#fafafa}
  .lig th{background:#8D0005;color:#fff;font-size:9px;font-weight:800;text-transform:uppercase;padding:6px 8px;text-align:left}
  .lig td{padding:5px 8px;font-size:10px;border-bottom:1px solid #ececec}
  .lig .r,.ent .r,th.r{text-align:right} .lig .c,th.c{text-align:center}
  .lig tfoot td{border-top:2px solid #C4C4C4;font-size:10px;padding:7px 8px}
  .k{font-weight:700} .tot{font-weight:800;color:#8D0005}
  .note{margin-top:10px;padding:8px 12px;background:#fff4f4;border-left:4px solid #DD101B;font-size:9px;color:#555;line-height:1.7}
  @media print{body{background:#fff;padding:0}.fiche{box-shadow:none;margin:0;max-width:none}}
</style></head><body>
${corps}
</body></html>`;
}

// ── 3) Réconciliation : BC Manœuvre ↔ COMMAN Avantage ───────────────────────
function montantProche(a, b) { return Math.abs(a - b) <= Math.max(TOL_ABS, Math.abs(b) * TOL_REL); }

async function reconcilier(ctx, opts) {
  const dryRun = !(opts && opts.dryRun === false);
  if (!actif()) return { ok: false, raison: 'AVANTAGE_SDK_ACTIF≠true — réconciliation impossible (passerelle requise)' };

  const { bcs } = await listerASaisir(ctx);
  const res = { ok: true, dry_run: dryRun, a_saisir: bcs.length, confirmes: 0, ecarts: 0, en_retard: 0, non_trouves: 0, errors: 0, details: [], alertes: [] };
  if (!bcs.length) return res;

  // Grouper par projet pour ne lire COMMAN qu'une fois par projet.
  const parProjet = new Map();
  for (const b of bcs) { if (!parProjet.has(b.projet_code)) parProjet.set(b.projet_code, []); parProjet.get(b.projet_code).push(b); }

  for (const [projetCode, groupe] of parProjet.entries()) {
    const code = parseInt(String(projetCode).replace(/^P/i, ''), 10);
    if (!code) continue;
    let eng; try { eng = await lireEngage(code); } catch (e) { res.errors++; continue; }
    if (!eng.ok) { res.errors++; res.details.push({ projet: projetCode, erreur: eng.erreur || eng.raison }); continue; }

    // Candidats Avantage non encore réclamés par un autre BC de ce cycle.
    const dispo = eng.commandes.map(c => ({ ...c, pris: false }));

    for (const b of groupe) {
      const codeFrn = await fournisseurs.chercherCode(b.fournisseur); // {code,nom,methode} | null
      // Candidats par montant proche (sous-total).
      const parMontant = dispo.filter(c => !c.pris && montantProche(c.sous_total, b.montant_prevu));
      // Restreindre par fournisseur si on a pu résoudre le code.
      const candidats = codeFrn ? parMontant.filter(c => String(c.fournisseur).trim() === String(codeFrn.code).trim()) : parMontant;

      if (candidats.length === 1) {
        const c = candidats[0]; c.pris = true;
        const ref = String(c.no).padStart(9, '0');
        const payload = { numero_commande_avantage: c.no, reference_avantage: ref, statut_avantage: 'Confirmé Avantage' };
        if (inchange(b._bc, payload, CHAMPS_CONFIRM)) { continue; }
        if (!dryRun) {
          payload.sync_avantage_ts = new Date().toISOString();
          const w = await upsert('BonDeCommande', b.id, payload);
          if (!w.ok) { res.errors++; continue; }
          await sleep(60);
        }
        res.confirmes++;
        res.details.push({ bc: b.numero_po || b.id, projet: projetCode, action: 'confirmé', no_avantage: c.no, fournisseur: b.fournisseur, montant: b.montant_prevu });
      } else if (candidats.length === 0) {
        // Y a-t-il un candidat même fournisseur mais montant différent → écart à signaler.
        const memeFrn = codeFrn ? dispo.filter(c => !c.pris && String(c.fournisseur).trim() === String(codeFrn.code).trim()) : [];
        if (memeFrn.length) {
          res.ecarts++;
          const c = memeFrn[0];
          res.alertes.push(`⚠ BC ${b.numero_po || b.id} (${b.projet_code}) : fournisseur trouvé dans Avantage (cmd ${c.no}) mais montant ${fmt(c.sous_total)} ≠ Manœuvre ${fmt(b.montant_prevu)}.`);
        } else if (b.age_jours != null && b.age_jours >= STALE_JOURS) {
          res.en_retard++;
          res.alertes.push(`⏱ BC ${b.numero_po || b.id} (${b.projet_code}, ${b.fournisseur}, ${fmt(b.montant_prevu)}) validé depuis ${b.age_jours} j et toujours pas saisi dans Avantage.`);
        } else {
          res.non_trouves++;
        }
      } else {
        // Plusieurs candidats → ambigu, on ne devine pas.
        res.non_trouves++;
        res.alertes.push(`❓ BC ${b.numero_po || b.id} (${b.projet_code}) : ${candidats.length} commandes Avantage possibles (même montant). Rapprochement manuel requis.`);
      }
    }
  }

  // Alerte Teams groupée (une seule notification par cycle) si écarts/retards.
  if (res.alertes.length && notificateur.disponible()) {
    try { await notificateur.envoyer('BC Manœuvre → Avantage : ' + res.alertes.length + ' point(s) à vérifier', res.alertes.join('\n')); } catch (_) {}
  }
  return res;
}

module.exports = { listerASaisir, fichesHTML, ficheUneHTML, reconcilier, estEligible, normaliser, actif };
