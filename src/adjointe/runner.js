// Orchestration de l'Adjointe IA sur la boîte projets@c-rc.ca.
//
// Échelle d'autonomie — chaque cran ajoute une capacité, aucun ne saute une validation :
//   N0 lecture et proposition locale · N1 catégories Outlook · N2 brouillons dans Outlook
//   N3 envoi automatique des seuls accusés de réception
const graph = require('./graph');
const { trier } = require('./triage');
const { decider, validerBrouillon } = require('./policy');
const { redigerBrouillon, resumerPourJournal } = require('./claude');
const { lireEtat, ecrireEtat, journaliser } = require('./store');
const vault = require('./vault');
const { NIVEAU, MAILBOX, SIGNATURE } = require('./config');

const FENETRE_DEFAUT_JOURS = 2;
const FENETRE_MAX_JOURS = 14;

function niveauCourant(surcharge) {
  const n = surcharge == null ? NIVEAU : parseInt(surcharge, 10);
  return Math.max(0, Math.min(3, isNaN(n) ? 0 : n));
}

function fenetre(etat) {
  const maintenant = Date.now();
  const plancher = maintenant - FENETRE_MAX_JOURS * 86400000;
  if (!etat.derniere_execution) return new Date(maintenant - FENETRE_DEFAUT_JOURS * 86400000).toISOString();
  const derniere = new Date(etat.derniere_execution).getTime();
  return new Date(Math.max(derniere, plancher)).toISOString();
}

function categoriesOutlook(item, decision) {
  const c = [];
  if (item.projet) c.push(item.projet);
  if (decision.action === 'escalader') c.push('Adjointe — escalade');
  else if (decision.action === 'brouillon') c.push('Adjointe — brouillon prêt');
  else if (item.bruit) c.push('Adjointe — sans suite');
  else c.push('Adjointe — classé');
  return c;
}

// Un cycle : balayer, trier, décider, appliquer ce que le niveau autorise.
async function executerCycle({ niveau, limite = 50, depuis } = {}) {
  const n = niveauCourant(niveau);
  const etat = lireEtat();
  const debut = depuis || fenetre(etat);
  const rapport = {
    debut_fenetre: debut, niveau: n, examines: 0, retenus: 0,
    escalades: 0, brouillons: 0, envoyes: 0, bruit: 0, erreurs: [],
  };

  const messages = await graph.listerMessages({ depuis: debut, limite });
  rapport.examines = messages.length;

  for (const msg of messages) {
    try {
      const item = trier(msg);
      const decision = decider(item, n);
      const existant = etat.elements[item.id] || {};

      const enregistrement = {
        ...existant,
        ...item,
        decision,
        statut: existant.statut && existant.statut !== 'nouveau' ? existant.statut : 'nouveau',
        vu_le: new Date().toISOString(),
      };

      if (item.bruit) {
        rapport.bruit++;
        enregistrement.statut = 'sans_suite';
      } else {
        rapport.retenus++;
        if (decision.action === 'escalader') {
          rapport.escalades++;
          if (enregistrement.statut === 'nouveau') enregistrement.statut = 'escalade';
        }
      }

      // N1 — classement dans Outlook
      if (n >= 1 && !existant.categorise) {
        try {
          await graph.categoriser(item.id, categoriesOutlook(item, decision));
          enregistrement.categorise = true;
        } catch (e) {
          rapport.erreurs.push('catégorisation ' + item.id + ' : ' + e.message);
        }
      }

      // N2 — proposition de réponse. Le brouillon n'est poussé dans Outlook qu'à N2+.
      if (decision.action === 'brouillon' || decision.action === 'repondre_auto') {
        if (!existant.brouillon) {
          const propose = await proposer(enregistrement, null, { pousser: n >= 2 });
          Object.assign(enregistrement, propose);
          rapport.brouillons++;

          // N3 — envoi automatique, uniquement si la politique l'a explicitement autorisé
          // et que le brouillon a passé la validation.
          if (decision.action === 'repondre_auto' && n >= 3 && enregistrement.brouillon &&
              enregistrement.brouillon.valide && enregistrement.brouillon.outlook_id) {
            await graph.envoyerBrouillon(enregistrement.brouillon.outlook_id);
            enregistrement.statut = 'envoye_auto';
            rapport.envoyes++;
            journaliser({ action: 'envoi_auto', id: item.id, projet: item.projet, sujet: item.sujet });
          }
        }
      }

      etat.elements[item.id] = enregistrement;
      journaliser({
        action: 'triage', id: item.id, projet: item.projet, categorie: item.categorie,
        decision: decision.action, motif: decision.motif, niveau: n,
      });
    } catch (e) {
      rapport.erreurs.push((msg.id || '?') + ' : ' + e.message);
    }
  }

  etat.derniere_execution = new Date().toISOString();
  etat.compteurs = rapport;
  ecrireEtat(etat);
  return rapport;
}

// Rédige une proposition de réponse. `pousser` décide si elle entre dans Outlook.
async function proposer(item, notes, { pousser = false } = {}) {
  const complet = await graph.lireMessage(item.id).catch(() => null);
  const corpsMessage = complet && complet.body ? corpsTexte(complet.body) : item.apercu;

  const brouillon = await redigerBrouillon(item, corpsMessage, notes);
  const controle = validerBrouillon(item, brouillon.corps);

  const resultat = {
    brouillon: {
      ...brouillon,
      valide: controle.valide,
      erreurs: controle.erreurs,
      outlook_id: null,
      cree_le: new Date().toISOString(),
    },
    statut: controle.valide ? 'brouillon_pret' : 'escalade',
  };

  if (pousser && controle.valide) {
    try {
      resultat.brouillon.outlook_id = await graph.creerBrouillonReponse(item.id, enHtml(brouillon.corps));
    } catch (e) {
      resultat.brouillon.erreurs = [...controle.erreurs, 'Outlook : ' + e.message];
    }
  }

  journaliser({
    action: 'brouillon', id: item.id, projet: item.projet, valide: controle.valide,
    erreurs: controle.erreurs, pousse: !!resultat.brouillon.outlook_id,
  });
  return resultat;
}

