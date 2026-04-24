import {
  type CookieJar,
  type HttpConfig,
  type RequestOptions,
  chemotionFetch,
  chemotionJson,
  makeCookieJar,
} from './http.js';
import {
  type Credentials,
  adoptCookie,
  isSessionAlive,
  loginWithCredentials,
} from './auth.js';
import type {
  Collection,
  CollectionsListResponse,
  ChemotionElementType,
  Reaction,
  ReactionCreateBody,
  ReactionUpdateBody,
  ReactionsListResponse,
  ResearchPlan,
  ResearchPlanCreateBody,
  ResearchPlanUpdateBody,
  ResearchPlansListResponse,
  Sample,
  SampleCreateBody,
  SampleUpdateBody,
  SamplesListResponse,
  Screen,
  ScreenCreateBody,
  ScreenUpdateBody,
  ScreensListResponse,
  SearchRequest,
  SearchResponse,
  SearchSelection,
  StructureSearchRequest,
  User,
  Wellplate,
  WellplateCreateBody,
  WellplateUpdateBody,
  WellplatesListResponse,
} from './types.js';

/**
 * Configuration required to talk to a Chemotion ELN instance.
 *
 * Phase 1 adds the cookie jar (constructed automatically if not
 * supplied) and the optional `onUnauthorized` hook. Phase 2 layers
 * endpoint methods on top of this without changing the shape.
 */
export interface ChemotionConfig {
  /** Root URL, no trailing slash, no `/api/v1` suffix. */
  baseUrl: string;
  /** User-Agent for instance admins reading logs. */
  userAgent?: string;
  /** Per-request timeout in ms. Default 30_000. */
  timeoutMs?: number;
  /**
   * Pre-existing cookie jar. Supply one if you want to share session
   * state across clients (e.g. a smoke script and an MCP server in
   * the same process); otherwise a fresh jar is created.
   */
  jar?: CookieJar;
  /**
   * Called on 401 responses. Return `true` to retry the request
   * once. Credentials-mode wires this to a re-login; cookie-mode
   * leaves it unset so 401s surface to the caller.
   */
  onUnauthorized?: () => Promise<boolean>;
  /** For testing. */
  fetchImpl?: typeof fetch;
}

/**
 * Common filter params accepted by list endpoints on element
 * resources (samples / reactions / research_plans / wellplates /
 * screens). Not every endpoint honours every field — Rails silently
 * drops unknown params, so we pass what the caller gives us.
 */
export interface ElementListQuery {
  collection_id?: number | 'all';
  /** 1-based. */
  page?: number;
  per_page?: number;
  from_date?: string;
  to_date?: string;
  user_label?: number;
  filter_created_at?: boolean;
  /** Samples-only filter: hide non-product samples in reactions. */
  product_only?: boolean;
  /** Samples-only: sort by molecule_weight / sum_formula. */
  molecule_sort?: boolean;
  [key: string]: unknown;
}

/**
 * Stateful client for the Chemotion ELN JSON API.
 *
 * Stateful because Chemotion authenticates via Devise session
 * cookies — each client instance owns a cookie jar. Share one
 * `ChemotionClient` across an MCP session; do not re-instantiate per
 * tool call.
 *
 * Design choices:
 *   - Thin: no retries, no caching, no rate limiting. The MCP tool
 *     layer stacks those on top where it needs them.
 *   - Honest: responses are returned as the server shaped them,
 *     wrapped in the envelope keys Chemotion uses (`samples`,
 *     `molecules`, `pagination`, …). We do not unwrap — callers that
 *     need just `.samples` narrow at the call site.
 *   - Permissive: unknown response fields survive via the
 *     `[key: string]: unknown` index signature on every type.
 */
export class ChemotionClient {
  private readonly http: HttpConfig;

