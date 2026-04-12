const fs = require('fs');
const { parse } = require('csv-parse/sync');
const https = require('https');
const exportDir = 'C:\\CRC\\avantage-bridge-v7\\bridge-v7\\exports-avantage';
const BASE44_KEY = 'de56105e236d42d29d2f2c75e84fb9ad';
const APP_ID = '68927e133cde9f63295dd616';
const PROJET_ID = '68cebd8d2e50479c494565ea';
const actMap = {};
parse(fs.readFileSync(exportDir+'\\ACTIVE.csv','latin1'),{columns:true,skip_empty_lines:true,trim:true}).forEach(r=>{actMap[r.ANUM]=r.ANOM||r.ANAM||r.ANUM;});
const phases = parse(fs.readFileSync(exportDir+'\\CONPRE.csv','latin1'),{columns:true,skip_empty_lines:true,trim:true}).filter(r=>((r['Num\u00e9ro du projet']||r.CPCONUM||'')||'').includes('23020'));
const actFact = {};
parse(fs.readFileSync(exportDir+'\\CONACT.csv','latin1'),{columns:true,skip_empty_lines:true,trim:true}).filter(r=>(r.CACONUM||'').includes('23020')).forEach(r=>{const a=(r.CAANUM||'').trim();actFact[a]=(actFact[a]||0)+(parseFloat(((r['Achat factur\u00e9 \(T\/F\)']||r.CAFACT||'0')||'0').replace(',','.'))||0);});
console.log('Phases:',phases.length);
function api(m,p,b){return new Promise(r=>{const o={hostname:'app.base44.com',path:'/api/apps/'+APP_ID+p,method:m,headers:{'api_key':BASE44_KEY,'Content-Type':'application/json'}};const req=https.request(o,re=>{let d='';re.on('data',c=>d+=c);re.on('end',()=>r({s:re.statusCode,d}))});req.on('error',e=>r({s:0,d:e.message}));if(b)req.write(JSON.stringify(b));req.end();});}
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
(async()=>{
  const cb=await api('GET','/entities/ControleBudgetaire?limit=500');
  const existing=JSON.parse(cb.d);const exArr=Array.isArray(existing)?existing:(existing.items||[]);
  const exMap={};exArr.filter(x=>x.projet_id===PROJET_ID).forEach(x=>{exMap[x.code_division]=x.id||x._id;});
  let created=0,updated=0,errors=0;
  for(const ph of phases){
    const code_act=(ph.CPACT||'').trim();
    const nom=actMap[code_act]||code_act;
    const budget=parseFloat((ph.CPMNT||'0').replace(',','.'))||0;
    const engage=actFact[code_act]||0;
    const div={projet_id:PROJET_ID,code_division:code_act,nom_division:nom,montant_initial:budget,montant_revise:0,engage:engage,mo_total:0,prevision_total:budget,recup_pertes:+(engage-budget).toFixed(2),pourcentage:budget>0?+(engage/budget*100).toFixed(2):0,directives_travaux:0,travaux_crc:0,credit_admin:0,asse_caut:0,decompte_crc:0};
    const existId=exMap[code_act];
    let st=429;
    while(st===429){const r=existId?await api('PUT','/entities/ControleBudgetaire/'+existId,div):await api('POST','/entities/ControleBudgetaire',div);st=r.s;if(st===429)await sleep(1500);}
    if(st===200||st===201){existId?updated++:created++;}else errors++;
    console.log(code_act,nom,'->',st);
    await sleep(150);
  }
  console.log('TERMINE - crees:',created,'mis a jour:',updated,'erreurs:',errors);
})();



