/**
 * Chemistry-aware formatters for MCP tool output.
 *
 * The whole point of this MCP vs a generic ELN MCP is that LLM output
 * sees structured chemistry — SMILES, molfile, quantities, analysis
 * trees — not a flattened prose dump. These formatters surface every
 * chemistry primitive Chemotion carries so the model can reason about
 * compounds, not just names.
 *
 * Output is markdown: tables use GFM pipes, molfile is fenced with
 * the ` ```molfile ` info string (Chemistry LLMs parse that better
 * than inline text), analysis trees render as nested bullet lists.
 *
 * User-identity fields (creator, contributor emails) are gated
 * behind `FormatOptions.revealUsers`. Default off — matches the
 * privacy-conservative default from elabftw-mcp.
 */

import type {
  Attachment,
  Collection,
  Container,
  Molecule,
  Reaction,
  ReactionSampleRef,
  ResearchPlan,
  ResearchPlanBlock,
  ResearchPlanImageValue,
  ResearchPlanKetcherValue,
  ResearchPlanReactionValue,
  ResearchPlanSampleValue,
  ResearchPlanTableValue,
  Sample,
  Screen,
  Wellplate,
} from './types.js';

export interface FormatOptions {
  /**
   * Reveal user-identity fields (creator name / email / initials).
   * Default false. `userid`/creator_id always survive — only PII is
   * filtered.
   */
  revealUsers?: boolean;
  /** Max markdown chars for long bodies before truncation. Default 4000. */
  maxBodyChars?: number;
}

const DEFAULT_MAX_BODY = 4000;

// ---------------------------------------------------------------------
// Tiny utilities
// ---------------------------------------------------------------------

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n\n*[truncated at ${max} chars]*`;
}

/**
 * Normalise a Chemotion rich-text field into a markdown string.
 * Reactions carry description/observation as Quill delta hashes
 * (`{ops:[{insert:"..."}]}`) while older records or other entities
 * may still hand back plain strings. Returns `''` for nullish or
 * shapes we can't make sense of so callers can skip the section.
 */
function renderRichText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && 'ops' in (value as Record<string, unknown>)) {
    return renderQuillDelta(value).trimEnd();
  }
  return '';
}

function emdash(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  return String(value);
}

function nz(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  return String(value);
}

function pct(value: number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  // Chemotion stores purity as 0..1 and yield sometimes 0..1, sometimes
  // 0..100. Normalise to percent display by inspecting the range.
  const n = value <= 1 ? value * 100 : value;
  return `${Number(n.toFixed(2))}%`;
}

function qty(value: unknown, unit: unknown): string | null {
  const v = nz(value);
  const u = nz(unit);
  if (!v && !u) return null;
  if (!u) return v;
  return `${v} ${u}`;
}

/**
 * Join an array of key:value strings with ` · ` separators, dropping
 * empty ones. Produces a single inline metadata line like:
 *   `amount: 500 mg · purity: 98% · solvent: MeOH`
 */
function inline(pairs: Array<string | null | undefined>): string {
  return pairs.filter((p): p is string => !!p && p.length > 0).join(' · ');
}

// ---------------------------------------------------------------------
// Molfile + SMILES
// ---------------------------------------------------------------------

/**
 * Pull the canonical chemistry identifiers from either the embedded
 * Molecule or the flat fields on a Sample. Chemotion mirrors molecule
 * fields onto the sample on some endpoints; on others only the nested
 * molecule carries them. Check both.
 */
function resolveChem(sample: Sample): {
  smiles?: string | null;
  molfile?: string | null;
  inchi?: string | null;
  inchikey?: string | null;
  sum_formula?: string | null;
  molecular_weight?: number | null;
  exact_molecular_weight?: number | null;
  iupac_name?: string | null;
} {
  const m: Molecule | undefined = sample.molecule;
  return {
    smiles: m?.cano_smiles ?? sample.canonical_smiles ?? null,
    molfile: m?.molfile ?? sample.molfile ?? null,
    inchi: m?.inchistring ?? sample.inchi ?? null,
    inchikey: m?.inchikey ?? sample.inchikey ?? null,
    sum_formula:
      m?.sum_formula ?? sample.sum_formula ?? sample.molecular_formula ?? null,
    molecular_weight: m?.molecular_weight ?? sample.molecular_weight ?? null,
    exact_molecular_weight: m?.exact_molecular_weight ?? null,
    iupac_name: m?.iupac_name ?? null,
  };
}

function renderChemBlock(sample: Sample): string[] {
  const c = resolveChem(sample);
  const lines: string[] = [];
  if (c.smiles) lines.push(`- SMILES: \`${c.smiles}\``);
  if (c.inchi) lines.push(`- InChI: \`${c.inchi}\``);
  if (c.inchikey) lines.push(`- InChIKey: \`${c.inchikey}\``);
  if (c.sum_formula) lines.push(`- Molecular formula: **${c.sum_formula}**`);
  if (c.molecular_weight != null)
    lines.push(
      `- Molecular weight: ${Number(c.molecular_weight.toFixed(3))} g/mol${
        c.exact_molecular_weight != null
          ? ` (exact ${Number(c.exact_molecular_weight.toFixed(4))})`
          : ''
      }`
    );
  if (c.iupac_name) lines.push(`- IUPAC: ${c.iupac_name}`);
  return lines;
}

