// {{trigger.a.b}} / {{steps.<id>.a.b}} placeholders in step fields.
const PLACEHOLDER = /\{\{\s*([\w.-]+)\s*\}\}/g;

export interface TemplateContext {
  trigger: unknown;
  steps: Record<string, unknown>;
}

/** Looks up "trigger.order.id" / "steps.s1.text" / "steps.s1.items.0.name" in the context. */
export function lookup(ctx: TemplateContext, path: string): unknown {
  let value: unknown = ctx;
  for (const key of path.split(".")) {
    if (value === null || value === undefined || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

/** Replaces each placeholder with its value; objects become JSON, missing values become "".
 * With json, values are escaped for use inside a JSON string ("…{{x}}…"), so quotes and
 * newlines in e.g. an AI reply don't break a JSON request body. */
export function fill(template: string | undefined, ctx: TemplateContext, { json = false } = {}): string {
  if (!template) return "";
  return template.replace(PLACEHOLDER, (_, path: string) => {
    const value = lookup(ctx, path);
    if (value === undefined || value === null) return "";
    const text = typeof value === "object" ? JSON.stringify(value) : String(value);
    return json ? JSON.stringify(text).slice(1, -1) : text;
  });
}
