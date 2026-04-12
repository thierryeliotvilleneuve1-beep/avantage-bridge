const https = require('https');
const KEY = 'de56105e236d42d29d2f2c75e84fb9ad';
const APP = '68927e133cde9f63295dd616';
const PROJET_ID = process.argv[2];
if (!PROJET_ID) { console.error('Usage: node purge-budget.js <projet_id_base44>'); process.exit(1); }
function api(m,p){return new Promise(r=>{const o={hostname:'app.base44.com',path:'/api/apps/'+APP+p,method:m,headers:{'api_key':KEY}};const req=https.request(o,re=>{let d='';re.on('data',c=>d+=c);re.on('end',()=>r({s:re.statusCode,d}))});req.end();});}
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
(async()=>{
  let total=0;
  while(true){
    const e=await api('GET','/entities/ControleBudgetaire?limit=500');
    const arr=JSON.parse(e.d);const a=Array.isArray(arr)?arr:(arr.items||[]);
    const del=a.filter(x=>x.projet_id===PROJET_ID);
    if(!del.length){console.log('DONE - supprimé:',total);break;}
    await Promise.all(del.map(x=>api('DELETE','/entities/ControleBudgetaire/'+(x._id||x.id))));
    total+=del.length;console.log('Supprimé:',total);
    await sleep(500);
  }
})();
