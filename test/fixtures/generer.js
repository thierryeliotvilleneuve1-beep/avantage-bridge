/**
 * Genere un jeu d'exports Avantage factices reproduisant les formats reels
 * (positions de colonnes tirees de src/lib/sources.js) pour le projet 99001.
 */
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const DIR = path.join(__dirname, 'exports');

function ligne(cols, taille) {
  const out = new Array(taille).fill('');
  Object.entries(cols).forEach(([i, v]) => { out[Number(i)] = v; });
  return out.join(',');
}

function generer() {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });

  fs.writeFileSync(path.join(DIR, 'ACTIVE.csv'),
    ['code,fr,en',
     '03000,BETON,CONCRETE',
     '16000,ELECTRICITE,ELECTRICAL',
     '06101,MAIN D OEUVRE,LABOUR'].join('\n'), 'latin1');

  fs.writeFileSync(path.join(DIR, 'CONPRE.csv'),
    ['Numero projet,Code activite,Montant previsionnel',
     '0000099001,03000,80000.00',
     '0000099001,16000,100000.00',
     '0000099001,06101,40000.00',
     '0000088888,03000,999999.00'].join('\n'), 'latin1');

  // Deux DP : seule la derniere doit etre retenue.
  fs.writeFileSync(path.join(DIR, 'CONFIT.csv'),
    ['CICONUM,CIANUM,CIDP,CIREV',
     '0000099001,03000,1,90000.00',
     '0000099001,03000,2,100000.00',
     '0000099001,16000,1,130000.00',
     '0000099001,06101,1,60000.00'].join('\n'), 'latin1');

  // [0]=projet [1]=activite [2]=pct [3]=depense a venir [4]=facture
  fs.writeFileSync(path.join(DIR, 'CONACT.csv'),
    ['Projet,Division,Pct,DepenseAvenir,Facture',
     '99001,03000,100,0.00,95000.00',
     '99001,16000,50,0.00,70000.00',
     '99001,06101,90,0.00,55000.00'].join('\n'), 'latin1');

  // [0]=projet [1]=GL [2]=date [3]=type+journal [4]=montant [5]=activite
  fs.writeFileSync(path.join(DIR, 'TRANS.csv'),
    ['Projet,GL,Date,Journal,Montant,Activite',
     '99001,33200,2026-03-01,P00123,80000.00,03000',
     '99001,33200,2026-03-15,P00124,60000.00,16000',
     '99001,52000,2026-03-20,E00050,45000.00,06101',
     '99001,11000,2026-03-31,R00900,220000.00,03000'].join('\n'), 'latin1');

  // [16]=num commande [17]=activite
  fs.writeFileSync(path.join(DIR, 'COMITE.csv'),
    [ligne({ 0: 'entete' }, 18),
     ligne({ 16: '000000001', 17: '03000' }, 18),
     ligne({ 16: '000000002', 17: '16000' }, 18),
     ligne({ 16: '000000003', 17: '' }, 18)].join('\n'), 'latin1');

  // [6]=montant total [8]/[9]=paire GL/montant [33]=projet [44]=commande
  fs.writeFileSync(path.join(DIR, 'PYBBIL.csv'),
    [ligne({ 0: 'entete' }, 49),
     ligne({ 0: '1', 6: '91977.00', 8: '33200', 9: '80000.00', 33: '99001', 44: '1' }, 49),
     ligne({ 0: '2', 6: '68982.75', 8: '33200', 9: '60000.00', 33: '99001', 44: '2' }, 49),
     ligne({ 0: '3', 6: '11497.13', 8: '33200', 9: '10000.00', 33: '88888', 44: '9' }, 49)].join('\n'), 'latin1');

  const comman = [
    { 'Numero projet': '0000099001', 'Numero sequentiel commande': '1', 'Nom du fournisseur': 'BETON XYZ', 'Sous-total': 80000, Statut: '1' },
    { 'Numero projet': '0000099001', 'Numero sequentiel commande': '2', 'Nom du fournisseur': 'ELECTRO ABC', 'Sous-total': 120000, Statut: '0' },
    { 'Numero projet': '0000099001', 'Numero sequentiel commande': '3', 'Nom du fournisseur': 'ORPHELIN', 'Sous-total': 5000, Statut: '0' },
    { 'Numero projet': '0000088888', 'Numero sequentiel commande': '9', 'Nom du fournisseur': 'AUTRE PROJET', 'Sous-total': 1000, Statut: '0' },
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(comman), 'COMMAN');
  XLSX.writeFile(wb, path.join(DIR, 'export.xlsx'));

  return DIR;
}

module.exports = { generer, DIR };
if (require.main === module) console.log('Fixtures generees dans', generer());
