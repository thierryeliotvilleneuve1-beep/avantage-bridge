const { parse } = require('csv-parse/sync');
function parseActive(csvContent) {
  const map = {};
  try {
    const records = parse(csvContent, { columns: false, skip_empty_lines: true, trim: true, from_line: 2 });
    // Colonnes ACTIVE: [0]=numéro activité [1]=description français [2]=description anglais ...
    records.forEach(r => {
      const code = (r[0] || '').trim().replace(/\.00$/, '');
      const nom  = (r[1] || code).trim();
      if (code) map[code] = nom;
    });
  } catch (e) {}
  return map;
}
module.exports = { parseActive };
