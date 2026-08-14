const fs = require('fs');
const path = require('path');
const { config } = require('./config');

// Chaque PME cliente est decrite par un fichier JSON dans data/clients/.
// Les fichiers sont relus a chaud : modifier un JSON prend effet au prochain appel.

const cache = new Map();

function chemin(id) {
  return path.join(config.dossierClients, `${id}.json`);
}

function normaliserNumero(n) {
  if (!n) return null;
  const chiffres = String(n).replace(/\D/g, '');
  if (chiffres.length === 10) return `+1${chiffres}`;
  if (chiffres.length === 11 && chiffres.startsWith('1')) return `+${chiffres}`;
  return String(n).startsWith('+') ? String(n) : `+${chiffres}`;
}

function valider(c, id) {
  const erreurs = [];
  if (!c.nom) erreurs.push('nom manquant');
  if (!c.persona || !c.persona.nom_agent) erreurs.push('persona.nom_agent manquant');
  if (!c.heures) erreurs.push('heures manquantes');
  if (erreurs.length) {
    throw new Error(`Client « ${id} » invalide : ${erreurs.join(', ')}`);
  }
}

function charger(id) {
  const f = chemin(id);
  if (!fs.existsSync(f)) return null;
  const brut = JSON.parse(fs.readFileSync(f, 'utf8'));
  valider(brut, id);

  const c = {
    id,
    actif: brut.actif !== false,
    fuseau: brut.fuseau || 'America/Toronto',
    langue: brut.langue || 'fr-CA',
    ...brut,
  };

  c.numero_agent = normaliserNumero(c.numero_agent);
  c.numero_transfert_defaut = normaliserNumero(c.numero_transfert_defaut);
  c.equipe = (c.equipe || []).map((m) => ({
    ...m,
    telephone: normaliserNumero(m.telephone),
    mots_cles: (m.mots_cles || []).map((k) => k.toLowerCase()),
  }));
  c.services = c.services || [];
  c.faq = c.faq || [];
  c.exclusions = c.exclusions || [];
  c.urgences = c.urgences || { mots_cles: [], numero: null, message: null };
  c.urgences.numero = normaliserNumero(c.urgences.numero);
  c.rdv = c.rdv || { actif: false };

  return c;
}

const clients = {
  /** Recharge tous les fichiers clients depuis le disque. */
  recharger() {
    cache.clear();
    fs.mkdirSync(config.dossierClients, { recursive: true });
    for (const f of fs.readdirSync(config.dossierClients)) {
      if (!f.endsWith('.json')) continue;
      const id = path.basename(f, '.json');
      try {
        const c = charger(id);
        if (c) cache.set(id, c);
      } catch (e) {
        console.error(`[ERREUR] Chargement du client ${id} : ${e.message}`);
      }
    }
    return cache.size;
  },

  parId(id) {
    if (!cache.has(id)) {
      try {
        const c = charger(id);
        if (c) cache.set(id, c);
      } catch (e) {
        console.error(`[ERREUR] ${e.message}`);
        return null;
      }
    }
    return cache.get(id) || null;
  },

  /** Retrouve le client a partir du numero compose par l'appelant. */
  parNumero(numero) {
    const cible = normaliserNumero(numero);
    if (!cible) return null;
    for (const c of cache.values()) {
      if (c.numero_agent === cible) return c;
    }
    return null;
  },

  tous() {
    return [...cache.values()];
  },

  enregistrer(id, donnees) {
    fs.mkdirSync(config.dossierClients, { recursive: true });
    valider(donnees, id);
    fs.writeFileSync(chemin(id), JSON.stringify(donnees, null, 2), 'utf8');
    cache.delete(id);
    return clients.parId(id);
  },

  normaliserNumero,
};

module.exports = { clients };
