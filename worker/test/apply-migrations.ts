import { applyD1Migrations, env } from 'cloudflare:test';

declare module 'cloudflare:test' {
  interface ProvidedEnv {
    TEST_MIGRATIONS: D1Migration[];
  }
}

/**
 * Drop line comments before handing the SQL to D1.
 *
 * Several migrations close with explanatory comments after their final statement.
 * applyD1Migrations splits on ";" and the trailing comment block then arrives as an
 * empty statement, which D1 rejects with "SQL code did not contain a statement".
 * None of these files contain a "--" sequence inside a string literal.
 */
const stripComments = (sql: string) =>
  sql
    .split('\n')
    .map(line => {
      const marker = line.indexOf('--');
      return marker === -1 ? line : line.slice(0, marker);
    })
    .join('\n');

const migrations = env.TEST_MIGRATIONS
  .map(m => ({ ...m, queries: (m.queries ?? []).map(stripComments).filter(q => q.trim()) }))
  .filter(m => m.queries.length > 0);

// Bring the test database up to the current schema once per worker.
await applyD1Migrations(env.DB, migrations);