function renderMolfileBlock(sample: Sample): string {
  const c = resolveChem(sample);
  if (!c.molfile) return '';
  // Fence with ` ```molfile ` so chemistry-aware LLMs recognise the
  // content. Strip Chemotion's occasional leading whitespace line.
  const body = c.molfile.replace(/\r\n/g, '\n');
  return '\n```molfile\n' + body + (body.endsWith('\n') ? '' : '\n') + '```\n';
}

// ---------------------------------------------------------------------
// Quantities
// ---------------------------------------------------------------------

function renderSolvents(
  solvent: Sample['solvent'] | undefined
): string | null {
  if (!Array.isArray(solvent) || solvent.length === 0) return null;
  const parts = solvent
    .map((s) => {
      const label = nz(s.label) ?? nz(s.smiles) ?? 'unk';
      const ratio = nz(s.ratio);
      return ratio ? `${label} (${ratio})` : label;
    })
    .filter(Boolean);
  return parts.length ? parts.join(' / ') : null;
}

function renderQuantities(sample: Sample): string[] {
  const lines: string[] = [];
  const amount = qty(sample.amount_value, sample.amount_unit);
  const real = qty(sample.real_amount_value, sample.real_amount_unit);
  const target = qty(sample.target_amount_value, sample.target_amount_unit);
  if (amount) lines.push(`- Amount: ${amount}`);
  if (real && real !== amount) lines.push(`- Real amount: ${real}`);
  if (target && target !== amount) lines.push(`- Target amount: ${target}`);
  if (sample.purity != null) lines.push(`- Purity: ${pct(sample.purity)}`);
  if (sample.density != null) lines.push(`- Density: ${sample.density} g/mL`);
  const molarity = qty(sample.molarity_value, sample.molarity_unit);
  if (molarity) lines.push(`- Molarity: ${molarity}`);
  const meltingPoint = renderTemperatureBounds(
    sample.melting_point_lowerbound,
    sample.melting_point_upperbound,
    sample.melting_point
  );
  if (meltingPoint) lines.push(`- Melting point: ${meltingPoint}`);
  const boilingPoint = renderTemperatureBounds(
    sample.boiling_point_lowerbound,
    sample.boiling_point_upperbound,
    sample.boiling_point
  );
  if (boilingPoint) lines.push(`- Boiling point: ${boilingPoint}`);
  const solvents = renderSolvents(sample.solvent);
  if (solvents) lines.push(`- Solvent: ${solvents}`);
  if (sample.location) lines.push(`- Location: ${sample.location}`);
  return lines;
}

function renderTemperatureBounds(
  lower: number | null | undefined,
  upper: number | null | undefined,
  legacy: string | null | undefined
): string | null {
  if (lower != null || upper != null) {
    if (lower != null && upper != null) {
      if (lower === upper) return `${lower} °C`;
      return `${lower}...${upper} °C`;
    }
    if (lower != null) return `≥ ${lower} °C`;
    return `≤ ${upper} °C`;
  }
  const text = nz(legacy);
  if (!text || text.includes('Infinity')) return null;
  return `${text} °C`;
}

