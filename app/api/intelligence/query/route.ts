import { NextRequest, NextResponse } from "next/server";
import { recordAudit } from "@/lib/audit";
import { currentUser } from "@/lib/auth";
import { getBiAccessPolicy, isSameOriginMutation } from "@/lib/intelligence/access";
import { askBiAnalyst } from "@/lib/intelligence/ai-analyst";
import { collectBiSnapshot, parseBiPeriod } from "@/lib/intelligence/collector";

export const dynamic = "force-dynamic";

const MAX_QUESTION_LEN = 600;
const MIN_QUESTION_LEN = 3;

export async function POST(req: NextRequest) {
  if (!isSameOriginMutation(req)) {
    return NextResponse.json({ error: "Cross-origin request rejected." }, { status: 403 });
  }

  const user = await currentUser();
  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const policy = getBiAccessPolicy(user.role);
  if (!policy.canRunAiQueries) {
    return NextResponse.json(
      { error: `Role ${user.role} is not permitted to query Business Intelligence.` },
      { status: 403 },
    );
  }

  let body: { question?: unknown; periodDays?: unknown };
  try {
    body = (await req.json()) as { question?: unknown; periodDays?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  const rawQuestion = typeof body.question === "string" ? body.question : "";
  const cleanedQuestion = rawQuestion
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (cleanedQuestion.length < MIN_QUESTION_LEN) {
    return NextResponse.json(
      { error: "Please enter a business question (at least 3 characters)." },
      { status: 400 },
    );
  }
  if (cleanedQuestion.length > MAX_QUESTION_LEN) {
    return NextResponse.json(
      { error: `Question must be under ${MAX_QUESTION_LEN} characters.` },
      { status: 400 },
    );
  }

  const periodDays = parseBiPeriod(
    typeof body.periodDays === "number" || typeof body.periodDays === "string"
      ? body.periodDays
      : 7,
  );

  try {
    const snapshot = await collectBiSnapshot({
      orgId: user.orgId,
      orgName: user.orgName,
      role: user.role,
      periodDays,
    });

    const answer = await askBiAnalyst({
      question: cleanedQuestion,
      snapshot,
    });

    await recordAudit({
      actor: user.email,
      actorType: "USER",
      action: "BI_NLQ_QUERY",
      orgId: user.orgId,
      entityType: "business_intelligence",
      after: {
        periodDays,
        answeredBy: answer.answeredBy,
        questionLength: cleanedQuestion.length,
      },
      userAgent: req.headers.get("user-agent"),
    });

    return NextResponse.json(answer);
  } catch (err) {
    console.error("POST /api/intelligence/query failed:", err);
    return NextResponse.json(
      { error: "Failed to analyze your business question." },
      { status: 500 },
    );
  }
}
