#!/usr/bin/env node
/**
 * Tests de la logique metier — sans reseau, sans cle API.
 *   npm test
 *
 * Ne couvre pas la chaine audio (Deepgram, ElevenLabs, Twilio), qui exige
 * un appel reel. Pour eprouver le comportement de l'agent : scripts/essai.js
 */

const { clients } = require('../src/clients');
const horaire = require('../src/horaire');
const outils = require('../src/moteur/outils');
const { promptSysteme } = require('../src/moteur/cerveau');
const { nettoyerPourLaVoix } = require('../src/moteur/tts');

let echecs = 0;
let total = 0;
let section = '';

const groupe = (nom) => { section = nom; console.log(`\n── ${nom} ${'─'.repeat(Math.max(0, 58 - nom.length))}`); };
const test = (nom, fn) => {
  total += 1;
  try {
    fn();
    console.log(`  \x1b[32m✓\x1b[0m ${nom}`);
  } catch (e) {
    echecs += 1;
    console.log(`  \x1b[31m✗ ${nom}\x1b[0m\n      ${e.message}`);
  }
};
const vrai = (c, m) => { if (!c) throw new Error(m || 'condition fausse'); };
const egal = (a, b, m) => { if (a !== b) throw new Error(`${m || 'valeurs différentes'} — attendu ${JSON.stringify(b)}, obtenu ${JSON.stringify(a)}`); };

clients.recharger();
const c = clients.parId('crc');
const ctx = () => ({ client: c, appelId: `test_${Date.now()}` });

// ─────────────────────────────────────────────────────────────────────────────
groupe('Fiches clients');

test('la fiche de démonstration se charge', () => {
  vrai(c, 'fiche crc introuvable');
  egal(c.nom, 'Construction Richard Champagne');
});

test('les numéros sont normalisés en E.164', () => {
  egal(c.numero_transfert_defaut, '+14183657973');
  egal(clients.normaliserNumero('418-365-7973'), '+14183657973');
  egal(clients.normaliserNumero('1 (418) 365-7973'), '+14183657973');
});

test('un appel est routé vers la bonne fiche par le numéro composé', () => {
  egal(clients.parNumero('418-555-0142')?.id, 'crc');
  egal(clients.parNumero('+15145559999'), null, 'un numéro inconnu ne doit router nulle part');
});

test('une fiche sans persona est rejetée', () => {
  let leve = false;
  try { clients.enregistrer('_essai_invalide', { nom: 'X', heures: {} }); } catch { leve = true; }
  vrai(leve, 'une fiche incomplète devrait être refusée');
});

// ─────────────────────────────────────────────────────────────────────────────
groupe('Heures d\'ouverture');

const a = (mural) => horaire.depuisHeureLocale(mural, c.fuseau);
const ouvertA = (mural) => horaire.estOuvert(c, a(mural));

test('ouvert un mardi matin', () => vrai(ouvertA('2026-08-18 10:00')));
test('fermé un mardi soir', () => vrai(!ouvertA('2026-08-18 21:00')));
test('fermé une minute avant l\'ouverture', () => vrai(!ouvertA('2026-08-18 06:59')));
test('ouvert une minute après l\'ouverture', () => vrai(ouvertA('2026-08-18 07:01')));
test('ouvert une minute avant la fermeture', () => vrai(ouvertA('2026-08-18 16:29')));
test('fermé une minute après la fermeture', () => vrai(!ouvertA('2026-08-18 16:31')));
test('fermé le vendredi après-midi', () => vrai(!ouvertA('2026-08-21 13:00')));
test('fermé la fin de semaine', () => vrai(!ouvertA('2026-08-22 10:00')));
test('fermé un jour férié', () => vrai(!ouvertA('2026-12-25 10:00')));

test('l\'heure murale est lue dans le fuseau du client, pas du serveur', () => {
  // Le piège : le serveur tourne en UTC, le client est à Toronto.
  egal(horaire.momentLisible(a('2026-08-18 10:00'), c.fuseau), 'mardi 18 août à 10 h 00');
});