function renderSampleProperties(sample: Sample): string[] {
  const xref =
    sample.xref && typeof sample.xref === 'object'
      ? (sample.xref as Record<string, unknown>)
      : {};
  const moleculeCas = Array.isArray(sample.molecule?.cas)
    ? sample.molecule?.cas.filter(
        (value): value is string => typeof value === 'string' && value.length > 0
      )
    : typeof sample.molecule?.cas === 'string'
      ? [sample.molecule.cas]
      : [];
  const cas =
    nz(xref.cas) ??
    (moleculeCas.length ? moleculeCas.join(', ') : null);

  const flash = (() => {
    const raw = xref.flash_point;
    if (!raw || typeof raw !== 'object') return null;
    const fp = raw as Record<string, unknown>;
    const value = nz(fp.value);
    const unit = nz(fp.unit) ?? '°C';
    return value ? `${value} ${unit}` : null;
  })();

  const lines: string[] = [];
  if (cas) lines.push(`- CAS: ${cas}`);
  if (sample.dry_solvent != null) {
    lines.push(`- Anhydrous: ${sample.dry_solvent ? 'yes' : 'no'}`);
  }
  const sampleType = nz(sample.sample_type);
  if (sampleType) lines.push(`- Sample type: ${sampleType}`);
  const inventoryLabel = nz(xref.inventory_label);
  if (inventoryLabel) lines.push(`- Inventory label: ${inventoryLabel}`);
  const color = nz(xref.color);
  if (color) lines.push(`- Color: ${color}`);
  const form = nz(xref.form);
  if (form) lines.push(`- Form: ${form}`);
  if (flash) lines.push(`- Flash point: ${flash}`);
  const refractiveIndex = nz(xref.refractive_index);
  if (refractiveIndex) lines.push(`- Refractive index: ${refractiveIndex}`);
  const solubility = nz(xref.solubility);
  if (solubility) lines.push(`- Solubility: ${solubility}`);
  return lines;
}

// ---------------------------------------------------------------------
// Container tree (analyses → datasets → attachments)
// ---------------------------------------------------------------------

function describeAttachment(a: Attachment): string {
  const name = nz(a.filename) ?? `attachment-${a.id}`;
  const size = a.filesize != null ? ` (${formatBytes(a.filesize)})` : '';
  return `${name}${size}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 ** 3)
    return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

/**
 * Render an analysis tree (root container → analyses → datasets →
 * attachments) as a nested bullet list. Returns an empty string if
 * the tree is empty.
 */
export function formatContainerTree(container: Container | undefined): string {
  if (!container) return '';
  const analyses = container.children ?? [];
  if (analyses.length === 0) return '';

  const lines: string[] = [];
  for (const a of analyses) {
    const kind =
      nz((a.extended_metadata as Record<string, unknown> | undefined)?.kind as string | undefined) ??
      nz(a.name) ??
      'analysis';
    const content =
      nz(
        (a.extended_metadata as Record<string, unknown> | undefined)
          ?.content as string | undefined
      ) ?? '';
    const header = `- **${kind}**${content ? ` — ${content}` : ''}${
      nz(a.description) ? ` (${a.description})` : ''
    }`;
    lines.push(header);
    const datasets = a.children ?? [];
    for (const ds of datasets) {
      const attachments = ds.attachments ?? [];
      const label =
        nz(ds.name) ??
        nz(
          (ds.extended_metadata as Record<string, unknown> | undefined)
            ?.kind as string | undefined
        ) ??
        `dataset-${ds.id}`;
      lines.push(
        `  - ${label} (${attachments.length} file${attachments.length === 1 ? '' : 's'})`
      );
      for (const att of attachments) {
        lines.push(`    - ${describeAttachment(att)}`);
      }
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------
// Sample renderer
// ---------------------------------------------------------------------

export function formatSample(
  sample: Sample,
  options: FormatOptions = {}
): string {
  const max = options.maxBodyChars ?? DEFAULT_MAX_BODY;
  const name = nz(sample.name) ?? nz(sample.short_label) ?? `sample-${sample.id}`;
  const header = `# ${name}  \n` +
    inline([
      `id: ${sample.id}`,
      sample.short_label ? `short_label: \`${sample.short_label}\`` : null,
      sample.external_label ? `external_label: \`${sample.external_label}\`` : null,
    ]);

  const sections: string[] = [header];

  const chem = renderChemBlock(sample);
  if (chem.length) {
    sections.push('## Structure\n' + chem.join('\n') + renderMolfileBlock(sample));
  } else if (resolveChem(sample).molfile) {
    // No identifiers but molfile present — still surface it.
    sections.push('## Structure' + renderMolfileBlock(sample));
  }

  const quantities = renderQuantities(sample);
  if (quantities.length) {
    sections.push('## Quantity\n' + quantities.join('\n'));
  }

  const properties = renderSampleProperties(sample);
  if (properties.length) {
    sections.push('## Properties\n' + properties.join('\n'));
  }

  if (sample.description) {
    sections.push(
      '## Description\n' + truncate(sample.description, max)
    );
  }

  const analyses = formatContainerTree(sample.container ?? undefined);
  if (analyses) {
    sections.push('## Analyses\n' + analyses);
  }

  const tail = renderTrailer(sample, options);
  if (tail) sections.push(tail);

  return sections.join('\n\n');
}

