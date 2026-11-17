"use client";

import { useState } from "react";

export type DailyThroughput = {
  day: string;
  created: string;
  closed: string;
};

export function ThroughputChart({ daily }: { daily: DailyThroughput[] }) {
  const [activeIndex, setActiveIndex] = useState<number>(
    Math.max(0, daily.length - 1),
  );

  const maxDaily = Math.max(
    1,
    ...daily.map((d) => Math.max(Number(d.created), Number(d.closed))),
  );
  const activeDay = daily[activeIndex];

  return (
    <div>
      {activeDay ? (
        <div className="chart-readout" aria-live="polite">
          <span className="font-mono font-semibold">{activeDay.day}</span>
          <span className="chart-readout-metrics">
            <span>
              <i className="swatch swatch-created" aria-hidden="true" /> Created:{" "}
              <strong>{activeDay.created}</strong>
            </span>
            <span>
              <i className="swatch swatch-closed" aria-hidden="true" /> Closed:{" "}
              <strong>{activeDay.closed}</strong>
            </span>
          </span>
        </div>
      ) : null}

      <div className="spark" role="list" aria-label="14-day shipment intake">
        {daily.map((d, i) => {
          const created = Number(d.created);
          const closed = Number(d.closed);
          const selected = i === activeIndex;
          return (
            <button
              key={d.day}
              type="button"
              role="listitem"
              className={`spark-col${selected ? " is-active" : ""}`}
              onMouseEnter={() => setActiveIndex(i)}
              onFocus={() => setActiveIndex(i)}
              onClick={() => setActiveIndex(i)}
              aria-label={`${d.day}: ${created} created, ${closed} closed`}
            >
              <span className="spark-bars">
                <span
                  className="spark-bar spark-bar-created"
                  data-empty={created === 0}
                  style={{
                    height: `${created === 0 ? 4 : Math.max(12, (created / maxDaily) * 100)}%`,
                  }}
                />
                <span
                  className="spark-bar spark-bar-closed"
                  data-empty={closed === 0}
                  style={{
                    height: `${closed === 0 ? 4 : Math.max(12, (closed / maxDaily) * 100)}%`,
                  }}
                />
              </span>
            </button>
          );
        })}
      </div>

      <div className="spark-labels">
        {daily.map((d, i) => (
          <div key={d.day}>{i % 3 === 0 ? d.day.split(" ")[1] : ""}</div>
        ))}
      </div>
    </div>
  );
}
