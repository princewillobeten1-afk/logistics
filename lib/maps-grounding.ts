export interface GroundedReviewSnippet {
  text?: string;
  uri?: string;
  author?: string;
}

export interface GroundedMapsSource {
  title: string;
  uri: string;
  placeId?: string;
  reviewSnippets: GroundedReviewSnippet[];
}

export interface LatLngPoint {
  lat: number;
  lng: number;
}

export interface SiteLocationLike {
  city?: string | null;
  name?: string | null;
  code?: string | null;
  latitude?: string | number | null;
  longitude?: string | number | null;
  lat?: number | null;
  lon?: number | null;
  lng?: number | null;
}

type RawCandidate = {
  groundingMetadata?: {
    groundingChunks?: Array<{
      maps?: {
        uri?: string;
        title?: string;
        placeId?: string;
        placeAnswerSources?: {
          reviewSnippets?: Array<{
            reviewText?: string;
            text?: string;
            googleMapsUri?: string;
            uri?: string;
            authorAttribution?: {
              displayName?: string;
            };
          }>;
        };
      };
    }>;
  };
};

/**
 * Extracts clickable Google Maps grounding links and review snippets from
 * Gemini `generateContent` candidates.
 */
export function extractMapsGroundingSources(
  candidates?: RawCandidate[] | null,
): GroundedMapsSource[] {
  if (!Array.isArray(candidates) || candidates.length === 0) return [];
  const chunks = candidates[0]?.groundingMetadata?.groundingChunks;
  if (!Array.isArray(chunks)) return [];

  const seenUris: Record<string, number> = {};
  const results: GroundedMapsSource[] = [];

  for (const chunk of chunks) {
    const maps = chunk?.maps;
    if (!maps?.uri) continue;

    const snippets: GroundedReviewSnippet[] = [];
    const rawSnippets = maps.placeAnswerSources?.reviewSnippets;
    if (Array.isArray(rawSnippets)) {
      for (const s of rawSnippets) {
        const text = (s.reviewText ?? s.text ?? "").trim();
        const uri = s.googleMapsUri ?? s.uri;
        const author = s.authorAttribution?.displayName;
        if (text || uri) {
          snippets.push({
            ...(text ? { text } : {}),
            ...(uri ? { uri } : {}),
            ...(author ? { author } : {}),
          });
        }
      }
    }

    const existingIdx = seenUris[maps.uri];
    if (existingIdx !== undefined) {
      if (snippets.length > 0) {
        results[existingIdx].reviewSnippets.push(...snippets);
      }
      continue;
    }

    seenUris[maps.uri] = results.length;
    results.push({
      title: maps.title?.trim() || "View on Google Maps",
      uri: maps.uri,
      ...(maps.placeId ? { placeId: maps.placeId } : {}),
      reviewSnippets: snippets,
    });
  }

  return results;
}

/**
 * Detects Google Maps / Gemini API quota exhaustion errors cleanly without
 * false-positive triggers on empty results or generic network errors.
 */
export function isQuotaErrorMessage(message: unknown, status?: number): boolean {
  if (status === 429) return true;
  const text = String(message ?? "").toLowerCase();
  if (!text) return false;
  return (
    text.includes("overquotamaperror") ||
    text.includes("quotaexceedederror") ||
    text.includes("over_query_limit") ||
    text.includes("resource_exhausted") ||
    text.includes("quota exceeded") ||
    text.includes("rate limit exceeded")
  );
}

/**
 * Resolves coordinates for a city/hub name against configured sites.
 */
export function resolveLocationCoordinates(
  queryCity: string | null | undefined,
  sites: SiteLocationLike[],
): LatLngPoint | null {
  const needle = String(queryCity ?? "").trim().toLowerCase();
  if (!needle) return null;

  for (const site of sites) {
    const candidates = [site.city, site.name, site.code]
      .filter(Boolean)
      .map((v) => String(v).toLowerCase());
    if (candidates.some((c) => c === needle || c.includes(needle) || needle.includes(c))) {
      const lat = Number(site.lat ?? site.latitude);
      const lng = Number(site.lng ?? site.lon ?? site.longitude);
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        return { lat, lng };
      }
    }
  }
  return null;
}

/**
 * Extracts coordinates directly from an address/location JSON object when
 * present before falling back to configured hub matching.
 */
export function extractPointFromAddress(
  addr: Record<string, unknown> | null | undefined,
): LatLngPoint | null {
  if (!addr || typeof addr !== "object") return null;
  const rawLat = addr.lat ?? addr.latitude;
  const rawLng = addr.lng ?? addr.lon ?? addr.longitude;
  if (rawLat === undefined || rawLat === null || rawLng === undefined || rawLng === null) {
    return null;
  }
  const lat = Number(rawLat);
  const lng = Number(rawLng);
  if (Number.isFinite(lat) && Number.isFinite(lng) && !(lat === 0 && lng === 0)) {
    return { lat, lng };
  }
  return null;
}

/**
 * Builds a concise operational prompt for Gemini Maps Grounding based on
 * either a shipment corridor or a regional logistics hub.
 */
export function buildCorridorGroundingPrompt(params: {
  question: string;
  originCity?: string;
  destinationCity?: string;
  hubName?: string;
  modes?: string[];
}): string {
  const cleanQuestion = params.question.trim();
  const contextParts: string[] = [];

  if (params.originCity && params.destinationCity) {
    contextParts.push(
      `Freight corridor: ${params.originCity} to ${params.destinationCity}`,
    );
  } else if (params.hubName) {
    contextParts.push(`Logistics hub focus: ${params.hubName}`);
  }

  if (params.modes && params.modes.length > 0) {
    contextParts.push(`Transport modes: ${params.modes.join(", ")}`);
  }

  const contextBlock =
    contextParts.length > 0
      ? `${contextParts.join(". ")}.\n\n`
      : "";

  return (
    `${contextBlock}You are supporting a freight operations dispatcher. ` +
    `Answer the following operational geography question using real-world Google Maps place and corridor data. ` +
    `Be concise, practical, and structured with clear headings or bullet points:\n\n${cleanQuestion}`
  );
}
