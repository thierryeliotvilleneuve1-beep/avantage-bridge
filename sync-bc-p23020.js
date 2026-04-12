const fs=require('fs'),{parse}=require('csv-parse/sync'),https=require('https');
const exportDir='C:\\CRC\\avantage-bridge-v7\\bridge-v7\\exports-avantage';
const KEY='de56105e236d42d29d2f2c75e84fb9ad',APP='68927e133cde9f63295dd616',PID='68cebd8d2e50479c494565ea';
function api(m,p,b){return new Promise(r=>{const o={hostname:'app.base44.com',path:'/api/apps/'+APP+p,method:m,headers:{'api_key':KEY,'Content-Type':'application/json'}};const req=https.request(o,re=>{let d='';re.on('data',c=>d+=c);re.on('end',()=>r({s:re.statusCode,d}))});req.on('error',e=>r({s:0,d:e.message}));if(b)req.write(JSON.stringify(b));req.end();});}
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
(async()=>{
  const cbRes=await api('GET','/entities/ControleBudgetaire?limit=500');
  const cbArr=JSON.parse(cbRes.d);const divArr=Array.isArray(cbArr)?cbArr:(cbArr.items||[]);
  const divMap={};divArr.filter(x=>x.projet_id===PID).forEach(x=>{divMap[x.code_division]=x.id||x._id;});
  console.log('Divisions:',Object.keys(divMap).length);
  const bcRes=await api('GET','/entities/BonDeCommande?limit=500');
  const bcArr=JSON.parse(bcRes.d);const bcEx=Array.isArray(bcArr)?bcArr:(bcArr.items||[]);
  const bcMap={};bcEx.filter(x=>x.projet_id===PID).forEach(x=>{bcMap[x.numero_po]=x.id||x._id;});
  const achats=parse(fs.readFileSync(exportDir+'\\ACHAT.csv','latin1'),{columns:true,skip_empty_lines:true,trim:true});
  const cols=Object.keys(achats[0]||{});console.log('Colonnes ACHAT:',cols.slice(0,6).join('|'));
  const projCol=cols.find(c=>c.toLowerCase().includes('projet'));
  const fournCol=cols.find(c=>c.toLowerCase().includes('fournisseur'));
  const cmdCol=cols.find(c=>c.toLowerCase().includes('commande'));
  const dateCol=cols.find(c=>c.toLowerCase().includes('ception'));
  const montantCol=cols.find(c=>c.toLowerCase().includes('sous-total')||c.toLowerCase().includes('sous total'));
  const actCol=cols.find(c=>c.toLowerCase().includes('activit'));
  console.log('Colonnes mappées:',{projCol,fournCol,cmdCol,montantCol,actCol});
  const p23020=achats.filter(r=>(r[projCol]||'').includes('23020'));
  console.log('Achats P23020:',p23020.length);
  let created=0,updated=0,errors=0;
  for(const a of p23020){
    const fourn=(a[fournCol]||'').trim();
    const cmd=(a[cmdCol]||'').trim();
    const date=(a[dateCol]||'').trim();
    const montant=parseFloat((a[montantCol]||'0').replace(',','.').replace(/\s/g,''))||0;
    const codeAct=(a[actCol]||'').trim();
    const key=cmd+'-'+fourn;
    const cbId=divMap[codeAct]||null;
    const bc={projet_id:PID,numero_po:key,description:fourn+(codeAct?' — '+codeAct:''),montant_prevu:montant,statut:'approuve',type_bon_commande:'fournisseur',type_fournisseur:'sous_traitant',date_commande:date||null,bc_valide:true,controle_budgetaire_id:cbId};
    const existId=bcMap[key];
    let st=429;
    while(st===429){const res=existId?await api('PUT','/entities/BonDeCommande/'+existId,bc):await api('POST','/entities/BonDeCommande',bc);st=res.s;if(st===429)await sleep(1500);}
    if(st===200||st===201){existId?updated++:created++;console.log(existId?'MAJ':'NEW',fourn,codeAct,montant+'$',st);}
    else{errors++;console.log('ERR',fourn,st);}
    await sleep(150);
  }
  console.log('TERMINE — créés:',created,'mis à jour:',updated,'erreurs:',errors);
})();
