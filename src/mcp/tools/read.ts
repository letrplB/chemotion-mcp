/**
 * MCP read tools for Chemotion ELN.
 *
 * One tool per read action we want to surface. Handlers are thin:
 *   1. Call a `ChemotionClient` method.
 *   2. Unwrap the single-entity envelope Chemotion returns
 *      (`{ sample: {...} }` → `sample`).
 *   3. Render through a chemistry-aware formatter or a compact list
 *      summary.
 *   4. Catch errors via `guard` so the MCP stays connected.
 *
 * Tool descriptions are what the model sees at discovery time —
 * they name the use-case, spell out args, and flag the important
 * defaults (pagination, collection scoping, body format).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ChemotionMcpConfig } from '../config.js';
import {
  type ChemotionClient,
  type ChemotionElementType,
  type ContainerPayload,
  type FormatOptions,
  type Reaction,
  type ReactionSampleRef,
  type ResearchPlan,
  type ResearchPlanBlock,
  type Sample,
  type Screen,
  type Well,
  type Wellplate,
  EMPTY_ROOT_CONTAINER,
  ELEMENT_TYPE_PLURAL,
  formatCollection,
  formatContainerTree,
  formatReaction,
  formatResearchPlan,
  formatSample,
  formatScreen,
  formatWellplate,
} from '../../client/index.js';
import {
  collectionIdSchema,
  elementKindSchema,
  errorText,
  guard,
  paginationArgsSchema,
  positiveInt,
  text,
} from './helpers.js';

// ---------------------------------------------------------------------
// List-formatting helpers
// ---------------------------------------------------------------------

interface ListSummary {
  id: number;
  label: string;
  extras?: Array<[string, string]>;
}

function renderSummaryList(
  title: string,
  rows: ListSummary[],
  pagination?: { page?: number; per_page?: number; total_count?: number; total_pages?: number }
): string {
  if (rows.length === 0) return `No ${title}.`;
  const lines = rows.map((r) => {
    const extras =
      r.extras && r.extras.length
        ? ' · ' + r.extras.map(([k, v]) => `${k}: ${v}`).join(' · ')
        : '';
    return `- #${r.id} ${r.label}${extras}`;
  });
  let header = `${rows.length} ${title}`;
  if (pagination) {
    const { page, per_page, total_count, total_pages } = pagination;
    const bits = [
      page != null ? `page ${page}${total_pages ? `/${total_pages}` : ''}` : null,
      total_count != null ? `total ${total_count}` : null,
      per_page != null ? `per_page ${per_page}` : null,
    ].filter(Boolean);
    if (bits.length) header += ` (${bits.join(', ')})`;
  }
  return `${header}:\n${lines.join('\n')}`;
}

/**
 * Fetch one element of `kind` by `id` and unwrap Chemotion's single-
 * entity envelope. Both `chem_get` and `chem_get_bulk` share this
 * path so there is one canonical "fetch + unwrap" implementation.
 */
async function fetchEntity(
  client: ChemotionClient,
  kind: ChemotionElementType,
  id: number
): Promise<Sample | Reaction | ResearchPlan | Wellplate | Screen> {
  switch (kind) {
    case 'sample':
      return (await client.getSample(id)).sample;
    case 'reaction':
      return (await client.getReaction(id)).reaction;
    case 'research_plan':
      return (await client.getResearchPlan(id)).research_plan;
    case 'wellplate':
      return (await client.getWellplate(id)).wellplate;
    case 'screen':
      return (await client.getScreen(id)).screen;
  }
}

function formatEntity(
  kind: ChemotionElementType,
  entity: Sample | Reaction | ResearchPlan | Wellplate | Screen,
  opts: FormatOptions
): string {
  switch (kind) {
    case 'sample':
      return formatSample(entity as Sample, opts);
    case 'reaction':
      return formatReaction(entity as Reaction, opts);
    case 'research_plan':
      return formatResearchPlan(entity as ResearchPlan, opts);
    case 'wellplate':
      return formatWellplate(entity as Wellplate, opts);
    case 'screen':
      return formatScreen(entity as Screen, opts);
  }
}

interface UpdatePrep {
  toolName: string;
  required: string[];
  notes: string[];
  payload: Record<string, unknown>;
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function compactRecord(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => {
      if (value === undefined || value === null) return false;
      if (typeof value === 'string' && value.length === 0) return false;
      return true;
    })
  );
}

function normalizeContainer(
  container: unknown
): { payload: ContainerPayload; usedFallback: boolean } {
  if (container && typeof container === 'object') {
    return {
      payload: jsonClone(container as ContainerPayload),
      usedFallback: false,
    };
  }
  return {
    payload: jsonClone(EMPTY_ROOT_CONTAINER),
    usedFallback: true,
  };
}

/**
 * Participant row for the `chem_get_update_payload` starter. Carries
 * every field Chemotion writes back onto an existing participant on
 * PUT (anything missing is saved as nil) but leaves out the bulky
 * `container` / `molecule`, which the server does not need.
 */
function reactionMaterialRefPayload(
  ref: ReactionSampleRef
): Record<string, unknown> {
  return compactRecord({
    id: ref.id,
    name: ref.name,
    short_label: ref.short_label,
    external_label: ref.external_label,
    show_label: ref.show_label,
    metrics: ref.metrics,
    solvent: ref.solvent,
    dry_solvent: ref.dry_solvent,
    residues: ref.residues,
    gas_type: ref.gas_type,
    gas_phase_data: ref.gas_phase_data,
    conversion_rate: ref.conversion_rate,
    weight_percentage: ref.weight_percentage,
    weight_percentage_reference: ref.weight_percentage_reference,
    reference: ref.reference,
    equivalent: ref.equivalent,
    equivalents: ref.equivalents,
    coefficient: ref.coefficient,
    position: ref.position,
    amount_value: ref.amount_value,
    amount_unit: ref.amount_unit,
    real_amount_value: ref.real_amount_value,
    real_amount_unit: ref.real_amount_unit,
    target_amount_value: ref.target_amount_value,
    target_amount_unit: ref.target_amount_unit,
    molarity_value: ref.molarity_value,
    molarity_unit: ref.molarity_unit,
    density: ref.density,
    yield: ref.yield,
    waste: ref.waste,
  });
}