// ---------------------------------------------------------------------
// Reaction renderer
// ---------------------------------------------------------------------

function refLabel(ref: ReactionSampleRef): string {
  const name = nz(ref.short_label) ?? nz(ref.name) ?? `#${ref.id}`;
  const formula =
    ref.molecule?.sum_formula ?? ref.molecular_formula ?? null;
  return formula ? `${name} (${formula})` : name;
}

function renderReactionScheme(reaction: Reaction): string {
  const lhs = [
    ...(reaction.starting_materials ?? []),
    ...(reaction.reactants ?? []),
  ].map(refLabel);
  const rhs = (reaction.products ?? []).map(refLabel);
  const left = lhs.length ? lhs.join(' + ') : '?';
  const right = rhs.length ? rhs.join(' + ') : '?';

  const conditions: string[] = [];
  const solvents = (reaction.solvents ?? [])
    .map((s) => nz(s.short_label) ?? nz(s.name))
    .filter(Boolean);
  if (solvents.length) conditions.push(`solvent: ${solvents.join(', ')}`);
  const temp = renderTemperature(reaction.temperature);
  if (temp) conditions.push(`T: ${temp}`);
  const duration = nz(reaction.duration);
  if (duration) conditions.push(`t: ${duration}`);
  const yields = (reaction.products ?? [])
    .map((p) => (p.yield != null ? pct(p.yield) : null))
    .filter(Boolean);
  if (yields.length) conditions.push(`yield: ${yields.join(', ')}`);

  const cond = conditions.length ? ` (${conditions.join(', ')})` : '';
  return `${left} → ${right}${cond}`;
}

function renderTemperature(
  temp: Reaction['temperature'] | undefined
): string | null {
  if (!temp) return null;
  if (typeof temp === 'string') return temp;
  const userText = nz(temp.userText);
  if (userText) return userText;
  const data = Array.isArray(temp.data) ? (temp.data as Array<Record<string, unknown>>) : [];
  if (data.length === 0) return null;
  const unit = nz(temp.valueUnit) ?? '°C';
  const values = data
    .map((d) => nz(d.value))
    .filter(Boolean)
    .join(' → ');
  return values ? `${values} ${unit}` : null;
}

function renderReactionTable(
  heading: string,
  rows: ReactionSampleRef[] | undefined
): string {
  if (!rows || rows.length === 0) return '';
  const lines: string[] = [
    `### ${heading}`,
    '| # | label | formula | MW | equiv | amount | yield |',
    '|---|---|---|---|---|---|---|',
  ];
  for (const r of rows) {
    const label = nz(r.short_label) ?? nz(r.name) ?? `#${r.id}`;
    const formula = nz(r.molecule?.sum_formula ?? r.molecular_formula) ?? '';
    const mw = r.molecule?.molecular_weight ?? r.molecular_weight;
    const mwStr = mw != null ? Number(mw.toFixed(2)).toString() : '';
    const equiv = r.equivalent != null ? r.equivalent.toString() : '';
    const amount =
      qty(r.real_amount_value, r.real_amount_unit) ??
      qty(r.target_amount_value, r.target_amount_unit) ??
      qty(r.amount_value, r.amount_unit) ??
      '';
    const yieldStr = r.yield != null ? pct(r.yield) ?? '' : '';
    lines.push(
      `| ${r.id} | ${label} | ${formula} | ${mwStr} | ${equiv} | ${amount} | ${yieldStr} |`
    );
  }
  return lines.join('\n');
}

