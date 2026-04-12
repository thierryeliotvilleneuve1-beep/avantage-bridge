const fs=require('fs'),{parse}=require('csv-parse/sync'),https=require('https');
const exportDir='C:\\CRC\\avantage-bridge-v7\\bridge-v7\\exports-avantage';
const KEY='de56105e236d42d29d2f2c75e84fb9ad',APP='68927e133cde9f63295dd616',PID='68cebd8d2e50479c494565ea';
function api(m,p,b){return new Promise(r=>{const o={hostname:'app.base44.com',path:'/api/apps/'+APP+p,method:m,headers:{'api_key':KEY,'Content-Type':'application/json'}};const req=https.request(o,re=>{let d='';re.on('data',c=>d+=c);re.on('end',()=>r({s:re.statusCode,d}))});req.on('error',e=>r({s:0,d:e.message}));if(b)req.write(JSON.stringify(b));req.end();});}
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
(async()=>{
  const rows=parse(fs.readFileSync(exportDir+'\\SAISIE.csv','latin1'),{columns:true,skip_empty_lines:true,trim:true});
  const cols=Object.keys(rows[0]);
  const actCol=cols.find(c=>c.includes('activit')||c.includes('Activit'));
  const tauxCol=cols.find(c=>c.includes('Taux de salaire'));
  const hRegCol=cols.find(c=>c.includes('heures r'));
  const hSupCol=cols.find(c=>c.includes('temps +'));
  const hDblCol=cols.find(c=>c.includes('temps x 2'));
  console.log('Colonnes MO:',{actCol,tauxCol,hRegCol,hSupCol,hDblCol});
  const p23=rows.filter(r=>Object.values(r).some(v=>v==='0000023020'));
  console.log('Lignes P23020:',p23.length);
  const moMap={};
  p23.forEach(r=>{
    const act=(r[actCol]||'').trim();
    const taux=parseFloat((r[tauxCol]||'0').replace(',','.'))||0;
    const hReg=parseFloat((r[hRegCol]||'0').replace(',','.'))||0;
    const hSup=parseFloat((r[hSupCol]||'0').replace(',','.'))||0;
    const hDbl=parseFloat((r[hDblCol]||'0').replace(',','.'))||0;
    const mo=taux*(hReg+hSup*1.5+hDbl*2);
    if(act&&mo>0)moMap[act]=(moMap[act]||0)+mo;
  });
  console.log('Activites avec MO:',Object.keys(moMap).length);
  Object.entries(moMap).slice(0,5).forEach(([k,v])=>console.log(' ',k,':',v.toFixed(2)+'$'));
  const cbRes=await api('GET','/entities/ControleBudgetaire?limit=500');
  const cbArr=JSON.parse(cbRes.d);const divs=(Array.isArray(cbArr)?cbArr:(cbArr.items||[])).filter(x=>x.projet_id===PID);
  let updated=0,errors=0;
  for(const div of divs){
    const mo=parseFloat((moMap[div.code_division]||0).toFixed(2));
    const engage=div.engage||0;
    const budget=div.montant_initial||0;
    const recup=parseFloat((budget-engage-mo).toFixed(2));
    let st=429;
    while(st===429){const res=await api('PUT','/entities/ControleBudgetaire/'+div.id,{...div,mo_total:mo,recup_pertes:recup});st=res.s;if(st===429)await sleep(1500);}
    if(st===200||st===201){updated++;if(mo>0)console.log('MAJ',div.code_division,div.nom_division,'MO:',mo.toFixed(2)+'$');}
    else{errors++;console.log('ERR',div.code_division,st);}
    await sleep(150);
  }
  console.log('TERMINE - mis a jour:',updated,'erreurs:',errors);
})();