  constructor(config: ChemotionConfig) {
    this.http = {
      baseUrl: config.baseUrl.replace(/\/+$/, ''),
      userAgent: config.userAgent,
      timeoutMs: config.timeoutMs,
      jar: config.jar ?? makeCookieJar(),
      onUnauthorized: config.onUnauthorized,
      fetchImpl: config.fetchImpl,
    };
  }

  get baseUrl(): string {
    return this.http.baseUrl;
  }

  get jar(): CookieJar {
    return this.http.jar;
  }

  // -----------------------------------------------------------------
  // Authentication
  // -----------------------------------------------------------------

  loginWithCredentials(creds: Credentials): Promise<void> {
    return loginWithCredentials(this.http, creds);
  }

  adoptCookie(rawCookie: string): void {
    adoptCookie(this.http.jar, rawCookie);
  }

  isSessionAlive(): Promise<boolean> {
    return isSessionAlive(this.http);
  }

  // -----------------------------------------------------------------
  // Identity
  // -----------------------------------------------------------------

  /** `GET /api/v1/users/current` — the caller's own user record. */
  me(): Promise<{ user: User } | User> {
    return chemotionJson(this.http, '/users/current');
  }

  // -----------------------------------------------------------------
  // Collections
  // -----------------------------------------------------------------

  /**
   * Aggregate the four collection-list endpoints Chemotion actually
   * exposes: `/collections/roots` (caller's own tree),
   * `/collections/shared_roots` (trees shared *with* the caller),
   * `/collections/remote_roots` (federated / remote), and
   * `/collections/locked` (the synthetic "All" / "chemotion-repository.net"
   * pseudo-collections). There is no single `/collections` endpoint —
   * it 405s. The four banks are merged into one response so callers
   * (including the MCP tool layer) see a flat list.
   *
   * The resulting envelope keeps a `roots` / `shared_roots` / etc.
   * breakdown on top of the merged `collections` array so consumers
   * that care about origin can still tell them apart.
   */
  async listCollections(): Promise<CollectionsListResponse> {
    const fetchBank = async (
      path: string
    ): Promise<Collection[]> => {
      try {
        const response = await chemotionJson<{ collections?: Collection[] }>(
          this.http,
          path
        );
        return response.collections ?? [];
      } catch {
        // Some banks return 404 on older builds (e.g. remote_roots
        // before federation was added). Treat as empty rather than
        // failing the whole aggregate.
        return [];
      }
    };

    const [roots, sharedRoots, remoteRoots, locked] = await Promise.all([
      fetchBank('/collections/roots'),
      fetchBank('/collections/shared_roots'),
      fetchBank('/collections/remote_roots'),
      fetchBank('/collections/locked'),
    ]);

    return {
      collections: [...roots, ...sharedRoots, ...remoteRoots, ...locked],
      roots,
      shared_roots: sharedRoots,
      remote_roots: remoteRoots,
      locked,
    };
  }

  /** `GET /api/v1/collections/:id` — single collection. */
  getCollection(id: number): Promise<{ collection: Collection }> {
    return chemotionJson(this.http, `/collections/${id}`);
  }

  /**
   * Resolve the `'all'` pseudo-collection to its real numeric id on
   * this instance. The "All" entry lives in `/collections/locked` and
   * its id is per-user (collections are per-user rows in Chemotion,
   * even the synthetic ones). Cached for the session since the id is
   * stable once the user exists.
   *
   * The Chemotion JSON API rejects `collection_id=all` with a 400 —
   * the string only makes sense inside the React UI's URL router.
   * Every list/search call that takes a `collection_id` must pass
   * this resolver's return value, never the literal `'all'`.
   */
  private allCollectionIdCache?: number;
  async resolveAllCollectionId(): Promise<number> {
    if (this.allCollectionIdCache !== undefined) {
      return this.allCollectionIdCache;
    }
    const response = await chemotionJson<{ collections?: Collection[] }>(
      this.http,
      '/collections/locked'
    );
    const all = (response.collections ?? []).find(
      (c) => c.label === 'All' || (c as { is_locked?: boolean }).is_locked === true
    );
    if (!all || typeof all.id !== 'number') {
      throw new Error(
        "Could not locate the 'All' pseudo-collection on this instance. " +
          "Try passing a real collection_id from chem_list_collections."
      );
    }
    this.allCollectionIdCache = all.id;
    return all.id;
  }

