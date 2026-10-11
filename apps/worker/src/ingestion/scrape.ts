import { normalizeStoreUrl } from "./http";
import type { ScrapedProduct } from "./scraped-product";
import { tryShopify } from "./sources/shopify";
import { tryWooCommerce } from "./sources/woocommerce";
import { tryJsonLd } from "./sources/json-ld";
import { tryLlmExtraction } from "./sources/llm-fallback";

export type ScrapeSource = "shopify" | "woocommerce" | "json-ld" | "llm";

export interface ScrapeResult {
  products: ScrapedProduct[];
  source: ScrapeSource;
}

const TIERS: Array<{ source: ScrapeSource; run: (storeUrl: string) => Promise<ScrapedProduct[] | null> }> = [
  { source: "shopify", run: tryShopify },
  { source: "woocommerce", run: tryWooCommerce },
  { source: "json-ld", run: tryJsonLd },
  { source: "llm", run: tryLlmExtraction },
];

/** Tries each ingestion tier in order of reliability, stopping at the first
 * that turns up products. Returns null if every tier came up empty. */
export async function scrapeStore(rawUrl: string): Promise<ScrapeResult | null> {
  const storeUrl = normalizeStoreUrl(rawUrl);

  for (const tier of TIERS) {
    const products = await tier.run(storeUrl);
    if (products && products.length > 0) {
      return { products, source: tier.source };
    }
  }

  return null;
}
