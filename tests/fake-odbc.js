// Faux pilote ODBC: repond aux requetes generees par odbc-source a partir de
// tables en memoire, pour tester la lecture directe sans BD Avantage reelle.
const Module = require('module');

function install(tables, opts) {
  const options = opts || {};
  const sqlVu = [];

  function colonnesDe(table) {
    const rows = tables[table] || [];
    const noms = rows.length ? Object.keys(rows[0]) : (options.colonnes && options.colonnes[table]) || [];
    return noms.map(n => ({
      name: n,
      dataType: 12,
      dataTypeName: (options.numeriques && options.numeriques.includes(n)) ? 'INTEGER' : 'CHAR',
    }));
  }

  function query(sql) {
    sqlVu.push(sql);
    if (options.echec) throw new Error(options.echec);
    const m = sql.match(/^SELECT (.+?) FROM "([^"]+)"(?: WHERE (.+))?$/s);
    if (!m) throw new Error('SQL non reconnu par le faux pilote: ' + sql);
    const [, colsRaw, table, where] = m;
    if (!tables[table] && !(options.colonnes && options.colonnes[table])) throw new Error('Table inconnue: ' + table);

    const meta = colonnesDe(table);
    if (where === '1 = 0') { const out = []; out.columns = meta; return out; }

    const cols = colsRaw.trim() === '*' ? meta.map(c => c.name) : colsRaw.split(',').map(c => c.trim().replace(/^"|"$/g, ''));
    let rows = tables[table] || [];

    if (where) {
      const w = where.match(/^"([^"]+)" IN \((.*)\)$/s);
      if (!w) throw new Error('Filtre non reconnu: ' + where);
      const col = w[1];
      const vals = new Set(w[2].split(',').map(v => v.trim().replace(/^'|'$/g, '')));
      rows = rows.filter(r => vals.has(String(r[col]).trim()));
    }

    const out = rows.map(r => Object.fromEntries(cols.map(c => [c, r[c]])));
    out.columns = meta.filter(c => cols.includes(c.name));
    return out;
  }

  const fake = {
    async connect(cs) {
      if (options.connexionEchoue) throw new Error(options.connexionEchoue);
      sqlVu.push('CONNECT ' + cs);
      return { query: async sql => query(sql), close: async () => {} };
    },
  };

  const orig = Module._load;
  Module._load = function (request) {
    if (request === 'odbc') return fake;
    return orig.apply(this, arguments);
  };

  return { sqlVu, restore: () => { Module._load = orig; } };
}

module.exports = { install };
