/**
 * MCP write tools for Chemotion ELN.
 *
 * All writes are gated on `config.allowWrites`. Destructive writes
 * (hard-delete) additionally require `config.allowDestructive` — and
 * note that Chemotion deletes are hard-deletes, not soft-deletes
 * (contrast with elabftw). Tool descriptions spell this out so the
 * LLM surfaces the stakes to the user before invoking.
 *
 * The Grape contract requires hidden state on every PUT: `container`
 * everywhere, `materials` on reactions, the id arrays on screens, and
 * (in practice) `wells` on wellplates. Update tools make these
 * optional and the client fills omitted ones from the entity's current
 * state, so a plain "rename this" call cannot drop participants,
 * wells, or links. Callers only send them to change them.
 *
 * Annotations: `CREATE` for additive tools, `UPDATE` for tools that
 * overwrite fields, `DELETE` for deletes.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  type ChemotionClient,
  type ContainerPayload,
  type ReactionMaterialEntry,
  type ResearchPlanBlock,
  type ResearchPlanFieldType,
  type ResearchPlanKetcherValue,
  type ResearchPlanQuillDelta,
  type ResearchPlanTableValue,
  type ResearchPlanUpdateBody,
  EMPTY_ROOT_CONTAINER,
  cloneReactionMaterials,
} from '../../client/index.js';
import type { ChemotionMcpConfig } from '../config.js';
import {
  CREATE,
  DELETE,
  READ,
  UPDATE,
  errorText,
  guard,
  positiveInt,
  text,
  writeDisabledResponse,
} from './helpers.js';

// ---------------------------------------------------------------------
// Shared zod shapes
// ---------------------------------------------------------------------

const containerPayloadSchema = z
  .record(z.string(), z.unknown())
  .describe(
    'The Chemotion container Hash that carries the analyses tree. ' +
      'Usually omit it: create uses an empty root container and update ' +
      'keeps the current tree. Only pass it to edit analyses; the server ' +
      'merges children and removes only those flagged `is_deleted: true`.'
  );

const amountUnitSchema = z.enum(['g', 'mg', 'l', 'ml', 'mol', 'mmol']);

const reactionMaterialEntrySchema = z
  .object({
    id: positiveInt
      .optional()
      .describe(
        'Existing sample id. Omit when minting a new sample inline inside the reaction payload.'
      ),
    reference: z
      .boolean()
      .optional()
      .describe(
        'Reference-material flag Chemotion uses for equivalents / yield calculations.'
      ),
    equivalent: z
      .number()
      .optional()
      .describe(
        'Stoichiometric equivalent for reagents or solvent ratio for solvents. This is the singular field name Chemotion returns on GET/PUT.'
      ),
    equivalents: z
      .number()
      .optional()
      .describe(
        'Legacy alias accepted by some older payload examples. Prefer `equivalent`; Chemotion normalizes to the singular form on readback.'
      ),
    coefficient: z
      .number()
      .optional()
      .describe('Stoichiometric coefficient.'),
    position: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('0-based position within the role bucket.'),
    amount_value: z
      .number()
      .optional()
      .describe('Nominal amount / volume value when the caller uses the generic amount fields.'),
    amount_unit: amountUnitSchema
      .optional()
      .describe('Unit for `amount_value`.'),
    real_amount_value: z
      .number()
      .optional()
      .describe('Actual charged amount / volume. Use with `real_amount_unit`.'),
    real_amount_unit: amountUnitSchema
      .optional()
      .describe('Unit for `real_amount_value`. For solvents this is typically `ml`.'),
    target_amount_value: z
      .number()
      .optional()
      .describe('Target amount / volume. Use with `target_amount_unit`.'),
    target_amount_unit: amountUnitSchema
      .optional()
      .describe('Unit for `target_amount_value`. For solvents this is typically `ml`.'),
    molarity_value: z
      .number()
      .optional()
      .describe('Participant molarity / concentration value when applicable.'),
    molarity_unit: z
      .string()
      .optional()
      .describe('Unit for `molarity_value`, e.g. `mmol/l`.'),
    density: z
      .number()
      .optional()
      .describe('Density in g/mL. Useful for solvent rows.'),
    yield: z
      .number()
      .optional()
      .describe('Yield on product rows. Chemotion may store this as a decimal fraction or as percent-like numbers.'),
    waste: z
      .boolean()
      .optional()
      .describe('Mark the participant as waste.'),
  })
  .catchall(z.unknown())
  .describe(
    'Reaction participant row. Existing samples are usually referenced by `id`, but callers can also inline a full sample-like shape to mint a new sample during reaction creation.'
  );

const reactionMaterialsSchema = z
  .object({
    starting_materials: z.array(reactionMaterialEntrySchema).optional(),
    reactants: z.array(reactionMaterialEntrySchema).optional(),
    products: z.array(reactionMaterialEntrySchema).optional(),
    solvents: z.array(reactionMaterialEntrySchema).optional(),
    purification_solvents: z.array(reactionMaterialEntrySchema).optional(),
  })
  .catchall(z.unknown())
  .describe(
    'Reaction participants keyed by role. Shape: ' +
      '`{starting_materials:[{id,reference,equivalent,position,real_amount_*,target_amount_*}], ' +
      'reactants:[...], products:[...], solvents:[...]}`. ' +
      'Each entry references an existing sample by `id`, or mints a ' +
      'new sample inline by carrying the full sample shape. Participant rows can ' +
      'also carry amount / volume / molarity fields. On update this REPLACES all ' +
      'participants: rows left out are destroyed and fields left out of a row are ' +
      'saved as empty. Start from `chem_get_update_payload`, or omit `materials` ' +
      'to keep the current participants.'
  );

// ---------------------------------------------------------------------
// Subsample-shape reaction material helpers
// ---------------------------------------------------------------------
//
// Chemotion's UI never attaches a bare existing sample id to a reaction.
// When a user drags a stock sample into a reactant slot, the frontend
// sends a subsample-shape row:
//   { id: <client-side uuid>, is_new: true, is_split: true,
//     parent_id: <stock id>, real_amount_value, … }
// The server sees `is_split && parent_id` and calls
// `create_sub_sample(parent)` — dup-ing the stock into a new sample
// with its own container, short_label, and a `parent_id` link. The
// stock is untouched, so one stock bottle can drive many reactions.
//
// If we PUT a bare `{id: <existing>}` into a bucket, the handler at
// `app/usecases/reactions/update_materials.rb` does
// `ReactionsSample.find_by(sample_id:)` UNSCOPED by reaction_id — it
// finds the pre-existing join row on whichever reaction currently owns
// the sample and `update!`s its `reaction_id` + `type`, effectively
// MOVING the row instead of creating a new one. The original reaction
// silently loses its link. Always emit the subsample shape, never the
// bare id — that's what these helpers enforce.

/** Build a subsample participant row for reactants / SMs / solvents. */
function buildSubsampleEntry(args: {
  parent_id: number;
  position: number;
  reference?: boolean;
  equivalent?: number;
  real_amount_value?: number;
  real_amount_unit?: string;
  target_amount_value?: number;
  target_amount_unit?: string;
  molarity_value?: number;
  molarity_unit?: string;
  density?: number;
  coefficient?: number;
  waste?: boolean;
}): ReactionMaterialEntry {
  const entry: ReactionMaterialEntry & Record<string, unknown> = {
    id: randomUUID(),
    is_new: true,
    is_split: true,
    parent_id: args.parent_id,
    position: args.position,
  };
  if (args.reference != null) entry.reference = args.reference;
  if (args.equivalent != null) entry.equivalent = args.equivalent;
  if (args.real_amount_value != null) entry.real_amount_value = args.real_amount_value;
  if (args.real_amount_unit != null) entry.real_amount_unit = args.real_amount_unit;
  if (args.target_amount_value != null) entry.target_amount_value = args.target_amount_value;
  if (args.target_amount_unit != null) entry.target_amount_unit = args.target_amount_unit;
  if (args.molarity_value != null) entry.molarity_value = args.molarity_value;
  if (args.molarity_unit != null) entry.molarity_unit = args.molarity_unit;
  if (args.density != null) entry.density = args.density;
  if (args.coefficient != null) entry.coefficient = args.coefficient;
  if (args.waste != null) entry.waste = args.waste;
  return entry;
}

