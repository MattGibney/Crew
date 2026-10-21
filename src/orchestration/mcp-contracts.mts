import { Ajv } from "ajv";
import { record } from "../shared/errors.mjs";
export interface ToolSchema {
  type: string | string[];
  description?: string;
  minLength?: number;
  maxLength?: number;
  maxItems?: number;
  pattern?: string;
  enum?: string[];
  items?: ToolSchema;
  properties?: Record<string, ToolSchema>;
  required?: string[];
  additionalProperties?: boolean;
}
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: ToolSchema & {
    properties: Record<string, ToolSchema>;
    required: string[];
  };
}
const ajv = new Ajv({ strict: false });
/** Each tool's public schema is also the runtime proof for its handler contract. */
export function toolArguments<T>(tool: ToolDefinition, input: unknown): T {
  if (record(input))
    for (const [key, value] of Object.entries(input)) {
      if (
        tool.inputSchema.properties[key]?.type === "array" &&
        Array.isArray(value) &&
        value.some((item) => typeof item === "string" && !item.trim())
      )
        throw new Error(`Invalid ${key}`);
    }
  // Compile with the handler type at this boundary; no JSON value is assumed typed.
  const validate = ajv.compile<T>(tool.inputSchema);
  if (record(input))
    for (const [key, value] of Object.entries(input)) {
      const shape = tool.inputSchema.properties[key];
      if (
        shape &&
        (shape.type === "string" ||
          (Array.isArray(shape.type) && shape.type.includes("string"))) &&
        typeof value === "string" &&
        (!value.trim() ||
          value.length >
            (shape.maxLength || (Array.isArray(shape.type) ? 160 : 80)))
      )
        throw new Error(`Invalid ${key}`);
    }
  if (!validate(input))
    throw new Error(
      `Invalid tool arguments: ${ajv.errorsText(validate.errors)}`,
    );
  return input;
}
export interface McpMessage {
  id?: string | number | null;
  method: string;
  params: Record<string, unknown>;
}
export function mcpMessage(input: unknown): McpMessage | null {
  if (
    !record(input) ||
    input.jsonrpc !== "2.0" ||
    typeof input.method !== "string"
  )
    return null;
  const value: McpMessage = {
    method: input.method,
    params: record(input.params) ? input.params : {},
  };
  if (Object.hasOwn(input, "id")) {
    if (
      input.id !== null &&
      typeof input.id !== "string" &&
      typeof input.id !== "number"
    )
      return null;
    value.id = input.id;
  }
  return value;
}
