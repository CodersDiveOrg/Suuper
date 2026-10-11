import { BadRequestException } from "@nestjs/common";
import { hasActions } from "./integrations";

/** Validates integration keys for an agent or bot: providers that have actions. */
export function validIntegrations(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    throw new BadRequestException("integrations must be an array of integration keys");
  }
  const keys = [...new Set(value as string[])];
  const invalid = keys.filter((k) => !hasActions(k));
  if (invalid.length) throw new BadRequestException(`These integrations can't be used by agents or bots yet: ${invalid.join(", ")}`);
  return keys;
}
