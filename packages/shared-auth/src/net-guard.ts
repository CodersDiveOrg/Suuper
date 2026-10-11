import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

// SSRF protection for requests to user-supplied URLs (agent http_request tool,
// external MCP servers, hosted MCP tools). Blocks loopback, private, link-local
// (cloud metadata), CGNAT, multicast and IPv4-mapped/NAT64 IPv6 forms.

export function isPrivateAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  const lower = address.toLowerCase();
  // "::"-prefixed covers loopback, unspecified and IPv4-mapped/compatible forms
  // (e.g. ::ffff:7f00:1 = 127.0.0.1); 64:ff9b:: is NAT64, which can reach IPv4
  // internals. None are needed for public APIs, so block them outright.
  return (
    lower.startsWith("::") ||
    lower.startsWith("64:ff9b:") ||
    lower.startsWith("fc") ||
    lower.startsWith("fd") ||
    lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")
  );
}

/** Literal-IP hosts skip DNS (and so the guarded lookup) — check them directly. */
export function isBlockedLiteralHost(hostname: string) {
  const host = hostname.replace(/^\[|\]$/g, "");
  return net.isIP(host) !== 0 && isPrivateAddress(host);
}

// Validates the address actually connected to (not just the hostname in the
// URL), so DNS rebinding can't point a public name at an internal service.
export const guardedLookup: typeof dns.lookup = ((
  hostname: string,
  options: dns.LookupOptions,
  callback: (...args: unknown[]) => void,
) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const list = addresses as dns.LookupAddress[];
    const blocked = list.find((a) => isPrivateAddress(a.address));
    if (blocked) return callback(new Error(`Blocked request to private address ${blocked.address}`));
    if (options.all) return callback(null, list);
    callback(null, list[0].address, list[0].family);
  });
}) as typeof dns.lookup;

/** Node http(s) agents that refuse to connect to private addresses. */
export const guardedHttpAgent = new http.Agent({ lookup: guardedLookup });
export const guardedHttpsAgent = new https.Agent({ lookup: guardedLookup });

/**
 * Pre-flight check for clients that can't take a custom agent (e.g. fetch):
 * http(s) only, no credentials in the URL, and every resolved address public.
 * Throws with a user-facing message. Pass allowPrivate for local development.
 */
export async function assertPublicUrl(raw: string, { allowPrivate = false } = {}): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Must be an absolute URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http and https URLs are allowed");
  if (url.username || url.password) throw new Error("Credentials in URLs are not allowed");
  if (allowPrivate) return url;
  if (isBlockedLiteralHost(url.hostname)) throw new Error("Private and internal addresses are blocked");
  const addresses = await dns.promises.lookup(url.hostname.replace(/^\[|\]$/g, ""), { all: true }).catch(() => {
    throw new Error(`Can't resolve ${url.hostname}`);
  });
  if (addresses.some((a) => isPrivateAddress(a.address))) throw new Error("Private and internal addresses are blocked");
  return url;
}
