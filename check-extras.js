const https = require('https');
const KEY = 'de56105e236d42d29d2f2c75e84fb9ad';
const APP = '68927e133cde9f63295dd616';
function api(p){return new Promise(r=>{const o={hostname:'app.base44.com',path:'/api/apps/'+APP+p,method:'GET',headers:{'api_key':KEY}};const req=https.request(o,re=>{let d='';re.on('data',c=>d+=c);re.on('end',()=>r(JSON.parse(d)))});req.end();});}
(async()=>{
  const arr = await api('/entities/ControleBudgetaire?limit=500');
  const divs = Array.isArray(arr) ? arr : (arr.items||[]);
  const p23020 = divs.filter(x=>x.projet_id==='68cebd8d2e50479c494565ea');
  const extras = p23020.filter(x => x.montant_initial === 0 && x.engage > 0);
  console.log('Divisions sans budget mais avec engagé:');
  extras.forEach(x => console.log(x.code_division, x.nom_division, x.engage));
  console.log('Total engage extras:', extras.reduce((s,x)=>s+x.engage,0).toFixed(2));
})();
