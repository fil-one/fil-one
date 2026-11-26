import { isRecord } from './json-rpc.ts';

/** The JSON Schema subset tool inputs use: flat objects of scalar properties. */
export interface ToolInputProperty {
  type: 'string' | 'boolean' | 'integer';
  enum?: readonly string[];
  description: string;
}

export interface ToolInputSchema {
  type: 'object';
  properties: Record<string, ToolInputProperty>;
  required?: string[];
  additionalProperties: false;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: ToolInputSchema;
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
}

/** A tool's arguments checked against its input schema, or what breaks it. */
export function checkToolArguments(
  // A call that sends no arguments is a call with none.
  args: unknown = {},
  schema: ToolInputSchema,
): { args: Record<string, unknown> } | { problem: string } {
  if (!isRecord(args)) return { problem: 'arguments must be an object' };
  const unknown = Object.keys(args).filter((key) => !Object.hasOwn(schema.properties, key));
  if (unknown.length > 0) return { problem: `unknown argument: ${unknown.join(', ')}` };
  const missing = (schema.required ?? []).filter((key) => args[key] === undefined);
  if (missing.length > 0) return { problem: `missing argument: ${missing.join(', ')}` };

  for (const [key, property] of Object.entries(schema.properties)) {
    const problem = args[key] === undefined ? undefined : checkValue(key, property, args[key]);
    if (problem) return { problem };
  }
  return { args };
}

/** What is wrong with one argument's value, if anything. */
function checkValue(key: string, property: ToolInputProperty, value: unknown) {
  if (property.enum) {
    const allowed = typeof value === 'string' && property.enum.includes(value);
    return allowed ? undefined : `${key} must be one of ${property.enum.join(', ')}`;
  }
  if (property.type === 'integer') {
    return Number.isInteger(value) ? undefined : `${key} must be an integer`;
  }
  return typeof value === property.type ? undefined : `${key} must be a ${property.type}`;
}