  /**
   * Take a user-facing `collection_id` value (number, `'all'`, or
   * omitted) and produce the numeric id Chemotion's REST endpoints
   * actually accept. Omitted → resolves to the "All" id so every
   * list/search tool has a safe default.
   */
  private async resolveCollectionId(
    value: number | 'all' | undefined
  ): Promise<number> {
    if (typeof value === 'number') return value;
    return this.resolveAllCollectionId();
  }

  // -----------------------------------------------------------------
  // Samples
  // -----------------------------------------------------------------

  /**
   * `GET /api/v1/samples` — paginated list. Requires `collection_id`
   * to narrow (Chemotion does not expose a cross-collection list
   * view via this endpoint; use `/search/samples` for that).
   * `collection_id: 'all'` is resolved to the numeric "All" id;
   * omitting `collection_id` does the same.
   */
  async listSamples(
    query: ElementListQuery = {}
  ): Promise<SamplesListResponse> {
    const collection_id = await this.resolveCollectionId(
      query.collection_id
    );
    return chemotionJson(this.http, '/samples', {
      query: { ...query, collection_id },
    });
  }

  /**
   * `GET /api/v1/samples/:id` — one sample plus its attached analyses
   * (`container`), literatures, and the linked Molecule.
   */
  getSample(id: number): Promise<{ sample: Sample }> {
    return chemotionJson(this.http, `/samples/${id}`);
  }

  /**
   * `GET /api/v1/samples/findByShortLabel/:short_label` — resolves a
   * human-readable label (e.g. "ABC-42") to a sample id and its
   * host collection. The server response envelope uses `sample_id`,
   * not `id`; we normalise to expose both so downstream handlers
   * can read either without another lookup.
   */
  async findSampleByShortLabel(
    shortLabel: string
  ): Promise<{ id?: number; collection_id?: number; [key: string]: unknown }> {
    const response = await chemotionJson<{
      sample_id?: number;
      id?: number;
      collection_id?: number;
      [key: string]: unknown;
    }>(
      this.http,
      `/samples/findByShortLabel/${encodeURIComponent(shortLabel)}`
    );
    return {
      ...response,
      id: response.id ?? response.sample_id,
    };
  }

  // -----------------------------------------------------------------
  // Reactions
  // -----------------------------------------------------------------

  async listReactions(
    query: ElementListQuery = {}
  ): Promise<ReactionsListResponse> {
    const collection_id = await this.resolveCollectionId(
      query.collection_id
    );
    return chemotionJson(this.http, '/reactions', {
      query: { ...query, collection_id },
    });
  }

  getReaction(id: number): Promise<{ reaction: Reaction }> {
    return chemotionJson(this.http, `/reactions/${id}`);
  }

  async findReactionByShortLabel(
    shortLabel: string
  ): Promise<{ id?: number; collection_id?: number; [key: string]: unknown }> {
    const response = await chemotionJson<{
      reaction_id?: number;
      id?: number;
      collection_id?: number;
      [key: string]: unknown;
    }>(
      this.http,
      `/reactions/findByShortLabel/${encodeURIComponent(shortLabel)}`
    );
    return {
      ...response,
      id: response.id ?? response.reaction_id,
    };
  }

  // -----------------------------------------------------------------
  // Research plans
  // -----------------------------------------------------------------

  async listResearchPlans(
    query: ElementListQuery = {}
  ): Promise<ResearchPlansListResponse> {
    const collection_id = await this.resolveCollectionId(
      query.collection_id
    );
    return chemotionJson(this.http, '/research_plans', {
      query: { ...query, collection_id },
    });
  }

