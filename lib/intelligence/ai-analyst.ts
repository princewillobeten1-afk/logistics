import { Type, type Schema } from "@google/genai";
import {
  generateAgentJson,
  getServerGeminiKey,
  MissingGeminiKeyError,
} from "@/lib/agents/gemini-client";
import { sanitizeInternalPath } from "@/lib/intelligence/access";
import { answerBiQuestionDeterministically } from "@/lib/intelligence/engine";
import type {
  BiDepartmentId,
  BiQueryResponse,
  BiSnapshot,
  DataProvenance,
} from "@/lib/intelligence/types";

const ALLOWED_DEPTS = new Set<BiDepartmentId>([
  "finance",
  "operations",
  "fleet",
  "shipments",
  "dispatch",
  "warehousing",
  "sales",
  "customers",
  "hr",
]);

const ALLOWED_PROVENANCE = new Set<DataProvenance>([
  "VERIFIED",
  "ESTIMATE",
  "PREDICTION",
]);

const BI_RESPONSE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    summary: {
      type: Type.STRING,
      description: "Concise 1-2 sentence executive takeaway grounded strictly in the provided data.",
    },
    explanation: {
      type: Type.STRING,
      description: "Detailed analytical narrative citing exact numbers, comparisons, and distinctions between VERIFIED records, ESTIMATES, and PREDICTIONS.",
    },
    provenanceTags: {
      type: Type.ARRAY,
      items: { type: Type.STRING, enum: ["VERIFIED", "ESTIMATE", "PREDICTION"] },
    },
    formulasUsed: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: "Transparent calculation formulas used to arrive at the numbers cited.",
    },
    chart: {
      type: Type.OBJECT,
      nullable: true,
      properties: {
        type: { type: Type.STRING, enum: ["bar", "line", "horizontal_bar"] },
        title: { type: Type.STRING },
        unit: { type: Type.STRING },
        provenance: { type: Type.STRING, enum: ["VERIFIED", "ESTIMATE", "PREDICTION"] },
        points: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              label: { type: Type.STRING },
              value: { type: Type.NUMBER },
            },
            required: ["label", "value"],
          },
        },
      },
      required: ["type", "title", "unit", "provenance", "points"],
    },
    table: {
      type: Type.OBJECT,
      nullable: true,
      properties: {
        title: { type: Type.STRING },
        columns: { type: Type.ARRAY, items: { type: Type.STRING } },
        rows: {
          type: Type.ARRAY,
          items: { type: Type.ARRAY, items: { type: Type.STRING } },
        },
        provenance: { type: Type.STRING, enum: ["VERIFIED", "ESTIMATE", "PREDICTION"] },
      },
      required: ["title", "columns", "rows", "provenance"],
    },
    recommendations: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          priority: { type: Type.STRING, enum: ["P1", "P2", "P3"] },
          department: {
            type: Type.STRING,
            enum: [
              "finance",
              "operations",
              "fleet",
              "shipments",
              "dispatch",
              "warehousing",
              "sales",
              "customers",
              "hr",
            ],
          },
          action: { type: Type.STRING },
          expectedImpact: { type: Type.STRING },
          provenance: { type: Type.STRING, enum: ["VERIFIED", "ESTIMATE", "PREDICTION"] },
          deepLink: { type: Type.STRING, nullable: true },
        },
        required: ["priority", "department", "action", "expectedImpact", "provenance"],
      },
    },
    followUpQuestions: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
  },
  required: [
    "summary",
    "explanation",
    "provenanceTags",
    "formulasUsed",
    "recommendations",
    "followUpQuestions",
  ],
};

interface RawGeminiBiAnswer {
  summary?: string;
  explanation?: string;
  provenanceTags?: string[];
  formulasUsed?: string[];
  chart?: {
    type?: "bar" | "line" | "horizontal_bar";
    title?: string;
    unit?: string;
    provenance?: string;
    points?: { label?: string; value?: number }[];
  } | null;
  table?: {
    title?: string;
    columns?: string[];
    rows?: string[][];
    provenance?: string;
  } | null;
  recommendations?: {
    priority?: "P1" | "P2" | "P3";
    department?: string;
    action?: string;
    expectedImpact?: string;
    provenance?: string;
    deepLink?: string | null;
  }[];
  followUpQuestions?: string[];
}

function normalizeProvenance(raw: string | undefined, fallback: DataProvenance = "VERIFIED"): DataProvenance {
  if (raw && ALLOWED_PROVENANCE.has(raw as DataProvenance)) {
    return raw as DataProvenance;
  }
  return fallback;
}

