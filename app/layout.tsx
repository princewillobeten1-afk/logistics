import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";
import { Nav } from "@/app/nav";
import { AccountBar } from "@/app/account-bar";
import { TopBar } from "@/app/top-bar";
import { requireUser } from "@/lib/auth";

export const metadata: Metadata = {
  title: "Logistics Control Tower",
  description: "Operations dashboard for the AI Logistics Control Tower",
};

// Routes that render without a session. Everything else is gated here rather
// than page by page, so a new page is protected the moment it is created —
// remembering to add a guard to nineteen pages is how one gets missed.
// Must match PUBLIC_PATHS in middleware.ts — see the comment there for why.
const PUBLIC = new Set(["/login", "/signup", "/forgot-password", "/reset-password"]);

const THEME_INIT_SCRIPT = `try{var s=localStorage.getItem("color-scheme");if(s==="light"||s==="dark"){document.querySelector('meta[name="color-scheme"]').content=s;document.documentElement.setAttribute("data-theme",s);}}catch(e){}`;

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = (await headers()).get("x-pathname") ?? "";

  if (PUBLIC.has(pathname)) {
    return (
      <html lang="en" suppressHydrationWarning>
        <head>
          <meta name="color-scheme" content="light dark" />
          <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        </head>
        <body>{children}</body>
      </html>
    );
  }

  // This is where a session is actually verified. Middleware only saw that a
  // cookie existed; a forged one gets no further than here.
  const user = await requireUser();

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta name="color-scheme" content="light dark" />
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>
        <a href="#main-content" className="skip-link visually-hidden">
          Skip to main content
        </a>
        <div className="shell">
          <aside className="rail">
            <Nav orgName={user.orgName} />
            <AccountBar
              email={user.email}
              name={user.name}
              role={user.role}
            />
          </aside>
          <div className="main-wrap">
            <TopBar />
            <main id="main-content" tabIndex={-1} className="main">
              {children}
            </main>
          </div>
        </div>
      </body>
    </html>
  );
}