test('le changement d\'heure est pris en compte', () => {
  egal(horaire.decalageMinutes(a('2026-08-18 10:00'), c.fuseau), -240, 'août = UTC-4');
  egal(horaire.decalageMinutes(a('2026-01-20 10:00'), c.fuseau), -300, 'janvier = UTC-5');
  vrai(ouvertA('2026-01-20 10:00'), 'ouvert un mardi de janvier');
});

// ─────────────────────────────────────────────────────────────────────────────
groupe('Disponibilités de rendez-vous');

test('les plages suivent la configuration, pas les heures d\'ouverture', () => {
  const l = horaire.disponibilites(c, '2026-08-17', []);
  egal(l.length, 12, 'de 09:00 à 15:00 par tranches de 30 min');
  egal(l[0], '09:00');
  egal(l[l.length - 1], '14:30');
});

test('une plage déjà réservée disparaît', () => {
  const l = horaire.disponibilites(c, '2026-08-17', [{ debut: '2026-08-17T10:00:00', duree_min: 30 }]);
  vrai(!l.includes('10:00'), '10:00 devrait être occupée');
  vrai(l.includes('10:30'), '10:30 devrait rester libre');
});

test('un rendez-vous long bloque toutes les plages qu\'il chevauche', () => {
  const l = horaire.disponibilites(c, '2026-08-17', [{ debut: '2026-08-17T10:00:00', duree_min: 90 }]);
  vrai(!l.includes('10:00') && !l.includes('10:30') && !l.includes('11:00'), 'chevauchement mal calculé');
  vrai(l.includes('11:30'), '11:30 devrait rester libre');
});

test('aucune plage la fin de semaine ni les jours fériés', () => {
  egal(horaire.disponibilites(c, '2026-08-22', []).length, 0, 'samedi');
  egal(horaire.disponibilites(c, '2026-12-25', []).length, 0, 'Noël');
});

// ─────────────────────────────────────────────────────────────────────────────
groupe('Outils de l\'agent');

test('les outils correspondent aux capacités de la fiche', () => {
  const noms = outils.definitions(c).map((o) => o.name);
  for (const n of ['consulter_infos', 'prendre_message', 'transferer_appel',
    'verifier_disponibilites', 'prendre_rendez_vous', 'escalader_urgence', 'terminer_appel']) {
    vrai(noms.includes(n), `outil manquant : ${n}`);
  }
});

test('une fiche sans rendez-vous ni urgence n\'expose pas ces outils', () => {
  const simple = { ...c, rdv: { actif: false }, urgences: { mots_cles: [], numero: null } };
  const noms = outils.definitions(simple).map((o) => o.name);
  vrai(!noms.includes('prendre_rendez_vous'), 'rendez-vous ne devrait pas être offert');
  vrai(!noms.includes('escalader_urgence'), 'urgence ne devrait pas être offerte');
});

test('chaque outil a un schéma valide pour Claude', () => {
  for (const o of outils.definitions(c)) {
    vrai(o.name && o.description && o.input_schema?.type === 'object', `schéma invalide : ${o.name}`);
    vrai(Array.isArray(o.input_schema.required), `« required » manquant : ${o.name}`);
  }
});

test('l\'acheminement par mot-clé trouve la bonne personne', () => {
  egal(outils.trouverMembre(c, 'soumission')?.nom, 'Thierry-Eliot Villeneuve');
  egal(outils.trouverMembre(c, 'chantier')?.nom, 'Carl Milot');
  egal(outils.trouverMembre(c, 'facture')?.nom, 'Louise Desaulniers');
  egal(outils.trouverMembre(c, 'Carl Milot')?.nom, 'Carl Milot', 'nom exact');
  egal(outils.trouverMembre(c, 'reception'), null, '« réception » ne vise personne en particulier');
});

// ─────────────────────────────────────────────────────────────────────────────
groupe('Consultation de la fiche');

const infos = (sujet, question) => outils.executer('consulter_infos', { sujet, question }, ctx()).resultat;

test('les heures sont énoncées correctement', () => {
  vrai(infos('heures').includes('lundi de 07:00'), 'heures absentes');
});

test('la FAQ répond quand la question correspond', () => {
  vrai(infos('faq', 'êtes-vous accrédités RBQ').includes('8231-1127-01'));
  vrai(infos('faq', 'où envoyer une facture').includes('info@c-rc.ca'));
});

