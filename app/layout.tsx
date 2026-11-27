import type { Metadata, Viewport } from "next";
import { Plus_Jakarta_Sans, Manrope, JetBrains_Mono } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";
import { NavShell } from "@/app/nav";
import { AccountBar } from "@/app/account-bar";
import { TopBar } from "@/app/top-bar";
import { MapsQuotaBanner } from "@/components/maps-quota-banner";
import { CustomerSupportWidget } from "@/components/customer-support-widget";
import { MotionProvider } from "@/components/motion-provider";
import { currentUser, requireUser } from "@/lib/auth";

const plusJakarta = Plus_Jakarta_Sans({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const manrope = Manrope({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-display",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export const metadata: Metadata = {
  title: "Logistics Control Tower",
  description: "Enterprise logistics operations, fleet planning, and dispatch control tower.",
  openGraph: {
    title: "Logistics Control Tower",
    description: "Enterprise logistics operations, fleet planning, and dispatch control tower.",
  },
};

// Routes that render without the authenticated app shell.
// Must match PUBLIC_PATHS in middleware.ts.
const PUBLIC = new Set([
  "/welcome",
  "/login",
  "/signup",
  "/forgot-password",
  "/reset-password",
]);

const THEME_INIT_SCRIPT = `try{var s=localStorage.getItem("color-scheme");if(s==="light"||s==="dark"){document.querySelector('meta[name="color-scheme"]').content=s;document.documentElement.setAttribute("data-theme",s);}}catch(e){}`;

const EXTENSION_ERROR_GUARD_SCRIPT = `(function(){function isExt(e){try{var s=(e&&(e.filename||(e.reason&&e.reason.stack)||(e.error&&e.error.stack)))||"";var m=(e&&(e.message||(e.reason&&e.reason.message)||e.reason))||"";if(typeof s==="string"&&(s.indexOf("chrome-extension://")!==-1||s.indexOf("moz-extension://")!==-1||s.indexOf("safari-extension://")!==-1)){return true;}if(typeof m==="string"&&m.indexOf("Failed to connect to MetaMask")!==-1&&(typeof s!=="string"||s.indexOf("/_next/")===-1)){return true;}}catch(_){}return false;}window.addEventListener("error",function(e){if(isExt(e)){e.preventDefault();e.stopImmediatePropagation();}},true);window.addEventListener("unhandledrejection",function(e){if(isExt(e)){e.preventDefault();e.stopImmediatePropagation();}},true);})();`;

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = (await headers()).get("x-pathname") ?? "";
  const fontVars = `${plusJakarta.variable} ${manrope.variable} ${jetbrainsMono.variable}`;

  const renderPublicShell = () => (
    <html lang="en" className={fontVars} suppressHydrationWarning>
      <head>
        <meta name="color-scheme" content="light dark" suppressHydrationWarning />
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <script dangerouslySetInnerHTML={{ __html: EXTENSION_ERROR_GUARD_SCRIPT }} />
      </head>
      <body suppressHydrationWarning>
        <MotionProvider>
          <MapsQuotaBanner />
          {children}
        </MotionProvider>
      </body>
    </html>
  );

  if (PUBLIC.has(pathname)) {
    return renderPublicShell();
  }

  let user;
  if (pathname === "/") {
    user = await currentUser();
    if (!user) {
      return renderPublicShell();
    }
  } else {
    user = await requireUser();
  }

  return (
    <html lang="en" className={fontVars} suppressHydrationWarning>
      <head>
        <meta name="color-scheme" content="light dark" suppressHydrationWarning />
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <script dangerouslySetInnerHTML={{ __html: EXTENSION_ERROR_GUARD_SCRIPT }} />
      </head>
      <body suppressHydrationWarning>
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