function buildCompactContextForPrompt(snapshot: BiSnapshot) {
  return {
    orgName: snapshot.orgName,
    roleScope: snapshot.roleScope.scopeLabel,
    redactionNotes: snapshot.roleScope.redactionNotes,
    period: `${snapshot.periodLabel} (${snapshot.comparisonLabel})`,
    currency: snapshot.currency,
    recordCounts: snapshot.recordCounts,
    executiveKpis: snapshot.executiveKpis.map((k) => ({
      label: k.label,
      value: k.valueFormatted,
      prior: k.priorValueFormatted,
      deltaPct: k.deltaPct,
      provenance: k.provenance,
      formula: k.formula,
      redacted: Boolean(k.redacted),
    })),
    departments: snapshot.departments.map((d) => ({
      id: d.id,
      name: d.name,
      status: d.status,
      healthScore: d.healthScore,
      headline: `${d.headlineLabel}: ${d.headlineValue}`,
      deltaPct: d.deltaPct,
      provenance: d.provenance,
      metrics: d.metrics,
      alertCount: d.alertCount,
      summary: d.summary,
    })),
    proactiveAlerts: snapshot.proactiveAlerts.slice(0, 12).map((a) => ({
      severity: a.severity,
      department: a.department,
      title: a.title,
      observed: a.observedValue,
      baseline: a.baselineValue,
      impact: a.estimatedImpact,
      provenance: a.provenance,
      formula: a.formula,
      action: a.recommendedAction,
      acknowledged: a.acknowledged,
    })),
    comparisons: {
      branches: snapshot.comparisons.branches.slice(0, 8),
      vehicles: snapshot.comparisons.vehicles.slice(0, 8),
      routes: snapshot.comparisons.routes.slice(0, 8),
      customers: snapshot.comparisons.customers.slice(0, 8),
    },
    forecastSummary: snapshot.forecastSummary,
    forecast30d: {
      horizonDays: snapshot.forecast30d.horizonDays,
      historicalDaysUsed: snapshot.forecast30d.historicalDaysUsed,
      totalProjectedShipments: snapshot.forecast30d.totalProjectedShipments,
      projectedShipmentsRange: snapshot.forecast30d.projectedShipmentsRange,
      totalProjectedCarrierCostMajor: snapshot.forecast30d.carrierCostRedacted
        ? "Restricted"
        : snapshot.forecast30d.totalProjectedCarrierCostMajor,
      projectedCarrierCostRange: snapshot.forecast30d.carrierCostRedacted
        ? "Restricted"
        : snapshot.forecast30d.projectedCarrierCostRange,
      projectedAvgCostPerShipmentMajor: snapshot.forecast30d.carrierCostRedacted
        ? "Restricted"
        : snapshot.forecast30d.projectedAvgCostPerShipmentMajor,
      carrierCostRedacted: Boolean(snapshot.forecast30d.carrierCostRedacted),
      dailyShipmentSlope: snapshot.forecast30d.dailyShipmentSlope,
      peakDayLabel: snapshot.forecast30d.peakDayLabel,
      peakDayShipments: snapshot.forecast30d.peakDayShipments,
      confidenceLevel: snapshot.forecast30d.confidenceLevel,
      weeklyRollup: snapshot.forecast30d.weeklyRollup.map((w) => ({
        week: w.weekLabel,
        dates: w.dateRangeLabel,
        projectedShipments: w.projectedShipments,
        shipmentsRange: [w.shipmentsLower, w.shipmentsUpper],
        projectedCarrierCost: snapshot.forecast30d.carrierCostRedacted
          ? "Restricted"
          : w.projectedCarrierCostMajor,
      })),
      modeAllocation: snapshot.forecast30d.modeAllocation.map((m) => ({
        mode: m.mode,
        sharePct: m.sharePct,
        projectedShipments: m.projectedShipments,
        projectedCarrierCost: snapshot.forecast30d.carrierCostRedacted
          ? "Restricted"
          : m.projectedCarrierCostMajor,
      })),
    },
    forecastPoints: snapshot.trendWithForecast
      .filter((p) => p.isForecast)
      .map((p) => ({
        date: p.label,
        shipments: p.shipments,
        range: [p.shipmentsLower, p.shipmentsUpper],
        spend: p.freightSpendMajor,
        co2eKg: p.co2eKg,
      })),
  };
}

/**
 * Answers natural-language executive BI questions strictly grounded in the
 * tenant-scoped, role-redacted BiSnapshot. Uses server-side Gemini when
 * GEMINI_API_KEY is configured, and falls back transparently to the
 * deterministic analytics engine (explicitly labeled DETERMINISTIC_ENGINE).
 */
