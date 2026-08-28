'use strict';

const { ouvrir } = require('../db');
const { creerServeur } = require('../api/serveur');
const { amorcer } = require('./amorcer');
const bq = require('../banque/rapprochement');

const PORT = Number(process.env.PORT || 4000);

(async () => {
  const db = await ouvrir();
  console.log(`[demo] base : ${db.mode}`);

  const vide = (await db.query(`SELECT count(*)::int AS n FROM gl.ecriture`)).rows[0].n === 0;
  if (vide) {
    const r = await amorcer(db);
    console.log(`[demo] ${r.fournisseurs} factures fournisseurs, ${r.mouvements} mouvements bancaires`);
    const bilan = await db.transaction((tx) => bq.suggererEtAutomatiser(tx, 1, 'cron@c-rc.ca'));
    console.log(`[demo] règles : ${bilan.automatiques} passées seules, ` +
                `${bilan.suggerees} suggérées, ${bilan.sans_regle} sans règle`);
  }

  const eq = (await db.query(`SELECT ecart, equilibre FROM gl.controle_equilibre`)).rows[0];
  console.log(`[demo] grand livre : écart ${Number(eq.ecart).toFixed(2)} — ` +
              `${eq.equilibre ? 'équilibré' : 'DÉSÉQUILIBRÉ'}`);

  creerServeur(db).listen(PORT, () => {
    console.log(`[demo] ouvrir http://localhost:${PORT}`);
  });
})().catch((e) => {
  console.error('[demo] échec :', e.message);
  process.exit(1);
});
