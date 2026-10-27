/**
 * App-agnostic types for the Chemotion ELN JSON API.
 *
 * There is NO public OpenAPI spec for the ELN. These interfaces are
 * derived from reading the Grape source
 * (`app/api/chemotion/*_api.rb`) and the Python wrapper. They are
 * intentionally permissive: Chemotion bodies carry lots of optional or
 * version-specific fields, so every interface closes with
 * `[key: string]: unknown`. Callers that need a specific field should
 * narrow at the call site rather than fighting the types.
 *
 * Naming follows the Rails wire format (snake_case). We do not
 * transform keys on the way in.
 */

// ---------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------

/**
 * Chemotion list endpoints paginate via `page` / `per_page`
 * (grape-kaminari) and report totals in `X-Total` / `X-Total-Pages` /
 * `X-Page` / `X-Per-Page` headers. The client copies those into a
 * `pagination` object on the parsed body.
 */
export interface Pagination {
  page?: number;
  per_page?: number;
  total_count?: number;
  total_pages?: number;
  [key: string]: unknown;
}

/**
 * Generic envelope shape. The index signature allows the list body
 * under any resource key (`samples`, `reactions`, …); callers that
 * need narrower typing should project to the concrete response
 * interfaces (`SamplesListResponse`, `ReactionsListResponse`, …).
 */
export interface PaginatedEnvelope<T> {
  pagination?: Pagination;
  [key: string]: T[] | Pagination | unknown;
}

// ---------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------

/**
 * A Chemotion collection. Collections nest (`children`) and are the
 * primary scoping container for samples/reactions/etc.
 */
export interface Collection {
  id: number;
  label: string;
  ancestry?: string | null;
  position?: number | null;
  is_shared?: boolean;
  is_locked?: boolean;
  permission_level?: number;
  shared_by?: { id: number; name?: string; initials?: string } | null;
  shared_with?: Array<{ id: number; name?: string; initials?: string }>;
  children?: Collection[];
  sample_detail_level?: number;
  reaction_detail_level?: number;
  wellplate_detail_level?: number;
  screen_detail_level?: number;
  researchplan_detail_level?: number;
  [key: string]: unknown;
}

/**
 * Aggregated shape returned by `ChemotionClient.listCollections()`:
 * the merged `collections` array plus a per-origin breakdown. On v4
 * the rows come from `GET /collections` (flat, linked by `ancestry`);
 * on older releases from `/collections/roots`, `/shared_roots`,
 * `/remote_roots`, and `/locked` (nested via `children`).
 */
export interface CollectionsListResponse {
  collections?: Collection[];
  roots?: Collection[];
  shared_roots?: Collection[];
  remote_roots?: Collection[];
  locked?: Collection[];
  [key: string]: unknown;
}

// ---------------------------------------------------------------------
// Molecules
// ---------------------------------------------------------------------

/**
 * A unique chemical structure. Samples reference a Molecule via
 * `molecule_id`. Molecules carry the canonical chemistry primitives.
 */