function summarizeResearchPlanField(
  block: ResearchPlanBlock,
  index: number
): ListSummary {
  const extras: Array<[string, string]> = [
    ['index', String(index)],
    ['type', block.type ?? 'unknown'],
  ];
  if (block.id) extras.push(['field_id', block.id]);
  if (block.title) extras.push(['title', block.title]);

  switch (block.type) {
    case 'richtext':
    case 'text': {
      const rendered =
        typeof block.value === 'string'
          ? block.value
          : block.value &&
              typeof block.value === 'object' &&
              Array.isArray((block.value as { ops?: unknown[] }).ops)
            ? JSON.stringify(block.value)
            : '';
      if (rendered) extras.push(['chars', String(rendered.length)]);
      break;
    }
    case 'table': {
      const value = block.value as
        | {
            columns?: Array<unknown>;
            rows?: Array<unknown>;
          }
        | null
        | undefined;
      extras.push(['cols', String(value?.columns?.length ?? 0)]);
      extras.push(['rows', String(value?.rows?.length ?? 0)]);
      break;
    }
    case 'sample': {
      const value = block.value as
        | { sample_id?: number | null }
        | null
        | undefined;
      if (value?.sample_id != null) {
        extras.push(['sample_id', String(value.sample_id)]);
      }
      break;
    }
    case 'reaction': {
      const value = block.value as
        | { reaction_id?: number | null }
        | null
        | undefined;
      if (value?.reaction_id != null) {
        extras.push(['reaction_id', String(value.reaction_id)]);
      }
      break;
    }
    case 'ketcher': {
      const value = block.value as
        | { sdf_file?: string | null; svg_file?: string | null }
        | null
        | undefined;
      extras.push(['sdf_file', value?.sdf_file ? 'yes' : 'no']);
      extras.push(['svg_file', value?.svg_file ?? 'none']);
      break;
    }
    default:
      break;
  }

  return {
    id: index,
    label: block.id ?? `field-${index}`,
    extras,
  };
}

function buildSampleUpdatePrep(sample: Sample): UpdatePrep {
  const { payload: container, usedFallback } = normalizeContainer(sample.container);
  const notes = [
    'Fields omitted from `chem_update_sample` stay unchanged; `container` may be omitted too.',
  ];
  if (usedFallback) {
    notes.unshift(
      'Chemotion returned `container: null`; this payload substitutes `EMPTY_ROOT_CONTAINER`.'
    );
  }
  return {
    toolName: 'chem_update_sample',
    required: [],
    notes,
    payload: compactRecord({
      id: sample.id,
      container,
      name: sample.name,
      external_label: sample.external_label,
      description: sample.description,
      purity: sample.purity,
      target_amount_value: sample.target_amount_value,
      target_amount_unit: sample.target_amount_unit,
      real_amount_value: sample.real_amount_value,
      real_amount_unit: sample.real_amount_unit,
      density: sample.density,
      molarity_value: sample.molarity_value,
      molarity_unit: sample.molarity_unit,
      location: sample.location,
      is_top_secret: sample.is_top_secret,
      molecule_id: sample.molecule_id,
      decoupled: sample.decoupled,
      stereo: sample.stereo,
      solvent: sample.solvent,
      dry_solvent: sample.dry_solvent,
      sum_formula: sample.sum_formula,
      sample_type: sample.sample_type,
      sample_details: sample.sample_details,
      melting_point_lowerbound: sample.melting_point_lowerbound,
      melting_point_upperbound: sample.melting_point_upperbound,
      boiling_point_lowerbound: sample.boiling_point_lowerbound,
      boiling_point_upperbound: sample.boiling_point_upperbound,
      xref: sample.xref ?? {},
    }),
  };
}

function buildReactionUpdatePrep(reaction: Reaction): UpdatePrep {
  const { payload: container, usedFallback } = normalizeContainer(reaction.container);
  const notes = [
    'Only send `materials` when you are changing participants; omit it (and `container`) and `chem_update_reaction` keeps the current ones.',
    'When you do send `materials`, keep every row and every field shown here: Chemotion writes omitted participant fields back as empty and destroys participants left out of the payload.',
    'To add a participant, prefer `chem_attach_reaction_material` / `chem_attach_reaction_product`; never add an existing sample id from another reaction (it moves that row).',
  ];
  if (usedFallback) {
    notes.unshift(
      'Chemotion returned `container: null`; this payload substitutes `EMPTY_ROOT_CONTAINER`.'
    );
  }
  const materials = {
    starting_materials: (reaction.starting_materials ?? []).map(
      reactionMaterialRefPayload
    ),
    reactants: (reaction.reactants ?? []).map(reactionMaterialRefPayload),
    products: (reaction.products ?? []).map(reactionMaterialRefPayload),
    solvents: (reaction.solvents ?? []).map(reactionMaterialRefPayload),
    purification_solvents: (reaction.purification_solvents ?? []).map(
      reactionMaterialRefPayload
    ),
    // v4 sequence-based-macromolecule reactants: passed through whole,
    // since leaving the bucket out destroys them.
    ...(Array.isArray(reaction.reactant_sbmm_samples)
      ? { reactant_sbmm_samples: jsonClone(reaction.reactant_sbmm_samples) }
      : {}),
  };
  return {
    toolName: 'chem_update_reaction',
    required: [],
    notes,
    payload: compactRecord({
      id: reaction.id,
      materials,
      container,
      name: reaction.name,
      description: reaction.description,
      observation: reaction.observation,
      purification: reaction.purification,
      solvent: reaction.solvent,
      status: reaction.status,
      role: reaction.role,
      temperature: reaction.temperature,
      duration: reaction.duration,
      rxno: reaction.rxno,
    }),
  };
}

function buildResearchPlanUpdatePrep(plan: ResearchPlan): UpdatePrep {
  const { payload: container, usedFallback } = normalizeContainer(plan.container);
  const notes = [
    'Research-plan PUT replaces the entire `body` array when you send `body`.',
    '`container` may be omitted; the current one is kept.',
  ];
  if (usedFallback) {
    notes.unshift(
      'Chemotion returned `container: null`; this payload substitutes `EMPTY_ROOT_CONTAINER`.'
    );
  }
  return {
    toolName: 'chem_update_research_plan',
    required: [],
    notes,
    payload: compactRecord({
      id: plan.id,
      container,
      name: plan.name,
      body: jsonClone((plan.body ?? []) as ResearchPlanBlock[]),
      wellplate_ids: (plan.wellplates ?? [])
        .map((wellplate) => wellplate.id)
        .filter((id): id is number => typeof id === 'number'),
    }),
  };
}

