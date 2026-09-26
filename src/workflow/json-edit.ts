/**
 * Edits one value in a JSON document's text and leaves every other character
 * as it was (issue #30). The workflow package is laid out by hand, and D37
 * wants a threshold change to be a one-line diff, so an accepted proposal
 * edits the value in place rather than re-serializing the file.
 */

type JsonNode =
  | { readonly kind: "object"; readonly start: number; readonly end: number; readonly members: ReadonlyMap<string, JsonNode> }
  | { readonly kind: "other"; readonly start: number; readonly end: number };

/** A recursive-descent scan that records where each value sits; `JSON.parse` has already checked the text. */
function scan(text: string): JsonNode {
  let at = 0;
  const skipSpace = () => {
    while (at < text.length && /\s/.test(text[at]!)) at += 1;
  };
  const readString = (): string => {
    const start = at;
    at += 1;
    while (text[at] !== '"') at += text[at] === "\\" ? 2 : 1;
    at += 1;
    return JSON.parse(text.slice(start, at)) as string;
  };
  const readValue = (): JsonNode => {
    skipSpace();
    const start = at;
    const opening = text[at];
    if (opening === "{") {
      at += 1;
      const members = new Map<string, JsonNode>();
      skipSpace();
      while (text[at] !== "}") {
        skipSpace();
        const key = readString();
        skipSpace();
        at += 1; // :
        members.set(key, readValue());
        skipSpace();
        if (text[at] === ",") at += 1;
        skipSpace();
      }
      at += 1;
      return { kind: "object", start, end: at, members };
    }
    if (opening === "[") {
      at += 1;
      skipSpace();
      while (text[at] !== "]") {
        readValue();
        skipSpace();
        if (text[at] === ",") at += 1;
        skipSpace();
      }
      at += 1;
    } else if (opening === '"') {
      readString();
    } else {
      while (at < text.length && /[^\s,\]}]/.test(text[at]!)) at += 1;
    }
    return { kind: "other", start, end: at };
  };
  return readValue();
}

/** The indentation of the line `index` sits on. */
function indentAt(text: string, index: number): string {
  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart))![0];
}

/**
 * Sets the value at `path` (object keys only), replacing it where it exists
 * and adding it at the end of its parent object otherwise, in that object's
 * layout: on the same line for a one-line object, on a line of its own
 * otherwise.
 *
 * @throws {Error} when the text is not JSON, or the path's parent is missing or not an object.
 */
export function setJsonValue(text: string, path: readonly string[], value: unknown): string {
  JSON.parse(text);
  const encoded = JSON.stringify(value);
  let node = scan(text);
  for (const [index, key] of path.slice(0, -1).entries()) {
    const next = node.kind === "object" ? node.members.get(key) : undefined;
    if (next === undefined) throw new Error(`${path.slice(0, index + 1).join(".")} is not in the document`);
    node = next;
  }
  const where = path.slice(0, -1).join(".") || "the document";
  if (node.kind !== "object") throw new Error(`${where} is not an object`);
  const key = path[path.length - 1]!;
  const existing = node.members.get(key);
  if (existing !== undefined) return `${text.slice(0, existing.start)}${encoded}${text.slice(existing.end)}`;

  const close = node.end - 1;
  const inner = text.slice(node.start + 1, close);
  const member = `${JSON.stringify(key)}: ${encoded}`;
  const hasMembers = node.members.size > 0;
  if (!inner.includes("\n")) {
    const body = inner.trim();
    return `${text.slice(0, node.start + 1)} ${hasMembers ? `${body}, ` : ""}${member} ${text.slice(close)}`;
  }
  const last = inner.trimEnd();
  const lastEnd = node.start + 1 + last.length;
  const memberIndent = hasMembers ? indentAt(text, lastEnd) : `${indentAt(text, close)}  `;
  return `${text.slice(0, lastEnd)}${hasMembers ? "," : ""}\n${memberIndent}${member}${text.slice(lastEnd)}`;
}
