const fs = require('fs');

// Lire index.js actuel
const indexPath = './src/index.js';
let content = fs.readFileSync(indexPath, 'utf8');

// Vérifier si les routes sont déjà ajoutées
if (content.includes('bc-sync') || content.includes('trans-sync')) {
  console.log('Routes déjà présentes dans index.js');
  process.exit(0);
}

// Ajouter les requires après le require budget
const budgetRequire = "require('./routes/budget')";
const newRequires = `require('./routes/budget')
const bcSyncRouter = require('./routes/bc-sync');
const transSyncRouter = require('./routes/trans-sync');`;
content = content.replace(budgetRequire, newRequires);

// Ajouter les app.use après app.use budget
const budgetUse = "app.use('/api/budget', budgetRouter);" ;

// Chercher le pattern d'utilisation des routes
if (content.includes("app.use('/api/budget'")) {
  content = content.replace(
    "app.use('/api/budget'",
    "app.use('/api/bc', bcSyncRouter);\napp.use('/api/trans', transSyncRouter);\napp.use('/api/budget'"
  );
} else {
  // Ajouter avant module.exports ou à la fin
  content = content.replace(
    'module.exports',
    "app.use('/api/bc', bcSyncRouter);\napp.use('/api/trans', transSyncRouter);\nmodule.exports"
  );
}

fs.writeFileSync(indexPath, content, 'utf8');
console.log('OK - routes bc-sync et trans-sync ajoutées dans index.js');
console.log('Vérification:');
console.log(content.split('\n').filter(l => l.includes('bc') || l.includes('trans-sync') || l.includes('budget')).join('\n'));