/** Build a product participant row — fresh sample, optionally `parent_id`-linked. */
function buildProductEntry(args: {
  reaction_id: number;
  position: number;
  molfile?: string;
  source_sample_id?: number;
  name?: string;
  short_label?: string;
  description?: string;
  real_amount_value?: number;
  real_amount_unit?: string;
  target_amount_value?: number;
  target_amount_unit?: string;
  yield?: number;
  purity?: number;
  decoupled?: boolean;
  sum_formula?: string;
}): ReactionMaterialEntry {
  const entry: ReactionMaterialEntry & Record<string, unknown> = {
    id: randomUUID(),
    is_new: true,
    position: args.position,
    container: EMPTY_ROOT_CONTAINER,
  };
  if (args.source_sample_id != null) {
    entry.is_split = true;
    entry.parent_id = args.source_sample_id;
  }
  if (args.molfile != null) entry.molfile = args.molfile;
  entry.name =
    args.name ?? `reaction-${args.reaction_id} product`;
  if (args.short_label != null) entry.short_label = args.short_label;
  if (args.description != null) entry.description = args.description;
  if (args.decoupled === true) entry.decoupled = true;
  if (args.sum_formula != null) entry.sum_formula = args.sum_formula;
  if (args.purity != null) entry.purity = args.purity;
  if (args.real_amount_value != null) entry.real_amount_value = args.real_amount_value;
  if (args.real_amount_unit != null) entry.real_amount_unit = args.real_amount_unit;
  if (args.target_amount_value != null) entry.target_amount_value = args.target_amount_value;
  if (args.target_amount_unit != null) entry.target_amount_unit = args.target_amount_unit;
  if (args.yield != null) entry.yield = args.yield;
  return entry;
}

const researchPlanBodySchema = z
  .array(z.record(z.string(), z.unknown()))
  .describe(
    'Typed-block array. Minimal block: ' +
      '`{"id":"<uuid>","type":"richtext","value":{"ops":[{"insert":"hello"}]},"title":""}`. ' +
      'Supported types: `richtext`, `text`, `table`, `image`, `sample`, ' +
      '`reaction`, `ketcher`, `attachment`.'
  );

const researchPlanFieldTypeSchema = z
  .enum(['richtext', 'text', 'table', 'sample', 'reaction', 'ketcher'])
  .describe(
    'Research-plan field type. Supported field-edit flows currently cover ' +
      '`richtext`/`text`, `table`, `sample`, `reaction`, and `ketcher` ' +
      '(molecule) blocks.'
  );

const researchPlanQuillDeltaSchema = z
  .object({
    ops: z.array(z.record(z.string(), z.unknown())),
  })
  .catchall(z.unknown())
  .describe(
    'Quill delta payload for `richtext` / `text` research-plan fields, ' +
      'e.g. `{ops:[{insert:"hello\\n"}]}`.'
  );

const researchPlanTableColumnSchema = z
  .object({
    headerName: z.string().optional(),
    field: z.string().optional(),
    colId: z.string().optional(),
    key: z.string().optional(),
    name: z.string().optional(),
    width: z.number().optional(),
    editable: z.boolean().optional(),
    resizable: z.boolean().optional(),
    linkType: z.enum(['sample', 'reaction']).optional(),
  })
  .catchall(z.unknown());

const researchPlanTableValueSchema = z
  .object({
    columns: z.array(researchPlanTableColumnSchema),
    rows: z.array(z.record(z.string(), z.unknown())),
    columnStates: z.array(z.record(z.string(), z.unknown())).optional(),
    startCollapsed: z.boolean().optional(),
  })
  .catchall(z.unknown())
  .describe(
    'Research-plan table payload. Minimal shape: ' +
      '`{columns:[{headerName,field,colId}], rows:[{<field>:<cell>}]}`. ' +
      'Chemotion also stores optional `columnStates` and `startCollapsed`.'
  );

const researchPlanNullableRefSchema = z
  .union([positiveInt, z.null()])
  .describe('Reference id, or `null` to clear the existing reference.');

const researchPlanPreviewAttachmentSchema = z
  .record(z.string(), z.unknown())
  .nullable()
  .optional();

// Extended sample fields that the Chemotion web UI exposes but our first
// pass of tools did not surface. Physical properties (MP/BP/flash/RI),
// form/color/solubility catalogue fields, CAS number, and the "Anhydrous"
// checkbox (which the server stores as `dry_solvent`). Most live in the
// free-form `xref` Hash; the UI writes them via `xref_<key>` accessors,
// so we mirror the same keys.
const sampleXrefSchema = z
  .object({
    cas: z
      .string()
      .optional()
      .describe('CAS registry number, e.g. "64-17-5" for ethanol.'),
    inventory_label: z
      .string()
      .optional()
      .describe('Inventory barcode / tag label.'),
    color: z
      .string()
      .optional()
      .describe('Physical colour, e.g. "blue crystals", "colourless".'),
    form: z
      .string()
      .optional()
      .describe(
        'Physical form, e.g. "powder", "oil", "octahedral crystals".'
      ),
    solubility: z
      .string()
      .optional()
      .describe('Solubility notes, e.g. "soluble in water, DMF; insoluble in hexane".'),
    flash_point: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        'Flash point as an object `{value: "<number>", unit: "°C"|"°F"}` ' +
          '(Chemotion stores it as a Hash, not a bare number).'
      ),
    refractive_index: z
      .union([z.string(), z.number()])
      .optional()
      .describe('Refractive index nD at 20 °C, e.g. "1.3611" for ethanol.'),
  })
  .catchall(z.unknown())
  .optional()
  .describe(
    'Extra property fields the Chemotion UI renders in the sample ' +
      'Properties tab but that live inside the `xref` JSONB column on ' +
      'the Sample model. Unknown keys pass through — the server stores ' +
      'anything you ship under `xref`.'
  );

const sampleExtraFieldsSchema = {
  dry_solvent: z
    .boolean()
    .optional()
    .describe(
      'Corresponds to the "Anhydrous" checkbox in the UI. Flags a ' +
        'solvent sample as moisture-free.'
    ),
  sum_formula: z
    .string()
    .optional()
    .describe(
      'Molecular formula. Auto-derived from the molfile for structured ' +
        'samples; set explicitly for decoupled samples (e.g. "Cu3(C9H3O6)2" ' +
        'for HKUST-1) so collections list and reports have a formula to show.'
    ),
  sample_type: z
    .enum(['Micromolecule', 'Mixture'])
    .optional()
    .describe(
      'Chemotion sample taxonomy. Default `Micromolecule`. Use `Mixture` ' +
        'for multi-component samples (consumes `sample_details` too).'
    ),
  sample_details: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'Extra parameters for Mixture / Polymer samples — component list, ' +
        'weight_percentages, etc. Freeform Hash.'
    ),
  molarity_value: z.number().optional(),
  molarity_unit: z
    .string()
    .optional()
    .describe('Molarity unit, typically "M" or "mM".'),
  boiling_point_lowerbound: z
    .number()
    .optional()
    .describe(
      'Boiling point lower bound in °C. Pair with `boiling_point_upperbound` ' +
        'to set a range; pass the same value in both for a sharp BP.'
    ),
  boiling_point_upperbound: z.number().optional().describe('Boiling point upper bound in °C.'),
  melting_point_lowerbound: z
    .number()
    .optional()
    .describe(
      'Melting point lower bound in °C. Pair with `melting_point_upperbound`.'
    ),
  melting_point_upperbound: z.number().optional().describe('Melting point upper bound in °C.'),
  xref: sampleXrefSchema,
} as const;

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeResearchPlanContainer(
  container: unknown
): ContainerPayload {
  if (container && typeof container === 'object') {
    return cloneJson(container as ContainerPayload);
  }
  return cloneJson(EMPTY_ROOT_CONTAINER);
}

