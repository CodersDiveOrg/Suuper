const FETCH_TIMEOUT_MS = 10_000;

export function normalizeStoreUrl(input: string): string {
  const withProtocol = /^https?:\/\//i.test(input) ? input : `https://${input}`;
  return withProtocol.replace(/\/+$/, "");
}

/** fetch() with a timeout; resolves to null on any network/timeout error instead of throwing,
 * since a scraping tier failing to reach a site just means "this tier doesn't apply." */
export async function safeFetch(url: string, init?: RequestInit): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
