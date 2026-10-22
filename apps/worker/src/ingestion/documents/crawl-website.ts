import * as cheerio from "cheerio";
import { assertPublicUrl } from "@platform/shared-auth";

// Reads a business's own site breadth-first from the start URL, staying on its
// host. Small limits: this runs on a shared single-core server.
const MAX_PAGES = 25;
const MAX_REDIRECTS = 3;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;
const SKIP_EXTENSIONS = /\.(pdf|jpe?g|png|gif|webp|svg|ico|css|js|json|xml|zip|mp4|mp3|webm|woff2?|ttf)$/i;

export interface CrawledPage {
  url: string;
  title: string;
  text: string;
}

export async function crawlWebsite(startUrl: string, allowPrivate: boolean): Promise<CrawledPage[]> {
  const start = new URL(startUrl);
  const queue: string[] = [normalize(start)];
  const seen = new Set(queue);
  const pages: CrawledPage[] = [];

  while (queue.length > 0 && pages.length < MAX_PAGES) {
    const url = queue.shift()!;
    const html = await fetchHtml(url, allowPrivate);
    if (!html) continue;

    const $ = cheerio.load(html);
    for (const href of $("a[href]").map((_, a) => $(a).attr("href")).get()) {
      const link = resolveLink(href, url, start.host);
      if (link && !seen.has(link) && seen.size < MAX_PAGES * 8) {
        seen.add(link);
        queue.push(link);
      }
    }

    const title = $("title").first().text().trim() || $("h1").first().text().trim() || url;
    const text = pageText($);
    if (text.length >= 50) pages.push({ url, title: title.slice(0, 200), text });
  }
  return pages;
}

/** The readable text of a page, without navigation, scripts and other chrome. */
function pageText($: cheerio.CheerioAPI): string {
  $("script, style, noscript, svg, iframe, nav, header, footer, form, aside, [aria-hidden=true]").remove();
  const root = $("main").first().length ? $("main").first() : $("article").first().length ? $("article").first() : $("body");
  // Block elements become paragraph breaks so the chunker can keep them together.
  root.find("br").replaceWith("\n");
  root.find("p, div, section, li, h1, h2, h3, h4, h5, h6, tr").each((_, el) => {
    $(el).append("\n\n");
  });
  return root
    .text()
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function resolveLink(href: string, base: string, host: string): string | null {
  if (/^(mailto|tel|javascript):/i.test(href)) return null;
  let url: URL;
  try {
    url = new URL(href, base);
  } catch {
    return null;
  }
  if (url.host !== host || (url.protocol !== "http:" && url.protocol !== "https:")) return null;
  if (SKIP_EXTENSIONS.test(url.pathname)) return null;
  return normalize(url);
}

function normalize(url: URL): string {
  const copy = new URL(url.toString());
  copy.hash = "";
  return copy.toString().replace(/\/$/, "");
}

/** GET an HTML page, re-checking every redirect hop against the SSRF guard. Null on any failure. */
async function fetchHtml(url: string, allowPrivate: boolean): Promise<string | null> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    try {
      await assertPublicUrl(current, { allowPrivate });
    } catch {
      return null;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(current, {
        redirect: "manual",
        signal: controller.signal,
        headers: { "User-Agent": "SuuperBot/1.0 (+https://app.suuper.cc)", Accept: "text/html" },
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) return null;
        current = new URL(location, current).toString();
        continue;
      }
      if (!response.ok || !(response.headers.get("content-type") ?? "").includes("text/html")) return null;
      const length = Number(response.headers.get("content-length") ?? 0);
      if (length > MAX_HTML_BYTES) return null;
      const html = await response.text();
      return html.length > MAX_HTML_BYTES ? null : html;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}
