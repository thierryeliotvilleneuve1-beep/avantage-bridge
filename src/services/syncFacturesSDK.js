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

// Champs comparés pour le différentiel (alignés sur le schéma réel FactureClient).
const CHAMPS = ['numero_facture', 'code_projet', 'projet_id', 'client_nom', 'client_code', 'date_facture',
  'montant_ht', 'montant_tps', 'montant_tvq', 'montant_ttc', 'solde_ouvert',
  'retenue_garantie_montant', 'retenue_garantie_total', 'retenue_garantie_pourcentage',
  'note_credit', 'statut_paiement', 'type_facture', 'source_avantage'];

function estActif(p) { return !/(termine|annule|archiv|ferm|clos|inactif)/i.test(p.statut || ''); }
function codeNum(p) { return parseInt(String(p.code_projet || '').replace(/^P/i, '').trim(), 10); }

// "2026/07/31" → "2026-07-31" (format date attendu par Base44) ; vide reste vide.
function dateISO(v) { const s = String(v || '').trim(); return s ? s.replace(/\//g, '-') : ''; }

// Statut de paiement Manœuvre (enum) déduit du solde réel (encaissements A/R) et de la retenue.
// f.solde_ouvert et f.montant_paye viennent du rapprochement RCVACM/BANQUE (cf. lectureFactures).
function statut(f) {
  if (f.note_credit) return 'annulé';
  if (Math.abs(f.solde_ouvert) < 0.01) return 'payé';
  if (f.retenue_total > 0 && Math.abs(f.solde_ouvert - f.retenue_total) < 0.01) return 'retenue';
  if ((f.montant_paye || 0) > 0.01) return 'partiel';
  return 'en_attente';
}

async function syncFacturesSDK(ctx, opts) {
  const dryRun = !(opts && opts.dryRun === false);
  if (!actif()) return { ok: false, raison: 'AVANTAGE_SDK_ACTIF≠true ou identifiants absents' };

  const projets = ((ctx && ctx.projets) || await apiGetAll('Projet')).filter(estActif);
  const existantes = (ctx && ctx.factures) || await apiGetAll('FactureClient');
  const parNumero = new Map(existantes.map(f => [String(f.numero_facture), f]));

  // entreprise_id : REQUIS + imposé par la RLS de création. On le prend d'une facture
  // existante (toutes portent celui de CRC), avec repli sur AVANTAGE_ENTREPRISE_ID.
  const entrepriseId = process.env.AVANTAGE_ENTREPRISE_ID
    || (existantes.find(f => f.entreprise_id) || {}).entreprise_id;
  if (!entrepriseId) return { ok: false, raison: 'entreprise_id introuvable — définir AVANTAGE_ENTREPRISE_ID' };

  let lues = 0, nouvelles = 0, a_modifier = 0, inchangees = 0, creees = 0, maj = 0, erreurs = 0;
  const apercu = [];
  const echantillon_erreurs = [];

  for (const p of projets) {
    const code = codeNum(p); if (!code) continue;
    let r;
    try { r = await lireFactures(String(code)); } catch (e) { erreurs++; continue; }
    if (!r.ok) { erreurs++; continue; }
    if (!r.factures.length) continue;
    apercu.push({ code_projet: p.code_projet, nb: r.factures.length, total: r.total_facture, solde: r.solde_ouvert });

    const projetId = idOf(p);
    for (const f of r.factures) {
      lues++;
      const payload = {
        entreprise_id: entrepriseId,          // requis + RLS création
        numero_facture: f.numero_facture,
        type_facture: 'progressive',          // facturation progressive de chantier
        code_projet: p.code_projet,           // aligné sur la fiche projet Manœuvre
        projet_id: projetId,
        client_nom: f.client_nom,
        client_code: f.client,
        date_facture: dateISO(f.date_facture),
        montant_ht: f.sous_total_ht,
        montant_tps: f.montant_tps,
        montant_tvq: f.montant_tvq,
        montant_ttc: f.total_facture,
        solde_ouvert: f.solde_ouvert,
        retenue_garantie_pourcentage: f.retenue_pct,
        retenue_garantie_montant: f.retenue_ht,
        retenue_garantie_total: f.retenue_total,
        note_credit: f.note_credit,
        statut_paiement: statut(f),
        source_avantage: true,
      };
      const ex = parNumero.get(String(f.numero_facture));
      if (!ex) nouvelles++;
      if (ex && inchange(ex, payload, CHAMPS)) { inchangees++; continue; }
      if (ex) a_modifier++;
      if (!dryRun) {
        payload.sync_avantage_ts = new Date().toISOString();
        const w = await upsert('FactureClient', ex ? idOf(ex) : null, payload);
        if (w.ok) { ex ? maj++ : creees++; }
        else {
          erreurs++;
          if (echantillon_erreurs.length < 3) echantillon_erreurs.push({ numero_facture: f.numero_facture, operation: ex ? 'PUT' : 'POST', status: w.status, data: String(w.data || '').slice(0, 300) });
        }
        await sleep(70);
      }
    }
  }

  return {
    ok: true, dry_run: dryRun,
    projets_avec_factures: apercu.length, factures_lues: lues,
    factures_nouvelles: nouvelles, a_modifier, inchangees,
    creees: dryRun ? 0 : creees, mises_a_jour: dryRun ? 0 : maj, erreurs,
    echantillon_erreurs,
    apercu,
  };
}

module.exports = { syncFacturesSDK };
