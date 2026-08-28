'use strict';

/**
 * Connexion à la base.
 *
 * Deux modes, une seule interface :
 *   DATABASE_URL absent  → PGlite, un vrai PostgreSQL embarqué dans le process.
 *                          Sert la démonstration et les tests : aucune
 *                          installation, aucun hébergement à décider.
 *   DATABASE_URL présent → node-postgres vers la vraie base.
 *
 * Le code métier ne sait pas lequel des deux il utilise. Passer de la
 * démonstration à la production est un changement de variable
 * d'environnement, pas une réécriture.
 */

const fs = require('fs');
const path = require('path');

const MIGRATIONS = path.join(__dirname, '..', 'db', 'migrations');

async function ouvrir({ migrer = true } = {}) {
  const url = process.env.DATABASE_URL;

  if (url) {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: url });
    const db = {
      mode: 'postgres',
      query: (t, p) => pool.query(t, p),
      exec: (t) => pool.query(t),
      transaction: async (fn) => {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          const r = await fn(c);
          await c.query('COMMIT');
          return r;
        } catch (e) {
          await c.query('ROLLBACK');
          throw e;
        } finally {
          c.release();
        }
      },
      fermer: () => pool.end(),
    };
    if (migrer) await appliquerMigrations(db);
    return db;
  }

  const { PGlite } = require('@electric-sql/pglite');
  const pg = new PGlite();
  const db = {
    mode: 'pglite',
    query: (t, p) => pg.query(t, p),
    exec: (t) => pg.exec(t),
    transaction: (fn) => pg.transaction(fn),
    fermer: () => pg.close(),
  };
  if (migrer) await appliquerMigrations(db);
  return db;
}

/**
 * Applique les migrations qui manquent, dans l'ordre, une fois chacune.
 * Le suivi est dans la base elle-même : rejouer est sans effet.
 */
async function appliquerMigrations(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS migration_appliquee (
      fichier    text PRIMARY KEY,
      applique_le timestamptz NOT NULL DEFAULT now()
    )`);

  const deja = new Set(
    (await db.query('SELECT fichier FROM migration_appliquee')).rows.map((r) => r.fichier)
  );

  for (const f of fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    if (deja.has(f)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS, f), 'utf8');
    await db.exec(sql);
    await db.query('INSERT INTO migration_appliquee (fichier) VALUES ($1)', [f]);
    console.log(`[migration] ${f}`);
  }
}

module.exports = { ouvrir, appliquerMigrations };