function buildWellplateUpdatePrep(wellplate: Wellplate): UpdatePrep {
  const { payload: container, usedFallback } = normalizeContainer(
    wellplate.container
  );
  const notes = [
    'Omit `wells` to keep the current layout. Sending `wells` replaces the layout, and Chemotion DESTROYS the samples of any well left out (an empty array deletes every sample in the plate).',
    '`container` may be omitted; the current one is kept.',
  ];
  if (usedFallback) {
    notes.unshift(
      'Chemotion returned `container: null`; this payload substitutes `EMPTY_ROOT_CONTAINER`.'
    );
  }
  return {
    toolName: 'chem_update_wellplate',
    required: [],
    notes,
    payload: compactRecord({
      id: wellplate.id,
      container,
      name: wellplate.name,
      description: wellplate.description,
      readout_titles: jsonClone(wellplate.readout_titles ?? []),
      wells: jsonClone((wellplate.wells ?? []) as Well[]),
    }),
  };
}

function buildScreenUpdatePrep(screen: Screen): UpdatePrep {
  const { payload: container, usedFallback } = normalizeContainer(screen.container);
  const notes = [
    '`wellplate_ids`, `research_plan_ids`, and `container` may be omitted; the current values are kept.',
    'Wellplate links are diffed against the `wellplate_ids` you send.',
  ];
  if (usedFallback) {
    notes.unshift(
      'Chemotion returned `container: null`; this payload substitutes `EMPTY_ROOT_CONTAINER`.'
    );
  }
  return {
    toolName: 'chem_update_screen',
    required: [],
    notes,
    payload: compactRecord({
      id: screen.id,
      container,
      name: screen.name,
      collaborator: screen.collaborator,
      requirements: screen.requirements,
      conditions: screen.conditions,
      result: screen.result,
      description: screen.description,
      component_graph_data: screen.component_graph_data,
      wellplate_ids: (screen.wellplates ?? [])
        .map((wellplate) => wellplate.id)
        .filter((id): id is number => typeof id === 'number'),
      research_plan_ids: (screen.research_plans ?? [])
        .map((plan) => plan.id)
        .filter((id): id is number => typeof id === 'number'),
    }),
  };
}

function buildUpdatePrep(
  kind: ChemotionElementType,
  entity: Sample | Reaction | ResearchPlan | Wellplate | Screen
): UpdatePrep {
  switch (kind) {
    case 'sample':
      return buildSampleUpdatePrep(entity as Sample);
    case 'reaction':
      return buildReactionUpdatePrep(entity as Reaction);
    case 'research_plan':
      return buildResearchPlanUpdatePrep(entity as ResearchPlan);
    case 'wellplate':
      return buildWellplateUpdatePrep(entity as Wellplate);
    case 'screen':
      return buildScreenUpdatePrep(entity as Screen);
  }
}

function renderUpdatePrep(kind: ChemotionElementType, prep: UpdatePrep): string {
  const meta = [
    `tool: \`${prep.toolName}\``,
    prep.required.length
      ? `required on PUT: ${prep.required.map((field) => `\`${field}\``).join(', ')}`
      : null,
  ]
    .filter((value): value is string => value !== null)
    .join(' · ');
  const sections = [
    `# ${kind} update payload`,
    meta,
  ];

  if (prep.notes.length) {
    sections.push('## Notes\n' + prep.notes.map((note) => `- ${note}`).join('\n'));
  }

  sections.push(
    '## Tool args\n```json\n' + JSON.stringify(prep.payload, null, 2) + '\n```'
  );
  return sections.join('\n\n');
}

/**
 * Run an array of async factories in chunks of `size`, sequential
 * between chunks, parallel within one. Ports the elabftw-mcp helper;
 * keeps concurrent socket count to the server manageable under bulk.
 */
async function chunkedAll<T>(
  factories: Array<() => Promise<T>>,
  size: number
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < factories.length; i += size) {
    const slice = factories.slice(i, i + size).map((fn) => fn());
    const results = await Promise.all(slice);
    for (const r of results) out.push(r);
  }
  return out;
}

function sampleSummary(sample: Sample): ListSummary {
  const name = sample.name ?? sample.short_label ?? `sample-${sample.id}`;
  const extras: Array<[string, string]> = [];
  if (sample.short_label && sample.name) extras.push(['label', sample.short_label]);
  const formula = sample.molecule?.sum_formula ?? sample.molecular_formula;
  if (formula) extras.push(['formula', formula]);
  const mw = Number(sample.molecule?.molecular_weight ?? sample.molecular_weight);
  if (Number.isFinite(mw)) extras.push(['MW', `${Number(mw.toFixed(2))}`]);
  return { id: sample.id, label: name, extras };
}

// ---------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------

