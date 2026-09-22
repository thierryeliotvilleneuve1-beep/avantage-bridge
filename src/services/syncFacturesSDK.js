// Écrit les FACTURES CLIENT (FACTMA, lues via SDK R09) dans l'entité FactureClient de Manœuvre.
// Remplace l'étape « FACTMA chiffrée → sautée » : n° de facture, date, montants et RETENUE réels.
//
// DRY-RUN PAR DÉFAUT : sans opts.dryRun===false, rien n'est écrit — on renvoie l'aperçu et le
// nombre de factures nouvelles / à modifier. L'écriture n'a lieu qu'avec apply explicite.
//
// Gardé par actif() : si le SDK n'est pas activé (ou la passerelle absente), l'étape est ignorée
// proprement — jamais d'échec bloquant pour le reste du cycle.

const { lireFactures, actif } = require('./lectureFactures');
const { apiGetAll, upsert, idOf, inchange, sleep } = require('../writers/base44-writer');

const CHAMPS = ['numero_facture', 'code_projet', 'client_nom', 'date_facture', 'total_facture', 'solde_ouvert', 'retenue_total', 'statut_paiement'];

function estActif(p) { return !/(termine|annule|archiv|ferm|clos|inactif)/i.test(p.statut || ''); }
function codeNum(p) { return parseInt(String(p.code_projet || '').replace(/^P/i, '').trim(), 10); }

async function syncFacturesSDK(ctx, opts) {
  const dryRun = !(opts && opts.dryRun === false);
  if (!actif()) return { ok: false, raison: 'AVANTAGE_SDK_ACTIF≠true ou identifiants absents' };

  const projets = ((ctx && ctx.projets) || await apiGetAll('Projet')).filter(estActif);
  const existantes = (ctx && ctx.factures) || await apiGetAll('FactureClient');
  const parNumero = new Map(existantes.map(f => [String(f.numero_facture), f]));

  let lues = 0, nouvelles = 0, a_modifier = 0, inchangees = 0, creees = 0, maj = 0, erreurs = 0;
  const apercu = [];

  for (const p of projets) {
    const code = codeNum(p); if (!code) continue;
    let r;
    try { r = await lireFactures(String(code)); } catch (e) { erreurs++; continue; }
    if (!r.ok) { erreurs++; continue; }
    if (!r.factures.length) continue;
    apercu.push({ code_projet: p.code_projet, nb: r.factures.length, total: r.total_facture, solde: r.solde_ouvert });

    for (const f of r.factures) {
      lues++;
      const payload = {
        numero_facture: f.numero_facture,
        code_projet: p.code_projet,           // aligné sur la fiche projet Manœuvre
        client_nom: f.client_nom,
        date_facture: f.date_facture,
        total_facture: f.total_facture,
        solde_ouvert: f.solde_ouvert,
        retenue_total: f.retenue_total,
        statut_paiement: f.statut_paiement,
      };
      const ex = parNumero.get(String(f.numero_facture));
      if (!ex) nouvelles++;
      if (ex && inchange(ex, payload, CHAMPS)) { inchangees++; continue; }
      if (ex) a_modifier++;
      if (!dryRun) {
        payload.sync_avantage_ts = new Date().toISOString();
        const w = await upsert('FactureClient', ex ? idOf(ex) : null, payload);
        if (w.ok) { ex ? maj++ : creees++; } else erreurs++;
        await sleep(70);
      }
    }
  }

  return {
    ok: true, dry_run: dryRun,
    projets_avec_factures: apercu.length, factures_lues: lues,
    factures_nouvelles: nouvelles, a_modifier, inchangees,
    creees: dryRun ? 0 : creees, mises_a_jour: dryRun ? 0 : maj, erreurs,
    apercu,
  };
}

module.exports = { syncFacturesSDK };
