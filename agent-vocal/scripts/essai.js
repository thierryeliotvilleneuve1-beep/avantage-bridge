#!/usr/bin/env node
/**
 * Console d'essai : converser avec l'agent par ecrit, avec le vrai prompt,
 * les vrais outils et la vraie fiche client — sans telephonie ni synthese vocale.
 *
 *   node scripts/essai.js crc
 *   node scripts/essai.js crc --heure "2026-08-18 21:00"      (soir, entreprise fermee)
 *   node scripts/essai.js crc --heure "2026-12-25 10:00"      (jour ferie)
 *   node scripts/essai.js crc --appelant +15145551234
 *
 * Seule ANTHROPIC_API_KEY est requise. Coute environ un cent par conversation.
 */

const readline = require('readline');
const crypto = require('crypto');

const { config } = require('../src/config');
const { clients } = require('../src/clients');
const { store } = require('../src/db');
const horaire = require('../src/horaire');
const { Cerveau } = require('../src/moteur/cerveau');

const C = {
  agent: '\x1b[1m\x1b[38;5;203m', appelant: '\x1b[1m\x1b[36m',
  outil: '\x1b[38;5;108m', action: '\x1b[1m\x1b[33m',
  faible: '\x1b[38;5;244m', erreur: '\x1b[31m', gras: '\x1b[1m', zero: '\x1b[0m',
};

// ── Arguments ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const idClient = args.find((a) => !a.startsWith('--')) || 'crc';
const lire = (nom) => {
  const i = args.indexOf(`--${nom}`);
  return i >= 0 ? args[i + 1] : null;
};
const heureSimulee = lire('heure');
const appelant = lire('appelant') || '+15145550199';

// ── Verifications ────────────────────────────────────────────────────────────
if (!config.llm.cle) {
  console.error(`${C.erreur}ANTHROPIC_API_KEY n'est pas définie.${C.zero}

Ajoutez-la dans agent-vocal/.env :
    ANTHROPIC_API_KEY=sk-ant-...

ou pour un seul essai :
    ANTHROPIC_API_KEY=sk-ant-... node scripts/essai.js ${idClient}
`);
  process.exit(1);
}

clients.recharger();
const client = clients.parId(idClient);
if (!client) {
  console.error(`${C.erreur}Fiche « ${idClient} » introuvable dans data/clients/.${C.zero}`);
  console.error(`Fiches disponibles : ${clients.tous().map((c) => c.id).join(', ') || 'aucune'}`);
  process.exit(1);
}

if (heureSimulee) {
  // Interpretee dans le fuseau du client : « 21:00 » veut dire 21 h chez lui.
  const d = horaire.depuisHeureLocale(heureSimulee, client.fuseau);
  if (!d) {
    console.error(`${C.erreur}Heure illisible : « ${heureSimulee} ». Format attendu : "2026-08-18 21:00".${C.zero}`);
    process.exit(1);
  }
  horaire.figerHorloge(d);
}

// ── Mise en place ────────────────────────────────────────────────────────────
const appelId = `essai_${crypto.randomBytes(5).toString('hex')}`;
const ouvert = horaire.estOuvert(client);
const transcription = [];
let outilsAppeles = 0;

store.ouvrirAppel({
  id: appelId,
  client_id: client.id,
  appelant,
  numero_appele: client.numero_agent,
});

const contexte = {
  client,
  appelId,
  appelant,
  denouement: null,
  categorie: null,
  resume: null,
  surOutil(nom, entree, sortie) {
    outilsAppeles += 1;
    const args = Object.entries(entree)
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join(', ');
    console.log(`\n  ${C.outil}▸ ${nom}${C.zero}${C.faible}(${args})${C.zero}`);
    console.log(`  ${C.faible}  └─ ${sortie.resultat.replace(/\n/g, '\n       ')}${C.zero}`);
    if (sortie.action) {
      console.log(`  ${C.action}⚑ ACTION ${sortie.action.type}${C.zero}${C.faible} ${
        JSON.stringify(sortie.action, (k, v) => (k === 'type' ? undefined : v))}${C.zero}`);
    }
  },
};

