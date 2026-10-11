import { safeFetch } from "../http";
import { stripHtml, type ScrapedProduct } from "../scraped-product";

const MAX_PAGES = 4; // up to 1000 products (Shopify's page size cap is 250)
const PAGE_SIZE = 250;

interface ShopifyVariant {
  price?: string;
}

interface ShopifyImage {
  src?: string;
}

interface ShopifyProduct {
  id: number | string;
  title: string;
  body_html?: string;
  handle: string;
  variants?: ShopifyVariant[];
  images?: ShopifyImage[];
}

/** Shopify exposes this on almost every storefront with no auth. Returns null
 * (not an empty array) when the store isn't Shopify, so callers know to try the next tier. */
export async function tryShopify(storeUrl: string): Promise<ScrapedProduct[] | null> {
  const all: ScrapedProduct[] = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    const response = await safeFetch(`${storeUrl}/products.json?limit=${PAGE_SIZE}&page=${page}`, {
      headers: { Accept: "application/json" },
    });
    if (!response || !response.ok) {
      return page === 1 ? null : all;
    }

    let body: { products?: ShopifyProduct[] };
    try {
      body = (await response.json()) as { products?: ShopifyProduct[] };
    } catch {
      return page === 1 ? null : all;
    }

    const products = body.products;
    if (!Array.isArray(products)) {
      return page === 1 ? null : all;
    }
    if (products.length === 0) {
      break;
    }

    for (const product of products) {
      all.push({
        externalId: String(product.id),
        title: product.title,
        description: product.body_html ? stripHtml(product.body_html) : undefined,
        price: parsePrice(product.variants?.[0]?.price),
        imageUrl: product.images?.[0]?.src,
        productUrl: `${storeUrl}/products/${product.handle}`,
      });
    }

    if (products.length < PAGE_SIZE) break;
  }

  return all;
}

function parsePrice(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : undefined;
}
