/** Small non-evaluating validator for the JSON schema subset used by renderer contracts.
 * Keeping validation interpreted preserves the desktop's script-src 'self' policy.
 */
export interface Schema {
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: Schema;
  oneOf?: Schema[];
  anyOf?: Schema[];
  enum?: unknown[];
  const?: unknown;
  minimum?: number;
  maximum?: number;
}
export interface SchemaGuard<T> {
  (value: unknown): value is T;
  errors: string[];
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case "null":
      return value === null;
    case "object":
      return record(value);
    case "array":
      return Array.isArray(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isSafeInteger(value);
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    default:
      throw new Error(`Unsupported renderer schema type: ${type}`);
  }
}
function inspect(
  schema: Schema,
  value: unknown,
  path: string,
  errors: string[],
): boolean {
  if (
    schema.type &&
    !(Array.isArray(schema.type) ? schema.type : [schema.type]).some((type) =>
      matchesType(type, value),
    )
  ) {
    errors.push(`${path} has an invalid type`);
    return false;
  }
  if (
    typeof value === "number" &&
    ((schema.minimum !== undefined && value < schema.minimum) ||
      (schema.maximum !== undefined && value > schema.maximum))
  ) {
    errors.push(`${path} is outside the allowed range`);
    return false;
  }
  if ("const" in schema && value !== schema.const) {
    errors.push(`${path} has an unexpected value`);
    return false;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path} has an unsupported value`);
    return false;
  }
  if (
    schema.oneOf &&
    schema.oneOf.filter((option) => inspect(option, value, path, [])).length !==
      1
  ) {
    errors.push(`${path} does not match one supported event shape`);
    return false;
  }
  if (
    schema.anyOf &&
    !schema.anyOf.some((option) => inspect(option, value, path, []))
  ) {
    errors.push(`${path} does not match a supported shape`);
    return false;
  }
  if (record(value)) {
    for (const key of schema.required || [])
      if (!(key in value)) {
        errors.push(`${path}.${key} is required`);
        return false;
      }
    for (const [key, child] of Object.entries(schema.properties || {}))
      if (key in value && !inspect(child, value[key], `${path}.${key}`, errors))
        return false;
    if (
      schema.additionalProperties === false &&
      Object.keys(value).some((key) => !(key in (schema.properties || {})))
    ) {
      errors.push(`${path} contains an unknown property`);
      return false;
    }
  }
  if (Array.isArray(value) && schema.items)
    for (const [index, item] of value.entries())
      if (!inspect(schema.items, item, `${path}[${index}]`, errors))
        return false;
  return true;
}
export function compile<T>(schema: Schema): SchemaGuard<T> {
  const guard = (value: unknown): value is T => {
    guard.errors = [];
    return inspect(schema, value, "response", guard.errors);
  };
  guard.errors = Array<string>();
  return guard;
}
export const errorsText = (errors: string[]): string => errors.join("; ");
