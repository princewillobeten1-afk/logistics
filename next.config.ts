import path from "node:path";
import type { NextConfig } from "next";

const isVercel = Boolean(process.env.VERCEL);

const nextConfig: NextConfig = {
  output: "standalone",
  // Build and dev must not share an output directory locally. `next build`
  // rewrites the chunk files a running `next dev` still holds references to,
  // and the dev server then dies with "Cannot find module './611.js'".
  // On Vercel (`VERCEL=1`), use the standard `.next` directory Vercel expects.
  distDir: process.env.NODE_ENV === "production" && !isVercel ? ".next-build" : ".next",

  // A stray package-lock.json in the home directory makes Next infer that as
  // the workspace root and trace the wrong files. Pin it to this project.
  outputFileTracingRoot: path.join(import.meta.dirname, "."),

  // `pg` opens TCP sockets, so it must stay a real Node module rather than be
  // traced and bundled into the server build.
  serverExternalPackages: ["pg"],
  typescript: { ignoreBuildErrors: false },
  experimental: {
    serverActions: {
      allowedOrigins: ["*.run.app", "localhost:3000", "127.0.0.1:3000"],
    },
  },
};

export default nextConfig;