export function formatReaction(
  reaction: Reaction,
  options: FormatOptions = {}
): string {
  const max = options.maxBodyChars ?? DEFAULT_MAX_BODY;
  const name =
    nz(reaction.name) ?? nz(reaction.short_label) ?? `reaction-${reaction.id}`;
  const header =
    `# ${name}  \n` +
    inline([
      `id: ${reaction.id}`,
      reaction.short_label ? `short_label: \`${reaction.short_label}\`` : null,
      reaction.status ? `status: ${reaction.status}` : null,
      reaction.role ? `role: ${reaction.role}` : null,
      reaction.rxno ? `rxno: ${reaction.rxno}` : null,
    ]);

  const sections: string[] = [header];

  sections.push('## Scheme\n' + renderReactionScheme(reaction));

  const tables = [
    renderReactionTable('Starting materials', reaction.starting_materials),
    renderReactionTable('Reactants', reaction.reactants),
    renderReactionTable('Products', reaction.products),
    renderReactionTable('Solvents', reaction.solvents),
  ].filter(Boolean);
  if (tables.length) sections.push(tables.join('\n\n'));

  const descText = renderRichText(reaction.description);
  if (descText) {
    sections.push('## Description\n' + truncate(descText, max));
  }
  const obsText = renderRichText(reaction.observation);
  if (obsText) {
    sections.push('## Observation\n' + truncate(obsText, max));
  }

  if (Array.isArray(reaction.purification) && reaction.purification.length) {
    sections.push(
      '## Purification\n' +
        reaction.purification.map((p) => `- ${p}`).join('\n')
    );
  }

  const analyses = formatContainerTree(reaction.container ?? undefined);
  if (analyses) sections.push('## Analyses\n' + analyses);

  const tail = renderTrailer(reaction, options);
  if (tail) sections.push(tail);

  return sections.join('\n\n');
}

// ---------------------------------------------------------------------
// Research plan renderer — Quill delta → markdown, plus typed blocks
// ---------------------------------------------------------------------

interface QuillOp {
  insert?: string | Record<string, unknown>;
  attributes?: Record<string, unknown>;
}

/**
 * Render a Quill Delta (`{ ops: [...] }`) as markdown. Handles the
 * attributes we see in Chemotion: bold, italic, underline, link,
 * header (1/2/3), list (bullet/ordered), code-block, blockquote.
 * Unknown attributes pass through as raw text.
 */
function renderQuillDelta(delta: unknown): string {
  if (!delta || typeof delta !== 'object') return '';
  const ops = (delta as { ops?: QuillOp[] }).ops;
  if (!Array.isArray(ops)) return '';

  let out = '';
  let buf = '';
  let pendingList: 'bullet' | 'ordered' | null = null;

  const flushLine = (attrs: Record<string, unknown> | undefined) => {
    const header = attrs?.header;
    if (typeof header === 'number' && header >= 1 && header <= 6) {
      out += '#'.repeat(header) + ' ' + buf + '\n';
    } else if (attrs?.blockquote) {
      out += '> ' + buf + '\n';
    } else if (attrs?.['code-block']) {
      out += '```\n' + buf + '\n```\n';
    } else if (attrs?.list === 'bullet') {
      out += '- ' + buf + '\n';
      pendingList = 'bullet';
    } else if (attrs?.list === 'ordered') {
      out += '1. ' + buf + '\n';
      pendingList = 'ordered';
    } else {
      out += buf + '\n';
      pendingList = null;
    }
    buf = '';
  };

  for (const op of ops) {
    if (typeof op.insert !== 'string') {
      // Embeds (image, mention, etc.). Represent as a placeholder.
      if (op.insert && typeof op.insert === 'object') {
        const embed = op.insert as Record<string, unknown>;
        if ('image' in embed) buf += `![image](${String(embed.image)})`;
        else if ('video' in embed) buf += `[video](${String(embed.video)})`;
        else buf += '[embed]';
      }
      continue;
    }

    const pieces = op.insert.split('\n');
    for (let i = 0; i < pieces.length; i += 1) {
      const piece = pieces[i] ?? '';
      let styled = piece;
      const a = op.attributes;
      if (a) {
        if (a.code) styled = `\`${styled}\``;
        if (a.bold) styled = `**${styled}**`;
        if (a.italic) styled = `*${styled}*`;
        if (a.underline) styled = `<u>${styled}</u>`;
        if (typeof a.link === 'string') styled = `[${styled}](${a.link})`;
      }
      buf += styled;
      if (i < pieces.length - 1) {
        // Newline inside the insert ends a line. Line-level attrs
        // (header, list, blockquote) often arrive on the `\n` op, but
        // when they sit on the text op itself we still flush here.
        flushLine(a);
      }
    }
  }

  if (buf) out += buf + '\n';
  return out.trim();
}

