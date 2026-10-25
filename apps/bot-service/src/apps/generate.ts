import type { AppSuggestion } from "@platform/shared-types";
import { complete } from "./ai";
import { APP_TEMPLATES, findTemplate, type AppTemplate } from "./templates";
import { defaultAnswers } from "./templates/helpers";

const MAX_DESCRIPTION_CHARS = 3000;
// Past this the builder falls back to keyword matching and default answers, which still makes a good app.
const MODEL_TIMEOUT_MS = 60_000;

/**
 * The AI App Builder: a plain description of what the business needs in, the
 * best-fitting app out, with its setup answers (categories, services, sources…)
 * drawn from the description. Nothing is created; the install wizard shows it
 * for review. Without a usable model reply, keyword matching picks the app.
 */
export async function suggestApp(businessId: string, rawDescription: string): Promise<AppSuggestion> {
  const description = rawDescription.trim().slice(0, MAX_DESCRIPTION_CHARS);
  let draft: { templateKey?: string; businessName?: string; answers?: Record<string, unknown> } | null = null;
  let generatedBy: AppSuggestion["generatedBy"] = "fallback";
  try {
    const result = await Promise.race([
      complete(businessId, "You turn a business owner's request into JSON. Reply with a single JSON object and nothing else.", builderPrompt(description), 500),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out")), MODEL_TIMEOUT_MS)),
    ]);
    draft = parseJson(result.text);
    if (draft) generatedBy = result.provider;
  } catch (error) {
    console.warn(`[bot-service] app builder model failed, using keyword matching: ${(error as Error).message}`);
  }

  const keywordMatch = matchTemplate(description);
  const template = (draft?.templateKey && findTemplate(draft.templateKey)) || keywordMatch || APP_TEMPLATES[0];
  const answers = defaultAnswers(template);
  // Only answers for this app's questions, as short text; anything else keeps its default.
  for (const question of template.setupQuestions) {
    const value = draft?.answers?.[question.key];
    const text = Array.isArray(value) ? value.map(String).join(question.type === "textarea" ? "\n" : ", ") : typeof value === "string" || typeof value === "number" ? String(value) : "";
    if (text.trim()) answers[question.key] = text.trim().slice(0, 2000);
  }
  const name = statedName(description) || clean(draft?.businessName) || template.name;
  return { templateKey: template.key, name, answers, generatedBy };
}

function builderPrompt(description: string): string {
  const apps = APP_TEMPLATES.map(
    (t) =>
      `- "${t.key}": ${t.name} (${t.tagline}). Setup answers: ${t.setupQuestions.map((q) => `"${q.key}" = ${q.label}${q.type === "list" ? " (comma-separated)" : ""}`).join("; ")}`,
  ).join("\n");
  return `A business owner wrote:
"""
${description}
"""

Choose the app that fits best:
${apps}

Return JSON:
{
  "templateKey": one of the keys above,
  "businessName": the business's name if stated, else "",
  "answers": { only setup answers the text states or clearly implies, by key; leave others out }
}`;
}

function parseJson(text: string) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const value = JSON.parse(text.slice(start, end + 1));
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The app whose keywords appear most (at word starts) in the description. */
export function matchTemplate(description: string): AppTemplate | undefined {
  const text = description.toLowerCase();
  let best: { template: AppTemplate; score: number } | undefined;
  for (const template of APP_TEMPLATES) {
    const score = template.keywords.filter((k) => new RegExp(`\\b${escapeRegExp(k)}`).test(text)).length;
    if (score > 0 && (!best || score > best.score)) best = { template, score };
  }
  return best?.template;
}

const clean = (value: unknown) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 60) : "");

/** A name the description states outright ("called Breathe", "We are Cheezy Bites"). */
function statedName(description: string): string | undefined {
  return description.match(/(?:[Cc]alled|[Nn]amed|[Ww]e are|[Ww]e're|[Tt]his is)\s+([A-Z][\w'&-]*(?:\s+[A-Z][\w'&-]*){0,3})/)?.[1];
}
