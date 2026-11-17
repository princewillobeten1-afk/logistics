/**
 * Resolves the configured Google Maps Platform API key on the server so
 * Server Components can pass it to client map providers across environments.
 */
export function getServerMapsApiKey(): string {
  return (
    process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ||
    process.env.GOOGLE_MAPS_API_KEY ||
    process.env.VITE_GOOGLE_MAPS_API_KEY ||
    ""
  ).trim();
}