function renderResearchBlock(block: ResearchPlanBlock): string {
  const type = block.type ?? 'unknown';
  const titlePrefix = block.title ? `**${block.title}**\n\n` : '';

  switch (type) {
    case 'richtext':
    case 'text': {
      const md = renderQuillDelta(block.value) ||
        (typeof block.value === 'string' ? String(block.value) : '');
      return titlePrefix + md;
    }
    case 'table': {
      return titlePrefix + renderResearchTable(block.value);
    }
    case 'image': {
      const v = block.value as Record<string, unknown> | null | undefined;
      const id = v && 'attachment_id' in v ? v.attachment_id : undefined;
      const alt = (v?.public_name as string | undefined) ?? 'image';
      return (
        titlePrefix +
        (id
          ? `![${alt}](chemotion://attachment/${id})`
          : `*(image placeholder)*`)
      );
    }
    case 'ketcher':
    case 'sample':
    case 'reaction': {
      // Lightweight placeholders — the tool layer can decide whether
      // to hydrate by id.
      const v = block.value as Record<string, unknown> | null | undefined;
      const id = v && 'id' in v ? v.id : undefined;
      return (
        titlePrefix +
        `*(${type}${id !== undefined ? ` ref: #${String(id)}` : ''})*`
      );
    }
    default: {
      // Unknown block kinds fall through as fenced JSON so content is
      // not lost silently.
      return (
        titlePrefix +
        '```json\n' +
        JSON.stringify(block, null, 2) +
        '\n```'
      );
    }
  }
}

function summarizeResearchBlock(block: ResearchPlanBlock, index: number): string {
  const bits = [
    `[${index}]`,
    block.id ? `id: ${block.id}` : null,
    `type: ${block.type ?? 'unknown'}`,
    block.title ? `title: ${block.title}` : null,
  ].filter((bit): bit is string => Boolean(bit));

  switch (block.type) {
    case 'richtext':
    case 'text': {
      const rendered = renderQuillDelta(block.value) ||
        (typeof block.value === 'string' ? block.value : '');
      if (rendered) bits.push(`chars: ${rendered.length}`);
      break;
    }
    case 'table': {
      const table = block.value as ResearchPlanTableValue | null | undefined;
      bits.push(`cols: ${table?.columns?.length ?? 0}`);
      bits.push(`rows: ${table?.rows?.length ?? 0}`);
      break;
    }
    case 'sample': {
      const value = block.value as ResearchPlanSampleValue | null | undefined;
      if (value?.sample_id != null) bits.push(`sample_id: ${value.sample_id}`);
      break;
    }
    case 'reaction': {
      const value = block.value as ResearchPlanReactionValue | null | undefined;
      if (value?.reaction_id != null) bits.push(`reaction_id: ${value.reaction_id}`);
      break;
    }
    case 'ketcher': {
      const value = block.value as ResearchPlanKetcherValue | null | undefined;
      bits.push(`sdf_file: ${value?.sdf_file ? 'yes' : 'no'}`);
      bits.push(`svg_file: ${value?.svg_file ?? 'none'}`);
      break;
    }
    case 'image': {
      const value = block.value as ResearchPlanImageValue | null | undefined;
      bits.push(`public_name: ${value?.public_name ?? 'none'}`);
      break;
    }
    default:
      break;
  }

  return `- ${bits.join(' | ')}`;
}

