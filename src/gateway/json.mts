import { createHash } from "node:crypto";
import { Ajv } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import formats from "ajv-formats";
import type { JsonObject, JsonValue } from "../agents/contracts.mjs";

export const MAX_JSON_BYTES = 256 * 1024;
export const sha256 = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

/** RFC 8785: ECMAScript number/string serialization, UTF-16 property ordering,
 * no Unicode normalization, and rejection of non-I-JSON input. */
export function canonicalJson(input: unknown): string {
  const seen = new Set<object>();
  function encode(value: unknown, depth: number): string {
    if (depth > 64) throw new Error("JSON exceeds the nesting limit.");
    if (value === null) return "null";
    if (typeof value === "boolean") return String(value);
    if (typeof value === "number" && Number.isFinite(value))
      return JSON.stringify(value);
    if (typeof value === "string") {
      if (/[\uD800-\uDFFF]/u.test(value))
        throw new Error("JSON contains invalid Unicode.");
      return JSON.stringify(value);
    }
    if (!value || typeof value !== "object" || seen.has(value))
      throw new Error("Expected finite, acyclic JSON.");
    seen.add(value);
    let result: string;
    if (Array.isArray(value)) {
      if (Object.keys(value).length !== value.length)
        throw new Error("Sparse or extended arrays are not JSON.");
      result = `[${Array.from(value, (item) => encode(item, depth + 1)).join(",")}]`;
    } else {
      if (![Object.prototype, null].includes(Object.getPrototypeOf(value)))
        throw new Error("Expected a plain JSON object.");
      if (Object.getOwnPropertySymbols(value).length)
        throw new Error("Symbols are not JSON.");
      const descriptors = Object.getOwnPropertyDescriptors(value);
      result = `{${Object.keys(descriptors)
        .sort()
        .map((key) => {
          const descriptor = descriptors[key];
          if (!descriptor.enumerable || !("value" in descriptor))
            throw new Error("JSON accessors are unsupported.");
          return `${encode(key, depth + 1)}:${encode(descriptor.value, depth + 1)}`;
        })
        .join(",")}}`;
    }
    seen.delete(value);
    return result;
  }
  const result = encode(input, 0);
  if (Buffer.byteLength(result) > MAX_JSON_BYTES)
    throw new Error("JSON exceeds the size limit.");
  return result;
}

export function jsonValue(input: unknown): JsonValue {
  // Parsing our canonical encoding strips prototypes; encoding validates every value.
  return JSON.parse(canonicalJson(input));
}
export function jsonObject(input: unknown): JsonObject {
  const value = jsonValue(input);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected a JSON object.");
  return value;
}

const options = {
  strict: false,
  strictSchema: true,
  logger: false,
  useDefaults: true,
  coerceTypes: false,
  removeAdditional: false,
} as const;
const draft7 = new Ajv(options);
const draft2020 = new Ajv2020(options);
formats.default(draft7);
formats.default(draft2020);
export function normalizeArguments(
  schema: JsonObject,
  input: unknown,
): {
  arguments: JsonObject;
  argumentsFingerprint: string;
} {
  const arguments_ = jsonObject(input);
  const validator = (
    schema.$schema === "https://json-schema.org/draft/2020-12/schema"
      ? draft2020
      : draft7
  ).compile(schema);
  if (!validator(arguments_))
    throw new Error("Arguments do not match the upstream tool schema.");
  rejectCredentialFields(arguments_);
  if (Buffer.byteLength(canonicalJson(arguments_)) > 128 * 1024)
    throw new Error("Arguments exceed the size limit.");
  return {
    arguments: arguments_,
    argumentsFingerprint: sha256(canonicalJson(arguments_)),
  };
}

const credentialField =
  /^(authorization|proxy.authorization|password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|credential(s)?)$/i;
export function rejectCredentialFields(value: JsonValue): void {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (credentialField.test(key))
      throw new Error("Service credentials belong in owner connection setup.");
    rejectCredentialFields(child);
  }
}

/** Defense in depth for trusted upstreams, not a sandbox for malicious executables.
 * Do not log raw provider errors. Redact before truncation, never after it. */
export class Sanitizer {
  private readonly secrets = new Set<string>();
  add(material: string): void {
    if (!material) return;
    for (const variant of [
      material,
      encodeURIComponent(material),
      Buffer.from(material).toString("base64"),
      JSON.stringify(material).slice(1, -1),
    ])
      this.secrets.add(variant);
  }
  text(input: string): string {
    let result = input;
    for (const secret of [...this.secrets].sort((a, b) => b.length - a.length))
      result = result.split(secret).join("[REDACTED]");
    return result
      .replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [REDACTED]")
      .replace(
        /((?:access_token|refresh_token|api_key|client_secret|password)\s*[=:]\s*)[^\s&,;]+/gi,
        "$1[REDACTED]",
      );
  }
  value(input: unknown): JsonValue {
    const walk = (value: JsonValue): JsonValue => {
      if (typeof value === "string") return this.text(value);
      if (Array.isArray(value)) return value.map(walk);
      if (value && typeof value === "object")
        return Object.fromEntries(
          Object.entries(value).map(([key, child]) => [
            this.text(key),
            credentialField.test(key) ? "[REDACTED]" : walk(child),
          ]),
        );
      return value;
    };
    return walk(jsonValue(input));
  }
}
