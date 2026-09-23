import { randomBytes } from "node:crypto";

import type { JevApiKeyResult } from "../config/configuration.js";
import { readShippedQuestionFile } from "../workflow/package.js";
import type { QuestionStatus, WorkflowPackage } from "../workflow/types.js";
import { redact, type EvidencePacket } from "./evidence.js";
import { completeTrace, startTrace } from "./traces.js";

/**
 * The Jev client (issue #16): one bounded judgment per call, over the
 * TypeSafe API (`POST /v1/systemone`, bearer key). The key comes only from
 * the environment or host secret storage; a missing key returns the
 * question to put to the developer and makes no call, with no fallback. The
 * exact exchange goes to a local trace without the key; the caller gets a
 * portable summary with a trace reference. Whether a failure is retried,
 * and fallback approval, are #18's; how an answer is used and recorded as a
 * decision envelope in the project records is #17's.
 */

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-latest";

/** A declared decision's question, as its question file carries it. */
export interface DecisionQuestion {
  readonly decision: string;
  readonly version: number;
  readonly status: QuestionStatus;
  readonly prompt: string;
  readonly answers: readonly string[];
}

/**
 * Reads a declared decision's question file from the shipped package. The
 * package validated every question file when it loaded, so only the fields
 * used here are read back.
 */
export function loadDecisionQuestion(workflowPackage: WorkflowPackage, decision: string): DecisionQuestion {
  const declaration = workflowPackage.decisions[decision];
  if (declaration === undefined) {
    const known = Object.keys(workflowPackage.decisions).join(", ");
    throw new Error(`unknown Jev decision "${decision}"; declared decisions are ${known}`);
  }
  const raw = readShippedQuestionFile(declaration.question);
  if (raw === undefined) throw new Error(`question file "${declaration.question}" is missing`);
  const file = JSON.parse(raw) as Omit<DecisionQuestion, "decision">;
  return {
    decision,
    version: file.version,
    status: file.status,
    prompt: file.prompt,
    answers: file.answers,
  };
}

export interface TransportRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly timeoutMs: number;
}

export type JevTransport = (request: TransportRequest) => Promise<{ readonly status: number; readonly body: string }>;

/** The real transport: Node's fetch with a finite timeout. */
export const fetchTransport: JevTransport = async (request) => {
  const response = await fetch(request.url, {
    method: "POST",
    headers: request.headers,
    body: request.body,
    signal: AbortSignal.timeout(request.timeoutMs),
  });
  return { status: response.status, body: await response.text() };
};

export interface JevClientOptions {
  readonly root: string;
  readonly apiKey: JevApiKeyResult;
  readonly transport: JevTransport;
  readonly timeoutMs: number;
  readonly now: () => string;
}

/** What a project record may keep about a call: no raw exchange, a reference to it. */
export interface JevCallSummary {
  readonly decision: string;
  readonly questionVersion: number;
  /** A `skeleton` question's wording is not yet accepted; #17 decides what such an answer may do. */
  readonly questionStatus: QuestionStatus;
  readonly model: string;
  readonly answer: string;
  readonly confidence?: number;
  /** How many pieces of evidence were withheld or cut; the trace lists them. */
  readonly omittedEvidence: number;
  readonly answeredAt: string;
  readonly traceReference: string;
}

export interface JevFailure {
  readonly decision: string;
  readonly status?: number;
  readonly error: string;
  /** A temporary failure (rate limit, overload, server error, timeout) that #18 may retry. */
  readonly retryable: boolean;
  readonly traceReference: string;
}

export type JevCallResult =
  | {
      /** No key: ask the developer how to configure it. Nothing was sent. */
      readonly kind: "needs-configuration";
      /** What to ask the developer about configuring the key. */
      readonly askHuman: string;
      readonly mayProceedWithoutJev: false;
    }
  | { readonly kind: "answered"; readonly summary: JevCallSummary }
  | { readonly kind: "failed"; readonly failure: JevFailure };