function corpsTexte(body) {
  if (!body) return '';
  if (body.contentType === 'text') return body.content || '';
  return (body.content || '').replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function echapper(t) {
  return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function enHtml(corps) {
  const paragraphes = String(corps).split(/\n{2,}/).map((p) =>
    '<p style="font-family:Calibri,Arial,sans-serif;font-size:11pt;color:#0A0A0A;margin:0 0 10pt 0;">' +
    echapper(p).replace(/\n/g, '<br>') + '</p>').join('');
  return '<div>' + paragraphes +
    '<p style="font-family:Calibri,Arial,sans-serif;font-size:9pt;color:#828182;margin:14pt 0 0 0;">' +
    'Brouillon préparé par l’Adjointe IA de CRC et relu avant envoi.</p></div>';
}

// Actions humaines déclenchées depuis l'interface -----------------------------

async function preparerManuellement(id, notes) {
  const etat = lireEtat();
  const item = etat.elements[id];
  if (!item) throw new Error('Élément inconnu : ' + id);
  const propose = await proposer(item, notes, { pousser: niveauCourant() >= 2 });
  etat.elements[id] = { ...item, ...propose };
  ecrireEtat(etat);
  return etat.elements[id];
}

async function approuverEtEnvoyer(id, corpsFinal, approuvePar) {
  const etat = lireEtat();
  const item = etat.elements[id];
  if (!item || !item.brouillon) throw new Error('Aucun brouillon pour ' + id);

  const corps = corpsFinal || item.brouillon.corps;
  const controle = validerBrouillon(item, corps);
  if (!controle.valide) {
    const err = new Error('Envoi bloqué : ' + controle.erreurs.join(' ; '));
    err.status = 422;
    throw err;
  }

  let outlookId = item.brouillon.outlook_id;
  if (!outlookId) outlookId = await graph.creerBrouillonReponse(id, enHtml(corps));
  else await graph.majBrouillon(outlookId, enHtml(corps));

  await graph.envoyerBrouillon(outlookId);

  etat.elements[id] = {
    ...item,
    statut: 'envoye',
    brouillon: { ...item.brouillon, corps, outlook_id: outlookId },
    approuve_par: approuvePar || 'humain',
    envoye_le: new Date().toISOString(),
  };
  ecrireEtat(etat);
  journaliser({ action: 'envoi_approuve', id, projet: item.projet, par: approuvePar || 'humain' });
  return etat.elements[id];
}

async function rejeter(id, motif, par) {
  const etat = lireEtat();
  const item = etat.elements[id];
  if (!item) throw new Error('Élément inconnu : ' + id);
  if (item.brouillon && item.brouillon.outlook_id) {
    await graph.supprimerBrouillon(item.brouillon.outlook_id).catch(() => {});
  }
  etat.elements[id] = { ...item, statut: 'rejete', motif_rejet: motif || null, brouillon: null };
  ecrireEtat(etat);
  journaliser({ action: 'rejet', id, motif: motif || null, par: par || 'humain' });
  return etat.elements[id];
}

async function marquerTraite(id, par) {
  const etat = lireEtat();
  const item = etat.elements[id];
  if (!item) throw new Error('Élément inconnu : ' + id);
  etat.elements[id] = { ...item, statut: 'traite', traite_le: new Date().toISOString() };
  ecrireEtat(etat);
  journaliser({ action: 'traite', id, par: par || 'humain' });
  return etat.elements[id];
}

// Consignation dans le vault, sur demande explicite (jamais en masse sans décision).
async function consignerAuVault(id) {
  const etat = lireEtat();
  const item = etat.elements[id];
  if (!item) throw new Error('Élément inconnu : ' + id);
  if (item.projet_sensible) {
    const e = new Error('Projet sensible — consignation manuelle interdite (Procedure §6)');
    e.status = 403;
    throw e;
  }
  const complet = await graph.lireMessage(id).catch(() => null);
  const resume = await resumerPourJournal(item, complet && complet.body ? corpsTexte(complet.body) : item.apercu);
  const r = vault.ajouterLigne(item, item.decision ? item.decision.action : 'consigné', resume);
  journaliser({ action: 'vault', id, ecrit: r.ecrit, fichier: r.fichier || null });
  return { ...r, resume };
}

async function statut() {
  const etat = lireEtat();
  const elements = Object.values(etat.elements || {});
  const parStatut = elements.reduce((acc, e) => {
    acc[e.statut || 'nouveau'] = (acc[e.statut || 'nouveau'] || 0) + 1;
    return acc;
  }, {});
  let acces = null;
  try { acces = await graph.verifierAcces(); } catch (e) { acces = { erreur: e.message }; }
  return {
    boite: MAILBOX,
    niveau: niveauCourant(),
    signature: SIGNATURE,
    derniere_execution: etat.derniere_execution,
    dernier_cycle: etat.compteurs || null,
    vault_actif: vault.actif(),
    acces,
    total: elements.length,
    par_statut: parStatut,
  };
}

module.exports = {
  executerCycle, preparerManuellement, approuverEtEnvoyer, rejeter, marquerTraite,
  consignerAuVault, statut, niveauCourant, enHtml,
};
