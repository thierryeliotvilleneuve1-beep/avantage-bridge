// Inbox Intel — Prototype exécutable (dry-run par défaut).
//
//   node src/inbox-intel/run-prototype.js            → simulation, aucune écriture
//   node src/inbox-intel/run-prototype.js --write    → écrit dans Base44 (exige
//       BASE44_API_KEY + entités EvenementTimeline/ActionSuggeree créées et
//       RLS auditées — voir docs/inbox-intel/AUDIT-PREREQUIS.md)
//
// Le contexte projet ci-dessous est un jeu de test local. En production il
// sera chargé depuis Base44 (Projet, LienEntite, assignations CP).

const fs = require('fs');
const path = require('path');
const { traiterCourriel } = require('./pipeline');
const { ecrireResultat } = require('./base44-sink');

// --- Contexte de test (remplacé par des lectures Base44 en prod) ---
const CONTEXTE = {
  projets: [
    { _id: 'proj_23020', code_projet: 'P23020', nom: 'Centre communautaire Ste-Anne' },
    { _id: 'proj_24011', code_projet: 'P24011', nom: 'Caserne 12 Shawinigan' },
  ],
  conversationsConnues: {
    // Fil déjà rattaché lors d'un événement antérieur.
    'CONV-EXC-CLAIM': 'P23020',
  },
  liensContacts: {
    // Simule LienEntite : contact fournisseur ↔ projet.
    'ventes@fenetrespro.ca': ['P23020'],
  },
  cpParProjet: {
    P23020: 'm.gagnon@c-rc.ca',
    P24011: 's.lavoie@c-rc.ca',
  },
  llmAdapter: null, // brancher LLMAdapter avec un backend quand disponible
};

async function main() {
  const ecrire = process.argv.includes('--write');
  const courriels = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'samples', 'courriels-test.json'), 'utf8'));

  console.log(`Inbox Intel — prototype (${ecrire ? 'ÉCRITURE Base44' : 'dry-run, aucune écriture'})`);
  console.log('='.repeat(78));

  for (const courriel of courriels) {
    const { evenement, action } = await traiterCourriel(courriel, CONTEXTE);

    console.log(`\n[${courriel.id_test}] ${courriel.objet}`);
    console.log(`  Type détecté      : ${evenement.type_document} (confiance ${evenement.confiance_classification}, ${evenement.methode_classification})`);
    console.log(`  Projet            : ${evenement.code_projet || '—'} (confiance ${evenement.confiance_rattachement}, signaux: ${evenement.signaux_rattachement.join(', ') || 'aucun'})`);
    console.log(`  Statut événement  : ${evenement.statut}${evenement.statut === 'a_rattacher' ? '  ← validation manuelle requise' : ''}`);
    console.log(`  Résumé            : ${evenement.resume_court}`);
    console.log(`  CP à notifier     : ${action.cp_email || '— (projet non rattaché)'}`);
    console.log(`  Action suggérée   : [${action.priorite}] ${action.description_action}`);
    console.log(`  Statut action     : ${action.statut} (confirmation CP requise avant toute exécution)`);

    if (ecrire) {
      const r = await ecrireResultat(evenement, action);
      console.log(`  Base44            : evenement=${r.evenement.status} action=${r.action ? r.action.status : 'non créée'}`);
    }
  }

  console.log('\n' + '='.repeat(78));
  console.log('Terminé. Aucune action exécutée automatiquement : toutes en `en_attente`.');
}

main().catch(e => { console.error(e); process.exit(1); });
