import { GoogleGenAI } from "@google/genai";
import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import {
  buildCorridorGroundingPrompt,
  extractMapsGroundingSources,
  isQuotaErrorMessage,
} from "@/lib/maps-grounding";

interface MapsGroundingBody {
  question?: string;
  originCity?: string;
  destinationCity?: string;
  hubName?: string;
  modes?: string[];
  lat?: number;
  lng?: number;
}

export async function POST(req: NextRequest) {
  const user = await currentUser();
  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  let body: MapsGroundingBody;
  try {
    body = (await req.json()) as MapsGroundingBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON request body." }, { status: 400 });
  }

  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (!question) {
    return NextResponse.json({ error: "Please enter a location or corridor question." }, { status: 400 });
  }
  if (question.length > 600) {
    return NextResponse.json({ error: "Question must be 600 characters or fewer." }, { status: 400 });
  }

  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    return NextResponse.json(
      { error: "Server Gemini API key is not configured for Maps Grounding." },
      { status: 503 },
    );
  }

  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });

  const prompt = buildCorridorGroundingPrompt({
    question,
    originCity: typeof body.originCity === "string" ? body.originCity : undefined,
    destinationCity: typeof body.destinationCity === "string" ? body.destinationCity : undefined,
    hubName: typeof body.hubName === "string" ? body.hubName : undefined,
    modes: Array.isArray(body.modes) ? body.modes.map(String) : undefined,
  });

  const hasCoords =
    typeof body.lat === "number" &&
    typeof body.lng === "number" &&
    Number.isFinite(body.lat) &&
    Number.isFinite(body.lng);

  try {
    const response = await ai.models.generateContent({
      model: "gemini-4-hydrogen",
      contents: prompt,
      config: {
        tools: [{ googleMaps: {} }],
        ...(hasCoords
          ? {
              toolConfig: {
                retrievalConfig: {
                  latLng: {
                    latitude: body.lat as number,
                    longitude: body.lng as number,
                  },
                },
              },
            }
          : {}),
      },
    });

    const text = response.text?.trim() || "No corridor details were returned for this query.";
    const sources = extractMapsGroundingSources(
      response.candidates as Parameters<typeof extractMapsGroundingSources>[0],
    );

    return NextResponse.json({
      text,
      sources,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status =
      typeof (err as { status?: unknown })?.status === "number"
        ? (err as { status: number }).status
        : undefined;

    if (isQuotaErrorMessage(message, status)) {
      return NextResponse.json(
        {
          error:
            "Gemini Maps Grounding quota reached for the configured Gemini API key. Retry shortly or select a billing-enabled key in Settings > Secrets.",
          quotaSource: "gemini",
        },
        { status: 429 },
      );
    }

    if (status === 400 || status === 403 || message.includes("API_KEY_INVALID") || message.includes("PERMISSION_DENIED")) {
      return NextResponse.json(
        {
          error:
            "Gemini API key rejected for Maps Grounding. Verify your GEMINI_API_KEY in Settings > Secrets.",
        },
        { status: status === 403 ? 403 : 400 },
      );
    }

    return NextResponse.json(
      { error: "Unable to complete Google Maps Grounding request right now." },
      { status: 502 },
    );
  }
}