  getResearchPlan(id: number): Promise<{ research_plan: ResearchPlan }> {
    return chemotionJson(this.http, `/research_plans/${id}`);
  }

  // -----------------------------------------------------------------
  // Wellplates & screens
  // -----------------------------------------------------------------

  async listWellplates(
    query: ElementListQuery = {}
  ): Promise<WellplatesListResponse> {
    const collection_id = await this.resolveCollectionId(
      query.collection_id
    );
    return chemotionJson(this.http, '/wellplates', {
      query: { ...query, collection_id },
    });
  }

  getWellplate(id: number): Promise<{ wellplate: Wellplate }> {
    return chemotionJson(this.http, `/wellplates/${id}`);
  }

  async listScreens(
    query: ElementListQuery = {}
  ): Promise<ScreensListResponse> {
    const collection_id = await this.resolveCollectionId(
      query.collection_id
    );
    return chemotionJson(this.http, '/screens', {
      query: { ...query, collection_id },
    });
  }

  getScreen(id: number): Promise<{ screen: Screen }> {
    return chemotionJson(this.http, `/screens/${id}`);
  }

  // -----------------------------------------------------------------
  // Molecules (no REST GET /molecules/:id — Chemotion does not expose
  // one. The conversion endpoint is useful for Phase 7 writes.)
  // -----------------------------------------------------------------

  /**
   * `POST /api/v1/molecules/smiles` — converts a SMILES string to a
   * molfile and looks up or creates the corresponding Molecule record.
   * Use this as a preprocessing step when `chem_create_sample` is
   * called with SMILES instead of molfile.
   *
   * Response shape varies by instance; we return `unknown` and let
   * callers narrow. Typical fields: `molfile`, `molecule` (full
   * Molecule record), `svg`.
   */
  smilesToMolfile(
    smiles: string,
    options?: { svg_file?: string; layout?: string; editor?: string }
  ): Promise<unknown> {
    return chemotionJson(this.http, '/molecules/smiles', {
      method: 'POST',
      body: { smiles, ...options },
    });
  }

  // -----------------------------------------------------------------
  // Search
  // -----------------------------------------------------------------

  /**
   * `POST /api/v1/search/all` — free-text search across all element
   * kinds. Returns a bag of per-kind result envelopes.
   *
   * Wire shape (verified against a live 1.x instance):
   *   - `collection_id` belongs at the TOP LEVEL of the body, not
   *     inside `selection`. Omit or pass `'all'` and the client
   *     resolves to the numeric "All" id.
   *   - `selection.elementType` must be `"all"` (or a plural like
   *     `"samples"`) — `"sample"` triggers "does not have a valid
   *     value".
   *   - `selection.search_by_method` / `selection.name_column` /
   *     `selection.name` are the fields the server reads for
   *     substring matching; anything inside `selection` that the
   *     server doesn't recognise is silently dropped.
   */
  async searchAll(
    selection: SearchSelection,
    options?: {
      page?: number;
      per_page?: number;
      collection_id?: number | 'all';
    }
  ): Promise<SearchResponse> {
    const collection_id = await this.resolveCollectionId(
      options?.collection_id
    );
    const body: SearchRequest = {
      selection,
      collection_id,
      page: options?.page,
      per_page: options?.per_page,
    };
    return chemotionJson(this.http, '/search/all', {
      method: 'POST',
      body,
    });
  }

  /** Same free-text search but restricted to one element kind. */
  async searchElementType(
    elementType: 'samples' | 'reactions' | 'wellplates' | 'screens',
    selection: SearchSelection,
    options?: {
      page?: number;
      per_page?: number;
      collection_id?: number | 'all';
    }
  ): Promise<SearchResponse> {
    const collection_id = await this.resolveCollectionId(
      options?.collection_id
    );
    const body: SearchRequest = {
      selection: { ...selection, elementType },
      collection_id,
      page: options?.page,
      per_page: options?.per_page,
    };
    return chemotionJson(this.http, `/search/${elementType}`, {
      method: 'POST',
      body,
    });
  }

