// Écriture dans le vault CRC — ajout seul, jamais d'écrasement (Procedure §5).
const fs = require('fs');
const path = require('path');
const { VAULT_DIR } = require('./config');
const { pourVault } = require('./redact');

function actif() {
  return !!VAULT_DIR && fs.existsSync(VAULT_DIR);
}

function cheminJournalAgents(nom) {
  return path.join(VAULT_DIR, '05-Journal-Agents', nom);
}

// Ajoute une ligne au journal de courriels de l'Adjointe. Ne touche à aucun fichier existant
// du vault autre que celui-ci.
function ajouterLigne(item, action, resume) {
  if (!actif()) return { ecrit: false, motif: 'VAULT_DIR non configuré' };
  const fichier = cheminJournalAgents('Journal-Adjointe-Courriels.md');
  if (!fs.existsSync(fichier)) {
    fs.mkdirSync(path.dirname(fichier), { recursive: true });
    fs.writeFileSync(fichier, [
      '---',
      'type: journal-agent',
      'agent: adjointe-ia',
      'source: projets@c-rc.ca',
      'confidentialite: restreint',
      '---',
      '',
      '# Journal — Adjointe IA, boîte projets@c-rc.ca',
      '',
      '> Contenu restreint. Ne jamais citer à un utilisateur autre que t.villeneuve@c-rc.ca.',
      '> Numéros de téléphone retirés à l’extraction.',
      '',
      '| Date | Projet | Catégorie | Expéditeur | Action | Résumé |',
      '|---|---|---|---|---|---|',
      '',
    ].join('\n'), 'utf8');
  }
  const cellule = (v) => String(v == null ? '' : v).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const ligne = '| ' + [
    (item.recu_le || '').slice(0, 10),
    item.projet || '—',
    item.categorie,
    cellule(item.expediteur),
    action,
    cellule(pourVault(resume || item.sujet)),
  ].map(cellule).join(' | ') + ' |\n';
  fs.appendFileSync(fichier, ligne, 'utf8');
  return { ecrit: true, fichier };
}

module.exports = { actif, ajouterLigne };
