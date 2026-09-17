// Diagnostic de la connexion ODBC Avantage: tables atteignables, colonnes
// resolues vers le modele logique, colonnes manquantes, echantillon de lignes.
const { SCHEMA } = require('../sources/schema');
const odbcSource = require('../sources/odbc-source');

async function inspecter(opts) {
  const options = opts || {};
  const echantillon = options.echantillon === true;

  return odbcSource.withConnection(async cnx => {
    const rapport = { source: 'odbc', ok: true, connexion: masquer(odbcSource.connectionString()), tables: {} };

    for (const [cle, def] of Object.entries(SCHEMA)) {
      const t = { table: def.table };
      try {
        const colonnes = (await odbcSource.columnsOf(cnx, def.table)).map(c => c.nom);
        const { map, manquantes } = odbcSource.resolveTable(def, colonnes);
        t.colonnes_disponibles = colonnes;
        t.mapping = map;
        t.manquantes = manquantes;
        if (def.ventilation) t.ventilation = odbcSource.detectVentilation(colonnes);
        if (echantillon) {
          const cols = Object.values(map).map(odbcSource.quote).join(', ');
          if (cols) {
            const rows = await cnx.query('SELECT ' + cols + ' FROM ' + odbcSource.quote(def.table));
            t.exemple = Array.from(rows).slice(0, 3);
            t.lignes = rows.length;
          }
        }
        t.ok = manquantes.length === 0;
      } catch (e) {
        t.ok = false;
        t.error = e.message;
        rapport.ok = false;
      }
      rapport.tables[cle] = t;
    }

    rapport.resume = Object.entries(rapport.tables).map(([k, v]) =>
      k + ': ' + (v.ok ? 'OK' : (v.error ? 'ERREUR' : 'colonnes manquantes -> ' + v.manquantes.join(', '))));
    return rapport;
  });
}

function masquer(cs) {
  return String(cs).replace(/(PWD|PASSWORD)=([^;]*)/ig, '$1=***');
}

module.exports = { inspecter };