  /**
   * `POST /api/v1/search/structure` — substructure or similarity
   * search by molfile. Set `search_type: 'sub'` for substructure or
   * `'sim'` + `tanimoto_threshold` for similarity.
   */
  async searchStructure(
    request: StructureSearchRequest,
    options?: { collection_id?: number | 'all' }
  ): Promise<SearchResponse> {
    const collection_id = await this.resolveCollectionId(
      options?.collection_id
    );
    return chemotionJson(this.http, '/search/structure', {
      method: 'POST',
      body: { ...request, collection_id },
    });
  }

  /**
   * `POST /api/v1/search/advanced` — structured-filter search. The
   * selection payload carries Chemotion's filter DSL (keys like
   * `field`, `value`, `match`, `link`). We pass it through verbatim.
   * `collection_id` is top-level and resolved for the caller.
   */
  async searchAdvanced(
    selection: Record<string, unknown>,
    options?: {
      page?: number;
      per_page?: number;
      collection_id?: number | 'all';
    }
  ): Promise<SearchResponse> {
    const collection_id = await this.resolveCollectionId(
      options?.collection_id
    );
    return chemotionJson(this.http, '/search/advanced', {
      method: 'POST',
      body: {
        selection,
        collection_id,
        page: options?.page,
        per_page: options?.per_page,
      },
    });
  }

  /**
   * `POST /api/v1/search/by_ids` — fetch specific element ids.
   *
   * Chemotion's wire shape here is idiosyncratic (verified against
   * `Usecases::Search::ByIds`):
   *   - `selection.elementType` must be the literal string `"by_ids"`,
   *     NOT the plural or singular element name.
   *   - The actual element kind goes in `selection.id_params.model_name`
   *     as a **lowercase singular** (`"sample"`, `"reaction"`,
   *     `"research_plan"`, `"wellplate"`, `"screen"`).
   *   - The ids list goes in `selection.id_params.ids`.
   *   - `selection.id_params.total_elements` is read during
   *     serialisation to compute pagination — pass `ids.length` so
   *     the server doesn't divide-by-zero when kaminari pages.
   *   - `page_size` (not `per_page`) drives `.per(...)` inside the
   *     usecase; send both to be safe.
   *   - `collection_id` is top-level and Grape wants it as a String,
   *     but JSON numbers coerce fine.
   */
  async searchByIds(
    ids: number[],
    elementType: ChemotionElementType,
    options?: {
      collection_id?: number | 'all';
      page?: number;
      per_page?: number;
    }
  ): Promise<SearchResponse> {
    const collection_id = await this.resolveCollectionId(
      options?.collection_id
    );
    const page = options?.page ?? 1;
    const perPage = options?.per_page ?? 25;
    return chemotionJson(this.http, '/search/by_ids', {
      method: 'POST',
      body: {
        selection: {
          elementType: 'by_ids',
          id_params: {
            model_name: elementType,
            ids,
            total_elements: ids.length,
          },
        },
        collection_id,
        page,
        page_size: perPage,
        per_page: perPage,
      },
    });
  }

  // -----------------------------------------------------------------
  // Attachments (binary download)
  // -----------------------------------------------------------------

  /**
   * `GET /api/v1/attachments/:id` — raw attachment bytes. Returns the
   * Response so callers can stream or buffer as they prefer.
   */
  downloadAttachment(id: number): Promise<Response> {
    return chemotionFetch(this.http, `/attachments/${id}`, {
      accept: '*/*',
    });
  }

  /**
   * `GET /api/v1/attachments/image/:id` — rendered image (bytes).
   * Used for SVGs and embedded research-plan images.
   */
  downloadAttachmentImage(id: number): Promise<Response> {
    return chemotionFetch(this.http, `/attachments/image/${id}`, {
      accept: '*/*',
    });
  }