export function registerReadTools(
  server: McpServer,
  client: ChemotionClient,
  config: ChemotionMcpConfig
): void {
  const formatOpts = { revealUsers: config.revealUserIdentities };

  // -----------------------------------------------------------------
  // Identity
  // -----------------------------------------------------------------

  server.tool(
    'chem_me',
    'Return the authenticated caller’s user record (id, name, initials, email). ' +
      'Useful as an authn sanity-check before heavier calls. ' +
      '`chem_me` is exempt from the `CHEMOTION_REVEAL_USER_IDENTITIES` privacy flag ' +
      '(the caller is looking up themselves).',
    {},
    async () =>
      guard(
        () => client.me(),
        (response) => {
          const u: Record<string, unknown> =
            typeof response === 'object' && response !== null && 'user' in response
              ? ((response as { user: Record<string, unknown> }).user ?? {})
              : (response as Record<string, unknown>);
          const name =
            (u.name as string | undefined) ??
            `${(u.first_name as string | undefined) ?? ''} ${(u.last_name as string | undefined) ?? ''}`.trim();
          const bits = [
            u.id != null ? `id=${u.id}` : null,
            name ? `name=${name}` : null,
            u.initials ? `initials=${u.initials}` : null,
            u.email ? `email=${u.email}` : null,
            u.type ? `type=${u.type}` : null,
          ].filter(Boolean);
          return text(bits.join(' | '));
        }
      )
  );

  // -----------------------------------------------------------------
  // Collections
  // -----------------------------------------------------------------

  server.tool(
    'chem_list_collections',
    'List every collection visible to the caller (own + shared + the locked ' +
      '"All" system collection), as a flat summary with parent links. ' +
      'Use a collection id from here as `collection_id` on the `chem_list_*` tools.',
    {},
    async () =>
      guard(
        () => client.listCollections(),
        (response) => {
          const rows = (response.collections ?? response.roots ?? []).map(
            (c) => {
              // v4 rows are flat and linked by `ancestry` ("1/13");
              // older releases nest them under `children`.
              const parent =
                typeof c.ancestry === 'string' && c.ancestry
                  ? c.ancestry.split('/').pop()
                  : undefined;
              return {
                id: c.id,
                label: c.label,
                extras: [
                  parent ? (['parent', `#${parent}`] as [string, string]) : null,
                  c.is_shared ? (['', 'shared'] as [string, string]) : null,
                  c.is_locked ? (['', 'system'] as [string, string]) : null,
                  c.children?.length
                    ? ([`children`, String(c.children.length)] as [string, string])
                    : null,
                ].filter((e): e is [string, string] => e !== null),
              };
            }
          );
          return text(renderSummaryList('collection(s)', rows));
        }
      )
  );

  server.tool(
    'chem_get_collection',
    'Fetch one collection with its immediate children. Use this to walk the ' +
      'collection tree one level at a time, or to confirm a collection id before ' +
      'listing its elements.',
    {
      id: positiveInt.describe('Collection id.'),
    },
    async (args) => {
      const { id } = args as { id: number };
      return guard(
        () => client.getCollection(id),
        (response) => text(formatCollection(response.collection, formatOpts))
      );
    }
  );

  // -----------------------------------------------------------------
  // Samples
  // -----------------------------------------------------------------

  server.tool(
    'chem_list_samples',
    'List samples in a collection. Requires `collection_id` (Chemotion does not ' +
      'expose a cross-collection list — use `chem_search` for that). Results are ' +
      'rendered as one line per sample with formula + MW; use `chem_get_sample` ' +
      'for full structure/quantity/analyses detail.',
    {
      collection_id: collectionIdSchema,
      ...paginationArgsSchema,
      from_date: z
        .string()
        .optional()
        .describe('Created-on lower bound, ISO date (e.g. "2026-01-31").'),
      to_date: z
        .string()
        .optional()
        .describe('Created-on upper bound, ISO date (inclusive day).'),
      product_only: z
        .boolean()
        .optional()
        .describe('Hide samples that are not reaction products.'),
    },
    async (args) => {
      const input = args as {
        collection_id: number | 'all';
        page?: number;
        per_page?: number;
        from_date?: string;
        to_date?: string;
        product_only?: boolean;
      };
      return guard(
        () =>
          client.listSamples({
            collection_id: input.collection_id,
            page: input.page ?? 1,
            per_page: input.per_page ?? 25,
            from_date: input.from_date,
            to_date: input.to_date,
            filter_created_at: input.from_date || input.to_date ? true : undefined,
            product_only: input.product_only,
          }),
        (response) => {
          const rows = (response.samples ?? []).map(sampleSummary);
          return text(renderSummaryList('sample(s)', rows, response.pagination));
        }
      );
    }
  );

  server.tool(
    'chem_get_sample',
    'Fetch one sample. Returns the full chemistry view: SMILES, InChI, InChIKey, ' +
      'molecular formula, molecular weight, a fenced molfile block, quantities ' +
      '(amount / real / target / purity / density / molarity / MP / BP / solvents), ' +
      'description, and the analyses tree (NMR / MS / IR …). Chemotion hydrates ' +
      'all of these in a single round-trip — there is no `include` arg.',
    {
      id: positiveInt.describe('Sample id.'),
    },
    async (args) => {
      const { id } = args as { id: number };
      return guard(
        () => client.getSample(id),
        (response) => text(formatSample(response.sample, formatOpts))
      );
    }
  );

  server.tool(
    'chem_get_sample_by_short_label',
    'Resolve a human-readable short label (e.g. "ABC-42") to a sample and return ' +
      'its full chemistry view. Two-hop under the hood: `findByShortLabel` → ' +
      '`get_sample`.',
    {
      short_label: z.string().min(1).describe('Sample short_label.'),
    },
    async (args) => {
      const { short_label } = args as { short_label: string };
      return guard(
        async () => {
          const ref = await client.findSampleByShortLabel(short_label);
          if (typeof ref.id !== 'number') {
            throw new Error(
              `No sample with short_label "${short_label}" visible to this session.`
            );
          }
          return client.getSample(ref.id);
        },
        (response) => text(formatSample(response.sample, formatOpts))
      );
    }
  );

  // -----------------------------------------------------------------
  // Reactions
  // -----------------------------------------------------------------

  server.tool(
    'chem_list_reactions',
    'List reactions in a collection. Renders as one line per reaction with status, ' +
      'role, and product count; use `chem_get_reaction` for the scheme + participant ' +
      'tables.',
    {
      collection_id: collectionIdSchema,
      ...paginationArgsSchema,
      from_date: z
        .string()
        .optional()
        .describe('Created-on lower bound, ISO date (e.g. "2026-01-31").'),
      to_date: z
        .string()
        .optional()
        .describe('Created-on upper bound, ISO date (inclusive day).'),
    },
    async (args) => {
      const input = args as {
        collection_id: number | 'all';
        page?: number;
        per_page?: number;
        from_date?: string;
        to_date?: string;
      };
      return guard(
        () =>
          client.listReactions({
            collection_id: input.collection_id,
            page: input.page ?? 1,
            per_page: input.per_page ?? 25,
            from_date: input.from_date,
            to_date: input.to_date,
            filter_created_at: input.from_date || input.to_date ? true : undefined,
          }),
        (response) => {
          const rows = (response.reactions ?? []).map((r) => {
            const name = r.name ?? r.short_label ?? `reaction-${r.id}`;
            const extras: Array<[string, string]> = [];
            if (r.short_label && r.name) extras.push(['label', r.short_label]);
            if (r.status) extras.push(['status', r.status]);
            if (r.role) extras.push(['role', r.role]);
            const productCount = r.products?.length ?? 0;
            if (productCount)
              extras.push(['products', productCount.toString()]);
            return { id: r.id, label: name, extras };
          });
          return text(renderSummaryList('reaction(s)', rows, response.pagination));
        }
      );
    }
  );

  server.tool(
    'chem_get_reaction',
    'Fetch one reaction. Returns a scheme one-liner, per-role participant tables ' +
      '(starting materials / reactants / products / solvents with equiv, amount, ' +
      'yield), description, observation, purification, and the analyses tree. ' +
      'All analyses hydrate in the same round-trip.',
    { id: positiveInt.describe('Reaction id.') },
    async (args) => {
      const { id } = args as { id: number };
      return guard(
        () => client.getReaction(id),
        (response) => text(formatReaction(response.reaction, formatOpts))
      );
    }
  );

  server.tool(
    'chem_get_reaction_by_short_label',
    'Resolve a reaction short label (e.g. "RXN-099") and return the full scheme view.',
    { short_label: z.string().min(1) },
    async (args) => {
      const { short_label } = args as { short_label: string };
      return guard(
        async () => {
          const ref = await client.findReactionByShortLabel(short_label);
          if (typeof ref.id !== 'number') {
            throw new Error(
              `No reaction with short_label "${short_label}" visible to this session.`
            );
          }
          return client.getReaction(ref.id);
        },
        (response) => text(formatReaction(response.reaction, formatOpts))
      );
    }
  );

  // -----------------------------------------------------------------
  // Research plans
  // -----------------------------------------------------------------

  server.tool(
    'chem_list_research_plans',
    'List research plans in a collection. One line per plan. Use ' +
      '`chem_get_research_plan` for the body blocks.',
    {
      collection_id: collectionIdSchema,
      ...paginationArgsSchema,
    },
    async (args) => {
      const input = args as {
        collection_id: number | 'all';
        page?: number;
        per_page?: number;
      };
      return guard(
        () =>
          client.listResearchPlans({
            collection_id: input.collection_id,
            page: input.page ?? 1,
            per_page: input.per_page ?? 25,
          }),
        (response) => {
          const rows = (response.research_plans ?? []).map((p) => ({
            id: p.id,
            label: p.name ?? `plan-${p.id}`,
            extras: [
              Array.isArray(p.body) && p.body.length
                ? (['blocks', String(p.body.length)] as [string, string])
                : null,
              Array.isArray(p.attachments) && p.attachments.length
                ? (['attachments', String(p.attachments.length)] as [
                    string,
                    string,
                  ])
                : null,
            ].filter((e): e is [string, string] => e !== null),
          }));
          return text(
            renderSummaryList('research plan(s)', rows, response.pagination)
          );
        }
      );
    }
  );

  server.tool(
    'chem_get_research_plan',
    'Fetch one research plan. Walks the typed `body` block array and renders: ' +
      '`richtext`/`text` blocks as markdown (Quill delta → bold/italic/links/' +
      'headers/lists/blockquote/code-block), `table` blocks as GFM pipe tables, ' +
      'image/sample/reaction/ketcher refs as short placeholders. The rendered ' +
      'output also includes a field inventory with stable block ids before the ' +
      'body so callers can target `chem_*_research_plan_field` updates safely. ' +
      'Unknown block kinds fall through as fenced JSON so content is never ' +
      'silently dropped.',
    { id: positiveInt.describe('Research plan id.') },
    async (args) => {
      const { id } = args as { id: number };
      return guard(
        () => client.getResearchPlan(id),
        (response) =>
          text(formatResearchPlan(response.research_plan, formatOpts))
      );
    }
  );

  server.tool(
    'chem_list_research_plan_fields',
    'List the body fields inside one research plan with stable field ids, ' +
      'block types, titles, and lightweight summaries (table sizes, linked ' +
      'reaction/sample ids, Ketcher SVG presence). Use this before ' +
      '`chem_add_research_plan_field`, `chem_update_research_plan_field`, or ' +
      '`chem_delete_research_plan_field` when you want a compact target list.',
    { id: positiveInt.describe('Research plan id.') },
    async (args) => {
      const { id } = args as { id: number };
      return guard(
        () => client.getResearchPlan(id),
        (response) => {
          const fields = Array.isArray(response.research_plan.body)
            ? response.research_plan.body
            : [];
          const rows = fields.map((block, index) =>
            summarizeResearchPlanField(block, index)
          );
          return text(renderSummaryList('research-plan field(s)', rows));
        }
      );
    }
  );

  // -----------------------------------------------------------------
  // Wellplates & screens
  // -----------------------------------------------------------------

  server.tool(
    'chem_list_wellplates',
    'List wellplates in a collection.',
    {
      collection_id: collectionIdSchema,
      ...paginationArgsSchema,
    },
    async (args) => {
      const input = args as {
        collection_id: number | 'all';
        page?: number;
        per_page?: number;
      };
      return guard(
        () =>
          client.listWellplates({
            collection_id: input.collection_id,
            page: input.page ?? 1,
            per_page: input.per_page ?? 25,
          }),
        (response) => {
          const rows = (response.wellplates ?? []).map((w) => ({
            id: w.id,
            label: w.name ?? `wellplate-${w.id}`,
            extras: [
              w.width != null && w.height != null
                ? ([`size`, `${w.width}×${w.height}`] as [string, string])
                : null,
              Array.isArray(w.wells) && w.wells.length
                ? ([`wells`, String(w.wells.length)] as [string, string])
                : null,
            ].filter((e): e is [string, string] => e !== null),
          }));
          return text(
            renderSummaryList('wellplate(s)', rows, response.pagination)
          );
        }
      );
    }
  );

  server.tool(
    'chem_get_wellplate',
    'Fetch one wellplate. Draws an ASCII grid for standard sizes (≤96 wells), ' +
      'row-per-well list otherwise.',
    { id: positiveInt.describe('Wellplate id.') },
    async (args) => {
      const { id } = args as { id: number };
      return guard(
        () => client.getWellplate(id),
        (response) => text(formatWellplate(response.wellplate, formatOpts))
      );
    }
  );

  server.tool(
    'chem_list_screens',
    'List screens in a collection.',
    {
      collection_id: collectionIdSchema,
      ...paginationArgsSchema,
    },
    async (args) => {
      const input = args as {
        collection_id: number | 'all';
        page?: number;
        per_page?: number;
      };
      return guard(
        () =>
          client.listScreens({
            collection_id: input.collection_id,
            page: input.page ?? 1,
            per_page: input.per_page ?? 25,
          }),
        (response) => {
          const rows = (response.screens ?? []).map((s) => ({
            id: s.id,
            label: s.name ?? `screen-${s.id}`,
            extras: s.collaborator ? [['collab', s.collaborator]] as Array<[string, string]> : [],
          }));
          return text(
            renderSummaryList('screen(s)', rows, response.pagination)
          );
        }
      );
    }
  );

  server.tool(
    'chem_get_screen',
    'Fetch one screen. Includes collaborator, requirements, conditions, result, ' +
      'and attached wellplates.',
    { id: positiveInt.describe('Screen id.') },
    async (args) => {
      const { id } = args as { id: number };
      return guard(
        () => client.getScreen(id),
        (response) => text(formatScreen(response.screen, formatOpts))
      );
    }
  );

  // -----------------------------------------------------------------
  // Cross-kind free-text search
  // -----------------------------------------------------------------

  server.tool(
    'chem_search',
    'Cross-collection free-text search. Scope with `element_type` (default: all) ' +
      'to restrict to samples / reactions / wellplates / screens. Chemotion’s ' +
      'search is substring-based over name / short_label / description; for ' +
      'substructure search use `chem_search_structure`, for structured filters ' +
      'use `chem_search_advanced`. Text search only returns samples from ' +
      'collections where you have sample detail level > 0.',
    {
      query: z.string().min(1).describe('Substring to match against element names / labels / descriptions.'),
      element_type: z
        .enum(['all', 'samples', 'reactions', 'wellplates', 'screens'])
        .optional()
        .describe('Restrict by kind. Default `all`.'),
      collection_id: collectionIdSchema
        .optional()
        .describe('Restrict to one collection. Default `all`.'),
      ...paginationArgsSchema,
    },
    async (args) => {
      const input = args as {
        query: string;
        element_type?: 'all' | 'samples' | 'reactions' | 'wellplates' | 'screens';
        collection_id?: number | 'all';
        page?: number;
        per_page?: number;
      };
      // Chemotion's search endpoints read `name_column` + `name` +
      // `search_by_method` inside `selection` but `collection_id` at
      // the top level of the body. We feed both correctly via the
      // client's `options` arg; anything inside `selection` that the
      // server doesn't recognise is silently dropped.
      const selection = {
        search_by_method: 'substring',
        name_column: 'name' as const,
        name: input.query,
        elementType: input.element_type ?? 'all',
      };
      return guard(
        () =>
          input.element_type && input.element_type !== 'all'
            ? client.searchElementType(input.element_type, selection, {
                page: input.page ?? 1,
                per_page: input.per_page ?? 25,
                collection_id: input.collection_id,
              })
            : client.searchAll(selection, {
                page: input.page ?? 1,
                per_page: input.per_page ?? 25,
                collection_id: input.collection_id,
              }),
        (response) => {
          const lines: string[] = [];
          for (const kind of [
            'samples',
            'reactions',
            'wellplates',
            'screens',
            'research_plans',
          ] as const) {
            const bucket = (response as Record<string, unknown>)[kind] as
              | { elements?: Array<{ id: number; name?: string; short_label?: string }>; totalElements?: number }
              | undefined;
            if (!bucket || !Array.isArray(bucket.elements) || bucket.elements.length === 0) continue;
            const header =
              `### ${kind} (${bucket.elements.length}` +
              (bucket.totalElements != null && bucket.totalElements !== bucket.elements.length
                ? `/${bucket.totalElements}`
                : '') +
              ')';
            const rows = bucket.elements.map((e) => {
              const label = e.name ?? e.short_label ?? `#${e.id}`;
              return `- #${e.id} ${label}`;
            });
            lines.push(header + '\n' + rows.join('\n'));
          }
          return text(lines.length ? lines.join('\n\n') : 'No matches.');
        }
      );
    }
  );

  // -----------------------------------------------------------------
  // Structure + advanced search (the elabftw-can't-do-this wins)
  // -----------------------------------------------------------------

  server.tool(
    'chem_search_structure',
    'Substructure / similarity search by chemical structure. Accepts either a ' +
      'molfile (preferred) or a SMILES string — SMILES is auto-converted via ' +
      '`/molecules/smiles` before dispatch. ' +
      '`search_type=sub` finds every sample whose structure contains the query ' +
      'as a substructure (fingerprint-filtered). `search_type=similar` finds ' +
      'structurally-similar samples; `tanimoto_threshold` (0.0–1.0, default 0.7) ' +
      'controls strictness. Scope with `collection_id` (default `all`).',
    {
      molfile: z
        .string()
        .optional()
        .describe(
          'MDL molfile (V2000 or V3000). Preferred — no conversion step. ' +
            'Mutually exclusive with `smiles`.'
        ),
      smiles: z
        .string()
        .optional()
        .describe(
          'SMILES string. Converted to molfile via `/molecules/smiles` before ' +
            'dispatch. Mutually exclusive with `molfile`.'
        ),
      search_type: z
        .preprocess(
          (v) => (v === 'sim' ? 'similar' : v),
          z.enum(['sub', 'similar'])
        )
        .describe(
          '`sub` = substructure (exact substructure match, fingerprint-filtered). ' +
            '`similar` = similarity (Tanimoto over Morgan-like fingerprints).'
        ),
      tanimoto_threshold: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe(
          'Similarity threshold for `search_type=similar`. Default 0.7. Ignored for `sub`.'
        ),
      element_type: z
        .enum(['samples', 'reactions'])
        .optional()
        .describe('Element kind to match against. Default `samples`.'),
      collection_id: collectionIdSchema
        .optional()
        .describe('Restrict to one collection. Default `all`.'),
      ...paginationArgsSchema,
    },
    async (args) => {
      const input = args as {
        molfile?: string;
        smiles?: string;
        search_type: 'sub' | 'similar';
        tanimoto_threshold?: number;
        element_type?: 'samples' | 'reactions';
        collection_id?: number | 'all';
        page?: number;
        per_page?: number;
      };

      if (!input.molfile && !input.smiles) {
        return errorText('either `molfile` or `smiles` must be provided.');
      }
      if (input.molfile && input.smiles) {
        return errorText('pass either `molfile` or `smiles`, not both.');
      }

      return guard(
        async () => {
          let molfile = input.molfile;
          if (!molfile) {
            // SMILES → molfile via the Chemotion pipeline.
            const conv = (await client.smilesToMolfile(
              input.smiles as string
            )) as Record<string, unknown>;
            const converted = conv.molfile;
            if (typeof converted !== 'string' || !converted) {
              throw new Error(
                'SMILES → molfile conversion returned no molfile. ' +
                  'Pass a molfile directly instead.'
              );
            }
            molfile = converted;
          }

          return client.searchStructure(
            {
              selection: {
                elementType: input.element_type ?? 'samples',
                search_type: input.search_type,
                molfile,
                ...(input.search_type === 'similar'
                  ? { tanimoto_threshold: input.tanimoto_threshold ?? 0.7 }
                  : {}),
              },
              page: input.page ?? 1,
              per_page: input.per_page ?? 25,
            },
            { collection_id: input.collection_id }
          );
        },
        (response) => {
          const lines: string[] = [];
          for (const kind of ['samples', 'reactions'] as const) {
            const bucket = (response as Record<string, unknown>)[kind] as
              | {
                  elements?: Array<{
                    id: number;
                    name?: string;
                    short_label?: string;
                    molecule?: { sum_formula?: string };
                    molecular_formula?: string;
                  }>;
                  totalElements?: number;
                }
              | undefined;
            if (
              !bucket ||
              !Array.isArray(bucket.elements) ||
              bucket.elements.length === 0
            )
              continue;
            const header =
              `### ${kind} (${bucket.elements.length}` +
              (bucket.totalElements != null &&
              bucket.totalElements !== bucket.elements.length
                ? `/${bucket.totalElements}`
                : '') +
              ')';
            const rows = bucket.elements.map((e) => {
              const label = e.name ?? e.short_label ?? `#${e.id}`;
              const formula = e.molecule?.sum_formula ?? e.molecular_formula;
              return `- #${e.id} ${label}${formula ? ` (${formula})` : ''}`;
            });
            lines.push(header + '\n' + rows.join('\n'));
          }
          return text(lines.length ? lines.join('\n\n') : 'No structural matches.');
        }
      );
    }
  );

  server.tool(
    'chem_search_advanced',
    'Advanced structured-filter search. Pass filter clauses as ' +
      '`filters: Array<{link, match, column, value}>`. ' +
      '`column` is a column on the element table from Chemotion\'s whitelist, e.g. ' +
      'samples: `external_label` (always), `name`, `short_label`, `sum_formula`, ' +
      '`molecular_mass`, `location`, `description`, `purity`, `density` ' +
      '(need sample detail_level > 0 on the collection); reactions: `name`, ' +
      '`short_label`, `status`, `rxno`, `duration`, `plain_text_description`; ' +
      'wellplates / screens / research_plans: `name`. ' +
      '`match` is a SQL op: `"LIKE"` / `"ILIKE"` for substring (Chemotion ' +
      'wraps the value in `%…%` itself and escapes any `%` you send — **do ' +
      'not** add wildcards), `"="`, `"<"`, `">"`, `">="`, `"<="` for exact / comparisons. ' +
      '`link` chains clauses with `"AND"` / `"OR"` (empty string on the ' +
      'first clause). ' +
      'Example: `[{link:"", match:"LIKE", column:"external_label", value:"DMSN"}]`. ' +
      'The tool assembles Chemotion\'s `{table, field:{table,column,label}}` ' +
      'wrapper from your `column` + `element_type` — the column whitelist ' +
      'is gated by the collection\'s `detail_level`.',
    {
      filters: z
        .array(
          z.object({
            link: z
              .enum(['', 'AND', 'OR'])
              .default('')
              .describe(
                'SQL linker to the previous clause. Empty string on the ' +
                  'first clause, "AND" / "OR" thereafter.'
              ),
            match: z
              .enum(['=', 'LIKE', 'ILIKE', 'NOT LIKE', 'NOT ILIKE', '>', '<', '>=', '<='])
              .default('LIKE')
              .describe('SQL operator.'),
            column: z
              .string()
              .min(1)
              .describe(
                'Column name on the element table (e.g. "external_label", ' +
                  '"name", "short_label", "molecular_mass").'
              ),
            value: z
              .string()
              .describe(
                'Value to match. For LIKE/ILIKE pass the bare substring ' +
                  '(`"DMSN"`); Chemotion adds the wildcards.'
              ),
            label: z
              .string()
              .optional()
              .describe(
                'Human-readable label for UI echo. Ignored by the server; ' +
                  'defaults to the `column` name if omitted.'
              ),
          })
        )
        .min(1)
        .describe('Filter clauses.'),
      element_type: z
        .enum(['samples', 'reactions', 'wellplates', 'screens', 'research_plans'])
        .optional()
        .describe('Element kind (table name). Default `samples`.'),
      collection_id: collectionIdSchema
        .optional()
        .describe('Restrict to one collection. Default `all`.'),
      ...paginationArgsSchema,
    },
    async (args) => {
      const input = args as {
        filters: Array<{
          link?: string;
          match?: string;
          column: string;
          value: string;
          label?: string;
        }>;
        element_type?:
          | 'samples'
          | 'reactions'
          | 'wellplates'
          | 'screens'
          | 'research_plans';
        collection_id?: number | 'all';
        page?: number;
        per_page?: number;
      };
      const table = input.element_type ?? 'samples';
      // Chemotion's advanced-search filter needs `table` at BOTH the
      // filter level and inside `field`; missing either makes the
      // detail-level gate reject with "Your search for X is not
      // allowed". Assemble the wire shape here so callers only think
      // in terms of column + value.
      const advanced_params = input.filters.map((f) => ({
        link: f.link ?? '',
        match: f.match ?? 'LIKE',
        table,
        field: {
          table,
          column: f.column,
          label: f.label ?? f.column,
        },
        value: f.value,
      }));
      return guard(
        () =>
          client.searchAdvanced(
            {
              elementType: table,
              advanced_params,
            },
            {
              page: input.page ?? 1,
              per_page: input.per_page ?? 25,
              collection_id: input.collection_id,
            }
          ),
        (response) => {
          const lines: string[] = [];
          for (const kind of [
            'samples',
            'reactions',
            'wellplates',
            'screens',
            'research_plans',
          ] as const) {
            const bucket = (response as Record<string, unknown>)[kind] as
              | {
                  elements?: Array<{
                    id: number;
                    name?: string;
                    short_label?: string;
                  }>;
                  totalElements?: number;
                }
              | undefined;
            if (
              !bucket ||
              !Array.isArray(bucket.elements) ||
              bucket.elements.length === 0
            )
              continue;
            const header =
              `### ${kind} (${bucket.elements.length}` +
              (bucket.totalElements != null &&
              bucket.totalElements !== bucket.elements.length
                ? `/${bucket.totalElements}`
                : '') +
              ')';
            const rows = bucket.elements.map((e) => {
              const label = e.name ?? e.short_label ?? `#${e.id}`;
              return `- #${e.id} ${label}`;
            });
            lines.push(header + '\n' + rows.join('\n'));
          }
          return text(lines.length ? lines.join('\n\n') : 'No matches.');
        }
      );
    }
  );

  server.tool(
    'chem_search_by_ids',
    'Fetch element summaries for a specific list of ids. Use when the caller ' +
      'already knows ids (e.g. from a previous search result or cross-reference). ' +
      'Chemotion expects the singular-form element kind on this endpoint.',
    {
      ids: z
        .array(positiveInt)
        .min(1)
        .max(100)
        .describe('Element ids, same kind. Max 100.'),
      kind: elementKindSchema,
      collection_id: collectionIdSchema
        .optional()
        .describe('Optional collection scope. Default `all`.'),
    },
    async (args) => {
      const input = args as {
        ids: number[];
        kind: ChemotionElementType;
        collection_id?: number | 'all';
      };
      return guard(
        () =>
          client.searchByIds(input.ids, input.kind, {
            collection_id: input.collection_id,
          }),
        (response) => {
          const pluralKey = ELEMENT_TYPE_PLURAL[input.kind];
          const bucket = (response as Record<string, unknown>)[pluralKey] as
            | {
                elements?: Array<{
                  id: number;
                  name?: string;
                  short_label?: string;
                }>;
                totalElements?: number;
              }
            | undefined;
          const elements = bucket?.elements ?? [];
          if (elements.length === 0) {
            return text('No elements returned.');
          }
          const rows = elements.map((e) => {
            const label = e.name ?? e.short_label ?? `#${e.id}`;
            return `- #${e.id} ${label}`;
          });
          return text(
            `${elements.length} ${pluralKey}:\n${rows.join('\n')}`
          );
        }
      );
    }
  );

  // -----------------------------------------------------------------
  // Utilities
  // -----------------------------------------------------------------

  server.tool(
    'chem_smiles_to_molfile',
    'Convert a SMILES string to a molfile via Chemotion’s OpenBabel/RDKit ' +
      'pipeline. Use as a preprocessing step before `chem_search_structure` (which ' +
      'only accepts molfile) or before `chem_create_sample` when the caller has a ' +
      'SMILES but the server prefers molfile.',
    {
      smiles: z.string().min(1).describe('Canonical or non-canonical SMILES.'),
    },
    async (args) => {
      const { smiles } = args as { smiles: string };
      return guard(
        () => client.smilesToMolfile(smiles),
        (response) => {
          const molfile =
            typeof response === 'object' && response !== null && 'molfile' in response
              ? String(
                  (response as Record<string, unknown>).molfile ?? ''
                )
              : '';
          if (!molfile) {
            return text(
              `No molfile returned. Raw response:\n\`\`\`json\n${JSON.stringify(response, null, 2)}\n\`\`\``
            );
          }
          return text(
            `Converted SMILES → molfile:\n\n\`\`\`molfile\n${molfile}\n\`\`\``
          );
        }
      );
    }
  );

  server.tool(
    'chem_download_attachment',
    'Download an attachment by id. Text files are returned inline; binary ' +
      'attachments come back as base64 with MIME type + size. Files over ' +
      '`max_bytes` are truncated with a note.',
    {
      id: positiveInt.describe('Attachment id.'),
      max_bytes: z
        .number()
        .int()
        .positive()
        .max(10_000_000)
        .optional()
        .describe('Cap on returned bytes. Default 2_000_000 (2 MB).'),
    },
    async (args) => {
      const input = args as { id: number; max_bytes?: number };
      const MAX = input.max_bytes ?? 2_000_000;
      return guard(
        async () => {
          const response = await client.downloadAttachment(input.id);
          const ct =
            response.headers.get('content-type') ?? 'application/octet-stream';
          const buf = await response.arrayBuffer();
          return { ct, buf };
        },
        ({ ct, buf }) => {
          const size = buf.byteLength;
          const isText =
            ct.startsWith('text/') ||
            ct.includes('json') ||
            ct.includes('xml') ||
            ct.includes('csv');
          if (isText && size <= MAX) {
            const decoded = new TextDecoder('utf-8', { fatal: false }).decode(
              new Uint8Array(buf)
            );
            return text(`${ct} (${size} bytes):\n\n${decoded}`);
          }
          const capped = size > MAX ? buf.slice(0, MAX) : buf;
          const base64 = Buffer.from(capped).toString('base64');
          const suffix = size > MAX ? ` (truncated from ${size} bytes)` : '';
          return text(
            `${ct} (${size} bytes)${suffix}\nbase64:\n${base64}`
          );
        }
      );
    }
  );

  // -----------------------------------------------------------------
  // Cross-kind "get by id" — handy for the model when it has an id
  // but isn't sure of the kind (e.g. from search results).
  // -----------------------------------------------------------------

  server.tool(
    'chem_get_update_payload',
    'Fetch the raw field set needed for a safe Chemotion PUT. Returns a ' +
      'JSON starter payload for the matching `chem_update_*` tool, including ' +
      'hidden required fields such as `container`, `materials`, `body`, ' +
      '`wells`, `wellplate_ids`, and `research_plan_ids` when applicable. ' +
      'Use this when you want to inspect or edit an existing entity without ' +
      'dropping server-managed attachments/links by accident.',
    {
      kind: elementKindSchema,
      id: positiveInt.describe('Element id.'),
    },
    async (args) => {
      const { kind, id } = args as { kind: ChemotionElementType; id: number };
      return guard(
        () => fetchEntity(client, kind, id),
        (entity) => text(renderUpdatePrep(kind, buildUpdatePrep(kind, entity)))
      );
    }
  );

  server.tool(
    'chem_get',
    'Cross-kind fetch: pass an element kind + id and get the appropriate ' +
      'chemistry-aware render. Thin alias over the per-kind `chem_get_*` tools; ' +
      'useful when the model has an id from a search result and wants one tool call.',
    {
      kind: elementKindSchema,
      id: positiveInt.describe('Element id.'),
    },
    async (args) => {
      const { kind, id } = args as { kind: ChemotionElementType; id: number };
      return guard(
        () => fetchEntity(client, kind, id),
        (entity) => text(formatEntity(kind, entity, formatOpts))
      );
    }
  );

  // -----------------------------------------------------------------
  // Bulk fetch — elabftw cohort-retro lesson: one call, N entities
  // -----------------------------------------------------------------

  server.tool(
    'chem_get_bulk',
    'Fetch up to 50 elements of the same kind in one tool call, with shared ' +
      'chemistry-aware rendering. Requests are chunked into groups of 8 to avoid ' +
      'opening 50 sockets at once; any id that fails aborts the whole call with ' +
      'the offending id surfaced in the error. ' +
      'Use this for cohort-style review (e.g. "walk me through the last 25 ' +
      'reactions in collection X with their analyses") instead of issuing 25 ' +
      'separate `chem_get_reaction` tool calls.',
    {
      kind: elementKindSchema,
      ids: z
        .array(positiveInt)
        .min(1)
        .max(50)
        .describe('Element ids, same `kind` for all. Max 50.'),
    },
    async (args) => {
      const { kind, ids } = args as {
        kind: ChemotionElementType;
        ids: number[];
      };
      return guard(
        async () => {
          const factories = ids.map((id) => async () => {
            try {
              return { id, entity: await fetchEntity(client, kind, id) };
            } catch (error) {
              const reason = error instanceof Error ? error.message : String(error);
              throw new Error(`${kind} #${id} failed: ${reason}`);
            }
          });
          return chunkedAll(factories, 8);
        },
        (results) => {
          if (results.length === 0) return text('No entities requested.');
          const blocks = results.map(({ id, entity }, i) => {
            const body = formatEntity(kind, entity, formatOpts);
            return `<!-- result ${i + 1}/${results.length} · ${kind} #${id} -->\n${body}`;
          });
          return text(blocks.join('\n\n---\n\n'));
        }
      );
    }
  );

  // Silence "unused" warning — we may surface it in a future phase.
  void ELEMENT_TYPE_PLURAL;
  void formatContainerTree;
}