const cerveau = new Cerveau(client, contexte);

// ── Affichage ────────────────────────────────────────────────────────────────
console.log(`
${C.gras}╭─ Console d'essai — Standard 24 ─────────────────────────────${C.zero}
${C.gras}│${C.zero} Entreprise   ${client.nom}
${C.gras}│${C.zero} Agent        ${client.persona.nom_agent}
${C.gras}│${C.zero} Moment       ${horaire.momentLisible(horaire.maintenant(), client.fuseau)}${
  heureSimulee ? `${C.faible} (simulé)${C.zero}` : ''}
${C.gras}│${C.zero} Entreprise   ${ouvert ? '\x1b[32mOUVERTE\x1b[0m' : '\x1b[33mFERMÉE\x1b[0m — aucun transfert possible'}
${C.gras}│${C.zero} Appelant     ${appelant}
${C.gras}│${C.zero} Outils       ${cerveau.outils.map((o) => o.name).join(', ')}
${C.gras}╰─────────────────────────────────────────────────────────────${C.zero}
${C.faible}Tapez votre réplique et Entrée. « /fin » pour terminer, Ctrl+C pour couper.${C.zero}
`);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const demander = () => new Promise((r) => rl.question(`${C.appelant}Appelant ▸ ${C.zero}`, r));

let tampon = '';
const direPhrase = (phrase) => {
  transcription.push({ qui: 'agent', texte: phrase, t: 0 });
  tampon += (tampon ? ' ' : '') + phrase;
};
const viderTampon = () => {
  if (tampon) console.log(`\n${C.agent}${client.persona.nom_agent} ▸ ${C.zero}${tampon}\n`);
  tampon = '';
};

function terminer(raison) {
  viderTampon();
  store.fermerAppel(appelId, {
    duree_s: 0,
    denouement: contexte.denouement || 'raccroche',
    categorie: contexte.categorie,
    resume: contexte.resume,
    transcription: JSON.stringify(transcription),
  });
  console.log(`${C.gras}╭─ Fin de l'essai ────────────────────────────────────────────${C.zero}`);
  console.log(`${C.gras}│${C.zero} Dénouement   ${contexte.denouement || 'raccroche'}`);
  console.log(`${C.gras}│${C.zero} Catégorie    ${contexte.categorie || '—'}`);
  console.log(`${C.gras}│${C.zero} Résumé       ${contexte.resume || '—'}`);
  console.log(`${C.gras}│${C.zero} Outils       ${outilsAppeles} appel(s)`);
  console.log(`${C.gras}│${C.zero} Consigné     ${appelId} ${C.faible}— visible dans la console web${C.zero}`);
  console.log(`${C.gras}╰─────────────────────────────────────────────────────────────${C.zero}`);
  if (raison) console.log(`${C.faible}${raison}${C.zero}`);
  rl.close();
  process.exit(0);
}

// ── Boucle de conversation ───────────────────────────────────────────────────
(async () => {
  try {
    const { actions } = await cerveau.ouvrir(direPhrase);
    viderTampon();
    if (actions.some((a) => a.type === 'raccrocher')) terminer("L'agent a mis fin à l'appel.");
  } catch (e) {
    console.error(`\n${C.erreur}Échec de l'appel au modèle : ${e.message}${C.zero}`);
    process.exit(1);
  }

  for (;;) {
    const entree = (await demander()).trim();
    if (!entree) continue;
    if (entree === '/fin') terminer('Essai interrompu.');

    transcription.push({ qui: 'appelant', texte: entree, t: 0 });
    try {
      const { actions } = await cerveau.repondre(entree, direPhrase);
      viderTampon();

      const transfert = actions.find((a) => a.type === 'transfert');
      if (transfert) {
        terminer(`En production, l'appel serait basculé vers ${transfert.numero} (${transfert.vers}).`);
      }
      if (actions.some((a) => a.type === 'raccrocher')) {
        terminer("L'agent a mis fin à l'appel.");
      }
    } catch (e) {
      console.error(`\n${C.erreur}Erreur : ${e.message}${C.zero}\n`);
    }
  }
})();

rl.on('SIGINT', () => terminer('Interrompu.'));
