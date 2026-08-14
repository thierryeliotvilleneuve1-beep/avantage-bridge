// Calculs d'heures d'ouverture et de disponibilites, dans le fuseau du client.

const JOURS = ['dim', 'lun', 'mar', 'mer', 'jeu', 'ven', 'sam'];
const JOURS_LONGS = {
  dim: 'dimanche', lun: 'lundi', mar: 'mardi', mer: 'mercredi',
  jeu: 'jeudi', ven: 'vendredi', sam: 'samedi',
};

// Horloge injectable : permet d'essayer le comportement « hors des heures »
// ou « veille de ferie » sans attendre le bon moment de la semaine.
let horlogeFigee = null;

/** Fige l'heure courante du systeme. `null` pour revenir a l'heure reelle. */
function figerHorloge(date) {
  horlogeFigee = date ? new Date(date) : null;
}

/** Heure courante, reelle ou figee. */
function maintenant() {
  return horlogeFigee ? new Date(horlogeFigee) : new Date();
}

/** Retourne { annee, mois, jour, heure, minute, jourSemaine } dans le fuseau donne. */
function partiesLocales(date, fuseau) {
  const fmt = new Intl.DateTimeFormat('fr-CA', {
    timeZone: fuseau,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short',
    hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  // L'index du jour vient d'un calcul UTC decale, plus fiable que le libelle localise.
  const decale = new Date(date.toLocaleString('en-US', { timeZone: fuseau }));
  return {
    annee: parseInt(p.year, 10),
    mois: parseInt(p.month, 10),
    jour: parseInt(p.day, 10),
    heure: parseInt(p.hour === '24' ? '0' : p.hour, 10),
    minute: parseInt(p.minute, 10),
    jourSemaine: JOURS[decale.getDay()],
    dateIso: `${p.year}-${p.month}-${p.day}`,
  };
}

/** Ecart, en minutes, entre l'heure murale du fuseau et UTC a cet instant. */
function decalageMinutes(date, fuseau) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: fuseau,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  const commeUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return (commeUtc - date.getTime()) / 60000;
}

/**
 * Convertit une heure murale (« 2026-08-18 10:00 ») en instant reel, en
 * l'interpretant dans le fuseau donne plutot que dans celui du serveur.
 * @returns {Date|null} null si la chaine est illisible
 */
function depuisHeureLocale(chaine, fuseau) {
  const m = String(chaine).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})/);
  if (!m) return null;
  const [, A, M, J, h, min] = m.map(Number);
  const mural = Date.UTC(A, M - 1, J, h, min);
  // Deux passes : la premiere estime le decalage, la seconde le corrige si
  // l'estimation tombait du mauvais cote d'un changement d'heure.
  let ts = mural;
  for (let i = 0; i < 2; i += 1) {
    ts = mural - decalageMinutes(new Date(ts), fuseau) * 60000;
  }
  return new Date(ts);
}

function enMinutes(hhmm) {
  const [h, m] = String(hhmm).split(':').map((x) => parseInt(x, 10));
  return h * 60 + (m || 0);
}

function enHhmm(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** L'entreprise est-elle ouverte a l'instant donne ? */
function estOuvert(client, date = maintenant()) {
  const l = partiesLocales(date, client.fuseau);
  if ((client.jours_feries || []).includes(l.dateIso)) return false;
  const plage = client.heures[l.jourSemaine];
  if (!plage) return false;
  const now = l.heure * 60 + l.minute;
  return now >= enMinutes(plage[0]) && now < enMinutes(plage[1]);
}

/** Phrase lisible des heures d'ouverture, pour le prompt et pour l'agent. */
function heuresLisibles(client) {
  const lignes = [];
  for (const j of ['lun', 'mar', 'mer', 'jeu', 'ven', 'sam', 'dim']) {
    const p = client.heures[j];
    lignes.push(p ? `${JOURS_LONGS[j]} de ${p[0]} a ${p[1]}` : `${JOURS_LONGS[j]} ferme`);
  }
  return lignes.join(', ');
}

/**
 * Plages libres pour un jour donne, en tenant compte des rendez-vous existants.
 * @param {object} client
 * @param {string} dateIso  AAAA-MM-JJ
 * @param {Array<{debut:string,duree_min:number}>} occupes rendez-vous deja pris
 */
function disponibilites(client, dateIso, occupes = []) {
  const cfg = client.rdv || {};
  if (!cfg.actif) return [];

  const d = new Date(`${dateIso}T12:00:00Z`);
  const jourSemaine = JOURS[new Date(d.toLocaleString('en-US', { timeZone: client.fuseau })).getDay()];

  // Les plages de rendez-vous peuvent differer des heures d'ouverture.
  const plage = (cfg.plages && cfg.plages[jourSemaine]) || client.heures[jourSemaine];
  if (!plage) return [];
  if ((client.jours_feries || []).includes(dateIso)) return [];

  const duree = cfg.duree_min || 30;
  const pris = occupes.map((o) => {
    const h = o.debut.slice(11, 16);
    return [enMinutes(h), enMinutes(h) + (o.duree_min || duree)];
  });

  const libres = [];
  for (let t = enMinutes(plage[0]); t + duree <= enMinutes(plage[1]); t += duree) {
    const chevauche = pris.some(([a, b]) => t < b && t + duree > a);
    if (!chevauche) libres.push(enHhmm(t));
  }
  return libres;
}

/** Horodatage lisible pour l'agent : « mardi 19 aout, 14 h 30 ». */
function momentLisible(date, fuseau) {
  return new Intl.DateTimeFormat('fr-CA', {
    timeZone: fuseau, weekday: 'long', day: 'numeric', month: 'long',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
}

module.exports = {
  partiesLocales, estOuvert, heuresLisibles, disponibilites,
  momentLisible, enMinutes, enHhmm, figerHorloge, maintenant,
  depuisHeureLocale, decalageMinutes,
  JOURS, JOURS_LONGS,
};