function renderResearchTable(value: unknown): string {
  if (!value || typeof value !== 'object') return '*(empty table)*';
  const v = value as {
    columns?: Array<{ headerName?: string; field?: string; colId?: string }>;
    rows?: Array<Record<string, unknown>>;
  };
  const cols = v.columns ?? [];
  const rows = v.rows ?? [];
  if (cols.length === 0 || rows.length === 0) return '*(empty table)*';

  const header =
    '| ' + cols.map((c) => c.headerName ?? c.field ?? '').join(' | ') + ' |';
  const sep = '|' + cols.map(() => '---').join('|') + '|';
  const body = rows
    .map(
      (row) =>
        '| ' +
        cols
          .map((c) => {
            const key = c.field ?? c.colId ?? '';
            const cell = row[key];
            return cell == null ? '' : String(cell);
          })
          .join(' | ') +
        ' |'
    )
    .join('\n');
  return [header, sep, body].join('\n');
}

export function formatResearchPlan(
  plan: ResearchPlan,
  options: FormatOptions = {}
): string {
  const max = options.maxBodyChars ?? DEFAULT_MAX_BODY * 2; // plans can be long
  const name = nz(plan.name) ?? `research_plan-${plan.id}`;
  const header = `# ${name}  \nid: ${plan.id}`;

  const sections: string[] = [header];

  const body = Array.isArray(plan.body) ? plan.body : [];
  if (body.length) {
    sections.push(
      '## Fields\n' + body.map((block, index) => summarizeResearchBlock(block, index)).join('\n')
    );
    const rendered = body.map(renderResearchBlock).join('\n\n');
    sections.push('## Body\n' + truncate(rendered, max));
  }

  const analyses = formatContainerTree(plan.container ?? undefined);
  if (analyses) sections.push('## Analyses\n' + analyses);

  if (Array.isArray(plan.attachments) && plan.attachments.length) {
    sections.push(
      '## Attachments\n' +
        plan.attachments.map((a) => `- ${describeAttachment(a)}`).join('\n')
    );
  }

  const tail = renderTrailer(plan, options);
  if (tail) sections.push(tail);

  return sections.join('\n\n');
}

// ---------------------------------------------------------------------
// Collection / wellplate / screen
// ---------------------------------------------------------------------

export function formatCollection(
  collection: Collection,
  _options: FormatOptions = {}
): string {
  const header = `# ${collection.label}  \nid: ${collection.id}${
    collection.is_shared ? ' (shared)' : ''
  }`;
  const sections: string[] = [header];

  const meta = inline([
    collection.permission_level !== undefined
      ? `permission: ${collection.permission_level}`
      : null,
    collection.position !== undefined && collection.position !== null
      ? `position: ${collection.position}`
      : null,
  ]);
  if (meta) sections.push(meta);

  const children = collection.children ?? [];
  if (children.length) {
    sections.push(
      '## Children\n' +
        children
          .map((c) => `- #${c.id} ${c.label}${c.is_shared ? ' (shared)' : ''}`)
          .join('\n')
    );
  }

  return sections.join('\n\n');
}

/**
 * Render a 96-well plate as an ASCII grid when small; otherwise
 * a compact row-per-well list. `sampleResolver` can inject sample
 * short_labels if the caller has hydrated them separately; without
 * it we display bare sample_ids.
 */
