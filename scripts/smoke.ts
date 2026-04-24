#!/usr/bin/env tsx
/**
 * Smoke-test harness for @sura_ai/chemotion-mcp.
 *
 * Phase 1: exercises config parse + auth bootstrap + session probe.
 * Phase 2 will extend this to list collections and dump a sample.
 *
 * Usage (credentials mode):
 *   CHEMOTION_BASE_URL=https://eln.example.org \
 *   CHEMOTION_USERNAME=you@example.org \
 *   CHEMOTION_PASSWORD='...' \
 *   bun run smoke
 *
 * Usage (cookie mode):
 *   CHEMOTION_BASE_URL=https://eln.example.org \
 *   CHEMOTION_SESSION_COOKIE='_chemotion_session=...; CSRF-TOKEN=...' \
 *   bun run smoke
 */

import { ChemotionClient } from '../src/client/index.js';
import { loadConfig } from '../src/mcp/config.js';

async function main(): Promise<void> {
  const config = loadConfig();
  process.stdout.write(`• instance: ${config.baseUrl}\n`);
  process.stdout.write(
    `• auth mode: ${config.auth.mode}\n` +
      (config.auth.mode === 'credentials'
        ? `• username: ${config.auth.username}\n`
        : '• cookie length: ' + config.auth.rawCookie.length + ' chars\n')
  );

  const client = new ChemotionClient({
    baseUrl: config.baseUrl,
    userAgent: config.userAgent,
    timeoutMs: config.timeoutMs,
  });

  if (config.auth.mode === 'credentials') {
    process.stdout.write('• logging in via POST /users/sign_in …\n');
    await client.loginWithCredentials({
      username: config.auth.username,
      password: config.auth.password,
    });
    process.stdout.write('  ✓ session cookie received\n');
  } else {
    process.stdout.write('• adopting supplied cookie …\n');
    client.adoptCookie(config.auth.rawCookie);
  }

  process.stdout.write('• probing /api/v1/users/current …\n');
  const alive = await client.isSessionAlive();
  if (!alive) {
    process.stderr.write('  ✗ session probe returned 401\n');
    process.exit(1);
  }
  process.stdout.write('  ✓ session is alive\n');

  process.stdout.write('• GET /api/v1/users/current →\n');
  const me = await client.me();
  process.stdout.write(`${JSON.stringify(me, null, 2)}\n`);

  process.stdout.write('\n• GET /api/v1/collections →\n');
  const collections = await client.listCollections();
  const roots = collections.collections ?? collections.roots ?? [];
  process.stdout.write(`  ${roots.length} root collection(s)\n`);
  for (const c of roots.slice(0, 5)) {
    process.stdout.write(
      `  - #${c.id} "${c.label}"${c.is_shared ? ' (shared)' : ''}${
        c.children?.length ? ` (${c.children.length} children)` : ''
      }\n`
    );
  }

  // If there's at least one collection with samples, probe one.
  const firstRoot = roots[0];
  if (firstRoot) {
    process.stdout.write(
      `\n• GET /api/v1/samples?collection_id=${firstRoot.id}&per_page=3 →\n`
    );
    const samples = await client.listSamples({
      collection_id: firstRoot.id,
      per_page: 3,
    });
    const rows = samples.samples ?? [];
    process.stdout.write(`  ${rows.length} sample(s)\n`);
    for (const s of rows) {
      process.stdout.write(
        `  - #${s.id} "${s.name ?? s.short_label ?? '(unnamed)'}"${
          s.molecule?.sum_formula ? ` ${s.molecule.sum_formula}` : ''
        }\n`
      );
    }

    if (rows[0]) {
      process.stdout.write(`\n• GET /api/v1/samples/${rows[0].id} →\n`);
      const single = await client.getSample(rows[0].id);
      const s = single.sample;
      process.stdout.write(
        [
          `  id=${s.id}`,
          `name="${s.name ?? ''}"`,
          `short_label="${s.short_label ?? ''}"`,
          `smiles=${s.molecule?.cano_smiles ?? s.canonical_smiles ?? '—'}`,
          `mw=${s.molecule?.molecular_weight ?? s.molecular_weight ?? '—'}`,
          `molfile_present=${
            (s.molecule?.molfile ?? s.molfile)?.length ? 'yes' : 'no'
          }`,
        ].join(' | ') + '\n'
      );
    }
  }

  process.stdout.write('\nphase 2 smoke OK.\n');
}

main().catch((error) => {
  process.stderr.write(
    `smoke test failed: ${error instanceof Error ? error.message : String(error)}\n`
  );
  if (error instanceof Error && error.stack) {
    process.stderr.write(`${error.stack}\n`);
  }
  process.exit(1);
});
