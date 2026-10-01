/**
 * Single resolution point for the Node dist download base (in this package).
 *
 * The `ZCODE_NODE_DIST_MIRROR` env var (CI or local) overrides the default.
 *
 * Latch productization: the default is the official `https://nodejs.org/dist`
 * source. The previous third-party mirror default (npmmirror) was retired with
 * the other vendor egress surfaces in the P1 security closure; an explicitly
 * configured mirror env var still wins for runners that cannot reach the
 * official source.
 *
 * Kept as its own module (not inline in stageCli.ts) because stageCli.ts ends
 * with a top-level `await main()`, so importing it executes the script and
 * tests cannot reference it.
 */
export const DEFAULT_NODE_DIST_BASE = "https://nodejs.org/dist";

export function resolveNodeDistBase(env: NodeJS.ProcessEnv = process.env): string {
  const mirror = env.ZCODE_NODE_DIST_MIRROR?.trim();
  return (mirror || DEFAULT_NODE_DIST_BASE).replace(/\/+$/u, "");
}
