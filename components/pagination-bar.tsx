"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { ALLOWED_PAGE_SIZES, buildPageHref } from "@/lib/pagination";

interface PaginationBarProps {
  basePath: string;
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  startIndex: number;
  endIndex: number;
  /** Additional URL query parameters (e.g. q, state, source) to preserve across page turns */
  queryParams?: Record<string, string | null | undefined>;
  itemLabel?: string;
}

export function PaginationBar({
  basePath,
  page,
  pageSize,
  total,
  totalPages,
  startIndex,
  endIndex,
  queryParams = {},
  itemLabel = "records",
}: PaginationBarProps) {
  const router = useRouter();
  const hasPrevious = page > 1;
  const hasNext = page < totalPages;

  const prevHref = buildPageHref(basePath, {
    ...queryParams,
    page: Math.max(1, page - 1),
    pageSize,
  });

  const nextHref = buildPageHref(basePath, {
    ...queryParams,
    page: Math.min(totalPages, page + 1),
    pageSize,
  });

  function handlePageSizeChange(nextSize: number) {
    const href = buildPageHref(basePath, {
      ...queryParams,
      page: 1,
      pageSize: nextSize,
    });
    router.push(href);
  }

  return (
    <nav
      aria-label={`${itemLabel} pagination`}
      className="pagination-bar"
    >
      <div className="pagination-meta">
        {total === 0 ? (
          <span>0 {itemLabel}</span>
        ) : (
          <span>
            Showing <strong>{startIndex}–{endIndex}</strong> of{" "}
            <strong>{total.toLocaleString()}</strong> {itemLabel}
          </span>
        )}
      </div>

      <div className="pagination-controls">
        <label className="pagination-size">
          <span>Rows</span>
          <select
            aria-label={`Rows per page for ${itemLabel}`}
            value={pageSize}
            onChange={(e) => handlePageSizeChange(Number(e.target.value))}
            className="pagination-select"
          >
            {ALLOWED_PAGE_SIZES.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </label>

        <span className="pagination-pages">
          Page <strong>{page}</strong> of <strong>{totalPages}</strong>
        </span>

        <div className="pagination-nav">
          {hasPrevious ? (
            <Link href={prevHref} className="pagination-btn">
              <ChevronLeft size={14} strokeWidth={2} aria-hidden="true" />
              <span>Previous</span>
            </Link>
          ) : (
            <span aria-disabled="true" className="pagination-btn">
              <ChevronLeft size={14} strokeWidth={2} aria-hidden="true" />
              <span>Previous</span>
            </span>
          )}

          {hasNext ? (
            <Link href={nextHref} className="pagination-btn">
              <span>Next</span>
              <ChevronRight size={14} strokeWidth={2} aria-hidden="true" />
            </Link>
          ) : (
            <span aria-disabled="true" className="pagination-btn">
              <span>Next</span>
              <ChevronRight size={14} strokeWidth={2} aria-hidden="true" />
            </span>
          )}
        </div>
      </div>
    </nav>
  );
}
