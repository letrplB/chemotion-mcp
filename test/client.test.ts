/**
 * Offline regression tests for the Chemotion client. A stub `fetch`
 * answers per route, so no live instance is needed. Wire shapes
 * mirror ComPlat/chemotion_ELN v4.0.0 and v3.1.x.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ChemotionAuthError, ChemotionClient } from '../src/client/index.js';
import { loadConfig } from '../src/mcp/config.js';

interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: unknown;
}

type Route = (call: Call) => Response | undefined;

const BASE = 'https://eln.example.org';

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** Build a client whose fetch is answered by `routes`, in order. */
function stub(routes: Route[]): { client: ChemotionClient; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>)
    );
    const raw = init?.body;
    const call: Call = {
      method: init?.method ?? 'GET',
      path: url.pathname.replace(/^\/api\/v1/, ''),
      query: url.searchParams,
      headers,
      body: typeof raw === 'string' ? JSON.parse(raw) : raw,
    };
    calls.push(call);
    for (const route of routes) {
      const response = route(call);
      if (response) return response;
    }
    return json({ error: 'Not Found' }, 404);
  }) as typeof fetch;
  return { client: new ChemotionClient({ baseUrl: BASE, fetchImpl }), calls };
}

const on =
  (method: string, path: string, respond: (call: Call) => Response): Route =>
  (call) =>
    call.method === method && call.path === path ? respond(call) : undefined;

const currentUser = on('GET', '/users/current', (call) =>
  call.headers.Authorization === 'Bearer jwt-1' ||
  call.headers.Authorization === 'Bearer chemtoken_abc'
    ? json({ user: { id: 6 } })
    : json({ error: '401 Unauthorized' }, 401)
);

describe('authentication', () => {
  it('mints a JWT on v4 and sends it as a bearer token', async () => {
    const { client, calls } = stub([
      on('POST', '/authentication/token', () => json({ token: 'jwt-1' }, 201)),
      currentUser,
    ]);
    await client.loginWithCredentials({ username: 'ABC', password: 'pw' });
    assert.deepEqual(calls[0]?.body, { username: 'ABC', password: 'pw' });
    assert.equal(calls.at(-1)?.headers.Authorization, 'Bearer jwt-1');
    assert.ok(!calls.some((c) => c.path.includes('sign_in')));
  });

  it('falls back to /public/token on pre-v4 instances', async () => {
    const { client, calls } = stub([
      on('POST', '/public/token', () => json({ token: 'jwt-1' }, 201)),
      currentUser,
    ]);
    await client.loginWithCredentials({ username: 'ABC', password: 'pw' });
    assert.deepEqual(
      calls.map((c) => `${c.method} ${c.path}`),
      ['POST /authentication/token', 'POST /public/token', 'GET /users/current']
    );
  });

  it('reports rejected credentials without trying other paths', async () => {
    const { client, calls } = stub([
      on('POST', '/authentication/token', () => json({ error: '401 Unauthorized' }, 401)),
    ]);
    await assert.rejects(
      client.loginWithCredentials({ username: 'ABC', password: 'bad' }),
      ChemotionAuthError
    );
    assert.equal(calls.length, 1);
  });

  it('sends an adopted API token', async () => {
    const { client } = stub([currentUser]);
    client.adoptApiToken('Bearer chemtoken_abc');
    assert.equal(await client.isSessionAlive(), true);
  });
});

describe('collections', () => {
  it('reads the v4 flat list and resolves "All" from it', async () => {
    const { client, calls } = stub([
      on('GET', '/collections', () =>
        json({
          own: [
            { id: 10, label: 'All', is_locked: true, ancestry: null },
            { id: 13, label: 'Project', is_locked: false, ancestry: null },
            { id: 14, label: 'Sub', is_locked: false, ancestry: '13' },
          ],
          shared_with_me: [{ id: 40, label: 'From Bob', ancestry: null }],
        })
      ),
      on('GET', '/samples', () => json({ samples: [] })),
    ]);
    const list = await client.listCollections();
    assert.deepEqual(
      list.collections?.map((c) => c.id),
      [13, 14, 40, 10]
    );
    assert.equal(list.shared_roots?.[0]?.is_shared, true);
    await client.listSamples({ collection_id: 'all' });
    assert.equal(calls.at(-1)?.query.get('collection_id'), '10');
  });

  it('falls back to the legacy banks when GET /collections 405s', async () => {
    const { client } = stub([
      on('GET', '/collections', () => json({ error: '405 Not Allowed' }, 405)),
      on('GET', '/collections/roots', () =>
        json({ collections: [{ id: 13, label: 'Project' }] })
      ),
      on('GET', '/collections/locked', () =>
        json({ collections: [{ id: 10, label: 'All', is_locked: true }] })
      ),
    ]);
    assert.equal(await client.resolveAllCollectionId(), 10);
  });

  it('does not hide auth failures behind an empty list', async () => {
    const { client } = stub([
      on('GET', '/collections', () => json({ error: '405' }, 405)),
      on('GET', '/collections/roots', () => json({ error: '401 Unauthorized' }, 401)),
    ]);
    await assert.rejects(client.listCollections(), /401/);
  });
});

