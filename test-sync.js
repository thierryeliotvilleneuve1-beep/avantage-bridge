const http = require('http');
const r = http.request({
  hostname: 'localhost', port: 3000,
  path: '/api/trans/sync-trans/P23020?division=06100',
  method: 'POST',
  headers: { 'x-api-key': 'CHANGE_MOI_CLE_SECRETE_LONGUE' },
  timeout: 120000
}, re => { let d=''; re.on('data',c=>d+=c); re.on('end',()=>console.log(d)); });
r.on('timeout', () => { console.log('TIMEOUT'); r.destroy(); });
r.on('error', e => console.log('ERREUR:', e.message));
r.end();
