const fs=require('fs'),{parse}=require('csv-parse/sync'),https=require('https');
const dir='C:\\CRC\\avantage-bridge-v7\\bridge-v7\\exports-avantage';
const KEY='de56105e236d42d29d2f2c75e84fb9ad',APP='68927e133cde9f63295dd616',PID='68cebd8d2e50479c494565ea';
function api(m,p){return new Promise(r=>{const o={hostname:'app.base44.com',path:'/api/apps/'+APP+p,method:m,headers:{'api_key':KEY}};const req=https.request(o,re=>{let d='';re.on('data',c=>d+=c);re.on('end',()=>r(JSON.parse(d)))});req.on('error',e=>r({}));req.end();});}
(async()=>{
  // Source 1 : CONPRE.csv (budgets Avantage)
  const preRows=parse(fs.readFileSync(dir+'\\CONPRE.csv','latin1'),{columns:true,skip_empty_lines:true,trim:true});
  const preCols=Object.keys(preRows[0]);
  const preActCol=preCols.find(c=>c.includes('CPACT')||c.includes('activit'));
  const preMntCol=preCols.find(c=>c.includes('CPMNT')||c.includes('vision'));
  const avBudget={};
  preRows.filter(r=>(r[Object.keys(r)[1]]||'').includes('23020')).forEach(r=>{
    const a=(r[preActCol]||'').trim();
    const v=parseFloat((r[preMntCol]||'0').replace(',','.'))||0;
    if(a)avBudget[a]=(avBudget[a]||0)+v;
  });

  // Source 2 : CONACT.csv (facturé Avantage)
  const actRows=parse(fs.readFileSync(dir+'\\CONACT.csv','latin1'),{columns:true,skip_empty_lines:true,trim:true});
  const actCols=Object.keys(actRows[0]);
  const actProjCol=actCols.find(c=>c.includes('projet'));
  const actActCol=actCols.find(c=>c.includes('activit'));
  const actFactCol=actCols.find(c=>c.toLowerCase().includes('factur'));
  const avFacture={};
  actRows.filter(r=>(r[actProjCol]||'').includes('23020')).forEach(r=>{
    const a=(r[actActCol]||'').trim();
    const v=parseFloat((r[actFactCol]||'0').replace(',','.'))||0;
    if(a)avFacture[a]=(avFacture[a]||0)+v;
  });

  // Source 3 : Manoeuvre
  const cbData=await api('GET','/entities/ControleBudgetaire?limit=500');
  const divs=(Array.isArray(cbData)?cbData:(cbData.items||[])).filter(x=>x.projet_id===PID);
  const mnMap={};divs.forEach(d=>mnMap[d.code_division]=d);

  // Comparaison
  const allCodes=[...new Set([...Object.keys(avBudget),...Object.keys(avFacture),...Object.keys(mnMap)])].sort();
  console.log('\n=== RAPPORT ÉCARTS P23020 ===');
  console.log('Code | Budget AV | Budget MN | Facturé AV | Engagé MN | Statut');
  console.log('-----|-----------|-----------|------------|-----------|-------');
  let ok=0,ecarts=0,manquant=0;
  allCodes.forEach(code=>{
    const bAv=(avBudget[code]||0).toFixed(2);
    const bMn=(mnMap[code]?.montant_initial||0).toFixed(2);
    const fAv=(avFacture[code]||0).toFixed(2);
    const eMn=(mnMap[code]?.engage||0).toFixed(2);
    const statut=!mnMap[code]?'❌ MANQUANT MANOEUVRE':Math.abs(parseFloat(fAv)-parseFloat(eMn))>1?'⚠️ ÉCART ENGAGÉ':'✅ OK';
    if(statut.includes('MANQUANT'))manquant++;
    else if(statut.includes('ÉCART'))ecarts++;
    else ok++;
    console.log(code+'|'+bAv+'|'+bMn+'|'+fAv+'|'+eMn+'|'+statut);
  });
  console.log('\nRésumé: OK='+ok+' | Écarts='+ecarts+' | Manquants='+manquant);
})();
