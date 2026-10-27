import {
  ChemotionApiError,
  type CookieJar,
  type HttpConfig,
  type RequestOptions,
  chemotionFetch,
  chemotionJson,
  makeCookieJar,
} from './http.js';
import {
  type Credentials,
  adoptApiToken,
  adoptCookie,
  isSessionAlive,
  loginWithCredentials,
} from './auth.js';
import {
  type Collection,
  type CollectionsListResponse,
  type ChemotionElementType,
  type Reaction,
  type ReactionCreateBody,
  type ReactionMaterials,
  type ReactionUpdateBody,
  type ReactionsListResponse,
  type ResearchPlan,
  type ResearchPlanCreateBody,
  type ResearchPlanUpdateBody,
  type ResearchPlansListResponse,
  type Sample,
  type SampleCreateBody,
  type SampleUpdateBody,
  type SamplesListResponse,
  type Screen,
  type ScreenCreateBody,
  type ScreenUpdateBody,
  type ScreensListResponse,
  type SearchRequest,
  type SearchResponse,
  type SearchSelection,
  type StructureSearchRequest,
  type User,
  type Wellplate,
  type WellplateCreateBody,
  type WellplateUpdateBody,
  type WellplatesListResponse,
  type ContainerPayload,
  type Pagination,
  EMPTY_ROOT_CONTAINER,
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
   * Personal API token (`chemtoken_…`, Chemotion v4+) or a JWT. Sent
   * as `Authorization: Bearer`. Equivalent to calling `adoptApiToken`.
   */
  apiToken?: string;
  /**
   * Called on 401 responses. Return `true` to retry the request
   * once. Credentials-mode wires this to a re-login; token and cookie
   * mode leave it unset so 401s surface to the caller. Concurrent 401s
   * share one in-flight call.
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
  /**
   * Lower date bound. ISO date string, `Date`, or Unix seconds — the
   * API takes Unix seconds and the client converts. Filters on
   * `updated_at` unless `filter_created_at` is true.
   */
  from_date?: string | number | Date;
  /** Upper date bound (inclusive day). Same formats as `from_date`. */
  to_date?: string | number | Date;
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
      onUnauthorized: config.onUnauthorized
        ? singleFlight(config.onUnauthorized)
        : undefined,
      fetchImpl: config.fetchImpl,
    };
    if (config.apiToken) adoptApiToken(this.http, config.apiToken);
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

  adoptApiToken(token: string): void {
    adoptApiToken(this.http, token);
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
   * Every collection visible to the caller, as one flat list plus a
   * per-origin breakdown.
   *
   * Chemotion v4 serves this from `GET /collections` as
   * `{own: [...], shared_with_me: [...]}` — flat rows linked by
   * `ancestry`, the locked "All" / "chemotion-repository.net" rows
   * included in `own`. Older releases 405 on that route and instead
   * expose four banks: `/collections/roots`, `/shared_roots`,
   * `/remote_roots`, and `/locked`. We try v4 first and fall back.
   */
  async listCollections(): Promise<CollectionsListResponse> {
    try {
      const response = await chemotionJson<{
        own?: Collection[];
        shared_with_me?: Collection[];
      }>(this.http, '/collections');
      if (Array.isArray(response?.own) || Array.isArray(response?.shared_with_me)) {
        const own = response.own ?? [];
        const shared = (response.shared_with_me ?? []).map((c) => ({
          ...c,
          is_shared: true,
        }));
        const roots = own.filter((c) => !c.is_locked);
        const locked = own.filter((c) => c.is_locked);
        return {
          collections: [...roots, ...shared, ...locked],
          roots,
          shared_roots: shared,
          remote_roots: [],
          locked,
        };
      }
    } catch (error) {
      if (!isMissingRoute(error)) throw error;
    }

    const fetchBank = async (path: string): Promise<Collection[]> => {
      try {
        const response = await chemotionJson<{ collections?: Collection[] }>(
          this.http,
          path
        );
        return response?.collections ?? [];
      } catch (error) {
        // Some banks are missing on some builds (e.g. remote_roots
        // before federation, synchronized collections removed). Treat
        // those as empty, but let auth and server errors surface.
        if (isMissingRoute(error)) return [];
        throw error;
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
   * this instance. The "All" row is a locked, per-user collection, so
   * its id differs between users. Cached for the session.
   *
   * Element and search endpoints take a numeric `collection_id`;
   * every call that accepts `'all'` routes through here.
   */
  private allCollectionIdCache?: number;
  async resolveAllCollectionId(): Promise<number> {
    if (this.allCollectionIdCache !== undefined) {
      return this.allCollectionIdCache;
    }
    const { locked = [], collections = [] } = await this.listCollections();
    const all =
      locked.find((c) => c.label === 'All') ??
      collections.find((c) => c.is_locked && c.label === 'All');
    if (!all || typeof all.id !== 'number') {
      throw new Error(
        "Could not locate the 'All' pseudo-collection on this instance. " +
          'Try passing a real collection_id from chem_list_collections.'
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

  /**
   * GET a paginated list endpoint. Chemotion paginates with
   * grape-kaminari, which reports totals in `X-Total` /
   * `X-Total-Pages` / `X-Page` / `X-Per-Page` response headers rather
   * than the body; we surface them as `pagination` on the result.
   * Date bounds are converted to the Unix seconds the API expects.
   */
  private async listJson<T extends { pagination?: Pagination }>(
    path: string,
    query: ElementListQuery
  ): Promise<T> {
    const { from_date, to_date, ...rest } = query;
    const response = await chemotionFetch(this.http, path, {
      query: {
        ...rest,
        from_date: toUnixSeconds(from_date),
        to_date: toUnixSeconds(to_date),
      },
    });
    const text = await response.text();
    const body = (text ? JSON.parse(text) : {}) as T;
    if (!body.pagination) {
      const header = (name: string): number | undefined => {
        const raw = response.headers.get(name);
        const n = raw == null ? Number.NaN : Number(raw);
        return Number.isFinite(n) ? n : undefined;
      };
      const pagination: Pagination = {
        page: header('x-page'),
        per_page: header('x-per-page'),
        total_count: header('x-total'),
        total_pages: header('x-total-pages'),
      };
      if (Object.values(pagination).some((v) => v !== undefined)) {
        body.pagination = pagination;
      }
    }
    return body;
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
    return this.listJson<SamplesListResponse>('/samples', { ...query, collection_id });
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
    return this.listJson<ReactionsListResponse>('/reactions', { ...query, collection_id });
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
    return this.listJson<ResearchPlansListResponse>('/research_plans', { ...query, collection_id });
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
    return this.listJson<WellplatesListResponse>('/wellplates', { ...query, collection_id });
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
    return this.listJson<ScreensListResponse>('/screens', { ...query, collection_id });
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
   * `PUT /api/v1/samples/:id` — partial update; omitted fields stay
   * unchanged. Grape requires `container` on PUT; when the caller
   * omits it we send the sample's current container back. Containers
   * are merged server-side (only children flagged `is_deleted` are
   * removed), so passing the fetched tree back is a no-op.
   */
  async updateSample(
    id: number,
    body: SampleUpdateBody
  ): Promise<{ sample: Sample }> {
    const container =
      body.container ?? containerOf((await this.getSample(id)).sample);
    return chemotionJson(this.http, `/samples/${id}`, {
      method: 'PUT',
      body: { ...body, container },
    });
  }

  /**
   * `DELETE /api/v1/samples/:id`. Chemotion soft-deletes (sets
   * `deleted_at`), but nothing in the API or UI restores the record.
   */
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
   * `materials` + `container` on PUT. Either one the caller omits is
   * filled from the reaction's current state: materials are sent back
   * as the full participant rows `getReaction` returned (see
   * `cloneReactionMaterials` for why a trimmed copy is unsafe).
   */
  async updateReaction(
    id: number,
    body: ReactionUpdateBody
  ): Promise<{ reaction: Reaction }> {
    let { materials, container } = body;
    if (!materials || !container) {
      const { reaction } = await this.getReaction(id);
      materials ??= cloneReactionMaterials(reaction);
      container ??= containerOf(reaction);
    }
    return chemotionJson(this.http, `/reactions/${id}`, {
      method: 'PUT',
      body: { ...body, materials, container },
    });
  }

  /** `DELETE /api/v1/reactions/:id` — soft-delete, not restorable via the API. */
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
   * `container`; omitted → the plan's current container is sent back.
   * A `body` sent here replaces the whole block array.
   */
  async updateResearchPlan(
    id: number,
    body: ResearchPlanUpdateBody
  ): Promise<{ research_plan: ResearchPlan }> {
    const container =
      body.container ??
      containerOf((await this.getResearchPlan(id)).research_plan);
    return chemotionJson(this.http, `/research_plans/${id}`, {
      method: 'PUT',
      body: { ...body, container },
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
  deleteResearchPlanByUiState(id: number): Promise<UiStateDeleteResponse> {
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
   * `container`; omitted → the current container is sent back.
   *
   * `wells` is NOT a patch: the server's `WellplateUpdater#update_wells`
   * walks the submitted wells and then destroys every sample that sat
   * in the plate but is missing from the payload. Sending `wells: []`
   * would therefore delete all the plate's samples, and omitting it
   * crashes older builds on a nil `wells`. When the caller omits
   * `wells` we send the current layout back unchanged.
   */
  async updateWellplate(
    id: number,
    body: WellplateUpdateBody
  ): Promise<{ wellplate: Wellplate }> {
    let { wells, container } = body;
    if (!wells || !container) {
      const { wellplate } = await this.getWellplate(id);
      wells ??= structuredClone(
        (wellplate.wells ?? []) as Array<Record<string, unknown>>
      );
      container ??= containerOf(wellplate);
    }
    return chemotionJson(this.http, `/wellplates/${id}`, {
      method: 'PUT',
      body: { ...body, wells, container },
    });
  }

  /** `DELETE /api/v1/wellplates/:id` — soft-delete, not restorable via the API. */
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
   * `wellplate_ids`, `research_plan_ids`, and `container`; any the
   * caller omits are filled from the screen's current state. The PUT
   * handler diffs `wellplate_ids` against the current links, so a
   * different list attaches / detaches wellplates accordingly.
   */
  async updateScreen(
    id: number,
    body: ScreenUpdateBody
  ): Promise<{ screen: Screen }> {
    let { wellplate_ids, research_plan_ids, container } = body;
    if (!wellplate_ids || !research_plan_ids || !container) {
      const { screen } = await this.getScreen(id);
      wellplate_ids ??= idsOf(screen.wellplates);
      research_plan_ids ??= idsOf(screen.research_plans);
      container ??= containerOf(screen);
    }
    return chemotionJson(this.http, `/screens/${id}`, {
      method: 'PUT',
      body: { ...body, wellplate_ids, research_plan_ids, container },
    });
  }

  /**
   * Screens have no per-id DELETE endpoint — same situation as
   * research plans. Route through `/ui_state/` with the
   * `Collection.get_all_collection_for_user` sentinel so the screen
   * is wiped regardless of which collection the caller is viewing.
   */
  deleteScreenByUiState(id: number): Promise<UiStateDeleteResponse> {
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

/**
 * Response of `DELETE /ui_state/`. On v4, `locked_sample_ids` lists
 * samples kept back because a reaction or wellplate still uses them.
 */
export interface UiStateDeleteResponse {
  selecteds?: unknown[];
  locked_sample_ids?: number[];
  [key: string]: unknown;
}

const MATERIAL_BUCKETS = [
  'starting_materials',
  'reactants',
  'products',
  'solvents',
  'purification_solvents',
  'reactant_sbmm_samples',
] as const;

/**
 * Deep-copy a reaction's participant rows into a `materials` payload
 * for `PUT /reactions/:id`, keeping every field the GET returned.
 *
 * Do not trim these rows. For existing participants the server's
 * `Usecases::Reactions::UpdateMaterials` assigns `solvent`, `metrics`,
 * `dry_solvent`, amounts, `show_label`, gas-phase and
 * weight-percentage fields straight from the payload, so a field left
 * out is written back as nil; a polymer sample without `residues`
 * raises a 500; and any bucket left out — including
 * `reactant_sbmm_samples` on v4 — has its samples destroyed. Sending
 * the GET rows back verbatim is what the Chemotion UI does.
 */
export function cloneReactionMaterials(
  reaction: Reaction
): Record<(typeof MATERIAL_BUCKETS)[number], Array<Record<string, unknown>>> &
  ReactionMaterials {
  const materials: Record<string, Array<Record<string, unknown>>> = {};
  for (const bucket of MATERIAL_BUCKETS) {
    const rows = (reaction as Record<string, unknown>)[bucket];
    if (bucket === 'reactant_sbmm_samples' && !Array.isArray(rows)) continue;
    materials[bucket] = Array.isArray(rows)
      ? structuredClone(rows as Array<Record<string, unknown>>)
      : [];
  }
  return materials as ReturnType<typeof cloneReactionMaterials>;
}

function containerOf(entity: { container?: unknown }): ContainerPayload {
  return entity.container && typeof entity.container === 'object'
    ? structuredClone(entity.container as ContainerPayload)
    : structuredClone(EMPTY_ROOT_CONTAINER);
}

function idsOf(rows: unknown): number[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => (row as { id?: unknown } | null)?.id)
    .filter((id): id is number => typeof id === 'number');
}

function isMissingRoute(error: unknown): boolean {
  return (
    error instanceof ChemotionApiError &&
    (error.statusCode === 404 || error.statusCode === 405)
  );
}

/** Accepts Unix seconds, a `Date`, or a date string; returns Unix seconds. */
function toUnixSeconds(
  value: string | number | Date | undefined
): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'number') return Math.floor(value);
  if (value instanceof Date) return Math.floor(value.getTime() / 1000);
  if (/^\d+$/.test(value)) return Number(value);
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new Error(`Unparseable date "${value}". Use an ISO date like 2026-01-31.`);
  }
  return Math.floor(ms / 1000);
}

/** Collapse concurrent calls into one in-flight promise. */
function singleFlight<T>(fn: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => {
    pending ??= fn().finally(() => {
      pending = undefined;
    });
    return pending;
  };
}