/** Temporary by HTTP semantics (timeout, rate limit, overload, server error); #18 owns the policy. */
function isRetryable(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

type ParsedAnswer =
  | { readonly ok: true; readonly model: string; readonly answer: string; readonly confidence?: number }
  | { readonly ok: false; readonly error: string };

function parseAnswer(body: unknown, question: DecisionQuestion): ParsedAnswer {
  const document = body as { model?: unknown; answers?: Record<string, { choice?: unknown; confidence?: unknown }> };
  const entry = document?.answers?.[question.decision];
  const choice = entry?.choice;
  if (typeof choice !== "string" || !question.answers.includes(choice)) {
    return {
      ok: false,
      error: `Jev returned no usable answer to "${question.decision}" (got ${JSON.stringify(choice)}; expected one of ${question.answers.join(", ")})`,
    };
  }
  const confidence = entry?.confidence;
  return {
    ok: true,
    model: typeof document.model === "string" ? document.model : JEV_MODEL,
    answer: choice,
    ...(typeof confidence === "number" ? { confidence } : {}),
  };
}

export async function askJev(
  call: { readonly question: DecisionQuestion; readonly evidence: EvidencePacket },
  options: JevClientOptions,
): Promise<JevCallResult> {
  if (options.apiKey.status === "missing") {
    return { kind: "needs-configuration", askHuman: options.apiKey.askHuman, mayProceedWithoutJev: false };
  }

  const { question } = call;
  const key = options.apiKey.key;
  // Whatever the caller passed, the key itself never leaves in the evidence.
  const evidence = JSON.parse(redact(JSON.stringify(call.evidence), [key])) as EvidencePacket;
  const body = JSON.stringify({
    model: JEV_MODEL,
    state: evidence,
    questions: {
      [question.decision]: {
        type: "choice",
        instructions: question.prompt,
        criteria: Object.fromEntries(question.answers.map((answer) => [answer, answer])),
      },
    },
  });
  const requestedAt = options.now();
  const traceName = `${requestedAt.replace(/[:.]/g, "-")}-${question.decision}-${randomBytes(3).toString("hex")}`;
  const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  // The trace holds the exact request with the key replaced, and is started
  // before sending so that every exchange that went out has one.
  const request = {
    decision: question.decision,
    questionVersion: question.version,
    questionStatus: question.status,
    requestedAt,
    request: {
      url: JEV_ENDPOINT,
      method: "POST",
      headers: { ...headers, Authorization: "Bearer [credential redacted]" },
      body: JSON.parse(body) as unknown,
    },
  };
  const traceReference = startTrace(options.root, traceName, request);
  const traced = (outcome: { readonly error: string } | { readonly response: object }) => {
    completeTrace(options.root, traceReference, { ...request, ...outcome });
    return traceReference;
  };

  let status: number;
  let responseBody: string;
  try {
    ({ status, body: responseBody } = await options.transport({
      url: JEV_ENDPOINT,
      headers,
      body,
      timeoutMs: options.timeoutMs,
    }));
  } catch (error) {
    const message = redact(error instanceof Error ? error.message : String(error), [key]);
    traced({ error: message });
    return {
      kind: "failed",
      failure: { decision: question.decision, error: message, retryable: true, traceReference },
    };
  }

  const parsed = parseJson(redact(responseBody, [key]));
  traced({ response: { status, body: parsed } });
  if (status < 200 || status >= 300) {
    return {
      kind: "failed",
      failure: {
        decision: question.decision,
        status,
        error: `Jev answered HTTP ${status}`,
        retryable: isRetryable(status),
        traceReference,
      },
    };
  }

  const answer = parseAnswer(parsed, question);
  if (!answer.ok) {
    return {
      kind: "failed",
      failure: { decision: question.decision, status, error: answer.error, retryable: false, traceReference },
    };
  }
  return {
    kind: "answered",
    summary: {
      decision: question.decision,
      questionVersion: question.version,
      questionStatus: question.status,
      model: answer.model,
      answer: answer.answer,
      ...(answer.confidence === undefined ? {} : { confidence: answer.confidence }),
      omittedEvidence: evidence.omitted.length,
      answeredAt: requestedAt,
      traceReference,
    },
  };
}
