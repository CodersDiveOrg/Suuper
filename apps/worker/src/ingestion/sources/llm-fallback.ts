import * as cheerio from "cheerio";
import { chat } from "@platform/shared-ai";
import { safeFetch } from "../http";
import type { ScrapedProduct } from "../scraped-product";

const MAX_TEXT_CHARS = 6000;

/** Last resort when no structured feed or JSON-LD markup exists: ask the local
 * chat model to read the homepage text and pick out anything that looks like
 * a product. Best-effort by nature — quality depends on the local model and
 * how product-like the page's visible text actually is. */
export async function tryLlmExtraction(storeUrl: string): Promise<ScrapedProduct[] | null> {
  const response = await safeFetch(storeUrl, { headers: { Accept: "text/html" } });
  if (!response || !response.ok) return null;

  const $ = cheerio.load(await response.text());
  $("script, style, noscript").remove();
  const text = $("body").text().replace(/\s+/g, " ").trim().slice(0, MAX_TEXT_CHARS);
  if (!text) return [];

  const prompt = [
    "You are extracting product listings from a web store's homepage text.",
    "Read the page text below and return a JSON array of products you can identify.",
    'Each item must look like: {"title": string, "description": string, "price": number or null, "productUrl": string}.',
    "If you cannot confidently identify any real products, return exactly: []",
    "Return ONLY the JSON array, no other text before or after it.",
    "",
    `Store URL: ${storeUrl}`,
    "Page text:",
    text,
  ].join("\n");

  let reply: string;
  try {
    reply = await chat([{ role: "user", content: prompt }]);
  } catch {
    return null;
  }

  const parsed = parseJsonArray(reply);
  if (!parsed) return [];

  return parsed
    .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
    .map((item) => toScrapedProduct(item, storeUrl))
    .filter((item): item is ScrapedProduct => item !== null);
}

function parseJsonArray(text: string): unknown[] | null {
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function toScrapedProduct(item: Record<string, unknown>, storeUrl: string): ScrapedProduct | null {
  if (typeof item.title !== "string" || !item.title.trim()) return null;
  return {
    title: item.title,
    description: typeof item.description === "string" ? item.description : undefined,
    price: typeof item.price === "number" ? item.price : undefined,
    productUrl: typeof item.productUrl === "string" ? item.productUrl : storeUrl,
  };
}
