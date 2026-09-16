/**
 * Bounded-SELECT statement validation and the partitioned-result page walk for the Snowflake
 * result capability. Pure logic — no `cloudflare:workers` imports — so both are unit-testable
 * against the verified SQL API contract:
 *
 *  - The initial `POST /api/v2/statements` response carries `resultSetMetaData.numRows` (the total
 *    rows the statement produced) and `resultSetMetaData.partitionInfo[]`, whose first object
 *    describes the partition returned inline and whose remaining objects describe partitions that
 *    can be retrieved with `GET /api/v2/statements/{handle}?partition={n}`. Each object reports the
 *    partition's `rowCount` (and sizes), so the cursor knows the true shape of the result up front.
 *
 * The walk enforces the operator's cumulative budgets exactly as the single-shot form does —
 * maxRows total, maxBytes total with whole-row drops — and slices deliveries to the configured
 * rows-per-page. The number of *service fetches* is bounded separately by the cursor's page
 * budget; partition fetches only happen when the buffer runs dry.
 */

/** The result of validating and normalizing one statement for execution. */
export function boundedSelect(sql: string, maxSqlLength = 32_000): string {
  const text = sql.trim().replace(/;+$/, "");
  if (text.length > maxSqlLength || !/^SELECT\b/i.test(text) || /\b(INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|COPY|CALL|USE|GRANT|REVOKE|PUT|GET)\b/i.test(text)) throw new Error("Only bounded SELECT statements are permitted.");
  return text;
}

/** Verified partition metadata: Snowflake reports each partition's row count up front. */
export interface PartitionMeta {
  rowCount: number;
  uncompressedSize?: number;
}

/** One page the agent receives from the result capability. */
export interface ReadOnlySqlPage {
  rows: unknown[][];
  rowCount: number;
  /** True when the cumulative byte budget clipped rows from this page (whole rows dropped). */
  truncated: boolean;
  /** Partitions retrieved from the service so far, including the initial response. */
  partitionsFetched: number;
  /** Rows delivered across the whole walk so far, including this page. */
  deliveredRows: number;
}

export interface PartitionPagerOptions {
  /** Rows delivered per page (policy: default 100, hard maximum 500). */
  rowsPerPage: number;
  /** Cumulative rows the whole walk may deliver (policy: default 1000, hard maximum 10 000). */
  maxRows: number;
  /** Cumulative encoded-bytes the whole walk may deliver (policy budget, whole-row drops). */
  maxBytes: number;
}

export interface PartitionPager {
  /** The authoritative total from partition metadata, when the response reported one. */
  totalRows?: number;
  /** The verified partition row counts, first entry being the partition returned inline. */
  partitions: PartitionMeta[];
  /** The @gadgets/cursor page fetcher: one call delivers one bounded page. */
  fetchPage: () => Promise<{ items: ReadOnlySqlPage[]; exhausted: boolean }>;
}

/**
 * Builds the page walk over an already-received first partition plus the partitions the verified
 * metadata promises. `fetchPartition(n)` retrieves partition `n` (1-based; partition 0 is the
 * initial response the caller already holds).
 */
export function partitionPager(
  first: { rows: unknown[][]; totalRows?: number; partitions?: PartitionMeta[] },
  options: PartitionPagerOptions,
  fetchPartition: (partition: number) => Promise<{ rows: unknown[][] }>,
): PartitionPager {
  // Verified metadata governs; a response without partitionInfo is a single-partition result.
  const partitions = (first.partitions && first.partitions.length > 0)
    ? first.partitions
    : [{ rowCount: first.rows.length }];
  let buffer: unknown[][] = first.rows;
  let nextPartition = 1;
  // Partition ids run 0..partitions.length-1; partition 0 arrived inline, so the highest partition
  // a GET may retrieve is the last one.
  const lastPartition = partitions.length - 1;
  let deliveredRows = 0;
  let deliveredBytes = 0;

  const dataEnded = () => buffer.length === 0 && nextPartition > lastPartition;

  const fetchPage = async (): Promise<{ items: ReadOnlySqlPage[]; exhausted: boolean }> => {
    // Nothing left at all (e.g. an empty result set): report exhaustion immediately.
    if (dataEnded()) return { items: [], exhausted: true };
    // Refill the buffer from the promised partitions until a full page is available or the
    // verified data ends — a page is rowsPerPage rows, not a short slice of one partition.
    while (buffer.length < options.rowsPerPage && nextPartition <= lastPartition) {
      const part = await fetchPartition(nextPartition);
      buffer = buffer.concat(Array.isArray(part.rows) ? part.rows : []);
      nextPartition += 1;
    }
    // Slice one bounded page, consuming the taken rows before the byte clip: rows the budget
    // drops are discarded from the buffer, never re-sliced on a later page.
    let rows = buffer.slice(0, options.rowsPerPage);
    buffer = buffer.slice(rows.length);
    // Cumulative UTF-8 byte budget: whole rows are dropped rather than truncated mid-value,
    // matching the single-shot form's honest clipping. Rows are encoded once per page.
    const encoder = new TextEncoder();
    const rowBytes = rows.map((row) => encoder.encode(JSON.stringify(row)).byteLength + 1);
    const fits = (count: number): number => rowBytes.slice(0, count).reduce((a, b) => a + b, 0);
    let kept = rows.length;
    while (kept > 0 && deliveredBytes + fits(kept) > options.maxBytes) {
      kept -= 1;
    }
    const truncated = kept < rows.length;
    rows = rows.slice(0, kept);
    deliveredRows += rows.length;
    deliveredBytes += fits(kept);
    const page: ReadOnlySqlPage = {
      rows,
      rowCount: rows.length,
      truncated,
      // Includes the initial inline response: nextPartition is the NEXT partition to fetch, so
      // partitions 0..nextPartition-1 have all been received from the service.
      partitionsFetched: nextPartition,
      deliveredRows,
    };
    // The walk ends when the verified data is exhausted or a cumulative budget is spent.
    const exhausted = dataEnded() || deliveredRows >= options.maxRows || rows.length === 0;
    return { items: [page], exhausted };
  };

  return {
    totalRows: first.totalRows,
    partitions,
    fetchPage,
  };
}