export interface Molecule {
  id: number;
  inchikey?: string | null;
  inchistring?: string | null;
  cano_smiles?: string | null;
  sum_formula?: string | null;
  molecular_weight?: number | null;
  exact_molecular_weight?: number | null;
  molfile?: string | null;
  molfile_version?: string | null;
  iupac_name?: string | null;
  cas?: string | string[] | null;
  names?: string[] | null;
  molecule_svg_file?: string | null;
  is_partial?: boolean;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------
// Samples
// ---------------------------------------------------------------------

/**
 * A sample (compound entry). Chemotion samples are "batches" of a
 * Molecule with amount / purity / location metadata.
 */
export interface Sample {
  id: number;
  name?: string;
  short_label?: string;
  external_label?: string | null;
  description?: string | null;
  molecule_id?: number;
  /** Embedded Molecule when the server hydrates it inline. */
  molecule?: Molecule;
  /** Canonical SMILES lifted from the molecule; present on most GETs. */
  canonical_smiles?: string | null;
  molfile?: string | null;
  inchi?: string | null;
  inchikey?: string | null;
  molecular_formula?: string | null;
  molecular_weight?: number | null;
  sum_formula?: string | null;
  purity?: number | null;
  /** Amount as stored: value + unit (g / mg / l / ml / mol / mmol). */
  amount_value?: number | null;
  amount_unit?: string | null;
  real_amount_value?: number | null;
  real_amount_unit?: string | null;
  target_amount_value?: number | null;
  target_amount_unit?: string | null;
  density?: number | null;
  molarity_value?: number | null;
  molarity_unit?: string | null;
  dry_solvent?: boolean | null;
  melting_point?: string | null;
  boiling_point?: string | null;
  melting_point_lowerbound?: number | null;
  melting_point_upperbound?: number | null;
  boiling_point_lowerbound?: number | null;
  boiling_point_upperbound?: number | null;
  solvent?: Array<{ label?: string; smiles?: string; ratio?: string | number }>;
  location?: string | null;
  is_top_secret?: boolean;
  decoupled?: boolean;
  stereo?: { abs?: string | null; rel?: string | null };
  sample_type?: string | null;
  sample_details?: Record<string, unknown> | null;
  xref?: Record<string, unknown>;
  tag?: Record<string, unknown>;
  /** Analysis tree attached to the sample (NMR, MS, IR, …). */
  container?: Container | null;
  literatures?: Literature[];
  segments?: Segment[];
  elemental_compositions?: Array<Record<string, unknown>>;
  residues?: Array<Record<string, unknown>>;
  collection_labels?: Array<{ id: number; name: string; is_shared?: boolean }>;
  tag_data?: Record<string, unknown>;
  /** Collection IDs this sample belongs to. */
  collection_ids?: number[];
  creator_id?: number;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

export interface SamplesListResponse {
  samples?: Sample[];
  molecules?: Molecule[];
  pagination?: Pagination;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------
// Reactions
// ---------------------------------------------------------------------

/**
 * A reaction link — a sample referenced as starting material, reactant,
 * product, or solvent on a reaction. Usually carries equivalents /
 * yield on top of the sample fields.
 */
export interface ReactionSampleRef extends Sample {
  /** Role: `starting_materials`, `reactants`, `products`, `solvents`. */
  reference?: boolean;
  equivalent?: number | null;
  equivalents?: number | null;
  yield?: number | null;
  coefficient?: number | null;
  position?: number;
  waste?: boolean;
  [key: string]: unknown;
}

/**
 * Participant row accepted inside reaction `materials` on create/update.
 * Existing samples are usually referenced by `id`; callers can also ship
 * an inline sample-like shape when Chemotion should mint a new sample.
 */
export interface ReactionMaterialEntry {
  /**
   * Either an existing integer sample id (when referencing a sample
   * already in inventory) OR a client-side temp id string that
   * Chemotion replaces with a real id on the server when you ship a
   * subsample / new-sample shape (`{id: "<uuid>", is_new: true, ...}`).
   */
  id?: number | string;
  reference?: boolean;
  equivalent?: number | null;
  equivalents?: number | null;
  coefficient?: number | null;
  position?: number;
  amount_value?: number | null;
  amount_unit?: string | null;
  real_amount_value?: number | null;
  real_amount_unit?: string | null;
  target_amount_value?: number | null;
  target_amount_unit?: string | null;
  molarity_value?: number | null;
  molarity_unit?: string | null;
  density?: number | null;
  yield?: number | null;
  waste?: boolean | null;
  [key: string]: unknown;
}

export interface Reaction {
  id: number;
  name?: string;
  short_label?: string;
  description?: string | null;
  observation?: string | null;
  purification?: string[] | null;
  dangerous_products?: string[] | null;
  conditions?: string | null;
  /** Planned / running / done / analyses pending / successful / not successful. */
  status?: string | null;
  /** General Procedure / Parts of GP / Single. */
  role?: string | null;
  temperature?: {
    valueUnit?: string;
    userText?: string;
    data?: Array<Record<string, unknown>>;
    [key: string]: unknown;
  } | null;
  duration?: string | null;
  durationDisplay?: Record<string, unknown>;
  /** Auto-calculated %. */
  rxno?: string | null;
  purification_solvents?: ReactionSampleRef[];
  solvents?: ReactionSampleRef[];
  starting_materials?: ReactionSampleRef[];
  reactants?: ReactionSampleRef[];
  products?: ReactionSampleRef[];
  literatures?: Literature[];
  segments?: Segment[];
  container?: Container | null;
  collection_ids?: number[];
  creator_id?: number;
  timestamp_start?: string | null;
  timestamp_stop?: string | null;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

export interface ReactionsListResponse {
  reactions?: Reaction[];
  pagination?: Pagination;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------
// Research plans
// ---------------------------------------------------------------------

/**
 * Research-plan body is an array of typed blocks. Each block type
 * carries a different `value` shape — keep it permissive here and
 * render block-by-block in the formatter.
 */
export type ResearchPlanFieldType =
  | 'richtext'
  | 'text'
  | 'table'
  | 'image'
  | 'sample'
  | 'reaction'
  | 'ketcher'
  | 'attachment';

export interface ResearchPlanQuillDeltaOp {
  insert?: string | Record<string, unknown>;
  attributes?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ResearchPlanQuillDelta {
  ops?: ResearchPlanQuillDeltaOp[];
  [key: string]: unknown;
}

export interface ResearchPlanTableColumn {
  headerName?: string;
  field?: string;
  colId?: string;
  key?: string;
  name?: string;
  width?: number;
  editable?: boolean;
  resizable?: boolean;
  linkType?: 'sample' | 'reaction';
  [key: string]: unknown;
}

export interface ResearchPlanTableValue {
  columns?: ResearchPlanTableColumn[];
  rows?: Array<Record<string, unknown>>;
  columnStates?: Array<Record<string, unknown>>;
  startCollapsed?: boolean;
  [key: string]: unknown;
}

export interface ResearchPlanImageValue {
  file_name?: string | null;
  public_name?: string | null;
  zoom?: number | null;
  attachment_id?: number | null;
  [key: string]: unknown;
}

export interface ResearchPlanSampleValue {
  sample_id?: number | null;
  [key: string]: unknown;
}

export interface ResearchPlanReactionValue {
  reaction_id?: number | null;
  [key: string]: unknown;
}

export interface ResearchPlanKetcherValue {
  sdf_file?: string | null;
  svg_file?: string | null;
  preview_attachment?: unknown;
  [key: string]: unknown;
}

export interface ResearchPlanBlock {
  id?: string;
  type?: ResearchPlanFieldType | string;
  value?:
    | ResearchPlanQuillDelta
    | ResearchPlanTableValue
    | ResearchPlanImageValue
    | ResearchPlanSampleValue
    | ResearchPlanReactionValue
    | ResearchPlanKetcherValue
    | string
    | null
    | unknown;
  title?: string | null;
  [key: string]: unknown;
}

export interface ResearchPlan {
  id: number;
  name?: string;
  body?: ResearchPlanBlock[];
  collection_ids?: number[];
  wellplates?: Wellplate[];
  attachments?: Attachment[];
  container?: Container | null;
  literatures?: Literature[];
  segments?: Segment[];
  creator_id?: number;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

export interface ResearchPlansListResponse {
  research_plans?: ResearchPlan[];
  pagination?: Pagination;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------
// Wellplates & screens
// ---------------------------------------------------------------------

export interface Well {
  id?: number;
  position_x?: number;
  position_y?: number;
  sample_id?: number | null;
  readouts?: Array<Record<string, unknown>>;
  additive?: string | null;
  label?: string | null;
  color_code?: string | null;
  [key: string]: unknown;
}

export interface Wellplate {
  id: number;
  name?: string;
  description?: string | null;
  height?: number;
  width?: number;
  readout_titles?: Array<{ name?: string; unit?: string }>;
  wells?: Well[];
  container?: Container | null;
  attachments?: Attachment[];
  segments?: Segment[];
  collection_ids?: number[];
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

export interface WellplatesListResponse {
  wellplates?: Wellplate[];
  pagination?: Pagination;
  [key: string]: unknown;
}

export interface Screen {
  id: number;
  name?: string;
  description?: string | null;
  collaborator?: string | null;
  requirements?: string | null;
  conditions?: string | null;
  result?: string | null;
  component_graph_data?: Record<string, unknown> | null;
  wellplates?: Wellplate[];
  research_plans?: ResearchPlan[];
  segments?: Segment[];
  container?: Container | null;
  collection_ids?: number[];
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

export interface ScreensListResponse {
  screens?: Screen[];
  pagination?: Pagination;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------
// Containers (analyses tree) and attachments
// ---------------------------------------------------------------------

/**
 * Chemotion containers form a three-level hierarchy:
 *   root container → analyses → datasets → (attachments).
 * Samples, reactions, research plans, and wellplates all embed a
 * single root container on fetch.
 */
export interface Container {
  id: number;
  name?: string | null;
  description?: string | null;
  container_type?: 'root' | 'analysis' | 'dataset' | 'attachment' | string;
  extended_metadata?: Record<string, unknown>;
  children?: Container[];
  attachments?: Attachment[];
  [key: string]: unknown;
}

export interface Attachment {
  id: number;
  filename?: string;
  identifier?: string | null;
  content_type?: string | null;
  filesize?: number;
  thumb?: boolean;
  attachable_id?: number;
  attachable_type?: string;
  aasm_state?: string;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------
// Incidentals: literatures, segments
// ---------------------------------------------------------------------

export interface Literature {
  id?: number;
  title?: string;
  url?: string | null;
  doi?: string | null;
  refs?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Segments are user-defined structured field groups on samples,
 * reactions, etc. (Labimotion/generic-element mechanism.)
 */
export interface Segment {
  id?: number;
  segment_klass_id?: number;
  properties?: Record<string, unknown>;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------

export interface User {
  id: number;
  email?: string;
  first_name?: string;
  last_name?: string;
  name?: string;
  initials?: string;
  is_templates_moderator?: boolean;
  type?: string;
  user_labels?: Array<{ id: number; title: string; color?: string }>;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------

/**
 * Free-form query shape accepted by `POST /search/all` and
 * `POST /search/advanced`. Chemotion's selection schema is complex
 * and version-dependent; we keep it permissive so Phase 5 can shape
 * the payload at the tool layer.
 */
export interface SearchSelection {
  elementType?:
    | 'all'
    | 'samples'
    | 'reactions'
    | 'wellplates'
    | 'screens'
    | 'research_plans'
    | 'cell_lines'
    | string;
  [key: string]: unknown;
}

export interface SearchRequest {
  selection: SearchSelection;
  /**
   * Collection scope lives at the TOP LEVEL of the body. Putting it
   * inside `selection` (as older docs suggested) is silently ignored
   * and the server returns 400 "collection_id is missing".
   */
  collection_id?: number;
  /** 1-based. */
  page?: number;
  per_page?: number;
  [key: string]: unknown;
}

/**
 * Structure search payload. `search_type` is "sub" for substructure
 * and "sim" for similarity. Molfile is required; `tanimoto_threshold`
 * applies to similarity mode only.
 */
export interface StructureSearchRequest {
  selection: SearchSelection & {
    /** The API accepts exactly `sub` or `similar`. */
    search_type: 'sub' | 'similar';
    molfile: string;
    /** 0.0 – 1.0 for similarity; ignored for substructure. */
    tanimoto_threshold?: number;
    /** elementType at minimum "samples"; chemotion also supports reactions. */
  };
  page?: number;
  per_page?: number;
  [key: string]: unknown;
}

/**
 * Response shape from `/search/*`: a bag of per-element-type sub-
 * envelopes. Exact keys vary with `selection.elementType`, so we
 * index-sig everything.
 */
export interface SearchResponse {
  samples?: { elements?: Sample[]; totalElements?: number; page?: number };
  reactions?: { elements?: Reaction[]; totalElements?: number; page?: number };
  wellplates?: {
    elements?: Wellplate[];
    totalElements?: number;
    page?: number;
  };
  screens?: { elements?: Screen[]; totalElements?: number; page?: number };
  research_plans?: {
    elements?: ResearchPlan[];
    totalElements?: number;
    page?: number;
  };
  molecules?: Molecule[];
  [key: string]: unknown;
}

// ---------------------------------------------------------------------
// Convenience: element kinds (for cross-type operations)
// ---------------------------------------------------------------------

export type ChemotionElementType =
  | 'sample'
  | 'reaction'
  | 'research_plan'
  | 'wellplate'
  | 'screen';

/** Plural forms as they appear on the wire. */
export const ELEMENT_TYPE_PLURAL: Record<ChemotionElementType, string> = {
  sample: 'samples',
  reaction: 'reactions',
  research_plan: 'research_plans',
  wellplate: 'wellplates',
  screen: 'screens',
};

// ---------------------------------------------------------------------
// Write payloads
// ---------------------------------------------------------------------

/**
 * Skeleton an MCP caller can pass for the required `container` field on
 * sample / reaction / research_plan create when they do not care about
 * attaching analyses. Matches the empty root container that Chemotion's
 * own UI emits on new-entity creation.
 */
export const EMPTY_ROOT_CONTAINER: ContainerPayload = {
  name: 'new',
  container_type: 'root',
  description: '',
  extended_metadata: {},
  attachments: [],
  children: [],
};

export interface ContainerPayload {
  id?: string | number;
  name?: string;
  container_type?: 'root' | 'analysis' | 'dataset' | string;
  description?: string;
  extended_metadata?: Record<string, unknown>;
  attachments?: Array<Record<string, unknown>>;
  children?: ContainerPayload[];
  [key: string]: unknown;
}

/**
 * Required + commonly-set fields for `POST /api/v1/samples`. The Grape
 * contract also accepts `residues`, `segments`, `literatures`, `xref`
 * etc. — kept as index-sig overflow so we do not over-specify.
 */
export interface SampleCreateBody {
  collection_id?: number;
  name?: string;
  short_label?: string;
  external_label?: string;
  description: string;
  purity: number;
  target_amount_value: number;
  target_amount_unit: string;
  real_amount_value?: number;
  real_amount_unit?: string;
  molarity_value?: number;
  molarity_unit?: string;
  location: string;
  is_top_secret: boolean;
  molfile?: string;
  molecule_id?: number;
  solvent?: Array<Record<string, unknown>>;
  density?: number;
  decoupled?: boolean;
  stereo?: { abs?: string; rel?: string };
  container: ContainerPayload;
  sample_type?: string;
  [key: string]: unknown;
}

/** `container` omitted → the client sends the current one back. */
export type SampleUpdateBody = Partial<SampleCreateBody> & {
  [key: string]: unknown;
};

/**
 * Materials shape the Chemotion Grape contract expects on reaction
 * create / update. Each bucket holds the sample refs for that role;
 * an existing sample is referenced by `id`, a new sample is minted
 * inline via the nested shape the UI sends (`name`, `target_amount_*`,
 * `container`, …). Participant rows can also carry amount / volume /
 * molarity fields such as `real_amount_value` + `real_amount_unit`.
 */
export interface ReactionMaterials {
  starting_materials?: ReactionMaterialEntry[];
  reactants?: ReactionMaterialEntry[];
  products?: ReactionMaterialEntry[];
  solvents?: ReactionMaterialEntry[];
  purification_solvents?: ReactionMaterialEntry[];
  [key: string]: unknown;
}

export interface ReactionCreateBody {
  collection_id: number;
  name?: string;
  short_label?: string;
  description?: Record<string, unknown>;
  observation?: Record<string, unknown>;
  purification?: string[];
  solvent?: string;
  status?: string;
  role?: string;
  temperature?: Record<string, unknown>;
  duration?: string;
  rxno?: string;
  materials: ReactionMaterials;
  container: ContainerPayload;
  [key: string]: unknown;
}

/** `materials` / `container` omitted → the client sends the current ones back. */
export type ReactionUpdateBody = Partial<ReactionCreateBody> & {
  [key: string]: unknown;
};

export interface ResearchPlanCreateBody {
  name: string;
  body?: ResearchPlanBlock[];
  collection_id?: number;
  container: ContainerPayload;
  [key: string]: unknown;
}

/**
 * Wellplate create body. Grape `requires`: `name`, `wells` (array,
 * can be empty `[]` to let server generate the default grid),
 * `collection_id`, `container`. `height` * `width` defines the grid
 * (defaults 8×12 = 96-well), min 1, max 100 per axis.
 */
export interface WellplateCreateBody {
  name: string;
  collection_id: number;
  wells: Array<Record<string, unknown>>;
  container: ContainerPayload;
  description?: Record<string, unknown>;
  readout_titles?: Array<Record<string, unknown>>;
  height?: number;
  width?: number;
  segments?: Array<Record<string, unknown>>;
  user_labels?: Array<unknown>;
  [key: string]: unknown;
}

/**
 * `wells` replaces the whole layout (samples in omitted wells are
 * destroyed); omit it — and `container` — to keep the current state.
 */
export type WellplateUpdateBody = Partial<WellplateCreateBody> & {
  [key: string]: unknown;
};

/**
 * Screen create body. Grape `requires`: `name`, `wellplate_ids`
 * (array, can be empty), `research_plan_ids` (array, can be empty),
 * `container`. `component_graph_data` carries the node/edge DAG
 * when the UI has drawn a component graph; omit for simple cases.
 */
export interface ScreenCreateBody {
  name: string;
  wellplate_ids: number[];
  research_plan_ids: number[];
  container: ContainerPayload;
  collection_id?: number;
  collaborator?: string;
  requirements?: string;
  conditions?: string;
  result?: string;
  description?: Record<string, unknown>;
  component_graph_data?: Record<string, unknown>;
  segments?: Array<Record<string, unknown>>;
  user_labels?: Array<unknown>;
  [key: string]: unknown;
}

/** Omitted id arrays / `container` → the client sends the current ones back. */
export type ScreenUpdateBody = Partial<ScreenCreateBody> & {
  [key: string]: unknown;
};

/** `container` omitted → the client sends the current one back. */
export type ResearchPlanUpdateBody = Partial<ResearchPlanCreateBody> & {
  [key: string]: unknown;
};
