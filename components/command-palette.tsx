"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowRight, CornerDownLeft, Search, X } from "lucide-react";
import {
  filterCommandItems,
  isShipmentReference,
  resolveCommandTarget,
  type CommandItem,
} from "@/lib/command-palette";

export function CommandPalette({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  const filtered = useMemo(() => filterCommandItems(query), [query]);

  const trimmed = query.trim();
  const directAction = useMemo(() => {
    if (!trimmed) return null;
    if (isShipmentReference(trimmed)) {
      const ref = trimmed.toUpperCase();
      return {
        id: "direct-shipment-ref",
        label: `Open shipment ${ref}`,
        description: `Jump directly to consignment timeline and milestones`,
        href: `/shipments/${encodeURIComponent(ref)}`,
      };
    }
    return {
      id: "direct-shipment-search",
      label: `Search shipments for “${trimmed}”`,
      description: "Filter all workspace consignments by cargo, route, or customer",
      href: `/shipments?q=${encodeURIComponent(trimmed)}`,
    };
  }, [trimmed]);

  const flatEntries = useMemo(() => {
    const entries: {
      id: string;
      label: string;
      description: string;
      href: string;
      group: string;
      item?: CommandItem;
    }[] = [];

    if (directAction && isShipmentReference(trimmed)) {
      entries.push({ ...directAction, group: "Direct Lookup" });
    }

    for (const item of filtered) {
      entries.push({
        id: item.id,
        label: item.label,
        description: item.description,
        href: item.href,
        group: item.group,
        item,
      });
    }

    if (directAction && !isShipmentReference(trimmed)) {
      entries.push({ ...directAction, group: "Search Shipments" });
    }

    return entries;
  }, [directAction, filtered, trimmed]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setActiveIndex(0);
      return;
    }
    const raf = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.cancelAnimationFrame(raf);
      document.body.style.overflow = prevOverflow;
    };
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  function executeEntry(href: string) {
    onClose();
    router.push(href);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (flatEntries.length === 0) return;
      setActiveIndex((prev) => (prev + 1) % flatEntries.length);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (flatEntries.length === 0) return;
      setActiveIndex((prev) => (prev - 1 + flatEntries.length) % flatEntries.length);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const chosen = flatEntries[activeIndex];
      if (chosen) {
        executeEntry(chosen.href);
        return;
      }
      const fallback = resolveCommandTarget(query, null);
      if (fallback) executeEntry(fallback);
    }
  }

  // Group entries preserving order
  const grouped = useMemo(() => {
    const map = new Map<string, typeof flatEntries>();
    for (const entry of flatEntries) {
      const list = map.get(entry.group);
      if (list) list.push(entry);
      else map.set(entry.group, [entry]);
    }
    return Array.from(map.entries());
  }, [flatEntries]);

  const activeEntryId = flatEntries[activeIndex]?.id;

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          className="cmd-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.14 }}
          onClick={onClose}
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="Command palette"
            className="cmd-dialog"
            initial={{ opacity: 0, y: -8, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.985 }}
            transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={handleKeyDown}
          >
            <div className="cmd-header">
              <Search size={16} strokeWidth={1.85} aria-hidden="true" className="cmd-search-icon" />
              <input
                ref={inputRef}
                type="text"
                role="combobox"
                aria-expanded={open}
                aria-autocomplete="list"
                className="cmd-input"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Jump to module, shipment ref (e.g. SHP-1001), or search…"
                aria-label="Command search"
                aria-controls="cmd-listbox"
                aria-activedescendant={activeEntryId ? `cmd-opt-${activeEntryId}` : undefined}
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
              />
              {query ? (
                <button
                  type="button"
                  className="cmd-clear-btn"
                  aria-label="Clear search"
                  onClick={() => {
                    setQuery("");
                    inputRef.current?.focus();
                  }}
                >
                  <X size={14} strokeWidth={2} aria-hidden="true" />
                </button>
              ) : null}
              <button
                type="button"
                className="cmd-esc-btn"
                onClick={onClose}
                aria-label="Close command palette"
              >
                ESC
              </button>
            </div>

            <div id="cmd-listbox" role="listbox" className="cmd-list" aria-label="Destinations">
              {flatEntries.length === 0 ? (
                <div className="cmd-empty">No matching modules or actions.</div>
              ) : (
                grouped.map(([groupName, entries]) => (
                  <div key={groupName} className="cmd-group">
                    <div className="cmd-group-label">{groupName}</div>
                    {entries.map((entry) => {
                      const flatIdx = flatEntries.findIndex((e) => e.id === entry.id);
                      const isActive = flatIdx === activeIndex;
                      return (
                        <button
                          key={entry.id}
                          id={`cmd-opt-${entry.id}`}
                          type="button"
                          role="option"
                          aria-selected={isActive}
                          className="cmd-item"
                          data-selected={isActive}
                          onMouseEnter={() => setActiveIndex(flatIdx)}
                          onClick={() => executeEntry(entry.href)}
                        >
                          <div className="cmd-item-main">
                            <strong>{entry.label}</strong>
                            <span>{entry.description}</span>
                          </div>
                          <span className="cmd-item-go" aria-hidden="true">
                            {isActive ? (
                              <CornerDownLeft size={13} strokeWidth={2} />
                            ) : (
                              <ArrowRight size={13} strokeWidth={1.75} />
                            )}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ))
              )}
            </div>

            <div className="cmd-footer">
              <span>
                <kbd>↑</kbd> <kbd>↓</kbd> Navigate
              </span>
              <span>
                <kbd>↵</kbd> Open
              </span>
              <span>
                <kbd>ESC</kbd> Close
              </span>
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