export function formatWellplate(
  wellplate: Wellplate,
  options: FormatOptions & {
    sampleResolver?: (sampleId: number) => string | undefined;
  } = {}
): string {
  const header = `# ${nz(wellplate.name) ?? `wellplate-${wellplate.id}`}  \n` +
    inline([
      `id: ${wellplate.id}`,
      wellplate.width != null && wellplate.height != null
        ? `${wellplate.width}×${wellplate.height}`
        : null,
    ]);

  const sections: string[] = [header];

  const wellplateDesc = renderRichText(wellplate.description);
  if (wellplateDesc) {
    sections.push(
      '## Description\n' +
        truncate(wellplateDesc, options.maxBodyChars ?? DEFAULT_MAX_BODY)
    );
  }

  const wells = wellplate.wells ?? [];
  const width = wellplate.width ?? 12;
  const height = wellplate.height ?? 8;

  // Only draw the grid for standard plate sizes (<= 96 wells).
  if (wells.length && width * height <= 96) {
    const grid: string[][] = [];
    for (let y = 0; y < height; y += 1) {
      grid.push(Array.from({ length: width }, () => '·'));
    }
    for (const w of wells) {
      const x = (w.position_x ?? 1) - 1;
      const y = (w.position_y ?? 1) - 1;
      if (y < 0 || y >= height || x < 0 || x >= width) continue;
      const sampleId = w.sample_id;
      let label = sampleId != null ? `S${sampleId}` : '·';
      if (sampleId != null && options.sampleResolver) {
        const resolved = options.sampleResolver(sampleId);
        if (resolved) label = resolved;
      }
      // Truncate to 6 chars to keep grid readable.
      grid[y]![x] = label.slice(0, 6).padEnd(6, ' ');
    }
    const rows = grid.map(
      (row, i) =>
        `${String.fromCharCode(65 + i)} ${row.map((c) => c.padEnd(6, ' ')).join(' ')}`
    );
    const headerRow =
      '  ' +
      Array.from({ length: width }, (_, i) =>
        (i + 1).toString().padEnd(6, ' ')
      ).join(' ');
    sections.push('## Grid\n```\n' + headerRow + '\n' + rows.join('\n') + '\n```');
  } else if (wells.length) {
    sections.push(
      '## Wells\n' +
        wells
          .slice(0, 200)
          .map(
            (w) =>
              `- (${w.position_x ?? '?'},${w.position_y ?? '?'}) → ${
                w.sample_id != null ? `sample #${w.sample_id}` : '—'
              }`
          )
          .join('\n') +
        (wells.length > 200 ? `\n*…${wells.length - 200} more*` : '')
    );
  }

  return sections.join('\n\n');
}

export function formatScreen(
  screen: Screen,
  options: FormatOptions = {}
): string {
  const max = options.maxBodyChars ?? DEFAULT_MAX_BODY;
  const header = `# ${nz(screen.name) ?? `screen-${screen.id}`}  \nid: ${screen.id}`;
  const sections: string[] = [header];

  const meta = inline([
    screen.collaborator ? `collaborator: ${screen.collaborator}` : null,
  ]);
  if (meta) sections.push(meta);

  if (screen.requirements)
    sections.push('## Requirements\n' + truncate(screen.requirements, max));
  if (screen.conditions)
    sections.push('## Conditions\n' + truncate(screen.conditions, max));
  if (screen.result) sections.push('## Result\n' + truncate(screen.result, max));
  const screenDesc = renderRichText(screen.description);
  if (screenDesc) sections.push('## Description\n' + truncate(screenDesc, max));

  if (Array.isArray(screen.wellplates) && screen.wellplates.length) {
    sections.push(
      '## Wellplates\n' +
        screen.wellplates
          .map((w) => `- #${w.id} ${nz(w.name) ?? ''}`)
          .join('\n')
    );
  }

  const analyses = formatContainerTree(screen.container ?? undefined);
  if (analyses) sections.push('## Analyses\n' + analyses);

  return sections.join('\n\n');
}

// ---------------------------------------------------------------------
// Trailer (footer) — creator + timestamps, gated by revealUsers
// ---------------------------------------------------------------------

interface Trailerish {
  creator_id?: number;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

function renderTrailer(entity: Trailerish, options: FormatOptions): string {
  const bits: string[] = [];
  if (entity.creator_id != null) {
    if (options.revealUsers) {
      // If the tool layer hydrated the user, creator may land alongside
      // the id as `creator_name`/`creator`. Surface whichever is there.
      const name = nz((entity as Record<string, unknown>).creator_name as string | undefined);
      bits.push(`creator: ${name ?? `user ${entity.creator_id}`}`);
    } else {
      bits.push(`creator: user ${entity.creator_id}`);
    }
  }
  if (entity.created_at) bits.push(`created: ${entity.created_at}`);
  if (entity.updated_at) bits.push(`updated: ${entity.updated_at}`);
  if (bits.length === 0) return '';
  return `---\n*${emdash(inline(bits))}*`;
}

// ---------------------------------------------------------------------
// Exported helpers (for tool layer reuse)
// ---------------------------------------------------------------------

export { renderReactionScheme };
