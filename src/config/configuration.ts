import type {
  SettingDefinition,
  ValidationIssue,
  WorkflowPackage,
} from "../workflow/types.js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { JEV_API_KEY_ENV_VAR, SECRET_KEY_PATTERN, SECRET_MESSAGE } from "../secrets.js";
import { isRecord, joinPath } from "../validation.js";

export { JEV_API_KEY_ENV_VAR };

export interface StageModelConfiguration {
  readonly model: string;
  /** Explicit fallback; jflow never substitutes a model implicitly (SPEC.md D20). */
  readonly fallbackModel?: string;
  /** The efforts a worker may run at; `model-selection` recommends one (D49, issue #28). */
  readonly efforts?: readonly string[];
}

export type SettingValue = boolean | number | string;

export interface ResolvedConfiguration {
  /** The primary conversational model, fixed across stages (SPEC.md D19). */
  readonly primaryModel?: string;
  readonly stageModels: Readonly<Record<string, StageModelConfiguration>>;
  readonly settings: Readonly<Record<string, SettingValue>>;
}

export type ConfigurationResult =
  | { readonly ok: true; readonly configuration: ResolvedConfiguration }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] };

const TOP_LEVEL_KEYS = ["primaryModel", "stageModels", "settings"] as const;

const STAGE_MODEL_KEYS = new Set(["model", "fallbackModel", "efforts"]);

/** Placeholders that would amount to an implicit, unapproved substitution. */
const IMPLICIT_FALLBACK_PLACEHOLDERS = new Set(["auto", "any", "default", "*"]);

function validateSettingValue(
  definition: SettingDefinition,
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): SettingValue | undefined {
  if (definition.locked === true) {
    if (value !== definition.default) {
      issues.push({
        path,
        message: `cannot be changed from its default (${String(definition.default)}); this gate is not configurable`,
      });
      return undefined;
    }
    return definition.default;
  }

  switch (definition.type) {
    case "boolean": {
      if (typeof value !== "boolean") {
        issues.push({ path, message: "must be a boolean" });
        return undefined;
      }
      return value;
    }
    case "integer": {
      const minimum = definition.minimum ?? Number.MIN_SAFE_INTEGER;
      const maximum = definition.maximum ?? Number.MAX_SAFE_INTEGER;
      if (
        typeof value !== "number" ||
        !Number.isInteger(value) ||
        value < minimum ||
        value > maximum
      ) {
        issues.push({
          path,
          message: `must be an integer between ${minimum} and ${maximum}`,
        });
        return undefined;
      }
      return value;
    }
    case "enum": {
      const allowed = definition.values ?? [];
      if (typeof value !== "string" || !allowed.includes(value)) {
        issues.push({
          path,
          message: `must be one of ${allowed.join(", ")}`,
        });
        return undefined;
      }
      return value;
    }
  }
}

/**
 * Flags secret-looking string values anywhere in the configuration. Declared
 * settings are exempt so that legitimate keys such as
 * `evidenceSharing.excludeCredentials` are not mistaken for stored secrets.
 */
