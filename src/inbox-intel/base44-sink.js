// Inbox Intel — Écriture vers Base44 (réutilise le client du bridge Avantage).
// GARDE-FOU : refuse d'écrire tant que les entités cibles n'existent pas dans
// l'app (elles doivent être créées dans Base44 après validation du modèle et
// audit RLS — voir docs/inbox-intel/AUDIT-PREREQUIS.md).

const { api, sleep } = require('../writers/base44-writer');

async function entiteExiste(nom) {
  const r = await api('GET', `/entities/${nom}?limit=1`);
  return r.status === 200;
}

async function ecrireResultat(evenement, action) {
  if (!process.env.BASE44_API_KEY) {
    throw new Error('BASE44_API_KEY manquante — écriture refusée.');
  }
  for (const nom of ['EvenementTimeline', 'ActionSuggeree']) {
    if (!(await entiteExiste(nom))) {
      throw new Error(`Entité ${nom} introuvable dans l'app Base44 — la créer (et auditer les RLS) avant d'écrire.`);
    }
  }

  // Idempotence : ne pas recréer un événement déjà ingéré.
  if (evenement.internet_message_id) {
    const dup = await api('GET',
      `/entities/EvenementTimeline?internet_message_id=${encodeURIComponent(evenement.internet_message_id)}&boite_source=${encodeURIComponent(evenement.boite_source || '')}&limit=1`);
    try {
      const d = JSON.parse(dup.data);
      const arr = Array.isArray(d) ? d : (d.items || []);
      if (arr.length > 0) return { evenement: { status: 'existant', _id: arr[0]._id }, action: null };
    } catch (e) { /* réponse illisible → on tente la création */ }
  }

  let rEv = { status: 429 };
  while (rEv.status === 429) {
    rEv = await api('POST', '/entities/EvenementTimeline', evenement);
    if (rEv.status === 429) await sleep(1000);
  }
  let evenementId = null;
  try { evenementId = JSON.parse(rEv.data)._id; } catch (e) {}

  let rAc = { status: 429 };
  while (rAc.status === 429) {
    rAc = await api('POST', '/entities/ActionSuggeree', { ...action, evenement_id: evenementId });
    if (rAc.status === 429) await sleep(1000);
  }

  return { evenement: rEv, action: rAc };
}

module.exports = { ecrireResultat };