test('la FAQ refuse de répondre hors sujet plutôt que d\'inventer', () => {
  // Le piège corrigé : « vous » suffisait à faire correspondre n'importe quoi.
  for (const q of ['vendez-vous des bicyclettes électriques',
    'bonjour comment allez-vous', 'je veux parler à quelqu\'un']) {
    vrai(infos('faq', q).includes('Ne pas inventer'), `aurait dû refuser : « ${q} »`);
  }
});

test('les accents ne bloquent pas la correspondance', () => {
  vrai(infos('faq', 'accredites RBQ').includes('8231-1127-01'), 'sans accents');
  vrai(infos('faq', 'accrédités RBQ').includes('8231-1127-01'), 'avec accents');
});

// ─────────────────────────────────────────────────────────────────────────────
groupe('Règles de transfert');

test('aucun transfert quand l\'entreprise est fermée', () => {
  horaire.figerHorloge(a('2026-08-18 21:00'));
  const r = outils.executer('transferer_appel', { destinataire: 'Carl Milot', raison: 'chantier' }, ctx());
  vrai(r.resultat.includes('fermee'), 'devrait refuser le transfert');
  vrai(!r.action, 'aucune action de transfert ne devrait être émise');
  horaire.figerHorloge(null);
});

test('transfert autorisé pendant les heures, avec repli sur le numéro principal', () => {
  horaire.figerHorloge(a('2026-08-18 10:00'));
  const r = outils.executer('transferer_appel', { destinataire: 'Carl Milot', raison: 'chantier' }, ctx());
  egal(r.action?.type, 'transfert');
  // Aucun membre n'a de téléphone dans la fiche : repli attendu.
  egal(r.action.numero, '+14183657973', 'devrait se replier sur le numéro principal');
  horaire.figerHorloge(null);
});

test('une urgence est escaladée même la nuit', () => {
  horaire.figerHorloge(a('2026-08-18 03:00'));
  const r = outils.executer('escalader_urgence', { nature: 'dégât d\'eau', lieu: 'école' }, ctx());
  egal(r.action?.type, 'transfert');
  egal(r.action.numero, '+14183657973');
  horaire.figerHorloge(null);
});

test('un rendez-vous hors plage libre est refusé', () => {
  const r = outils.executer('prendre_rendez_vous', {
    nom: 'Test', telephone: '5145551234', date: '2026-08-22', heure: '10:00', objet: 'essai',
  }, ctx());
  vrai(r.resultat.includes("n'est pas disponible"), 'un samedi devrait être refusé');
  vrai(!r.action, 'aucune confirmation ne devrait être émise');
});

// ─────────────────────────────────────────────────────────────────────────────
groupe('Prompt et sortie vocale');

test('le prompt porte la persona, l\'équipe et les consignes du client', () => {
  const p = promptSysteme(c, { appelant: '+15145551234' });
  vrai(p.includes('Sophie'), 'persona');
  vrai(p.includes('Carl Milot'), 'équipe');
  vrai(p.includes('confidentielles'), 'consignes propres au client');
  vrai(p.includes('pas de puces'), 'consigne de sortie vocale');
});

test('le prompt annonce l\'état d\'ouverture au moment de l\'appel', () => {
  horaire.figerHorloge(a('2026-08-18 21:00'));
  vrai(promptSysteme(c, {}).includes('FERMEE'), 'devrait annoncer fermé');
  horaire.figerHorloge(a('2026-08-18 10:00'));
  vrai(promptSysteme(c, {}).includes('OUVERTE'), 'devrait annoncer ouvert');
  horaire.figerHorloge(null);
});

test('le balisage ne se rend jamais à la synthèse vocale', () => {
  egal(nettoyerPourLaVoix('**Bonjour** _madame_'), 'Bonjour madame');
  egal(nettoyerPourLaVoix('- premier point'), 'premier point');
  egal(nettoyerPourLaVoix('M. Milot vous rappellera'), 'Monsieur Milot vous rappellera');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(62)}`);
console.log(`${total - echecs}/${total} test(s) réussi(s)${echecs ? `, \x1b[31m${echecs} échec(s)\x1b[0m` : ''}.\n`);
process.exit(echecs ? 1 : 0);
