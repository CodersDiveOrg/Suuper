// What every scraping tier normalizes its findings into, before embedding.
export interface ScrapedProduct {
  externalId?: string;
  title: string;
  description?: string;
  price?: number;
  currency?: string;
  imageUrl?: string;
  productUrl: string;
}

/** Strips HTML tags/entities down to plain text, for descriptions pulled from HTML fields. */
export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** The text embedded for a product: what actually drives recommendation matching. */
export function embeddingText(product: ScrapedProduct): string {
  const parts = [product.title];
  if (product.description) parts.push(product.description);
  if (product.price !== undefined) parts.push(`Price: ${product.price} ${product.currency ?? ""}`.trim());
  return parts.join("\n");
}