describe('lists', () => {
  it('converts date bounds to Unix seconds and reads pagination headers', async () => {
    const { client, calls } = stub([
      on('GET', '/samples', () =>
        json({ samples: [{ id: 1 }] }, 200, {
          'X-Total': '42',
          'X-Total-Pages': '2',
          'X-Page': '1',
          'X-Per-Page': '25',
        })
      ),
    ]);
    const response = await client.listSamples({
      collection_id: 13,
      from_date: '2026-01-31',
      filter_created_at: true,
    });
    assert.equal(calls[0]?.query.get('from_date'), String(Date.UTC(2026, 0, 31) / 1000));
    assert.deepEqual(response.pagination, {
      page: 1,
      per_page: 25,
      total_count: 42,
      total_pages: 2,
    });
  });
});

describe('updates preserve server state', () => {
  it('sends current wells back when a wellplate update omits them', async () => {
    const wells = [
      { id: 1, position: { x: 1, y: 1 }, sample: { id: 501 }, readouts: [] },
      { id: 2, position: { x: 2, y: 1 }, sample: null, readouts: [] },
    ];
    const container = { id: 77, container_type: 'root', children: [] };
    const { client, calls } = stub([
      on('GET', '/wellplates/5', () => json({ wellplate: { id: 5, wells, container } })),
      on('PUT', '/wellplates/5', (call) => json({ wellplate: call.body })),
    ]);
    await client.updateWellplate(5, { name: 'renamed' });
    const put = calls.find((c) => c.method === 'PUT')?.body as Record<string, unknown>;
    assert.deepEqual(put.wells, wells);
    assert.deepEqual(put.container, container);
    assert.equal(put.name, 'renamed');
  });

  it('sends full participant rows back when a reaction update omits materials', async () => {
    const solventRow = {
      id: 900,
      short_label: 'solvent',
      solvent: [{ label: 'THF', ratio: 1 }],
      metrics: 'mmm',
      dry_solvent: true,
      gas_type: 'off',
      molecule: { id: 3 },
    };
    const sbmm = [{ id: 31, name: 'enzyme' }];
    const { client, calls } = stub([
      on('GET', '/reactions/7', () =>
        json({
          reaction: {
            id: 7,
            starting_materials: [],
            reactants: [],
            products: [],
            solvents: [solventRow],
            purification_solvents: [],
            reactant_sbmm_samples: sbmm,
            container: { id: 70, children: [] },
          },
        })
      ),
      on('PUT', '/reactions/7', () => json({ reaction: { id: 7 } })),
    ]);
    await client.updateReaction(7, { name: 'renamed' });
    const put = calls.find((c) => c.method === 'PUT')?.body as {
      materials: Record<string, unknown[]>;
    };
    assert.deepEqual(put.materials.solvents, [solventRow]);
    assert.deepEqual(put.materials.reactant_sbmm_samples, sbmm);
  });

  it('fills screen id arrays from the current screen', async () => {
    const { client, calls } = stub([
      on('GET', '/screens/9', () =>
        json({
          screen: { id: 9, wellplates: [{ id: 4 }], research_plans: [{ id: 2 }] },
        })
      ),
      on('PUT', '/screens/9', () => json({ screen: { id: 9 } })),
    ]);
    await client.updateScreen(9, { result: 'done' });
    const put = calls.find((c) => c.method === 'PUT')?.body as Record<string, unknown>;
    assert.deepEqual(put.wellplate_ids, [4]);
    assert.deepEqual(put.research_plan_ids, [2]);
  });
});

describe('config', () => {
  const withEnv = (env: Record<string, string>, fn: () => void): void => {
    const keys = [
      'CHEMOTION_BASE_URL',
      'CHEMOTION_USERNAME',
      'CHEMOTION_PASSWORD',
      'CHEMOTION_API_TOKEN',
      'CHEMOTION_SESSION_COOKIE',
    ];
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    for (const k of keys) delete process.env[k];
    Object.assign(process.env, env);
    try {
      fn();
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  };

  it('accepts token mode', () => {
    withEnv({ CHEMOTION_BASE_URL: BASE, CHEMOTION_API_TOKEN: 'chemtoken_abc' }, () => {
      assert.deepEqual(loadConfig().auth, { mode: 'token', token: 'chemtoken_abc' });
    });
  });

  it('rejects more than one auth mode', () => {
    withEnv(
      {
        CHEMOTION_BASE_URL: BASE,
        CHEMOTION_API_TOKEN: 'chemtoken_abc',
        CHEMOTION_SESSION_COOKIE: '_chemotion_session=x',
      },
      () => assert.throws(loadConfig, /Several auth modes/)
    );
  });
});
