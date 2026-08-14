const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { config } = require('./config');

fs.mkdirSync(path.dirname(config.fichierDb), { recursive: true });
const db = new Database(config.fichierDb);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS appels (
  id              TEXT PRIMARY KEY,
  client_id       TEXT NOT NULL,
  appelant        TEXT,
  numero_appele   TEXT,
  debut           TEXT NOT NULL,
  fin             TEXT,
  duree_s         INTEGER,
  denouement      TEXT,          -- message | transfert | rendez_vous | urgence | raccroche | filtre
  categorie       TEXT,
  resume          TEXT,
  transcription   TEXT,
  cout_estime     REAL
);

CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  appel_id    TEXT NOT NULL,
  client_id   TEXT NOT NULL,
  cree_le     TEXT NOT NULL,
  nom         TEXT,
  telephone   TEXT,
  courriel    TEXT,
  objet       TEXT,
  contenu     TEXT,
  urgence     TEXT DEFAULT 'normale',
  destinataire TEXT,
  traite      INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS rendezvous (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  appel_id    TEXT NOT NULL,
  client_id   TEXT NOT NULL,
  cree_le     TEXT NOT NULL,
  nom         TEXT,
  telephone   TEXT,
  courriel    TEXT,
  debut       TEXT NOT NULL,
  duree_min   INTEGER,
  objet       TEXT,
  statut      TEXT DEFAULT 'confirme'
);

CREATE TABLE IF NOT EXISTS evenements (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  appel_id  TEXT,
  client_id TEXT,
  horodate  TEXT NOT NULL,
  type      TEXT NOT NULL,
  detail    TEXT
);

CREATE INDEX IF NOT EXISTS idx_appels_client ON appels(client_id, debut DESC);
CREATE INDEX IF NOT EXISTS idx_messages_client ON messages(client_id, cree_le DESC);
CREATE INDEX IF NOT EXISTS idx_rdv_client ON rendezvous(client_id, debut);
`);

const maintenant = () => new Date().toISOString();

const requetes = {
  ouvrirAppel: db.prepare(
    `INSERT INTO appels (id, client_id, appelant, numero_appele, debut)
     VALUES (@id, @client_id, @appelant, @numero_appele, @debut)`
  ),
  fermerAppel: db.prepare(
    `UPDATE appels SET fin=@fin, duree_s=@duree_s, denouement=@denouement,
     categorie=@categorie, resume=@resume, transcription=@transcription
     WHERE id=@id`
  ),
  insererMessage: db.prepare(
    `INSERT INTO messages (appel_id, client_id, cree_le, nom, telephone, courriel,
      objet, contenu, urgence, destinataire)
     VALUES (@appel_id, @client_id, @cree_le, @nom, @telephone, @courriel,
      @objet, @contenu, @urgence, @destinataire)`
  ),
  insererRdv: db.prepare(
    `INSERT INTO rendezvous (appel_id, client_id, cree_le, nom, telephone, courriel,
      debut, duree_min, objet)
     VALUES (@appel_id, @client_id, @cree_le, @nom, @telephone, @courriel,
      @debut, @duree_min, @objet)`
  ),
  insererEvenement: db.prepare(
    `INSERT INTO evenements (appel_id, client_id, horodate, type, detail)
     VALUES (@appel_id, @client_id, @horodate, @type, @detail)`
  ),
  rdvDuJour: db.prepare(
    `SELECT debut, duree_min FROM rendezvous
     WHERE client_id=? AND statut='confirme' AND debut LIKE ?`
  ),
};

const store = {
  ouvrirAppel(appel) {
    requetes.ouvrirAppel.run({ debut: maintenant(), ...appel });
  },

  fermerAppel(id, donnees) {
    requetes.fermerAppel.run({
      id,
      fin: maintenant(),
      duree_s: donnees.duree_s ?? null,
      denouement: donnees.denouement ?? null,
      categorie: donnees.categorie ?? null,
      resume: donnees.resume ?? null,
      transcription: donnees.transcription ?? null,
    });
  },

  ajouterMessage(m) {
    const r = requetes.insererMessage.run({
      cree_le: maintenant(),
      nom: null, telephone: null, courriel: null, objet: null,
      contenu: null, urgence: 'normale', destinataire: null,
      ...m,
    });
    return r.lastInsertRowid;
  },

  ajouterRdv(r) {
    const res = requetes.insererRdv.run({
      cree_le: maintenant(),
      nom: null, telephone: null, courriel: null,
      duree_min: 30, objet: null,
      ...r,
    });
    return res.lastInsertRowid;
  },

  journaliser(appel_id, client_id, type, detail) {
    requetes.insererEvenement.run({
      appel_id: appel_id ?? null,
      client_id: client_id ?? null,
      horodate: maintenant(),
      type,
      detail: typeof detail === 'string' ? detail : JSON.stringify(detail ?? null),
    });
  },

  rdvDuJour(client_id, dateIso) {
    return requetes.rdvDuJour.all(client_id, `${dateIso}%`);
  },

  // Lectures pour la console d'administration
  listerAppels(client_id, limite = 50) {
    return db
      .prepare(
        `SELECT id, appelant, debut, fin, duree_s, denouement, categorie, resume
         FROM appels WHERE client_id=? ORDER BY debut DESC LIMIT ?`
      )
      .all(client_id, limite);
  },

  detailAppel(id) {
    return db.prepare('SELECT * FROM appels WHERE id=?').get(id);
  },

  listerMessages(client_id, limite = 50) {
    return db
      .prepare(
        `SELECT * FROM messages WHERE client_id=? ORDER BY cree_le DESC LIMIT ?`
      )
      .all(client_id, limite);
  },

  listerRdv(client_id, limite = 50) {
    return db
      .prepare(
        `SELECT * FROM rendezvous WHERE client_id=? ORDER BY debut DESC LIMIT ?`
      )
      .all(client_id, limite);
  },

  statistiques(client_id) {
    const base = db
      .prepare(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(duree_s), 0) AS secondes,
                SUM(CASE WHEN denouement='transfert' THEN 1 ELSE 0 END) AS transferts,
                SUM(CASE WHEN denouement='message' THEN 1 ELSE 0 END) AS messages,
                SUM(CASE WHEN denouement='rendez_vous' THEN 1 ELSE 0 END) AS rdv,
                SUM(CASE WHEN denouement='filtre' THEN 1 ELSE 0 END) AS filtres
         FROM appels WHERE client_id=? AND debut >= date('now','-30 days')`
      )
      .get(client_id);
    return {
      periode: '30 derniers jours',
      appels: base.total,
      minutes: Math.round(base.secondes / 60),
      transferts: base.transferts || 0,
      messages: base.messages || 0,
      rendez_vous: base.rdv || 0,
      filtres: base.filtres || 0,
    };
  },
};

module.exports = { db, store };
