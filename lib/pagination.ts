export const DEFAULT_PAGE_SIZE = 25;
export const ALLOWED_PAGE_SIZES = [10, 25, 50, 100] as const;
export const MAX_PAGE_SIZE = 100;

export interface PaginationParams {
  page: number;
  pageSize: number;
  offset: number;
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  hasPrevious: boolean;
  hasNext: boolean;
  startIndex: number;
  endIndex: number;
}

/**
 * Parses and safely clamps URL/API pagination parameters (`page`, `pageSize`).
 */
export function parsePaginationParams(
  rawPage: string | number | null | undefined,
  rawPageSize: string | number | null | undefined,
  defaultPageSize = DEFAULT_PAGE_SIZE,
): PaginationParams {
  const parsedPage = Number.parseInt(String(rawPage ?? "1"), 10);
  const page = Number.isFinite(parsedPage) && parsedPage >= 1 ? Math.min(parsedPage, 10_000) : 1;

  const parsedSize = Number.parseInt(String(rawPageSize ?? String(defaultPageSize)), 10);
  const pageSize =
    Number.isFinite(parsedSize) && parsedSize >= 1
      ? Math.min(parsedSize, MAX_PAGE_SIZE)
      : defaultPageSize;

  return {
    page,
    pageSize,
    offset: (page - 1) * pageSize,
  };
}

/**
 * Builds consistent pagination metadata from a page slice and total item count.
 */
export function buildPaginatedResult<T>(
  items: T[],
  total: number,
  page: number,
  pageSize: number,
): PaginatedResult<T> {
  const safeTotal = Math.max(0, Math.floor(total));
  const safePageSize = Math.max(1, Math.min(Math.floor(pageSize), MAX_PAGE_SIZE));
  const totalPages = Math.max(1, Math.ceil(safeTotal / safePageSize));
  const clampedPage = Math.max(1, Math.min(Math.floor(page), totalPages));
  const startIndex = safeTotal === 0 ? 0 : (clampedPage - 1) * safePageSize + 1;
  const endIndex = safeTotal === 0 ? 0 : Math.min(safeTotal, startIndex + items.length - 1);

  return {
    items,
    total: safeTotal,
    page: clampedPage,
    pageSize: safePageSize,
    totalPages,
    hasPrevious: clampedPage > 1,
    hasNext: clampedPage < totalPages,
    startIndex,
    endIndex,
  };
}

/**
 * Builds a clean relative URL preserving active search/filter parameters alongside page state.
 */
export function buildPageHref(
  basePath: string,
  params: Record<string, string | number | null | undefined>,
): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const str = String(value).trim();
    if (!str) continue;
    if (key === "page" && str === "1") continue;
    if (key === "pageSize" && str === String(DEFAULT_PAGE_SIZE)) continue;
    qs.set(key, str);
  }
  const encoded = qs.toString();
  return encoded ? `${basePath}?${encoded}` : basePath;
}

/**
 * Filters (when a search query `q` is provided) and slices an array on the server
 * with consistent pagination clamping so pages only transmit bounded rows to the client.
 */
export function paginateArray<T>(
  items: readonly T[],
  options: {
    q?: string | null;
    page?: string | number | null;
    pageSize?: string | number | null;
    defaultPageSize?: number;
    matcher?: (item: T, normalizedQuery: string) => boolean;
  },
): PaginatedResult<T> & { query: string } {
  const query = String(options.q ?? "").trim();
  const normalized = query.toLowerCase();
  const filtered =
    normalized && options.matcher
      ? items.filter((item) => options.matcher!(item, normalized))
      : [...items];

  const { page, pageSize } = parsePaginationParams(
    options.page,
    options.pageSize,
    options.defaultPageSize ?? DEFAULT_PAGE_SIZE,
  );

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const clampedPage = Math.max(1, Math.min(page, totalPages));
  const offset = (clampedPage - 1) * pageSize;
  const slice = filtered.slice(offset, offset + pageSize);

  return {
    ...buildPaginatedResult(slice, filtered.length, clampedPage, pageSize),
    query,
  };
}

