import path from 'node:path';
import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config';

// Async factory rather than top-level await: this package is CommonJS, so the config is
// bundled as CJS and top-level await is not available there.
export default defineWorkersConfig(async () => {
  // Read the real migration files so tests run against the schema that ships, rather
  // than a hand-maintained copy that can drift from it. readD1Migrations handles
  // statement splitting correctly, which naive splitting on ";" does not.
  const migrations = await readD1Migrations(path.join(__dirname, 'migrations'));

  return {
    test: {
      setupFiles: ['./test/apply-migrations.ts'],
      poolOptions: {
        workers: {
          singleWorker: true,
          miniflare: {
            compatibilityDate: '2024-09-23',
            compatibilityFlags: ['nodejs_compat'],
            d1Databases: ['DB'],
            bindings: {
              TEST_MIGRATIONS: migrations,
              JWT_SECRET: 'test-secret-not-used-anywhere-real',
              FALLBACK_NOTIFICATION_EMAIL: 'cfo@example.edu',
              FROM_NAME: 'Test Sender',
              FROM_EMAIL: 'noreply@example.test',
              APP_BASE_URL: 'https://portal.example.test',
              // RESEND_API_KEY is deliberately unset, so sends are recorded in
              // email_log as "skipped" instead of reaching the network.
            },
          },
        },
      },
    },
  };
});
