// Faux Base44 en memoire: on remplace https.request pour tester le bridge
// de bout en bout sans toucher a l'application de production.
const https = require('https');
const { EventEmitter } = require('events');

function install(store, opts) {
  const options = opts || {};
  const pageSize = options.pageSize || 500;
  const calls = { GET: 0, POST: 0, PUT: 0 };
  let seq = 0;

  https.request = function (o, cb) {
    const req = new EventEmitter();
    let body = '';
    req.write = c => { body += c; };
    req.end = () => {
      const m = o.method;
      calls[m] = (calls[m] || 0) + 1;
      const url = o.path.replace(/^\/api\/apps\/[^/]+/, '');
      const [pathname, query] = url.split('?');
      const params = new URLSearchParams(query || '');
      const parts = pathname.split('/').filter(Boolean); // ['entities', 'Entite', id?]
      const entity = parts[1];
      const id = parts[2];
      store[entity] = store[entity] || [];

      let status = 200, payload = {};
      if (m === 'GET') {
        const limit = parseInt(params.get('limit'), 10) || pageSize;
        const skip = parseInt(params.get('skip'), 10) || 0;
        payload = store[entity].slice(skip, skip + Math.min(limit, pageSize));
      } else if (m === 'POST') {
        const rec = Object.assign({ _id: 'mock' + (++seq) }, JSON.parse(body || '{}'));
        store[entity].push(rec);
        payload = rec; status = 201;
      } else if (m === 'PUT') {
        const i = store[entity].findIndex(x => x._id === id);
        if (i === -1) { status = 404; payload = { error: 'not found' }; }
        else { store[entity][i] = Object.assign({}, store[entity][i], JSON.parse(body || '{}')); payload = store[entity][i]; }
      }

      const res = new EventEmitter();
      res.statusCode = status;
      process.nextTick(() => { res.emit('data', JSON.stringify(payload)); res.emit('end'); });
      cb(res);
    };
    return req;
  };

  return calls;
}

module.exports = { install };
