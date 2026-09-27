// Brand manifest reader — product/identity/brand.yaml is the only place
// identity fields live (INV-3); scripts read them from there, never hardcode.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BRAND_FILE = path.join(repoRoot, 'product', 'identity', 'brand.yaml');

/** Minimal manifest read — brand.yaml is flat `key: value` lines. */
export function readBrand() {
  const text = readFileSync(BRAND_FILE, 'utf8');
  const field = (name) => text.match(new RegExp(`^${name}:\\s*(\\S+)`, 'm'))?.[1];
  return {
    repoRoot,
    productName: field('product_name') ?? 'Latch',
    gatewayBaseUrl: field('gateway_base_url'),
  };
}
