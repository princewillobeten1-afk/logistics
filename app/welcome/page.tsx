import { LandingPage } from "@/components/landing/landing-page";
import { currentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Control Tower · Autonomous Freight Operations",
  description:
    "Deterministic corridor planning, 6-factor carrier scoring, and policy-gated autonomous freight recovery.",
};

export default async function WelcomePage() {
  const user = await currentUser();
  return <LandingPage isAuthenticated={Boolean(user)} />;
}
