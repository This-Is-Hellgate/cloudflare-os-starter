/**
 * The shared live-paging runtime for Gatekeeper cursor capabilities.
 *
 * Gatekeepers hand agents cursor RPC capabilities (`Cursor<T>` per workshop-shared: call `next()`
 * until it returns null). Vendors page differently — Hugging Face Hub uses an offset page number,
 * the datasets-server uses offset/length windows with a known total, Snowflake partitions large
 * results with per-partition metadata returned up front — but the *mechanics* of a live cursor are
 * vendor-independent, and this package owns them exactly once:
 *
 *  - Each `next()` performs at most one vendor fetch through the injected `fetchPage`.
 *  - Exhaustion is idempotent: once a fetch reports exhaustion, later `next()` calls return null
 *    without touching the vendor again.
 *  - A walk is bounded: after `maxPages` fetches the cursor refuses further service calls rather
 *    than walking an unbounded link chain.
 *  - A cursor has a deliberate close: `close()` ends the capability's lifetime; later walks throw
 *    instead of silently resurrecting it.
 *  - Walks never overlap: a second `next()` while one is in flight is rejected.
 *  - A failed fetch is reported, consumes page budget, and leaves the cursor usable — transient
 *    vendor failures stay retryable without claiming success (per the gatekeepers' reviews).
 *
 * This package is deliberately decorator-free. RPC validation shapes are compiled per project by
 * capnweb-validate; a decorated class in a source-consumed dependency is never transformed and
 * would throw at startup. Each gatekeeper therefore keeps its own thin `@validateRpc()` RpcTarget
 * that delegates to a `LivePageSource` minted inside its governed session flow — that closure is
 * what carries the capability's resource identity and authority.
 */

/** One vendor response: the bounded items on this page, plus whether the walk has reached the end. */
export interface LivePage<T> {
  items: T[];
  /**
   * True when the vendor has no more data after this page. Vendors should derive this from an
   * authoritative contract signal (a reported total, a last-partition marker) rather than from a
   * short page: a filtered or fixed-size page can legitimately be empty mid-walk.
   */
  exhausted: boolean;
}

/** Fetches the NEXT page from the service. One call = one vendor round trip. */
export type LivePageFetcher<T> = () => Promise<LivePage<T>>;

/** Default page budget per cursor walk; the hard maximum the runtime accepts is 100. */
export const DEFAULT_MAX_PAGES = 10;
export const MAX_MAX_PAGES = 100;

export interface LivePageSourceOptions<T> {
  fetchPage: LivePageFetcher<T>;
  /** Fetch budget for this cursor. Defaults to 10; hard maximum 100. */
  maxPages?: number;
  /** Vendor label used in error messages, e.g. "Hugging Face discussions". */
  label?: string;
}

/**
 * The vendor-independent state machine behind a live cursor capability. Plain class, no RPC
 * surface: gatekeepers wrap it in their own transformed RpcTarget.
 */
export class LivePageSource<T> {
  readonly #fetchPage: LivePageFetcher<T>;
  readonly #maxPages: number;
  readonly #label: string;

  #walked = 0;
  #exhausted = false;
  #closed = false;
  #inFlight = false;

  constructor(options: LivePageSourceOptions<T>) {
    this.#fetchPage = options.fetchPage;
    const max = options.maxPages ?? DEFAULT_MAX_PAGES;
    if (!Number.isInteger(max) || max < 1 || max > MAX_MAX_PAGES) {
      throw new Error(`Cursor page budget must be an integer between 1 and ${MAX_MAX_PAGES}.`);
    }
    this.#maxPages = max;
    this.#label = options.label ?? "cursor";
  }

  /** Service fetches performed so far, including failed ones. */
  get walked(): number { return this.#walked; }

  /** Whether the walk has reached the vendor's end of data. */
  get exhausted(): boolean { return this.#exhausted; }

  /** Whether the capability's lifetime has been ended by `close()`. */
  get closed(): boolean { return this.#closed; }

  /** The configured fetch budget. */
  get maxPages(): number { return this.#maxPages; }

  /**
   * The next batch of items, or null once the walk is exhausted. Throws (without consuming
   * budget) if the cursor is closed or a walk is already in flight.
   */
  async next(): Promise<T[] | null> {
    if (this.#closed) {
      throw new Error(`This ${this.#label} cursor is closed; open a new one to walk again.`);
    }
    if (this.#inFlight) {
      throw new Error(`This ${this.#label} cursor already has a walk in progress.`);
    }
    if (this.#exhausted) return null;
    if (this.#walked >= this.#maxPages) {
      throw new Error(
        `This ${this.#label} cursor has walked its ${this.#maxPages}-page limit; ` +
        `issue a new bounded query to continue.`);
    }
    this.#inFlight = true;
    this.#walked += 1; // A failed fetch still made a service call: the budget bounds attempts.
    try {
      const page = await this.#fetchPage();
      if (page.exhausted) this.#exhausted = true;
      return page.items;
    } finally {
      this.#inFlight = false;
    }
  }

  /** Ends the capability's lifetime. Idempotent; a closed cursor refuses further walks. */
  close(): void {
    this.#closed = true;
  }
}

/**
 * A `LivePageFetcher` over a fixed `p`-numbered offset contract: page `p` starts at
 * `p * pageSize`, and the vendor reports the total item count on every response, so exhaustion is
 * derived from an authoritative total rather than from a short page. Hugging Face Hub list
 * endpoints behave exactly this way: pages are dense in matching items (the server filters before
 * paging), each page carries `pageSize` items until the final one, and `count` is the filtered
 * total.
 */
export function offsetPaged<T>(options: {
  fetchPage: (page: number) => Promise<{ items: T[]; total: number }>;
  pageSize: number;
  label?: string;
  maxPages?: number;
}): LivePageSource<T> {
  let page = 0;
  return new LivePageSource<T>({
    label: options.label,
    maxPages: options.maxPages,
    fetchPage: async () => {
      const index = page;
      const result = await options.fetchPage(index);
      page += 1;
      // The authoritative end: the reported total fits inside the pages delivered so far. A full
      // final page therefore still ends the walk — shortness is never the exhaustion signal.
      const pagesDelivered = (index + 1) * options.pageSize;
      return { items: result.items, exhausted: pagesDelivered >= result.total };
    },
  });
}
