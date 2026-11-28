"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Search, X } from "lucide-react";
import { buildPageHref } from "@/lib/pagination";

interface TableSearchBarProps {
  basePath: string;
  initialQuery?: string;
  pageSize: number;
  placeholder: string;
  label: string;
  extraParams?: Record<string, string | null | undefined>;
  summaryText: string;
}

export function TableSearchBar({
  basePath,
  initialQuery = "",
  pageSize,
  placeholder,
  label,
  extraParams = {},
  summaryText,
}: TableSearchBarProps) {
  const router = useRouter();
  const [value, setValue] = useState(initialQuery);

  function submitSearch(nextQuery: string) {
    const href = buildPageHref(basePath, {
      ...extraParams,
      q: nextQuery.trim() || undefined,
      page: 1,
      pageSize,
    });
    router.push(href);
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submitSearch(value);
      }}
      className="board-toolbar"
    >
      <div className="board-search-group">
        <div className="search-field">
          <Search
            size={15}
            strokeWidth={1.75}
            aria-hidden="true"
            className="search-field-icon"
          />
          <label htmlFor={`search-${basePath.replace(/\W+/g, "")}`} className="visually-hidden">
            {label}
          </label>
          <input
            id={`search-${basePath.replace(/\W+/g, "")}`}
            type="search"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={placeholder}
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
          />
          {value ? (
            <button
              type="button"
              className="search-clear"
              aria-label="Clear search"
              onClick={() => {
                setValue("");
                submitSearch("");
              }}
            >
              <X size={13} strokeWidth={2} aria-hidden="true" />
            </button>
          ) : null}
        </div>
        <button type="submit" className="search-submit-btn">
          Apply filter
        </button>
      </div>

      <div className="board-summary" aria-live="polite">
        {summaryText}
      </div>
    </form>
  );
}