export async function askBiAnalyst({
  question,
  snapshot,
}: {
  question: string;
  snapshot: BiSnapshot;
}): Promise<BiQueryResponse> {
  if (!getServerGeminiKey()) {
    return answerBiQuestionDeterministically(question, snapshot);
  }

  const contextJson = JSON.stringify(buildCompactContextForPrompt(snapshot));

  const systemInstruction = [
    "You are an Executive Business Intelligence Analyst for an enterprise Logistics SaaS platform.",
    "STRICT DATA TRUTHFULNESS RULES:",
    "1. Answer ONLY using the actual company data supplied in the JSON snapshot below. NEVER invent, extrapolate, or fabricate numbers, customers, branches, vehicles, or corridors that are not in the snapshot.",
    "2. If a field is marked 'Restricted' or redacted for the user's role, explicitly acknowledge the access control restriction and do not guess the value.",
    "3. Always clearly distinguish between VERIFIED records, ESTIMATE modeled figures (e.g., fuel proxy, 24% gross margin benchmark, detention fee benchmark), and PREDICTION forecasts (7-day and 30-day OLS volume & carrier cost projections).",
    "4. Provide transparent calculation formulas in formulasUsed.",
    "5. Include a supporting chart (with up to 8 numeric points directly from the snapshot) and/or a supporting table whenever quantitative comparisons answer the question.",
    "6. Provide 2-4 concrete, prioritized (P1/P2/P3) recommendations with valid relative app links only (/shipments, /fleet, /warehouses, /approvals, /exceptions, /orders, /customers, /carriers, /planning, /intelligence).",
  ].join("\n");

  const prompt = `COMPANY BI SNAPSHOT (TENANT-SCOPED & ROLE-FILTERED):\n${contextJson}\n\nMANAGEMENT QUESTION:\n${question}`;

  try {
    const { data, meta } = await generateAgentJson<RawGeminiBiAnswer>({
      systemInstruction,
      prompt,
      responseSchema: BI_RESPONSE_SCHEMA,
      thinkingDepth: "LOW",
      timeoutMs: 32_000,
      perAttemptTimeoutMs: 18_000,
    });

    const summary =
      typeof data.summary === "string" && data.summary.trim()
        ? data.summary.trim()
        : "Business intelligence analysis completed from live workspace records.";
    const explanation =
      typeof data.explanation === "string" && data.explanation.trim()
        ? data.explanation.trim()
        : summary;

    const provenanceTags: DataProvenance[] = Array.from(
      new Set(
        (Array.isArray(data.provenanceTags) ? data.provenanceTags : ["VERIFIED"]).map((t) =>
          normalizeProvenance(t),
        ),
      ),
    );

    const chart =
      data.chart &&
      Array.isArray(data.chart.points) &&
      data.chart.points.length > 0
        ? {
            type: (["bar", "line", "horizontal_bar"].includes(String(data.chart.type))
              ? data.chart.type
              : "horizontal_bar") as "bar" | "line" | "horizontal_bar",
            title: String(data.chart.title ?? "Supporting Breakdown"),
            unit: String(data.chart.unit ?? ""),
            provenance: normalizeProvenance(data.chart.provenance),
            points: data.chart.points
              .slice(0, 12)
              .filter((p) => typeof p.label === "string" && Number.isFinite(Number(p.value)))
              .map((p) => ({
                label: String(p.label).slice(0, 48),
                value: Number(p.value),
              })),
          }
        : null;

    const table =
      data.table &&
      Array.isArray(data.table.columns) &&
      data.table.columns.length > 0 &&
      Array.isArray(data.table.rows) &&
      data.table.rows.length > 0
        ? {
            title: String(data.table.title ?? "Supporting Data Table"),
            columns: data.table.columns.slice(0, 8).map((c) => String(c)),
            rows: data.table.rows
              .slice(0, 15)
              .map((r) =>
                Array.isArray(r) ? r.slice(0, 8).map((cell) => String(cell ?? "—")) : [],
              ),
            provenance: normalizeProvenance(data.table.provenance),
          }
        : null;

    const recommendations = (Array.isArray(data.recommendations) ? data.recommendations : [])
      .slice(0, 5)
      .map((rec) => {
        const dept = ALLOWED_DEPTS.has(rec.department as BiDepartmentId)
          ? (rec.department as BiDepartmentId)
          : "operations";
        return {
          priority: (["P1", "P2", "P3"].includes(String(rec.priority))
            ? rec.priority
            : "P2") as "P1" | "P2" | "P3",
          department: dept,
          action: String(rec.action ?? "").trim(),
          expectedImpact: String(rec.expectedImpact ?? "").trim(),
          provenance: normalizeProvenance(rec.provenance),
          deepLink: sanitizeInternalPath(rec.deepLink, "/intelligence"),
        };
      })
      .filter((r) => r.action.length > 0);

    const followUpQuestions = (
      Array.isArray(data.followUpQuestions) ? data.followUpQuestions : []
    )
      .map((q) => String(q).trim())
      .filter(Boolean)
      .slice(0, 4);

    return {
      question,
      answeredBy: "GEMINI_AI",
      modelUsed: meta.model,
      latencyMs: meta.latencyMs,
      generatedAt: new Date().toISOString(),
      summary,
      explanation,
      provenanceTags: provenanceTags.length > 0 ? provenanceTags : ["VERIFIED"],
      formulasUsed: (Array.isArray(data.formulasUsed) ? data.formulasUsed : [])
        .map((f) => String(f).trim())
        .filter(Boolean)
        .slice(0, 6),
      chart: chart && chart.points.length > 0 ? chart : null,
      table,
      recommendations,
      followUpQuestions,
      accessNote: snapshot.roleScope.redactionNotes[0] ?? null,
    };
  } catch (err) {
    if (!(err instanceof MissingGeminiKeyError)) {
      console.warn("BI Gemini query fell back to deterministic analytics:", err);
    }
    return answerBiQuestionDeterministically(question, snapshot);
  }
}
