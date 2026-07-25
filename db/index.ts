import { env } from "cloudflare:workers";

export function getD1(): D1Database {
  const binding = (env as unknown as { DB?: D1Database }).DB;
  if (!binding) {
    throw new Error("The family-game database is unavailable.");
  }
  return binding;
}