function checkSecretKeys(
  value: unknown,
  path: string,
  declaredSettingKeys: ReadonlySet<string>,
  issues: ValidationIssue[],
  flaggedPaths: Set<string>,
): void {
  if (!isRecord(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    const keyPath = joinPath(path, key);
    // A declared setting is only exempt where it legitimately lives, directly
    // under `settings`; the same name elsewhere is still an unknown key.
    if (path === "settings" && declaredSettingKeys.has(key)) continue;
    if (isSecretKey(key, nested)) {
      issues.push({ path: keyPath, message: SECRET_MESSAGE });
      flaggedPaths.add(keyPath);
      continue;
    }
    checkSecretKeys(nested, keyPath, declaredSettingKeys, issues, flaggedPaths);
  }
}

/** A stored secret is a secret-looking key holding a string value. */
function isSecretKey(key: string, value: unknown): boolean {
  return SECRET_KEY_PATTERN.test(key) && typeof value === "string";
}

function validateStageModels(
  value: unknown,
  workflowPackage: WorkflowPackage,
  issues: ValidationIssue[],
): Record<string, StageModelConfiguration> {
  const stageModels: Record<string, StageModelConfiguration> = {};
  if (value === undefined) return stageModels;

  if (!isRecord(value)) {
    issues.push({ path: "stageModels", message: "must be an object keyed by stage name" });
    return stageModels;
  }

  const configurable = new Set(workflowPackage.configurationSurface.configurableStageModels);

  for (const [stage, entry] of Object.entries(value)) {
    const stagePath = `stageModels.${stage}`;
    if (!configurable.has(stage)) {
      issues.push({
        path: stagePath,
        message: `unknown stage "${stage}"; configurable stages are ${[...configurable].join(", ")}`,
      });
      continue;
    }
    if (!isRecord(entry)) {
      issues.push({ path: stagePath, message: "must be an object with a model" });
      continue;
    }

    let rejected = false;
    for (const key of Object.keys(entry)) {
      if (STAGE_MODEL_KEYS.has(key)) continue;
      if (key === "primaryModel") {
        issues.push({
          path: `${stagePath}.primaryModel`,
          message:
            "the primary conversational model is fixed across stages and cannot be overridden per stage",
        });
      } else if (isSecretKey(key, entry[key])) {
        issues.push({ path: `${stagePath}.${key}`, message: SECRET_MESSAGE });
      } else {
        issues.push({
          path: `${stagePath}.${key}`,
          message: `unknown stage model key; supported keys are ${[...STAGE_MODEL_KEYS].join(", ")}`,
        });
      }
      rejected = true;
    }

    const model = entry["model"];
    if (typeof model !== "string" || model.trim() === "") {
      issues.push({ path: `${stagePath}.model`, message: "must be a non-empty model name" });
      rejected = true;
    }

    const fallback = entry["fallbackModel"];
    if (fallback !== undefined) {
      if (typeof fallback !== "string" || fallback.trim() === "") {
        issues.push({
          path: `${stagePath}.fallbackModel`,
          message: "must be a non-empty model name",
        });
        rejected = true;
      } else if (IMPLICIT_FALLBACK_PLACEHOLDERS.has(fallback.trim().toLowerCase())) {
        issues.push({
          path: `${stagePath}.fallbackModel`,
          message:
            "must name an explicit model; jflow never substitutes a model automatically and asks the human instead",
        });
        rejected = true;
      }
    }

    const efforts = entry["efforts"];
    if (efforts !== undefined) {
      if (
        !Array.isArray(efforts) ||
        efforts.length === 0 ||
        efforts.some((effort) => typeof effort !== "string" || effort.trim() === "") ||
        new Set(efforts).size !== efforts.length
      ) {
        issues.push({ path: `${stagePath}.efforts`, message: "must be a non-empty list of distinct effort names" });
        rejected = true;
      }
    }

    if (rejected || typeof model !== "string") continue;

    stageModels[stage] = {
      model,
      ...(typeof fallback === "string" ? { fallbackModel: fallback } : {}),
      ...(Array.isArray(efforts) ? { efforts: efforts as string[] } : {}),
    };
  }

  return stageModels;
}

/**
 * Validates user configuration against the workflow package's declared surface
 * and applies defaults, failing loudly with actionable errors rather than
 * silently weakening a gate (SPEC.md user story 50, confirmed default 2).
 */
export function resolveConfiguration(
  document: unknown,
  workflowPackage: WorkflowPackage,
): ConfigurationResult {
  const issues: ValidationIssue[] = [];

  if (document === undefined || document === null) {
    document = {};
  }
  if (!isRecord(document)) {
    return {
      ok: false,
      issues: [{ path: "", message: "configuration must be an object" }],
    };
  }

  const definitions = new Map(
    workflowPackage.configurationSurface.settings.map((setting) => [setting.key, setting]),
  );
  const declaredSettingKeys = new Set(definitions.keys());
  const flaggedPaths = new Set<string>();

  checkSecretKeys(document, "", declaredSettingKeys, issues, flaggedPaths);

  for (const key of Object.keys(document)) {
    if ((TOP_LEVEL_KEYS as readonly string[]).includes(key)) continue;
    if (flaggedPaths.has(key)) continue;
    issues.push({
      path: key,
      message: `unknown configuration key; supported keys are ${TOP_LEVEL_KEYS.join(", ")}`,
    });
  }

  let primaryModel: string | undefined;
  const primaryValue = document["primaryModel"];
  if (primaryValue !== undefined) {
    if (typeof primaryValue !== "string" || primaryValue.trim() === "") {
      issues.push({ path: "primaryModel", message: "must be a non-empty model name" });
    } else {
      primaryModel = primaryValue;
    }
  }

  const stageModels = validateStageModels(document["stageModels"], workflowPackage, issues);

  const settings: Record<string, SettingValue> = {};
  for (const definition of definitions.values()) {
    settings[definition.key] = definition.default;
  }

  const settingsValue = document["settings"];
  if (settingsValue !== undefined) {
    if (!isRecord(settingsValue)) {
      issues.push({ path: "settings", message: "must be an object keyed by setting name" });
    } else {
      for (const [key, value] of Object.entries(settingsValue)) {
        const path = `settings.${key}`;
        if (flaggedPaths.has(path)) continue;
        const definition = definitions.get(key);
        if (!definition) {
          issues.push({
            path,
            message: `unknown setting; supported settings are ${[...definitions.keys()].join(", ")}`,
          });
          continue;
        }
        const resolved = validateSettingValue(definition, value, path, issues);
        if (resolved !== undefined) {
          settings[key] = resolved;
        }
      }
    }
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    configuration: {
      ...(primaryModel === undefined ? {} : { primaryModel }),
      stageModels,
      settings,
    },
  };
}

export type JevApiKeySource = "environment" | "key-file" | "host-secret-storage";

export type JevApiKeyResult =
  | { readonly status: "configured"; readonly source: JevApiKeySource; readonly key: string }
  | {
      readonly status: "missing";
      readonly askHuman: string;
      /** Never true: a missing key is a human question, not a silent fallback. */
      readonly mayProceedWithoutJev: false;
    };

export interface JevApiKeyLookup {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The user's key file (`jevKeyFilePath`); undefined when there is none. */
  readonly readKeyFile?: () => string | undefined;
  readonly readHostSecret?: () => string | undefined;
}

/**
 * The user's Jev key file: `jflow/jev-key` in `XDG_CONFIG_HOME`, else in
 * `~/.config`. It sits outside every project, so no project read or commit
 * can reach it.
 */
export function jevKeyFilePath(
  env: Readonly<Record<string, string | undefined>>,
  home: string = homedir(),
): string {
  const configHome = env["XDG_CONFIG_HOME"]?.trim() || join(home, ".config");
  return join(configHome, "jflow", "jev-key");
}

/** Reads the user's key file; undefined when it does not exist. */
export function readJevKeyFile(env: Readonly<Record<string, string | undefined>>): string | undefined {
  try {
    return readFileSync(jevKeyFilePath(env), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Resolves the Jev API key from the environment, the user's key file, or host
 * secret storage, in that order. The key is never read from project files or
 * version control, and a missing key asks the human rather than falling back
 * (SPEC.md confirmed default 8).
 */
export function resolveJevApiKey(lookup: JevApiKeyLookup): JevApiKeyResult {
  const fromEnv = lookup.env[JEV_API_KEY_ENV_VAR];
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") {
    return { status: "configured", source: "environment", key: fromEnv.trim() };
  }

  const fromFile = lookup.readKeyFile?.();
  if (typeof fromFile === "string" && fromFile.trim() !== "") {
    return { status: "configured", source: "key-file", key: fromFile.trim() };
  }

  const fromHost = lookup.readHostSecret?.();
  if (typeof fromHost === "string" && fromHost.trim() !== "") {
    return { status: "configured", source: "host-secret-storage", key: fromHost.trim() };
  }

  return {
    status: "missing",
    askHuman:
      `No Jev API key is configured. Put the key in ${jevKeyFilePath(lookup.env)} ` +
      `or set the ${JEV_API_KEY_ENV_VAR} environment variable, then tell jflow to continue. ` +
      `jflow will not proceed without Jev unless you explicitly approve it.`,
    mayProceedWithoutJev: false,
  };
}