  /**
   * `GET /api/v1/attachments/zip/:container_id` — zipped dump of a
   * container's attachments. Use when pulling an entire analysis
   * tree at once.
   */
  downloadContainerZip(containerId: number): Promise<Response> {
    return chemotionFetch(this.http, `/attachments/zip/${containerId}`, {
      accept: '*/*',
    });
  }

  // -----------------------------------------------------------------
  // Write: samples
  // -----------------------------------------------------------------

  /**
   * `POST /api/v1/samples` — create a sample. The Chemotion Grape
   * contract requires `target_amount_value` + `target_amount_unit`,
   * `description`, `purity`, `location`, `is_top_secret`, and a
   * `container` Hash. Callers that do not care about the analyses
   * tree can pass `EMPTY_ROOT_CONTAINER` for `container`.
   *
   * Defensive default: Chemotion's create handler reads
   * `params[:xref][:inventory_label]` WITHOUT a nil-check
   * (sample_api.rb L608 as of 2026-04), so omitting `xref` causes a
   * NoMethodError → 500. We default `xref: {}` when the caller
   * didn't provide one so the handler's `[:inventory_label]` lookup
   * returns nil safely.
   *
   * The returned envelope is `{ sample: Sample }`.
   */
  createSample(body: SampleCreateBody): Promise<{ sample: Sample }> {
    const payload = { xref: {}, ...body };
    return chemotionJson(this.http, '/samples', {
      method: 'POST',
      body: payload,
    });
  }

  /**
   * `PUT /api/v1/samples/:id` — partial update. Chemotion silently
   * drops unknown params, so this takes a permissive Record. The
   * Grape contract requires `container` on PUT as well — pass the
   * sample's existing container back untouched if you are not
   * editing analyses. `getSample(id)` returns the container on its
   * response envelope.
   */
  updateSample(
    id: number,
    body: SampleUpdateBody
  ): Promise<{ sample: Sample }> {
    return chemotionJson(this.http, `/samples/${id}`, {
      method: 'PUT',
      body,
    });
  }

  /** `DELETE /api/v1/samples/:id` — hard delete. No soft-delete flag. */
  deleteSample(id: number): Promise<unknown> {
    return chemotionJson(this.http, `/samples/${id}`, { method: 'DELETE' });
  }

  // -----------------------------------------------------------------
  // Write: reactions
  // -----------------------------------------------------------------

  /**
   * `POST /api/v1/reactions` — create a reaction. Requires
   * `collection_id`, `materials` (Hash with arrays under
   * `starting_materials`, `reactants`, `products`, `solvents`), and
   * `container`. Each material entry is a sample ref — typically
   * `{ id, reference, equivalent, position, real_amount_*, target_amount_* }`
   * for an existing sample, or a new-sample shape if Chemotion should
   * mint one inline.
   *
   * The `name`, `short_label`, and `rxno` fields are server-derived
   * when omitted but can be set explicitly.
   */
  createReaction(
    body: ReactionCreateBody
  ): Promise<{ reaction: Reaction }> {
    return chemotionJson(this.http, '/reactions', {
      method: 'POST',
      body,
    });
  }

  /**
   * `PUT /api/v1/reactions/:id` — partial update. Grape requires
   * `materials` + `container` on PUT; pass the reaction's existing
   * values back if you are only editing other fields. `getReaction`
   * returns both on the response envelope.
   */
  updateReaction(
    id: number,
    body: ReactionUpdateBody
  ): Promise<{ reaction: Reaction }> {
    return chemotionJson(this.http, `/reactions/${id}`, {
      method: 'PUT',
      body,
    });
  }

  /** `DELETE /api/v1/reactions/:id` — hard delete. */
  deleteReaction(id: number): Promise<unknown> {
    return chemotionJson(this.http, `/reactions/${id}`, { method: 'DELETE' });
  }

  // -----------------------------------------------------------------
  // Write: research plans
  // -----------------------------------------------------------------