function defaultResearchPlanTableValue(): ResearchPlanTableValue {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
  const columns = ids.map((id) => ({
    headerName: id,
    field: id,
    colId: id,
  }));
  const blankRow = Object.fromEntries(ids.map((id) => [id, '']));
  return {
    columns,
    rows: [cloneJson(blankRow), cloneJson(blankRow), cloneJson(blankRow)],
  };
}

function textToQuillDelta(text: string): ResearchPlanQuillDelta | string {
  if (text.length === 0) return '';
  return {
    ops: [
      {
        insert: text.endsWith('\n') ? text : `${text}\n`,
      },
    ],
  };
}

function clampInsertIndex(index: number | undefined, size: number): number {
  if (index == null) return size;
  return Math.max(0, Math.min(index, size));
}

function listResearchPlanWellplateIds(
  plan: Record<string, unknown>
): number[] | undefined {
  const wellplates = plan.wellplates;
  if (!Array.isArray(wellplates)) return undefined;
  const ids = wellplates
    .map((wellplate) =>
      wellplate &&
      typeof wellplate === 'object' &&
      'id' in wellplate &&
      typeof wellplate.id === 'number'
        ? wellplate.id
        : null
    )
    .filter((id): id is number => id !== null);
  return ids.length ? ids : undefined;
}

type ResearchPlanFieldMutationArgs = {
  title?: string;
  text?: string;
  delta?: ResearchPlanQuillDelta;
  table?: ResearchPlanTableValue;
  sample_id?: number | null;
  reaction_id?: number | null;
  sdf_file?: string | null;
  svg_file?: string | null;
  svg_markup?: string;
  is_chemdraw?: boolean;
  preview_attachment?: Record<string, unknown> | null;
};

async function buildResearchPlanFieldBlock(
  client: ChemotionClient,
  fieldType: ResearchPlanFieldType,
  input: ResearchPlanFieldMutationArgs & {
    field_id?: string;
  }
): Promise<ResearchPlanBlock> {
  if (input.text !== undefined && input.delta !== undefined) {
    throw new Error('Provide either `text` or `delta`, not both.');
  }
  if (input.svg_markup !== undefined && input.svg_file !== undefined) {
    throw new Error('Provide either `svg_markup` or `svg_file`, not both.');
  }

  switch (fieldType) {
    case 'richtext':
    case 'text':
      return {
        id: input.field_id ?? randomUUID(),
        type: fieldType,
        title: input.title ?? 'Text',
        value:
          input.delta !== undefined
            ? cloneJson(input.delta)
            : input.text !== undefined
              ? textToQuillDelta(input.text)
              : '',
      };
    case 'table':
      return {
        id: input.field_id ?? randomUUID(),
        type: 'table',
        title: input.title,
        value: cloneJson(input.table ?? defaultResearchPlanTableValue()),
      };
    case 'sample':
      return {
        id: input.field_id ?? randomUUID(),
        type: 'sample',
        title: input.title,
        value: {
          sample_id: input.sample_id ?? null,
        },
      };
    case 'reaction':
      return {
        id: input.field_id ?? randomUUID(),
        type: 'reaction',
        title: input.title,
        value: {
          reaction_id: input.reaction_id ?? null,
        },
      };
    case 'ketcher': {
      let svgFile = input.svg_file ?? null;
      if (input.svg_markup !== undefined) {
        const response = await client.saveResearchPlanSvg(
          input.svg_markup,
          input.is_chemdraw ?? false
        );
        svgFile = response.svg_path;
      }
      const value: ResearchPlanKetcherValue = {
        svg_file: svgFile,
        preview_attachment:
          input.preview_attachment === undefined ? null : cloneJson(input.preview_attachment),
      };
      if (input.sdf_file !== undefined) value.sdf_file = input.sdf_file;
      return {
        id: input.field_id ?? randomUUID(),
        type: 'ketcher',
        title: input.title,
        value,
      };
    }
  }

  throw new Error(`Unsupported research-plan field type "${fieldType}".`);
}

async function patchResearchPlanFieldBlock(
  client: ChemotionClient,
  block: ResearchPlanBlock,
  patch: ResearchPlanFieldMutationArgs
): Promise<ResearchPlanBlock> {
  if (patch.text !== undefined && patch.delta !== undefined) {
    throw new Error('Provide either `text` or `delta`, not both.');
  }
  if (patch.svg_markup !== undefined && patch.svg_file !== undefined) {
    throw new Error('Provide either `svg_markup` or `svg_file`, not both.');
  }

  const next = cloneJson(block);
  if (patch.title !== undefined) next.title = patch.title;

  switch (block.type) {
    case 'richtext':
    case 'text':
      if (patch.delta !== undefined) {
        next.value = cloneJson(patch.delta);
      } else if (patch.text !== undefined) {
        next.value = textToQuillDelta(patch.text);
      }
      return next;
    case 'table':
      if (patch.table !== undefined) {
        next.value = cloneJson(patch.table);
      }
      return next;
    case 'sample': {
      if (patch.sample_id === undefined) return next;
      next.value = {
        ...(next.value && typeof next.value === 'object'
          ? cloneJson(next.value as Record<string, unknown>)
          : {}),
        sample_id: patch.sample_id,
      };
      return next;
    }
    case 'reaction': {
      if (patch.reaction_id === undefined) return next;
      next.value = {
        ...(next.value && typeof next.value === 'object'
          ? cloneJson(next.value as Record<string, unknown>)
          : {}),
        reaction_id: patch.reaction_id,
      };
      return next;
    }
    case 'ketcher': {
      const value =
        next.value && typeof next.value === 'object'
          ? cloneJson(next.value as Record<string, unknown>)
          : {};
      if (patch.sdf_file !== undefined) value.sdf_file = patch.sdf_file;
      if (patch.preview_attachment !== undefined) {
        value.preview_attachment = patch.preview_attachment;
      }
      if (patch.svg_markup !== undefined) {
        const response = await client.saveResearchPlanSvg(
          patch.svg_markup,
          patch.is_chemdraw ?? false
        );
        value.svg_file = response.svg_path;
      } else if (patch.svg_file !== undefined) {
        value.svg_file = patch.svg_file;
      }
      next.value = value;
      return next;
    }
    default:
      throw new Error(
        `Research-plan field type "${String(block.type)}" is not supported by the field patch tool.`
      );
  }
}

/** Re-number `position` after an insert so rows stay 0..n-1 in order. */
function renumberPositions(rows: Array<Record<string, unknown>>): void {
  rows.forEach((row, index) => {
    row.position = index;
  });
}

function lockedNote(response: { locked_sample_ids?: number[] } | undefined): string {
  const locked = response?.locked_sample_ids;
  return locked?.length
    ? ` Samples kept because a reaction or wellplate still uses them: ${locked.map((id) => `#${id}`).join(', ')}.`
    : '';
}

// ---------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------

