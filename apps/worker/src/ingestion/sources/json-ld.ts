import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";
import { safeFetch } from "../http";
import type { ScrapedProduct } from "../scraped-product";

const MAX_LINKS_TO_CRAWL = 12;
const CRAWL_CONCURRENCY = 4;
const PRODUCT_PATH_HINTS = ["/product/", "/products/", "/item/", "/shop/"];

/** Most storefronts (any platform, including custom-built ones) embed schema.org
 * Product markup for SEO rich snippets. Reads the given page plus a bounded set
 * of same-origin links that look like product pages. Returns null only when the
 * site couldn't be reached at all; [] means "reachable, no Product markup found." */
export async function tryJsonLd(storeUrl: string): Promise<ScrapedProduct[] | null> {
  const homepageHtml = await fetchHtml(storeUrl);
  if (homepageHtml === null) return null;

  const found: ScrapedProduct[] = [];
  const home$ = cheerio.load(homepageHtml);
  found.push(...extractJsonLdProducts(home$, storeUrl));

  const links = extractProductLinks(home$, storeUrl).slice(0, MAX_LINKS_TO_CRAWL);
  for (let i = 0; i < links.length; i += CRAWL_CONCURRENCY) {
    const batch = links.slice(i, i + CRAWL_CONCURRENCY);
    const pages = await Promise.all(batch.map(fetchHtml));
    pages.forEach((html, idx) => {
      if (!html) return;
      const page$ = cheerio.load(html);
      found.push(...extractJsonLdProducts(page$, batch[idx]));
    });
  }

  return dedupeByUrl(found);
}

async function fetchHtml(url: string): Promise<string | null> {
  const response = await safeFetch(url, { headers: { Accept: "text/html" } });
  if (!response || !response.ok) return null;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("html")) return null;
  return response.text();
}

function extractJsonLdProducts($: CheerioAPI, pageUrl: string): ScrapedProduct[] {
  const results: ScrapedProduct[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse($(el).contents().text());
    } catch {
      return;
    }
    for (const node of flattenJsonLd(parsed)) {
      const product = jsonLdNodeToProduct(node, pageUrl);
      if (product) results.push(product);
    }
  });
  return results;
}

function flattenJsonLd(node: unknown): Record<string, unknown>[] {
  if (Array.isArray(node)) return node.flatMap(flattenJsonLd);
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    const graph = Array.isArray(obj["@graph"]) ? (obj["@graph"] as unknown[]).flatMap(flattenJsonLd) : [];
    return [obj, ...graph];
  }
  return [];
}

function jsonLdNodeToProduct(node: Record<string, unknown>, pageUrl: string): ScrapedProduct | null {
  const type = node["@type"];
  const isProduct = type === "Product" || (Array.isArray(type) && type.includes("Product"));
  if (!isProduct || typeof node.name !== "string") return null;

  const offer = firstOffer(node.offers);
  const image = Array.isArray(node.image) ? node.image[0] : node.image;

  return {
    externalId: typeof node.sku === "string" ? node.sku : undefined,
    title: node.name,
    description: typeof node.description === "string" ? node.description : undefined,
    price: offer?.price,
    currency: offer?.currency,
    imageUrl: typeof image === "string" ? image : undefined,
    productUrl: typeof node.url === "string" ? node.url : pageUrl,
  };
}

function firstOffer(offers: unknown): { price?: number; currency?: string } | undefined {
  const offer = Array.isArray(offers) ? offers[0] : offers;
  if (!offer || typeof offer !== "object") return undefined;
  const o = offer as Record<string, unknown>;
  const price =
    typeof o.price === "string" ? Number.parseFloat(o.price) : typeof o.price === "number" ? o.price : undefined;
  return { price, currency: typeof o.priceCurrency === "string" ? o.priceCurrency : undefined };
}

function extractProductLinks($: CheerioAPI, baseUrl: string): string[] {
  const origin = new URL(baseUrl).origin;
  const links = new Set<string>();
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    let absolute: URL;
    try {
      absolute = new URL(href, baseUrl);
    } catch {
      return;
    }
    if (absolute.origin !== origin) return;
    const path = absolute.pathname.toLowerCase();
    if (PRODUCT_PATH_HINTS.some((hint) => path.includes(hint))) {
      links.add(absolute.toString());
    }
  });
  return [...links];
}

function dedupeByUrl(products: ScrapedProduct[]): ScrapedProduct[] {
  const seen = new Map<string, ScrapedProduct>();
  for (const product of products) {
    seen.set(product.productUrl, product);
  }
  return [...seen.values()];
}
