#!/usr/bin/env node
// Verification avant mise en service : configuration, fiches clients, coherence
// des heures et des numeros. A executer apres chaque modification de fiche.

const { config } = require('../src/config');
const { clients } = require('../src/clients');
const horaire = require('../src/horaire');
const { tbc } = require('../src/telephonie/telus-business-connect');

let erreurs = 0;
let avis = 0;

const ok = (m) => console.log(`  \x1b[32mOK\x1b[0m    ${m}`);
const avertir = (m) => { avis += 1; console.log(`  \x1b[33mAVIS\x1b[0m  ${m}`); };
const echec = (m) => { erreurs += 1; console.log(`  \x1b[31mÉCHEC\x1b[0m ${m}`); };

console.log('\n── Environnement ────────────────────────────────────────────');
const manquants = config.verifier();
if (manquants.length) echec(`Variables manquantes : ${manquants.join(', ')}`);
else ok('Toutes les variables essentielles sont définies');

if (config.urlPublique && !/^https:\/\//.test(config.urlPublique)) {
  avertir(`URL_PUBLIQUE devrait être en https (${config.urlPublique})`);
}
if (config.cleAdmin === 'CHANGE_MOI_CLE_LONGUE_ET_ALEATOIRE') {
  echec('CLE_ADMIN est encore la valeur par défaut');
} else if (config.cleAdmin.length < 24) {
  avertir('CLE_ADMIN fait moins de 24 caractères');
} else {
  ok('Clé d’administration définie');
}

if (!config.twilio.sid || !config.twilio.token) echec('Identifiants Twilio absents — aucun appel ne peut entrer');
else ok('Identifiants Twilio présents');
if (!config.twilio.numero) avertir('TWILIO_NUMERO absent — pas de transfert ni de texto');

console.log(`  ${tbc.disponible() ? '\x1b[32mOK\x1b[0m    Telus Business Connect configuré' : '\x1b[33mAVIS\x1b[0m  Telus Business Connect non configuré (facultatif)'}`);
if (!tbc.disponible()) avis += 1;

console.log('\n── Fiches clients ───────────────────────────────────────────');
const n = clients.recharger();
if (!n) {
  echec('Aucune fiche client dans data/clients/');
} else {
  const numeros = new Map();
  for (const c of clients.tous()) {
    console.log(`\n  ▸ ${c.nom} (${c.id})${c.actif ? '' : ' — INACTIF'}`);

    if (!c.numero_agent) echec(`${c.id} : numero_agent absent — les appels ne seront pas routés`);
    else if (numeros.has(c.numero_agent)) echec(`${c.id} : numéro ${c.numero_agent} déjà utilisé par ${numeros.get(c.numero_agent)}`);
    else { numeros.set(c.numero_agent, c.id); ok(`Numéro d’agent ${c.numero_agent}`); }

    if (!c.voix_id && !config.tts.voixDefaut) echec(`${c.id} : aucune voix (voix_id ni VOIX_DEFAUT)`);
    else ok(`Voix ${c.voix_id || `par défaut (${config.tts.voixDefaut})`}`);

    const joursOuverts = Object.entries(c.heures).filter(([, p]) => p);
    if (!joursOuverts.length) avertir(`${c.id} : aucun jour d’ouverture — tous les appels iront en message`);
    else ok(`${joursOuverts.length} jour(s) d’ouverture — ${horaire.heuresLisibles(c)}`);

    for (const [j, p] of joursOuverts) {
      if (horaire.enMinutes(p[0]) >= horaire.enMinutes(p[1])) {
        echec(`${c.id} : plage invalide le ${j} (${p[0]} → ${p[1]})`);
      }
    }

    if (!c.equipe.length && !c.numero_transfert_defaut) {
      avertir(`${c.id} : aucun destinataire de transfert — l’agent ne pourra que prendre des messages`);
    } else {
      const sansContact = c.equipe.filter((m) => !m.telephone && !m.courriel);
      if (sansContact.length) avertir(`${c.id} : ${sansContact.map((m) => m.nom).join(', ')} — ni téléphone ni courriel`);
      const joignables = c.equipe.filter((m) => m.telephone).length;
      ok(`${c.equipe.length} membre(s), ${joignables} joignable(s) par transfert`);
    }

    if (c.urgences?.mots_cles?.length && !c.urgences.numero) {
      echec(`${c.id} : mots-clés d’urgence définis mais aucun numéro d’urgence`);
    }

    if (c.rdv?.actif) {
      // Cherche le prochain jour ouvrable plutot que « demain », qui tombe
      // souvent une fin de semaine et donnerait un faux avertissement.
      let trouve = null;
      for (let j = 1; j <= 10 && !trouve; j += 1) {
        const date = new Date(Date.now() + j * 864e5).toISOString().slice(0, 10);
        const libres = horaire.disponibilites(c, date, []);
        if (libres.length) trouve = { date, libres };
      }
      if (!trouve) echec(`${c.id} : rendez-vous actifs mais aucune plage libre dans les 10 prochains jours`);
      else ok(`Rendez-vous actifs — ${trouve.libres.length} plage(s) de ${c.rdv.duree_min || 30} min le ${trouve.date}`);
    }

    if (!c.faq.length) avertir(`${c.id} : FAQ vide — l’agent prendra un message pour toute question`);
    else ok(`${c.faq.length} question(s) en FAQ`);
  }
}

console.log('\n─────────────────────────────────────────────────────────────');
console.log(`${erreurs} échec(s), ${avis} avis.\n`);
process.exit(erreurs ? 1 : 0);
