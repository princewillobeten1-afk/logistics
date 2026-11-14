import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Build and dev must not share an output directory. `next build` rewrites
  // the chunk files a running `next dev` still holds references to, and the
  // dev server then dies with "Cannot find module './611.js'" — the build
  // deleted the chunk out from under it.
  //
  // Next sets NODE_ENV to production for both `build` and `start`, and
  // development for `dev`, so this splits them without an extra dependency:
  // build writes .next-build, start reads it, dev keeps .next to itself.
  distDir: process.env.NODE_ENV === "production" ? ".next-build" : ".next",

  // A stray package-lock.json in the home directory makes Next infer that as
  // the workspace root and trace the wrong files. Pin it to this project.
  outputFileTracingRoot: path.join(import.meta.dirname, "."),

  // `pg` opens TCP sockets, so it must stay a real Node module rather than be
  // traced and bundled into the server build.
  serverExternalPackages: ["pg"],
  typescript: { ignoreBuildErrors: false },
};

export default nextConfig;