  /**
   * `POST /api/v1/research_plans` — create a research plan. Requires
   * `name` and `container` (pass `EMPTY_ROOT_CONTAINER` if no
   * analyses). `body` is an array of typed blocks; an empty array
   * is valid and produces a blank plan. Minimal block example:
   * `{ id, type: 'richtext', value: { ops: [{ insert: 'hello' }] }, title: '' }`.
   */
  createResearchPlan(
    body: ResearchPlanCreateBody
  ): Promise<{ research_plan: ResearchPlan }> {
    return chemotionJson(this.http, '/research_plans', {
      method: 'POST',
      body,
    });
  }

  /**
   * `PUT /api/v1/research_plans/:id` — partial update. Grape requires
   * `container`; pass the plan's existing container back if you are
   * only editing `body` or `name`.
   */
  updateResearchPlan(
    id: number,
    body: ResearchPlanUpdateBody
  ): Promise<{ research_plan: ResearchPlan }> {
    return chemotionJson(this.http, `/research_plans/${id}`, {
      method: 'PUT',
      body,
    });
  }

  /**
   * `POST /api/v1/research_plans/svg` — persist raw SVG markup for a
   * research-plan Ketcher block and return the stored filename. The UI
   * calls this after the structure editor produces inline SVG so the
   * plan body can reference a stable filesystem path.
   */
  saveResearchPlanSvg(
    svg_file: string,
    is_chemdraw = false
  ): Promise<{ svg_path: string }> {
    return chemotionJson(this.http, '/research_plans/svg', {
      method: 'POST',
      body: {
        svg_file,
        is_chemdraw,
      },
    });
  }

  /**
   * Research plans have no per-id DELETE endpoint in Chemotion. The
   * canonical path is `DELETE /api/v1/ui_state/` with a ui_state
   * payload naming the collection and the checked ids. We scope the
   * delete to `Collection.get_all_collection_for_user` (id=0 sentinel)
   * so a plan gets wiped regardless of which collection the caller
   * is viewing. Samples / reactions can reach this path too if we
   * ever need to bulk-delete them; for now keep single-entity
   * semantics.
   */
  deleteResearchPlanByUiState(id: number): Promise<unknown> {
    return chemotionJson(this.http, '/ui_state/', {
      method: 'DELETE',
      body: {
        currentCollection: { id: 0 },
        options: { deleteSubsamples: false },
        research_plan: { checkedIds: [id], uncheckedIds: [], checkedAll: false },
        selecteds: [],
      },
    });
  }

  // -----------------------------------------------------------------
  // Write: wellplates
  // -----------------------------------------------------------------

  /**
   * `POST /api/v1/wellplates` — create a wellplate. Grape requires
   * `name`, `collection_id`, `wells`, and `container`. `wells` may be
   * an empty array (server generates the default `height` × `width`
   * grid; defaults are 8 × 12 = 96 wells). Caller-supplied wells
   * override the grid.
   */
  createWellplate(
    body: WellplateCreateBody
  ): Promise<{ wellplate: Wellplate }> {
    return chemotionJson(this.http, '/wellplates', {
      method: 'POST',
      body,
    });
  }

  /**
   * `PUT /api/v1/wellplates/:id` — partial update. Grape requires
   * `container`; pass the wellplate's existing container back unless
   * editing analyses.
   *
   * Defensive default: the server-side `Usecases::Wellplates::Update`
   * calls `WellplateUpdater.update_wells(well_data: params[:wells])`
   * which NPEs when `params[:wells]` is nil (i.e. when the caller
   * didn't pass any). Grape lists `wells` as optional on PUT but the
   * usecase treats it as required. We default `wells: []` so the
   * updater has an iterable to walk — an empty well array is a no-op
   * in the wells layer.
   */
  updateWellplate(
    id: number,
    body: WellplateUpdateBody
  ): Promise<{ wellplate: Wellplate }> {
    const payload = { wells: [], ...body };
    return chemotionJson(this.http, `/wellplates/${id}`, {
      method: 'PUT',
      body: payload,
    });
  }

