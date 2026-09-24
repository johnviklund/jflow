/**
 * Shared building blocks for validating untrusted JSON documents: every
 * issue is collected with a dotted path so a report names each offending
 * value rather than stopping at the first (SPEC.md user story 50).
 */

import type { ValidationIssue } from "./workflow/types.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Appends a key to a dotted document path; the root path is the empty string. */
export function joinPath(prefix: string, key: string): string {
  return prefix === "" ? key : `${prefix}.${key}`;
}

export class IssueCollector {
  readonly issues: ValidationIssue[] = [];

  add(path: string, message: string): void {
    this.issues.push({ path, message });
  }

  get ok(): boolean {
    return this.issues.length === 0;
  }

  get count(): number {
    return this.issues.length;
  }
}

export function requireBoolean(value: unknown, path: string, issues: IssueCollector): boolean {
  if (typeof value !== "boolean") {
    issues.add(path, "must be a boolean");
    return false;
  }
  return value;
}

export function requireNonEmptyString(
  value: unknown,
  path: string,
  issues: IssueCollector,
): string {
  if (typeof value !== "string" || value.trim() === "") {
    issues.add(path, "must be a non-empty string");
    return "";
  }
  return value;
}

export function requireIntegerInRange(
  value: unknown,
  path: string,
  minimum: number,
  issues: IssueCollector,
): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum) {
    issues.add(path, `must be an integer of at least ${minimum}`);
    return minimum;
  }
  return value;
}

/** Whether `value` is one of a closed set of strings. */
export function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return (values as readonly unknown[]).includes(value);
}

export function validateEnumValue<T extends string>(
  value: unknown,
  path: string,
  allowed: readonly T[],
  issues: IssueCollector,
): T | undefined {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    issues.add(path, `must be one of ${allowed.join(", ")}`);
    return undefined;
  }
  return value as T;
}

/** An optional string field: absent is fine, present must be non-empty. */
export function optionalString(
  value: unknown,
  path: string,
  issues: IssueCollector,
): string | undefined {
  if (value === undefined) return undefined;
  const result = requireNonEmptyString(value, path, issues);
  return result === "" ? undefined : result;
}

/** An ISO 8601 timestamp, so records sort and compare across sessions and machines. */
export function requireTimestamp(value: unknown, path: string, issues: IssueCollector): string {
  const text = requireNonEmptyString(value, path, issues);
  if (text !== "" && Number.isNaN(Date.parse(text))) {
    issues.add(path, "must be an ISO 8601 timestamp");
    return "";
  }
  return text;
}

export function optionalTimestamp(
  value: unknown,
  path: string,
  issues: IssueCollector,
): string | undefined {
  if (value === undefined) return undefined;
  const result = requireTimestamp(value, path, issues);
  return result === "" ? undefined : result;
}

export function validateStringArray(
  value: unknown,
  path: string,
  issues: IssueCollector,
): string[] {
  if (!Array.isArray(value)) {
    issues.add(path, "must be an array of strings");
    return [];
  }
  const result: string[] = [];
  value.forEach((entry, index) => {
    const item = requireNonEmptyString(entry, `${path}[${index}]`, issues);
    if (item !== "") result.push(item);
  });
  return result;
}

export function optionalStringArray(
  value: unknown,
  path: string,
  issues: IssueCollector,
): string[] | undefined {
  return value === undefined ? undefined : validateStringArray(value, path, issues);
}

/**
 * An object with a closed key set: every key must be declared by the schema.
 * Returns the object for field validation, or undefined when it is not one.
 */
export function requireObject(
  value: unknown,
  path: string,
  keys: readonly string[],
  issues: IssueCollector,
): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    issues.add(path, "must be an object");
    return undefined;
  }
  rejectUnknownKeys(value, path, keys, issues);
  return value;
}

/**
 * Rejects keys a schema does not declare. Used where an undeclared key is a
 * sign of drift or of content that must not be there at all, such as a raw
 * trace body inside a project record (SPEC.md D23).
 */
export function rejectUnknownKeys(
  value: Record<string, unknown>,
  path: string,
  allowed: readonly string[],
  issues: IssueCollector,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      issues.add(joinPath(path, key), `unknown key; supported keys are ${allowed.join(", ")}`);
    }
  }
}
