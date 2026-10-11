import { safeFetch } from "../http";
import { stripHtml, type ScrapedProduct } from "../scraped-product";

const MAX_PAGES = 4;
const PAGE_SIZE = 100;

interface WooImage {
  src?: string;
}

interface WooPrices {
  price?: string;
  currency_code?: string;
  currency_minor_unit?: number;
}

interface WooProduct {
  id: number | string;
  name: string;
  description?: string;
  short_description?: string;
  images?: WooImage[];
  prices?: WooPrices;
  permalink: string;
}

/** WooCommerce's Store API is public/no-auth by design for headless storefronts. */
export async function tryWooCommerce(storeUrl: string): Promise<ScrapedProduct[] | null> {
  const all: ScrapedProduct[] = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    const response = await safeFetch(
      `${storeUrl}/wp-json/wc/store/v1/products?per_page=${PAGE_SIZE}&page=${page}`,
      { headers: { Accept: "application/json" } },
    );
    if (!response || !response.ok) {
      return page === 1 ? null : all;
    }

    let products: WooProduct[];
    try {
      const body = await response.json();
      if (!Array.isArray(body)) return page === 1 ? null : all;
      products = body as WooProduct[];
    } catch {
      return page === 1 ? null : all;
    }

    if (products.length === 0) break;

    for (const product of products) {
      all.push({
        externalId: String(product.id),
        title: product.name,
        description: stripHtml(product.description || product.short_description || ""),
        price: parseMinorUnitPrice(product.prices),
        currency: product.prices?.currency_code,
        imageUrl: product.images?.[0]?.src,
        productUrl: product.permalink,
      });
    }

    if (products.length < PAGE_SIZE) break;
  }

  return all;
}

/** Store API prices are integers in the currency's minor unit, e.g. "2999" + minor_unit 2 -> 29.99. */
function parseMinorUnitPrice(prices: WooPrices | undefined): number | undefined {
  if (!prices?.price) return undefined;
  const raw = Number.parseInt(prices.price, 10);
  if (!Number.isFinite(raw)) return undefined;
  const minorUnit = prices.currency_minor_unit ?? 2;
  return raw / 10 ** minorUnit;
}