  /** `DELETE /api/v1/wellplates/:id` — hard delete. */
  deleteWellplate(id: number): Promise<unknown> {
    return chemotionJson(this.http, `/wellplates/${id}`, {
      method: 'DELETE',
    });
  }

  // -----------------------------------------------------------------
  // Write: screens
  // -----------------------------------------------------------------

  /**
   * `POST /api/v1/screens` — create a screen. Grape requires `name`,
   * `wellplate_ids`, `research_plan_ids`, and `container`. The id
   * arrays may be empty (`[]`) when the screen has no attached
   * wellplates / plans yet.
   */
  createScreen(body: ScreenCreateBody): Promise<{ screen: Screen }> {
    return chemotionJson(this.http, '/screens', {
      method: 'POST',
      body,
    });
  }

  /**
   * `PUT /api/v1/screens/:id` — partial update. Grape requires
   * `wellplate_ids`, `research_plan_ids`, and `container`. The PUT
   * handler reconciles wellplate attachment by diffing the submitted
   * ids against the current ones, so passing a different list
   * attaches / detaches wellplates accordingly.
   */
  updateScreen(
    id: number,
    body: ScreenUpdateBody
  ): Promise<{ screen: Screen }> {
    return chemotionJson(this.http, `/screens/${id}`, {
      method: 'PUT',
      body,
    });
  }

  /**
   * Screens have no per-id DELETE endpoint — same situation as
   * research plans. Route through `/ui_state/` with the
   * `Collection.get_all_collection_for_user` sentinel so the screen
   * is wiped regardless of which collection the caller is viewing.
   */
  deleteScreenByUiState(id: number): Promise<unknown> {
    return chemotionJson(this.http, '/ui_state/', {
      method: 'DELETE',
      body: {
        currentCollection: { id: 0 },
        options: { deleteSubsamples: false },
        screen: { checkedIds: [id], uncheckedIds: [], checkedAll: false },
        selecteds: [],
      },
    });
  }

  // -----------------------------------------------------------------
  // Escape hatches
  // -----------------------------------------------------------------

  /** Raw JSON request. For endpoints not yet wrapped. */
  request<T = unknown>(path: string, options?: RequestOptions): Promise<T> {
    return chemotionJson<T>(this.http, path, options);
  }

  /** Raw fetch (returns Response). For binary downloads. */
  fetch(path: string, options?: RequestOptions): Promise<Response> {
    return chemotionFetch(this.http, path, options);
  }

  // -----------------------------------------------------------------
  // Pagination
  // -----------------------------------------------------------------

  /**
   * Generic pager over a list endpoint. Supply the list method and
   * the envelope key that carries the rows, and this yields every
   * row across every page.
   *
   * Usage:
   * ```ts
   * for await (const sample of client.paginate(
   *   (query) => client.listSamples(query),
   *   'samples',
   *   { collection_id: 1 }
   * )) { ... }
   * ```
   *
   * Stops when a page returns fewer rows than `per_page` or when the
   * `pagination.total_pages` is reached (whichever we can tell first).
   */
  async *paginate<TKey extends string, T>(
    listFn: (query: ElementListQuery) => Promise<
      { pagination?: { page?: number; total_pages?: number } } & Record<
        TKey,
        T[] | undefined
      >
    >,
    rowsKey: TKey,
    baseQuery: ElementListQuery = {},
    pageSize = 25
  ): AsyncGenerator<T, void, unknown> {
    let page = baseQuery.page ?? 1;
    while (true) {
      const response = await listFn({
        ...baseQuery,
        page,
        per_page: pageSize,
      });
      const rows = (response[rowsKey] ?? []) as T[];
      for (const row of rows) yield row;

      const totalPages = response.pagination?.total_pages;
      if (typeof totalPages === 'number' && page >= totalPages) return;
      if (rows.length < pageSize) return;
      page += 1;
    }
  }
}