export function registerWriteTools(
  server: McpServer,
  client: ChemotionClient,
  config: ChemotionMcpConfig
): void {
  if (!config.allowWrites) {
    // Expose a single diagnostic tool in place of the real write set so
    // the LLM discovers the gate explicitly rather than wondering why
    // the write tools are missing.
    server.registerTool(
    'chem_writes_disabled',
    {
      title: 'Writes disabled',
      description:
        'Placeholder — writes are disabled on this Chemotion MCP. Set ' +
          'CHEMOTION_ALLOW_WRITES=true (and CHEMOTION_ALLOW_DESTRUCTIVE=true ' +
          'for deletes) to enable create/update/delete tools.',
      annotations: READ,
    },
    async () => writeDisabledResponse()
  );
    return;
  }

  // -------------------------------------------------------------------
  // Samples
  // -------------------------------------------------------------------

  server.registerTool(
    'chem_create_sample',
    {
      title: 'Create sample',
      description:
        'Create a new sample in a collection. Chemotion requires target ' +
        'amount + unit, purity, description, location, and an ' +
        '`is_top_secret` boolean. Pass `molfile` OR `molecule_id` to link ' +
        'structure; omit both only when creating a decoupled sample (set ' +
        '`decoupled: true`). Returns the created sample id + short_label.',
      inputSchema: {
        collection_id: positiveInt.describe(
          'Target collection. Use `chem_list_collections` to find the id. ' +
            'The sample is also added to the "all" collection automatically.'
        ),
        name: z.string().optional(),
        short_label: z
          .string()
          .optional()
          .describe(
            'Human-readable label (e.g. "ABC-42"). Auto-generated from the ' +
              'user prefix + counter when omitted.'
          ),
        external_label: z.string().optional(),
        description: z.string().describe('Markdown allowed. Required.'),
        purity: z
          .number()
          .min(0)
          .max(1)
          .describe('Decimal fraction 0..1, not percent.'),
        target_amount_value: z.number(),
        target_amount_unit: z
          .enum(['g', 'mg', 'l', 'ml', 'mol', 'mmol'])
          .describe('Chemotion amount units.'),
        real_amount_value: z.number().optional(),
        real_amount_unit: z
          .enum(['g', 'mg', 'l', 'ml', 'mol', 'mmol'])
          .optional(),
        location: z
          .string()
          .describe(
            'Physical storage location string (e.g. "shelf A / box 3"). ' +
              'Required by Grape; pass an empty string if unknown.'
          ),
        is_top_secret: z.boolean().default(false),
        molfile: z
          .string()
          .optional()
          .describe(
            'V2000 molfile. Provide this or `molecule_id`; otherwise set ' +
              '`decoupled=true` for a sample without structure.'
          ),
        molecule_id: positiveInt
          .optional()
          .describe(
            'Existing Molecule id, e.g. from `chem_search`. Mutually ' +
              'exclusive with `molfile` — passing both makes `molfile` win.'
          ),
        density: z.number().optional(),
        decoupled: z.boolean().optional(),
        stereo: z
          .object({
            abs: z.string().optional(),
            rel: z.string().optional(),
          })
          .optional(),
        ...sampleExtraFieldsSchema,
        container: containerPayloadSchema.optional(),
      },
      annotations: CREATE,
    },
    async (input) => {
      return guard(
        () =>
          client.createSample({
            ...input,
            container: input.container ?? EMPTY_ROOT_CONTAINER,
          }),
        (response) => {
          const sample = response.sample;
          if (!sample || typeof sample.id !== 'number') {
            return errorText(
              'Create succeeded but Chemotion returned no sample envelope.'
            );
          }
          const label = sample.short_label ?? sample.name ?? '(unnamed)';
          return text(
            `Created sample #${sample.id} ${label} in collection ${input.collection_id}.`
          );
        }
      );
    }
  );

  server.registerTool(
    'chem_update_sample',
    {
      title: 'Update sample',
      description:
        'Patch fields on an existing sample. Any field omitted is left ' +
        'unchanged, including the analyses `container`. Returns the ' +
        'refreshed sample id + short_label.',
      inputSchema: {
        id: positiveInt,
        container: containerPayloadSchema.optional(),
        name: z.string().optional(),
        external_label: z.string().optional(),
        description: z.string().optional(),
        purity: z.number().min(0).max(1).optional(),
        target_amount_value: z.number().optional(),
        target_amount_unit: z
          .enum(['g', 'mg', 'l', 'ml', 'mol', 'mmol'])
          .optional(),
        real_amount_value: z.number().optional(),
        real_amount_unit: z
          .enum(['g', 'mg', 'l', 'ml', 'mol', 'mmol'])
          .optional(),
        location: z.string().optional(),
        is_top_secret: z.boolean().optional(),
        molfile: z.string().optional(),
        density: z.number().optional(),
        decoupled: z.boolean().optional(),
        stereo: z
          .object({
            abs: z.string().optional(),
            rel: z.string().optional(),
          })
          .optional(),
        ...sampleExtraFieldsSchema,
      },
      annotations: UPDATE,
    },
    async ({ id, ...rest }) => {
      return guard(
        () => client.updateSample(id, rest),
        (response) => {
          const sample = response.sample;
          const label =
            sample?.short_label ?? sample?.name ?? `sample-${id}`;
          return text(`Updated sample #${id} ${label}.`);
        }
      );
    }
  );

  // -------------------------------------------------------------------
  // Reactions
  // -------------------------------------------------------------------

  server.registerTool(
    'chem_create_reaction',
    {
      title: 'Create reaction',
      description:
        'Create a new reaction. Requires `collection_id` and `materials` ' +
        '(sample refs by role). Chemotion derives `short_label` and ' +
        'auto-computes the scheme on save; you can optionally supply ' +
        '`name`, `rxno` (RInChI-style reaction class), and temperature/ ' +
        'duration. Material rows can carry reagent amounts and solvent ' +
        'volumes via `real_amount_*` / `target_amount_*`. Products without ' +
        'reactants are legal but rare.',
      inputSchema: {
        collection_id: positiveInt,
        name: z.string().optional(),
        short_label: z.string().optional(),
        description: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            'Quill-delta rich text hash: `{ops:[{insert:"..."}]}`. ' +
              'Plain-string descriptions go here wrapped in the delta shape.'
          ),
        observation: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Quill-delta hash, same shape as `description`.'),
        purification: z
          .array(z.string())
          .optional()
          .describe('Tag list (e.g. `["Column","Recryst."]`).'),
        solvent: z.string().optional(),
        status: z
          .enum([
            'Planned',
            'Running',
            'Done',
            'Analyses Pending',
            'Successful',
            'Not Successful',
          ])
          .optional(),
        role: z
          .enum(['single', 'gp', 'parts'])
          .optional()
          .describe('Single / general procedure / parts-of-GP.'),
        temperature: z.record(z.string(), z.unknown()).optional(),
        duration: z.string().optional().describe('e.g. "18 Hour(s)".'),
        rxno: z
          .string()
          .optional()
          .describe('Optional RInChI-style reaction class (e.g. "rxno:00014").'),
        materials: reactionMaterialsSchema,
        container: containerPayloadSchema.optional(),
      },
      annotations: CREATE,
    },
    async (input) => {
      return guard(
        () =>
          client.createReaction({
            ...input,
            container: input.container ?? EMPTY_ROOT_CONTAINER,
          }),
        (response) => {
          const reaction = response.reaction;
          if (!reaction || typeof reaction.id !== 'number') {
            return errorText(
              'Create succeeded but Chemotion returned no reaction envelope.'
            );
          }
          const label =
            reaction.short_label ?? reaction.name ?? '(unnamed)';
          return text(
            `Created reaction #${reaction.id} ${label} in collection ${input.collection_id}.`
          );
        }
      );
    }
  );

  server.registerTool(
    'chem_update_reaction',
    {
      title: 'Update reaction',
      description:
        'Patch fields on an existing reaction. Omit `materials` and ' +
        '`container` to keep the current participants and analyses — the ' +
        'tool sends the server\'s current values back. Pass `materials` only ' +
        'to edit participants, starting from ' +
        '`chem_get_update_payload(kind="reaction", id=...)`: it replaces ' +
        'every role bucket. To add a participant use ' +
        '`chem_attach_reaction_material` / `chem_attach_reaction_product`.',
      inputSchema: {
        id: positiveInt,
        materials: reactionMaterialsSchema.optional(),
        container: containerPayloadSchema.optional(),
        name: z.string().optional(),
        description: z.record(z.string(), z.unknown()).optional(),
        observation: z.record(z.string(), z.unknown()).optional(),
        purification: z.array(z.string()).optional(),
        solvent: z.string().optional(),
        status: z.string().optional(),
        role: z.string().optional(),
        temperature: z.record(z.string(), z.unknown()).optional(),
        duration: z.string().optional(),
        rxno: z.string().optional(),
      },
      annotations: UPDATE,
    },
    async ({ id, ...rest }) => {
      return guard(
        () => client.updateReaction(id, rest),
        (response) => {
          const reaction = response.reaction;
          const label =
            reaction?.short_label ?? reaction?.name ?? `reaction-${id}`;
          return text(`Updated reaction #${id} ${label}.`);
        }
      );
    }
  );

  server.registerTool(
    'chem_attach_reaction_material',
    {
      title: 'Attach reaction material',
      description:
        'Attach a sample to a reaction as a `starting_materials` / ' +
        '`reactants` / `solvents` / `purification_solvents` row via ' +
        "Chemotion's subsample mechanism. This is the safe equivalent of " +
        'dragging a stock bottle from the inventory into a reaction slot: ' +
        'the server `dup`s the stock sample into a new subsample with ' +
        '`parent_id` pointing back to the stock, attaches the subsample to ' +
        'the reaction, and leaves the stock untouched and reusable in other ' +
        'reactions. ' +
        'Why this tool exists: passing a bare existing `sample_id` to ' +
        "`chem_update_reaction`'s materials hits a handler that does " +
        '`ReactionsSample.find_by(sample_id:)` unscoped by reaction_id, ' +
        'which silently MOVES the row from whichever reaction currently ' +
        'owns the sample — you lose the link on the old reaction with a ' +
        '200 OK. This tool never passes a bare id; it always mints a ' +
        'subsample, so stock samples stay browsable in inventory and one ' +
        'stock bottle can drive many reactions.',
      inputSchema: {
        reaction_id: positiveInt.describe('Target reaction id.'),
        role: z
          .enum([
            'starting_materials',
            'reactants',
            'solvents',
            'purification_solvents',
          ])
          .describe(
            'Which bucket on the reaction to attach to. Products are ' +
              'handled by `chem_attach_reaction_product` (which creates a ' +
              'fresh product sample rather than splitting a stock).'
          ),
        source_sample_id: positiveInt.describe(
          'Existing stock sample id to split from. The stock is not ' +
            'modified; the server clones it into a new subsample with ' +
            '`parent_id = source_sample_id` and attaches the subsample.'
        ),
        real_amount_value: z
          .number()
          .optional()
          .describe('Actual charged amount / volume in this reaction.'),
        real_amount_unit: amountUnitSchema
          .optional()
          .describe(
            'Unit for `real_amount_value`. For solvents this is typically `ml`.'
          ),
        target_amount_value: z
          .number()
          .optional()
          .describe('Target amount / volume. Use with `target_amount_unit`.'),
        target_amount_unit: amountUnitSchema.optional(),
        equivalent: z
          .number()
          .optional()
          .describe(
            'Stoichiometric equivalent for reagents or ratio for solvents.'
          ),
        reference: z
          .boolean()
          .optional()
          .describe(
            'Reference-material flag Chemotion uses for equivalents / yield ' +
              'calculations. Typically `true` for the limiting SM.'
          ),
        position: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            '0-based position within the bucket. Omit to append at the end.'
          ),
        molarity_value: z.number().optional(),
        molarity_unit: z
          .string()
          .optional()
          .describe('e.g. `M` or `mmol/l`.'),
        density: z
          .number()
          .optional()
          .describe('Density in g/mL. Helpful for solvent rows.'),
        coefficient: z.number().optional(),
        waste: z.boolean().optional(),
      },
      annotations: CREATE,
    },
    async (input) => {
      return guard(
        async () => {
          const { reaction } = await client.getReaction(input.reaction_id);
          const materials = cloneReactionMaterials(reaction);
          const bucket = materials[input.role];
          const position = input.position ?? bucket.length;
          bucket.splice(
            Math.min(position, bucket.length),
            0,
            buildSubsampleEntry({
              parent_id: input.source_sample_id,
              position,
              reference: input.reference,
              equivalent: input.equivalent,
              real_amount_value: input.real_amount_value,
              real_amount_unit: input.real_amount_unit,
              target_amount_value: input.target_amount_value,
              target_amount_unit: input.target_amount_unit,
              molarity_value: input.molarity_value,
              molarity_unit: input.molarity_unit,
              density: input.density,
              coefficient: input.coefficient,
              waste: input.waste,
            })
          );
          renumberPositions(bucket);
          return client.updateReaction(input.reaction_id, {
            materials,
            container: reaction.container as ContainerPayload | undefined,
          });
        },
        (response) => {
          const reaction = response.reaction;
          const label =
            reaction?.short_label ?? reaction?.name ?? `reaction-${input.reaction_id}`;
          return text(
            `Attached subsample of stock #${input.source_sample_id} to ${label} (#${input.reaction_id}) as ${input.role}.`
          );
        }
      );
    }
  );

  server.registerTool(
    'chem_attach_reaction_product',
    {
      title: 'Attach reaction product',
      description:
        'Attach a product to a reaction. Mints a fresh product sample ' +
        '(not a subsample of a stock) and attaches it to the `products` ' +
        'bucket. Pass `molfile` + `name` to mint from a structure, or ' +
        '`source_sample_id` to derive the product from an existing stock ' +
        '(creates a child sample with `parent_id` set). ' +
        'Why this tool exists: passing a bare existing `sample_id` to a ' +
        "reaction's `products` array hits the same unscoped " +
        '`ReactionsSample.find_by(sample_id:)` handler that silently moves ' +
        'the row from whichever reaction currently owns the sample. This ' +
        'tool always mints a new sample so downstream reactions that use ' +
        'the intermediate as a starting material keep their link.',
      inputSchema: {
        reaction_id: positiveInt.describe('Target reaction id.'),
        molfile: z
          .string()
          .optional()
          .describe(
            'V2000 molfile for the product structure. Provide this OR ' +
              '`source_sample_id` OR `decoupled: true` with a `sum_formula`.'
          ),
        source_sample_id: positiveInt
          .optional()
          .describe(
            'Existing sample id to mint the product as a child of. Used ' +
              'when you have a reference entry for the compound already ' +
              '(e.g. literature compound in inventory) and want the ' +
              "reaction's product row to be a provenance-linked batch of it."
          ),
        name: z
          .string()
          .optional()
          .describe(
            'Display name for the product sample. Defaults to `reaction-<id> product`.'
          ),
        short_label: z
          .string()
          .optional()
          .describe(
            'Optional short label. Chemotion auto-generates one if omitted.'
          ),
        description: z
          .string()
          .optional()
          .describe('Markdown-allowed description on the product sample.'),
        real_amount_value: z
          .number()
          .optional()
          .describe('Isolated amount / volume.'),
        real_amount_unit: amountUnitSchema.optional(),
        target_amount_value: z.number().optional(),
        target_amount_unit: amountUnitSchema.optional(),
        yield: z
          .number()
          .optional()
          .describe(
            'Isolated yield as a decimal fraction (0.0–1.0), e.g. `0.73` for 73%.'
          ),
        purity: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe('Decimal fraction 0..1.'),
        position: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('0-based position within the products bucket.'),
        decoupled: z
          .boolean()
          .optional()
          .describe(
            'Create as a decoupled sample (no structure). Pair with ' +
              '`sum_formula` for the displayed formula.'
          ),
        sum_formula: z
          .string()
          .optional()
          .describe(
            'Explicit molecular formula for decoupled products, e.g. ' +
              '`Cu2(C40H20N2O8)` for a MOF framework product.'
          ),
      },
      annotations: CREATE,
    },
    async (input) => {
      const hasStructure =
        input.molfile != null ||
        input.source_sample_id != null ||
        (input.decoupled === true && input.sum_formula != null);
      if (!hasStructure) {
        return errorText(
          'Provide one of: `molfile` + `name`, OR `source_sample_id`, ' +
            'OR `decoupled: true` + `sum_formula`. Without a structure ' +
            'hint Chemotion cannot mint the product sample.'
        );
      }
      return guard(
        async () => {
          const { reaction } = await client.getReaction(input.reaction_id);
          const materials = cloneReactionMaterials(reaction);
          const bucket = materials.products;
          const position = input.position ?? bucket.length;
          bucket.splice(
            Math.min(position, bucket.length),
            0,
            buildProductEntry({
              reaction_id: input.reaction_id,
              position,
              molfile: input.molfile,
              source_sample_id: input.source_sample_id,
              name: input.name,
              short_label: input.short_label,
              description: input.description,
              real_amount_value: input.real_amount_value,
              real_amount_unit: input.real_amount_unit,
              target_amount_value: input.target_amount_value,
              target_amount_unit: input.target_amount_unit,
              yield: input.yield,
              purity: input.purity,
              decoupled: input.decoupled,
              sum_formula: input.sum_formula,
            })
          );
          renumberPositions(bucket);
          return client.updateReaction(input.reaction_id, {
            materials,
            container: reaction.container as ContainerPayload | undefined,
          });
        },
        (response) => {
          const reaction = response.reaction;
          const label =
            reaction?.short_label ?? reaction?.name ?? `reaction-${input.reaction_id}`;
          const derivedFrom = input.source_sample_id
            ? ` (derived from sample #${input.source_sample_id})`
            : '';
          return text(
            `Attached product to ${label} (#${input.reaction_id})${derivedFrom}.`
          );
        }
      );
    }
  );

  // -------------------------------------------------------------------
  // Research plans
  // -------------------------------------------------------------------

  server.registerTool(
    'chem_create_research_plan',
    {
      title: 'Create research plan',
      description:
        'Create a new research plan. The `body` is an array of typed ' +
        'blocks (richtext / table / image / sample / reaction / ketcher). ' +
        'Pass `body=[]` for a blank plan and add blocks later via ' +
        '`chem_add_research_plan_field` or `chem_update_research_plan`. ' +
        'Returns the created plan id.',
      inputSchema: {
        name: z.string().min(1),
        collection_id: positiveInt.optional(),
        body: researchPlanBodySchema.optional(),
        container: containerPayloadSchema.optional(),
      },
      annotations: CREATE,
    },
    async (input) => {
      return guard(
        () =>
          client.createResearchPlan({
            ...input,
            body: input.body ?? [],
            container: input.container ?? EMPTY_ROOT_CONTAINER,
          }),
        (response) => {
          const plan = response.research_plan;
          if (!plan || typeof plan.id !== 'number') {
            return errorText(
              'Create succeeded but Chemotion returned no research_plan envelope.'
            );
          }
          return text(
            `Created research plan #${plan.id} "${plan.name ?? input.name}".`
          );
        }
      );
    }
  );

  server.registerTool(
    'chem_update_research_plan',
    {
      title: 'Update research plan',
      description:
        'Patch fields on an existing research plan. Omitted fields stay ' +
        'unchanged, including the analyses `container`. Sending `body` ' +
        'replaces the entire block array; there is no per-block patch. ' +
        'For single-field edits, ' +
        'prefer `chem_add_research_plan_field`, ' +
        '`chem_update_research_plan_field`, and ' +
        '`chem_delete_research_plan_field`.',
      inputSchema: {
        id: positiveInt,
        container: containerPayloadSchema.optional(),
        name: z.string().optional(),
        body: researchPlanBodySchema.optional(),
        wellplate_ids: z.array(z.number().int().positive()).optional(),
      },
      annotations: UPDATE,
    },
    async ({ id, ...rest }) => {
      return guard(
        () => client.updateResearchPlan(id, rest),
        (response) => {
          const plan = response.research_plan;
          const name = plan?.name ?? `plan-${id}`;
          return text(`Updated research plan #${id} "${name}".`);
        }
      );
    }
  );

  server.registerTool(
    'chem_add_research_plan_field',
    {
      title: 'Add research plan field',
      description:
        'Add one field block to an existing research plan without rebuilding ' +
        'the entire `body` array manually. This tool fetches the current ' +
        'plan, preserves `container` and linked `wellplate_ids`, inserts the ' +
        'new field, and PUTs the full body back. Supported block types here ' +
        'are `richtext`/`text`, `table`, `sample`, `reaction`, and `ketcher` ' +
        '(molecule field). For `ketcher`, provide raw `svg_markup` if you ' +
        'want the tool to persist the SVG and store the returned filename.',
      inputSchema: {
        id: positiveInt.describe('Research plan id.'),
        field_type: researchPlanFieldTypeSchema,
        index: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('0-based insert index. Omit to append at the end of the body.'),
        field_id: z
          .string()
          .optional()
          .describe('Optional custom block id. Defaults to a generated UUID.'),
        title: z
          .string()
          .optional()
          .describe('Optional block title. Rich-text blocks default to `Text`.'),
        text: z
          .string()
          .optional()
          .describe('Plain-text content for `richtext` / `text` fields.'),
        delta: researchPlanQuillDeltaSchema.optional(),
        table: researchPlanTableValueSchema.optional(),
        sample_id: researchPlanNullableRefSchema.optional(),
        reaction_id: researchPlanNullableRefSchema.optional(),
        sdf_file: z
          .string()
          .nullable()
          .optional()
          .describe('Molfile / SDF string for a `ketcher` field.'),
        svg_file: z
          .string()
          .nullable()
          .optional()
          .describe(
            'Existing persisted research-plan SVG filename for a `ketcher` field.'
          ),
        svg_markup: z
          .string()
          .optional()
          .describe(
            'Raw SVG markup for a `ketcher` field. The tool persists it via `/research_plans/svg` and stores the returned filename.'
          ),
        is_chemdraw: z
          .boolean()
          .optional()
          .describe('Whether `svg_markup` came from ChemDraw instead of Ketcher.'),
        preview_attachment: researchPlanPreviewAttachmentSchema.describe(
          'Optional `preview_attachment` payload for a `ketcher` field.'
        ),
      },
      annotations: CREATE,
    },
    async (input) => {
      return guard(
        async () => {
          const response = await client.getResearchPlan(input.id);
          const plan = response.research_plan as Record<string, unknown>;
          const body = Array.isArray(plan.body)
            ? cloneJson(plan.body as ResearchPlanBlock[])
            : [];
          const block = await buildResearchPlanFieldBlock(
            client,
            input.field_type,
            input
          );
          const index = clampInsertIndex(input.index, body.length);
          body.splice(index, 0, block);
          const updateBody: ResearchPlanUpdateBody = {
            container: normalizeResearchPlanContainer(plan.container),
            body,
            wellplate_ids: listResearchPlanWellplateIds(plan),
          };
          const updated = await client.updateResearchPlan(input.id, updateBody);
          return {
            fieldId: block.id ?? input.field_id ?? `field-${index}`,
            index,
            plan: updated.research_plan,
          };
        },
        ({ fieldId, index, plan }) =>
          text(
            `Added research-plan field ${fieldId} to #${input.id} "${plan.name ?? `plan-${input.id}`}" at index ${index}.`
          )
      );
    }
  );

  server.registerTool(
    'chem_update_research_plan_field',
    {
      title: 'Update research plan field',
      description:
        'Update one field block inside an existing research plan. This tool ' +
        'fetches the current plan, patches the targeted block by `field_id`, ' +
        'preserves `container` and linked `wellplate_ids`, and PUTs the full ' +
        'body back. Supported block edits here cover `richtext`/`text`, ' +
        '`table`, `sample`, `reaction`, and `ketcher`. Set `index` to move ' +
        'the field to a new position while updating it.',
      inputSchema: {
        id: positiveInt.describe('Research plan id.'),
        field_id: z.string().describe('Stable research-plan block id to patch.'),
        index: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Optional new 0-based index for the field after patching.'),
        title: z.string().optional(),
        text: z
          .string()
          .optional()
          .describe('Plain-text replacement for `richtext` / `text` fields.'),
        delta: researchPlanQuillDeltaSchema.optional(),
        table: researchPlanTableValueSchema.optional(),
        sample_id: researchPlanNullableRefSchema.optional(),
        reaction_id: researchPlanNullableRefSchema.optional(),
        sdf_file: z.string().nullable().optional(),
        svg_file: z.string().nullable().optional(),
        svg_markup: z.string().optional(),
        is_chemdraw: z.boolean().optional(),
        preview_attachment: researchPlanPreviewAttachmentSchema,
      },
      annotations: UPDATE,
    },
    async (input) => {
      return guard(
        async () => {
          const response = await client.getResearchPlan(input.id);
          const plan = response.research_plan as Record<string, unknown>;
          const body = Array.isArray(plan.body)
            ? cloneJson(plan.body as ResearchPlanBlock[])
            : [];
          const currentIndex = body.findIndex((block) => block.id === input.field_id);
          if (currentIndex < 0) {
            throw new Error(
              `Research-plan field ${input.field_id} was not found in plan #${input.id}.`
            );
          }
          const currentBlock = body[currentIndex];
          if (!currentBlock) {
            throw new Error(
              `Research-plan field ${input.field_id} resolved to an empty block slot in plan #${input.id}.`
            );
          }
          const patched = await patchResearchPlanFieldBlock(
            client,
            currentBlock,
            input
          );
          body.splice(currentIndex, 1);
          const nextIndex = clampInsertIndex(input.index, body.length);
          body.splice(nextIndex, 0, patched);
          const updateBody: ResearchPlanUpdateBody = {
            container: normalizeResearchPlanContainer(plan.container),
            body,
            wellplate_ids: listResearchPlanWellplateIds(plan),
          };
          const updated = await client.updateResearchPlan(input.id, updateBody);
          return {
            index: nextIndex,
            plan: updated.research_plan,
            type: patched.type ?? 'unknown',
          };
        },
        ({ index, plan, type }) =>
          text(
            `Updated research-plan field ${input.field_id} (${type}) in #${input.id} "${plan.name ?? `plan-${input.id}`}" at index ${index}.`
          )
      );
    }
  );

  server.registerTool(
    'chem_delete_research_plan_field',
    {
      title: 'Delete research plan field',
      description:
        'Delete one field block from an existing research plan by `field_id`. ' +
        'This tool fetches the current plan, removes the targeted block, ' +
        'preserves `container` and linked `wellplate_ids`, and PUTs the full ' +
        'body back.',
      inputSchema: {
        id: positiveInt.describe('Research plan id.'),
        field_id: z.string().describe('Stable research-plan block id to delete.'),
      },
      annotations: DELETE,
    },
    async (input) => {
      return guard(
        async () => {
          const response = await client.getResearchPlan(input.id);
          const plan = response.research_plan as Record<string, unknown>;
          const body = Array.isArray(plan.body)
            ? cloneJson(plan.body as ResearchPlanBlock[])
            : [];
          const currentIndex = body.findIndex((block) => block.id === input.field_id);
          if (currentIndex < 0) {
            throw new Error(
              `Research-plan field ${input.field_id} was not found in plan #${input.id}.`
            );
          }
          const [removed] = body.splice(currentIndex, 1);
          const updateBody: ResearchPlanUpdateBody = {
            container: normalizeResearchPlanContainer(plan.container),
            body,
            wellplate_ids: listResearchPlanWellplateIds(plan),
          };
          const updated = await client.updateResearchPlan(input.id, updateBody);
          return {
            index: currentIndex,
            plan: updated.research_plan,
            type: removed?.type ?? 'unknown',
          };
        },
        ({ index, plan, type }) =>
          text(
            `Deleted research-plan field ${input.field_id} (${type}) from #${input.id} "${plan.name ?? `plan-${input.id}`}" at former index ${index}.`
          )
      );
    }
  );

  // -------------------------------------------------------------------
  // Wellplates
  // -------------------------------------------------------------------

  server.registerTool(
    'chem_create_wellplate',
    {
      title: 'Create wellplate',
      description:
        'Create a new wellplate. Requires `collection_id`, `name`, and a ' +
        '`container`. `wells` defaults to `[]` which makes Chemotion ' +
        'generate a default `height` × `width` grid (defaults 8 × 12 = ' +
        '96 wells). Pass a populated `wells` array to seed specific ' +
        'sample-to-well assignments. Returns the created wellplate id.',
      inputSchema: {
        collection_id: positiveInt,
        name: z.string().min(1),
        wells: z
          .array(z.record(z.string(), z.unknown()))
          .optional()
          .describe(
            'Array of well-shape hashes. Empty / omitted lets the server ' +
              'generate the default height×width grid. Each populated well ' +
              'typically carries `{position, sample_id?, readouts?, notes?}`.'
          ),
        height: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Rows in the default grid. Server default 8.'),
        width: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Columns in the default grid. Server default 12.'),
        description: z.record(z.string(), z.unknown()).optional(),
        readout_titles: z
          .array(z.record(z.string(), z.unknown()))
          .optional(),
        container: containerPayloadSchema.optional(),
      },
      annotations: CREATE,
    },
    async (args) => {
      const {
        collection_id,
        name,
        wells,
        container,
        ...rest
      } = args as {
        collection_id: number;
        name: string;
        wells?: Array<Record<string, unknown>>;
        container?: ContainerPayload;
      } & Record<string, unknown>;
      return guard(
        () =>
          client.createWellplate({
            ...rest,
            collection_id,
            name,
            wells: wells ?? [],
            container: container ?? EMPTY_ROOT_CONTAINER,
          }),
        (response) => {
          const wp = response.wellplate;
          return text(
            `Created wellplate #${wp?.id} "${wp?.name ?? name}" in collection ${collection_id}.`
          );
        }
      );
    }
  );

  server.registerTool(
    'chem_update_wellplate',
    {
      title: 'Update wellplate',
      description:
        'Patch fields on an existing wellplate. Omitted fields stay unchanged, ' +
        'including `wells` and `container`. DANGER: `wells` replaces the whole ' +
        'layout and Chemotion destroys the samples of every well you leave ' +
        'out — start from `chem_get_update_payload(kind="wellplate", id=...)` ' +
        'and keep every well when editing one.',
      inputSchema: {
        id: positiveInt,
        container: containerPayloadSchema.optional(),
        name: z.string().optional(),
        wells: z
          .array(z.record(z.string(), z.unknown()))
          .optional()
          .describe(
            'Full well layout. Omit to keep it. Samples of wells missing here are destroyed.'
          ),
        description: z.record(z.string(), z.unknown()).optional(),
        readout_titles: z
          .array(z.record(z.string(), z.unknown()))
          .optional(),
      },
      annotations: UPDATE,
    },
    async ({ id, ...rest }) => {
      return guard(
        () => client.updateWellplate(id, rest),
        (response) => {
          const wp = response.wellplate;
          return text(
            `Updated wellplate #${id} "${wp?.name ?? ''}".`
          );
        }
      );
    }
  );

  // -------------------------------------------------------------------
  // Screens
  // -------------------------------------------------------------------

  server.registerTool(
    'chem_create_screen',
    {
      title: 'Create screen',
      description:
        'Create a new screen. Screens group wellplates + research plans into ' +
        'a single parameter-study workspace. Requires `name`; ' +
        '`wellplate_ids` and `research_plan_ids` default to `[]`. Optional fields capture the classic screen ' +
        'metadata (collaborator, requirements, conditions, result). ' +
        'Returns the created screen id.',
      inputSchema: {
        collection_id: positiveInt.optional(),
        name: z.string().min(1),
        wellplate_ids: z
          .array(z.number().int().positive())
          .optional()
          .describe(
            'Existing wellplate ids to attach. Default `[]` — you can attach ' +
              'wellplates later via `chem_update_screen`.'
          ),
        research_plan_ids: z
          .array(z.number().int().positive())
          .optional()
          .describe('Existing research plan ids to attach. Default `[]`.'),
        container: containerPayloadSchema.optional(),
        collaborator: z.string().optional(),
        requirements: z.string().optional(),
        conditions: z.string().optional(),
        result: z.string().optional(),
        description: z.record(z.string(), z.unknown()).optional(),
        component_graph_data: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            'Optional node/edge DAG describing the screen components. ' +
              'Omit for simple cases; Chemotion renders the graph in the UI.'
          ),
      },
      annotations: CREATE,
    },
    async (args) => {
      const {
        name,
        wellplate_ids,
        research_plan_ids,
        container,
        ...rest
      } = args as {
        name: string;
        wellplate_ids?: number[];
        research_plan_ids?: number[];
        container?: ContainerPayload;
      } & Record<string, unknown>;
      return guard(
        () =>
          client.createScreen({
            ...rest,
            name,
            wellplate_ids: wellplate_ids ?? [],
            research_plan_ids: research_plan_ids ?? [],
            container: container ?? EMPTY_ROOT_CONTAINER,
          }),
        (response) => {
          const s = response.screen;
          return text(`Created screen #${s?.id} "${s?.name ?? name}".`);
        }
      );
    }
  );

  server.registerTool(
    'chem_update_screen',
    {
      title: 'Update screen',
      description:
        'Patch fields on an existing screen. Omitted fields stay unchanged, ' +
        'including `wellplate_ids`, `research_plan_ids`, and `container`. ' +
        'The wellplate attachment is reconciled by diff: ids in the ' +
        'submitted list but not currently attached are attached, ids ' +
        'currently attached but not in the submitted list are detached.',
      inputSchema: {
        id: positiveInt,
        wellplate_ids: z.array(z.number().int().positive()).optional(),
        research_plan_ids: z.array(z.number().int().positive()).optional(),
        container: containerPayloadSchema.optional(),
        name: z.string().optional(),
        collaborator: z.string().optional(),
        requirements: z.string().optional(),
        conditions: z.string().optional(),
        result: z.string().optional(),
        description: z.record(z.string(), z.unknown()).optional(),
        component_graph_data: z.record(z.string(), z.unknown()).optional(),
      },
      annotations: UPDATE,
    },
    async ({ id, ...rest }) => {
      return guard(
        () => client.updateScreen(id, rest),
        (response) => {
          const s = response.screen;
          return text(`Updated screen #${id} "${s?.name ?? ''}".`);
        }
      );
    }
  );

  // -------------------------------------------------------------------
  // Destructive: hard-delete
  // -------------------------------------------------------------------

  if (!config.allowDestructive) {
    server.registerTool(
    'chem_deletes_disabled',
    {
      title: 'Deletes disabled',
      description:
        'Placeholder — destructive writes are disabled on this Chemotion ' +
          'MCP. Set CHEMOTION_ALLOW_DESTRUCTIVE=true (in addition to ' +
          'CHEMOTION_ALLOW_WRITES) to enable delete tools. Deleted ' +
          'elements cannot be restored through the API or UI.',
      annotations: READ,
    },
    async () =>
        errorText(
          'Destructive tools disabled. Set CHEMOTION_ALLOW_DESTRUCTIVE=true to enable.'
        )
  );
    return;
  }

  server.registerTool(
    'chem_delete_sample',
    {
      title: 'Delete sample',
      description:
        'DELETE a sample. Chemotion only marks the row deleted, but nothing ' +
        'in the API or UI restores it — treat it as permanent. The sample ' +
        'disappears from every collection, with its analyses. ' +
        'Confirm with the user before invoking; a `chem_get_sample` ' +
        'first to show what is about to vanish is the courteous pattern.',
      inputSchema: {
        id: positiveInt,
      },
      annotations: DELETE,
    },
    async ({ id }) => {
      return guard(
        async () => {
          await client.deleteSample(id);
          return id;
        },
        () => text(`Deleted sample #${id}.`)
      );
    }
  );

  server.registerTool(
    'chem_delete_reaction',
    {
      title: 'Delete reaction',
      description:
        'DELETE a reaction. Not restorable through the API or UI. Removes ' +
        'the reaction and its analyses. Confirm with the user before ' +
        'invoking.',
      inputSchema: {
        id: positiveInt,
      },
      annotations: DELETE,
    },
    async ({ id }) => {
      return guard(
        async () => {
          await client.deleteReaction(id);
          return id;
        },
        () => text(`Deleted reaction #${id}.`)
      );
    }
  );

  server.registerTool(
    'chem_delete_research_plan',
    {
      title: 'Delete research plan',
      description:
        'DELETE a research plan. Not restorable through the API or UI. ' +
        'Chemotion has no per-id delete for research plans, so this routes ' +
        'through the ui_state bulk-delete endpoint scoped to the "All" ' +
        'collection. On v4 it is removed from your own collections and ' +
        'destroyed once no collection holds it. Confirm with the user first.',
      inputSchema: {
        id: positiveInt,
      },
      annotations: DELETE,
    },
    async ({ id }) => {
      return guard(
        () => client.deleteResearchPlanByUiState(id),
        (response) => text(`Deleted research plan #${id}.${lockedNote(response)}`)
      );
    }
  );

  server.registerTool(
    'chem_delete_wellplate',
    {
      title: 'Delete wellplate',
      description:
        'DELETE a wellplate. Not restorable through the API or UI. Removes ' +
        'the wellplate, its wells and analyses; screens that used it ' +
        'survive. Confirm with the user first.',
      inputSchema: {
        id: positiveInt,
      },
      annotations: DELETE,
    },
    async ({ id }) => {
      return guard(
        async () => {
          await client.deleteWellplate(id);
          return id;
        },
        () => text(`Deleted wellplate #${id}.`)
      );
    }
  );

  server.registerTool(
    'chem_delete_screen',
    {
      title: 'Delete screen',
      description:
        'DELETE a screen. Not restorable through the API or UI. Chemotion ' +
        'has no per-id delete for screens, so this routes through the ' +
        'ui_state bulk-delete endpoint scoped to the "All" collection. ' +
        'Attached wellplates and research plans survive. Confirm with the ' +
        'user first.',
      inputSchema: {
        id: positiveInt,
      },
      annotations: DELETE,
    },
    async ({ id }) => {
      return guard(
        () => client.deleteScreenByUiState(id),
        (response) => text(`Deleted screen #${id}.${lockedNote(response)}`)
      );
    }
  );
}
