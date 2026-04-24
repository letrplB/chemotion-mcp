/**
 * Shared MCP tool helpers: error-to-text guard, text response
 * builder, zod primitives reused across tool registrations.
 *
 * The `guard` wrapper converts any error thrown inside a tool
 * handler into a text response with `isError: true` instead of
 * crashing the stdio connection. Tool calls that crash the MCP
 * transport are invisible to the LLM — it sees a disconnect and
 * starts hallucinating. Returning a structured error keeps the
 * conversation alive and lets the model self-correct.
 */

import { z } from 'zod';
import { ChemotionApiError, ChemotionAuthError } from '../../client/index.js';

export type TextResponse = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

export function text(body: string): TextResponse {
  return { content: [{ type: 'text', text: body }] };
}

export function errorText(message: string): TextResponse {
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
  };
}

/**
 * Run a data-fetching function and format the result, catching any
 * error into an `isError` text response.
 *
 * Two-argument shape:
 *   `guard(async () => fetch(), (value) => text(render(value)))`
 *
 * `ChemotionApiError` lands with status + body so the LLM can see
 * what the server actually said. `ChemotionAuthError` lands as its
 * own category — its messages include actionable hints.
 */
export async function guard<T>(
  fn: () => Promise<T>,
  handler: (value: T) => TextResponse | Promise<TextResponse>
): Promise<TextResponse> {
  try {
    const value = await fn();
    return await handler(value);
  } catch (error) {
    if (error instanceof ChemotionApiError) {
      const bodySnippet = error.body
        ? `\n${error.body.slice(0, 600)}${error.body.length > 600 ? ' …' : ''}`
        : '';
      return errorText(
        `${error.statusCode} ${error.method} ${error.url}${bodySnippet}`
      );
    }
    if (error instanceof ChemotionAuthError) {
      return errorText(error.message);
    }
    const msg = error instanceof Error ? error.message : String(error);
    return errorText(msg);
  }
}

export function writeDisabledResponse(): TextResponse {
  return errorText(
    'Write tools are disabled. Set CHEMOTION_ALLOW_WRITES=true to enable ' +
      'create / update tools, and CHEMOTION_ALLOW_DESTRUCTIVE=true to enable ' +
      'delete.'
  );
}

// ---------------------------------------------------------------------
// Shared zod primitives
// ---------------------------------------------------------------------

export const elementKindSchema = z
  .enum(['sample', 'reaction', 'research_plan', 'wellplate', 'screen'])
  .describe(
    'Chemotion element kind. ' +
      '`sample` = chemical substance with molecule/amount/purity. ' +
      '`reaction` = multi-step reaction with SM/reactants/products/solvents. ' +
      '`research_plan` = free-form planning document with typed blocks. ' +
      '`wellplate` = plate layout of wells → samples. ' +
      '`screen` = collection of wellplates for parameter screening.'
  );

export const positiveInt = z.number().int().positive();

// MCP's JSON-RPC tool-call layer occasionally serializes integer args
// as strings when the schema is a union with a string literal
// alternative (the JSON Schema `anyOf` emitted by zod has no
// discriminator, so the caller hedges). Preprocess decimal strings
// into real numbers before letting zod pick a branch — otherwise
// `"13"` falls into neither `number` nor `'all'` and zod rejects.
export const collectionIdSchema = z
  .preprocess(
    (v) => (typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v),
    z.union([z.number().int().positive(), z.literal('all')])
  )
  .describe(
    'Collection id to scope the list to. Pass `"all"` to hit the ' +
      'pseudo-collection that returns every element the caller can see ' +
      '(Chemotion aggregates own + shared).'
  );

export const paginationArgsSchema = {
  page: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('1-based page number. Default 1.'),
  per_page: z
    .number()
    .int()
    .positive()
    .max(100)
    .optional()
    .describe('Rows per page. Default 25.'),
};
