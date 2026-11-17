import type { Metadata } from "next";
import { Plus_Jakarta_Sans, JetBrains_Mono } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";
import { NavShell } from "@/app/nav";
import { AccountBar } from "@/app/account-bar";
import { TopBar } from "@/app/top-bar";
import { MapsQuotaBanner } from "@/components/maps-quota-banner";
import { CustomerSupportWidget } from "@/components/customer-support-widget";
import { MotionProvider } from "@/components/motion-provider";
import { requireUser } from "@/lib/auth";

const plusJakarta = Plus_Jakarta_Sans({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Logistics Control Tower",
  description: "Enterprise logistics operations, fleet planning, and dispatch control tower.",
  openGraph: {
    title: "Logistics Control Tower",
    description: "Enterprise logistics operations, fleet planning, and dispatch control tower.",
  },
};

// Routes that render without a session.
// Must match PUBLIC_PATHS in middleware.ts.
const PUBLIC = new Set(["/login", "/signup", "/forgot-password", "/reset-password"]);

const THEME_INIT_SCRIPT = `try{var s=localStorage.getItem("color-scheme");if(s==="light"||s==="dark"){document.querySelector('meta[name="color-scheme"]').content=s;document.documentElement.setAttribute("data-theme",s);}}catch(e){}`;

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = (await headers()).get("x-pathname") ?? "";
  const fontVars = `${plusJakarta.variable} ${jetbrainsMono.variable}`;

  if (PUBLIC.has(pathname)) {
    return (
      <html lang="en" className={fontVars} suppressHydrationWarning>
        <head>
          <meta name="color-scheme" content="light dark" />
          <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        </head>
        <body>
          <MotionProvider>
            <MapsQuotaBanner />
            {children}
          </MotionProvider>
        </body>
      </html>
    );
  }

  const user = await requireUser();

  return (
    <html lang="en" className={fontVars} suppressHydrationWarning>
      <head>
        <meta name="color-scheme" content="light dark" />
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>
        <MotionProvider>
          <MapsQuotaBanner />
          <a href="#main-content" className="skip-link visually-hidden">
            Skip to main content
          </a>
          <div className="shell">
            <NavShell
              orgName={user.orgName}
              account={
                <AccountBar
                  email={user.email}
                  name={user.name}
                  role={user.role}
                />
              }
            />
            <div className="main-wrap">
              <TopBar />
              <main id="main-content" tabIndex={-1} className="main">
                {children}
              </main>
            </div>
          </div>
          <CustomerSupportWidget />
        </MotionProvider>
      </body>
    </html>
  );
}
