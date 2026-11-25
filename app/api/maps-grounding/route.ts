import { NextRequest, NextResponse } from "next/server";
import {
  generateCorridorText,
  MissingGeminiKeyError,
} from "@/lib/agents/gemini-client";
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
    return NextResponse.json(
      { error: "Authentication required." },
      { status: 401 },
    );
  }

  let body: MapsGroundingBody;
  try {
    body = (await req.json()) as MapsGroundingBody;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON request body." },
      { status: 400 },
    );
  }

  const question =
    typeof body.question === "string" ? body.question.trim() : "";
  if (!question) {
    return NextResponse.json(
      { error: "Please enter a location or corridor question." },
      { status: 400 },
    );
  }
  if (question.length > 600) {
    return NextResponse.json(
      { error: "Question must be 600 characters or fewer." },
      { status: 400 },
    );
  }

  const prompt = buildCorridorGroundingPrompt({
    question,
    originCity:
      typeof body.originCity === "string" ? body.originCity : undefined,
    destinationCity:
      typeof body.destinationCity === "string"
        ? body.destinationCity
        : undefined,
    hubName: typeof body.hubName === "string" ? body.hubName : undefined,
    modes: Array.isArray(body.modes) ? body.modes.map(String) : undefined,
  });

  try {
    const response = await generateCorridorText({
      prompt,
      lat: typeof body.lat === "number" ? body.lat : undefined,
      lng: typeof body.lng === "number" ? body.lng : undefined,
    });

    const sources = extractMapsGroundingSources(
      response.candidates as Parameters<typeof extractMapsGroundingSources>[0],
    );

    return NextResponse.json({
      text: response.text,
      sources,
      provider: response.provider,
      model: response.model,
    });
  } catch (err) {
    if (err instanceof MissingGeminiKeyError) {
      return NextResponse.json(
        {
          error:
            "Neither GEMINI_API_KEY nor NVIDIA_API_KEY is configured for corridor intelligence.",
        },
        { status: 503 },
      );
    }

    const message = err instanceof Error ? err.message : String(err);
    const status =
      typeof (err as { status?: unknown })?.status === "number"
        ? (err as { status: number }).status
        : undefined;

    if (isQuotaErrorMessage(message, status)) {
      return NextResponse.json(
        {
          error:
            "AI corridor intelligence quota reached for the configured API key. Retry shortly.",
          quotaSource: "gemini",
        },
        { status: 429 },
      );
    }

    if (
      status === 400 ||
      status === 403 ||
      message.includes("API_KEY_INVALID") ||
      message.includes("PERMISSION_DENIED")
    ) {
      return NextResponse.json(
        {
          error:
            "Configured AI API key was rejected for corridor intelligence. Verify your API key configuration.",
        },
        { status: status === 403 ? 403 : 400 },
      );
    }

    return NextResponse.json(
      { error: "Unable to complete corridor intelligence request right now." },
      { status: 502 },
    );
  }
}
