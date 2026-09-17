// CLI: node discover-db.js [--echantillon]
// A lancer sur le poste qui voit Avantage. Produit avantage-db-rapport.json,
// qui sert a figer le mapping des colonnes dans src/sources/schema.js.
require('dotenv').config();
const fs = require('fs');
const path = require('path');

(async () => {
  const echantillon = process.argv.includes('--echantillon');
  try {
    const { inspecter } = require('./src/services/dbInspect');
    console.log('Connexion a la BD Avantage...');
    const rapport = await inspecter({ echantillon });
    const sortie = path.resolve(__dirname, 'avantage-db-rapport.json');
    fs.writeFileSync(sortie, JSON.stringify(rapport, null, 2));
    console.log('\nConnexion :', rapport.connexion);
    rapport.resume.forEach(l => console.log('  ' + l));
    console.log('\nRapport complet : ' + sortie);
    if (!rapport.ok) {
      console.log('\nCertaines tables ou colonnes ne sont pas resolues.');
      console.log('Envoyer avantage-db-rapport.json pour figer le mapping.');
    }
    process.exit(rapport.ok ? 0 : 2);
  } catch (e) {
    console.error('\nECHEC : ' + e.message);
    console.error("\nVerifier ODBC_DSN / ODBC_CONNECTION_STRING dans .env, et que le module 'odbc' est installe (npm install odbc).");
    process.exit(1);
  }
})();
