const fs = require('fs');
let content = fs.readFileSync('./src/routes/trans-sync.js', 'utf8');
content = content
  .replace(
    "if (cmd && act && !map[cmd]) map[cmd] = act;",
    "const cmdNorm = cmd.padStart(9, '0'); if (cmdNorm && act && !map[cmdNorm]) map[cmdNorm] = act;"
  )
  .replace(
    "const numCommande = (r[kCommande] || '').toString().trim();",
    "const numCommande = (r[kCommande] || '').toString().trim().padStart(9, '0');"
  );
fs.writeFileSync('./src/routes/trans-sync.js', content, 'utf8');
console.log('OK - fix padStart applique');
