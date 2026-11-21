// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

// Cloudflare Flagship — feature-flag evaluation binding (VRT fork).
// Rendered as a `wrapped` binding whose `config` inner binding is a JSON
// snapshot of the app's flags; evaluation happens locally in the isolate,
// matching Flagship's "evaluate inside the Worker" semantics.

export class FlagshipEvaluationError extends Error {
  readonly errorCode: string;

  constructor(errorCode: string, message: string) {
    super(message);
    this.name = 'FlagshipEvaluationError';
    this.errorCode = errorCode;
  }
}

type Json =
  | string
  | number
  | boolean
  | null
  | Json[]
  | { [key: string]: Json };

type FlagshipEvaluationContext = Record<string, Json>;
type ConditionOperator =
  | 'equals'
  | 'not_equals'
  | 'greater_than'
  | 'less_than'
  | 'greater_than_or_equals'
  | 'less_than_or_equals'
  | 'contains'
  | 'starts_with'
  | 'ends_with'
  | 'in'
  | 'not_in'
  | 'has'
  | 'not_has';

interface Condition {
  attribute: string;
  operator: ConditionOperator;
  value?: Json;
}

interface ConditionGroup {
  all?: (Condition | ConditionGroup)[];
  any?: (Condition | ConditionGroup)[];
}

interface Rollout {
  percentage: number;
  attribute?: string;
}

interface Rule {
  conditions?: (Condition | ConditionGroup)[] | ConditionGroup;
  serve_variation: string;
  rollout?: Rollout;
}

interface FlagDefinition {
  enabled: boolean;
  type: 'boolean' | 'string' | 'number' | 'json';
  defaultVariant: string;
  variants: Record<string, Json>;
  rules: Rule[];
}

interface AppConfig {
  appId?: string;
  accountTag?: string;
  flags: Record<string, FlagDefinition>;
}

interface EvaluationDetails<T> {
  flagKey: string;
  value: T;
  variant?: string;
  reason?: string;
  errorCode?: string;
  errorMessage?: string;
}

const MISSING = Symbol('flagship.missing');
const MAX_PATH_SEGMENTS = 5;
const MAX_GROUP_DEPTH = 5;

function isRecord(v: unknown): v is Record<string, Json> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Context validation per CF semantics: JSON values only, finite numbers,
// no cycles; Date values normalize to ISO 8601 strings.
function normalizeContextValue(v: unknown, seen: Set<unknown>): Json {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) {
      throw new FlagshipEvaluationError(
        'INVALID_CONTEXT',
        'context numbers must be finite'
      );
    }
    return v;
  }
  if (v instanceof Date) {
    const t = v.getTime();
    if (!Number.isFinite(t)) {
      throw new FlagshipEvaluationError(
        'INVALID_CONTEXT',
        'context Date is invalid'
      );
    }
    return new Date(t).toISOString();
  }
  if (Array.isArray(v) || isRecord(v)) {
    if (seen.has(v)) {
      throw new FlagshipEvaluationError(
        'INVALID_CONTEXT',
        'context contains a cycle'
      );
    }
    seen.add(v);
    const out: Json = Array.isArray(v)
      ? v.map((item) => normalizeContextValue(item, seen))
      : Object.fromEntries(
          Object.entries(v as Record<string, unknown>).map(([k, item]) => [
            k,
            normalizeContextValue(item, seen),
          ])
        );
    seen.delete(v);
    return out;
  }
  throw new FlagshipEvaluationError(
    'INVALID_CONTEXT',
    `context contains unsupported value of type ${typeof v}`
  );
}

function normalizeContext(raw: unknown): FlagshipEvaluationContext {
  if (raw === undefined) return {};
  if (!isRecord(raw)) {
    throw new FlagshipEvaluationError(
      'INVALID_CONTEXT',
      'context must be an object'
    );
  }
  return normalizeContextValue(raw, new Set()) as FlagshipEvaluationContext;
}

// A literal top-level key wins over dot-path traversal; otherwise paths
// traverse up to five segments.
function resolveAttribute(
  ctx: FlagshipEvaluationContext,
  attribute: string
): Json | typeof MISSING {
  if (Object.prototype.hasOwnProperty.call(ctx, attribute)) {
    return ctx[attribute] as Json;
  }
  const segments = attribute.split('.');
  if (segments.length > MAX_PATH_SEGMENTS) return MISSING;
  let cur: Json | undefined = ctx[segments[0] as string];
  if (cur === undefined) return MISSING;
  for (let i = 1; i < segments.length; i++) {
    if (!isRecord(cur)) return MISSING;
    cur = cur[segments[i] as string];
    if (cur === undefined) return MISSING;
  }
  return cur;
}

function isoTime(v: Json | undefined): number | typeof MISSING {
  if (typeof v !== 'string') return MISSING;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : MISSING;
}

// Missing attributes never match — including negative operators. A null
// attribute only matches not_equals / not_in.
function compare(cond: Condition, attr: Json | typeof MISSING): boolean {
  if (attr === MISSING) return false;
  const { operator, value } = cond;
  if (attr === null) {
    return operator === 'not_equals' || operator === 'not_in';
  }
  switch (operator) {
    case 'equals':
      return attr === value;
    case 'not_equals':
      return attr !== value;
    // Negative operators are the strict negation of their positive form, so
    // a malformed rule value (e.g. non-array for `in`) still yields a match.
    case 'in':
      return Array.isArray(value) && value.includes(attr);
    case 'not_in':
      return !(Array.isArray(value) && value.includes(attr));
    case 'has':
      return (
        Array.isArray(attr) && value !== undefined && attr.includes(value)
      );
    case 'not_has':
      return !(
        Array.isArray(attr) &&
        value !== undefined &&
        attr.includes(value)
      );
    case 'contains':
      return (
        typeof attr === 'string' &&
        typeof value === 'string' &&
        attr.includes(value)
      );
    case 'starts_with':
      return (
        typeof attr === 'string' &&
        typeof value === 'string' &&
        attr.startsWith(value)
      );
    case 'ends_with':
      return (
        typeof attr === 'string' &&
        typeof value === 'string' &&
        attr.endsWith(value)
      );
    case 'greater_than':
    case 'less_than':
    case 'greater_than_or_equals':
    case 'less_than_or_equals': {
      // Numeric compare, or ISO 8601 datetime compare when both sides parse.
      if (typeof attr === 'number' && typeof value === 'number') {
        return numericCompare(operator, attr, value);
      }
      const at = isoTime(attr);
      const vt = isoTime(value);
      if (at !== MISSING && vt !== MISSING) {
        return numericCompare(operator, at, vt);
      }
      return false;
    }
  }
}

function numericCompare(
  op: ConditionOperator,
  a: number,
  b: number
): boolean {
  switch (op) {
    case 'greater_than':
      return a > b;
    case 'less_than':
      return a < b;
    case 'greater_than_or_equals':
      return a >= b;
    case 'less_than_or_equals':
      return a <= b;
    default:
      return false;
  }
}

function isCondition(v: Condition | ConditionGroup): v is Condition {
  return typeof (v as Condition).attribute === 'string';
}

function evalConditions(
  node: (Condition | ConditionGroup)[] | ConditionGroup | undefined,
  ctx: FlagshipEvaluationContext,
  depth: number
): boolean {
  if (node === undefined) return true;
  if (depth > MAX_GROUP_DEPTH) return false;
  if (!Array.isArray(node)) {
    if (Array.isArray(node.all)) {
      return node.all.every((n) => evalNode(n, ctx, depth + 1));
    }
    if (Array.isArray(node.any)) {
      return node.any.some((n) => evalNode(n, ctx, depth + 1));
    }
    return false;
  }
  return node.every((n) => evalNode(n, ctx, depth + 1));
}

function evalNode(
  node: Condition | ConditionGroup,
  ctx: FlagshipEvaluationContext,
  depth: number
): boolean {
  if (isCondition(node)) {
    if (node.attribute.length === 0) return false;
    return compare(node, resolveAttribute(ctx, node.attribute));
  }
  return evalConditions(node, ctx, depth);
}

// FNV-1a 32-bit — consistent-hash bucketing salted per app+flag so the same
// identifier lands in different buckets across unrelated flags.
function bucketOf(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 100;
}

function rolloutPasses(
  rollout: Rollout,
  ctx: FlagshipEvaluationContext,
  seed: string
): 'pass' | 'fail' | 'rule-fails' {
  const attribute = rollout.attribute ?? 'targetingKey';
  const resolved = resolveAttribute(ctx, attribute);
  if (resolved !== MISSING && resolved !== null && typeof resolved === 'object') {
    // Array/object bucketing value → the rule fails, continue to next rule.
    return 'rule-fails';
  }
  const pct = rollout.percentage;
  if (typeof pct !== 'number' || !Number.isFinite(pct) || pct <= 0) {
    return 'fail';
  }
  if (pct >= 100) return 'pass';
  const bucket =
    resolved === MISSING || resolved === null
      ? Math.floor(Math.random() * 100)
      : bucketOf(`${seed}:${String(resolved)}`);
  return bucket < pct ? 'pass' : 'fail';
}

interface EvalResult {
  variant: string;
  value: Json;
  reason: string;
}

function flagValue(flag: FlagDefinition, name: string): Json {
  const value = flag.variants[name];
  if (value === undefined) {
    throw new FlagshipEvaluationError(
      'GENERAL',
      `variant '${name}' is not defined`
    );
  }
  return value;
}

function evaluate(
  flag: FlagDefinition,
  flagKey: string,
  ctx: FlagshipEvaluationContext,
  seed: string
): EvalResult {
  if (!flag.enabled) {
    return {
      variant: flag.defaultVariant,
      value: flagValue(flag, flag.defaultVariant),
      reason: 'DISABLED',
    };
  }
  const rules = Array.isArray(flag.rules) ? flag.rules : [];
  if (rules.length === 0) {
    return {
      variant: flag.defaultVariant,
      value: flagValue(flag, flag.defaultVariant),
      reason: 'STATIC',
    };
  }
  for (const rule of rules) {
    if (!evalConditions(rule.conditions, ctx, 0)) continue;
    const variation = rule.serve_variation;
    if (typeof variation !== 'string' || !(variation in flag.variants)) {
      continue;
    }
    if (rule.rollout !== undefined) {
      const check = rolloutPasses(rule.rollout, ctx, `${seed}:${flagKey}`);
      if (check !== 'pass') continue;
      return {
        variant: variation,
        value: flag.variants[variation] as Json,
        reason: 'SPLIT',
      };
    }
    return {
      variant: variation,
      value: flag.variants[variation] as Json,
      reason: 'TARGETING_MATCH',
    };
  }
  return {
    variant: flag.defaultVariant,
    value: flagValue(flag, flag.defaultVariant),
    reason: 'DEFAULT',
  };
}

type ValueKind = 'boolean' | 'string' | 'number' | 'object';

function kindOf(v: Json): ValueKind {
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'string') return 'string';
  if (typeof v === 'number') return 'number';
  return 'object';
}

const FLAG_TYPE_KIND: Record<FlagDefinition['type'], ValueKind> = {
  boolean: 'boolean',
  string: 'string',
  number: 'number',
  json: 'object',
};

class FlagshipImpl {
  readonly #app: AppConfig;
  readonly #seed: string;

  constructor(config: unknown) {
    const app = isRecord(config) ? (config as unknown as AppConfig) : { flags: {} };
    this.#app = {
      ...app,
      flags: isRecord(app.flags) ? app.flags : {},
    };
    this.#seed = `${this.#app.accountTag ?? ''}:${this.#app.appId ?? ''}`;
  }

  #evaluate(flagKey: string, rawContext: unknown): EvalResult {
    const ctx = normalizeContext(rawContext);
    const flag = this.#app.flags[flagKey];
    if (flag === undefined) {
      throw new FlagshipEvaluationError(
        'FLAG_NOT_FOUND',
        `flag '${flagKey}' not found`
      );
    }
    return evaluate(flag, flagKey, ctx, this.#seed);
  }

  async #typed<T>(
    flagKey: string,
    defaultValue: T,
    context: unknown,
    want: ValueKind,
    details: boolean
  ): Promise<T | EvaluationDetails<T>> {
    try {
      const result = this.#evaluate(flagKey, context);
      const flag = this.#app.flags[flagKey] as FlagDefinition;
      if (kindOf(result.value) !== want || FLAG_TYPE_KIND[flag.type] !== want) {
        throw new FlagshipEvaluationError(
          'TYPE_MISMATCH',
          `flag '${flagKey}' is not of the requested type`
        );
      }
      const value = result.value as T;
      return details
        ? { flagKey, value, variant: result.variant, reason: result.reason }
        : value;
    } catch (err) {
      if (err instanceof FlagshipEvaluationError) {
        if (details) {
          return {
            flagKey,
            value: defaultValue,
            reason: 'ERROR',
            errorCode: err.errorCode,
            errorMessage: err.message,
          };
        }
        return defaultValue;
      }
      throw err;
    }
  }

  async get(flagKey: string, ...rest: [Json?, unknown?]): Promise<Json> {
    const [defaultValue, context] = rest;
    try {
      return (await this.#evaluate(flagKey, context)).value;
    } catch (err) {
      // With a default supplied, known failures return it; without one they
      // are thrown, per the documented get() contract.
      if (err instanceof FlagshipEvaluationError && rest.length >= 1) {
        return defaultValue as Json;
      }
      throw err;
    }
  }

  getBooleanValue(
    flagKey: string,
    defaultValue: boolean,
    context?: unknown
  ): Promise<boolean> {
    return this.#typed(flagKey, defaultValue, context, 'boolean', false) as Promise<boolean>;
  }

  getStringValue(
    flagKey: string,
    defaultValue: string,
    context?: unknown
  ): Promise<string> {
    return this.#typed(flagKey, defaultValue, context, 'string', false) as Promise<string>;
  }

  getNumberValue(
    flagKey: string,
    defaultValue: number,
    context?: unknown
  ): Promise<number> {
    return this.#typed(flagKey, defaultValue, context, 'number', false) as Promise<number>;
  }

  getObjectValue<T extends object>(
    flagKey: string,
    defaultValue: T,
    context?: unknown
  ): Promise<T> {
    return this.#typed(flagKey, defaultValue, context, 'object', false) as Promise<T>;
  }

  getBooleanDetails(
    flagKey: string,
    defaultValue: boolean,
    context?: unknown
  ): Promise<EvaluationDetails<boolean>> {
    return this.#typed(flagKey, defaultValue, context, 'boolean', true) as Promise<
      EvaluationDetails<boolean>
    >;
  }

  getStringDetails(
    flagKey: string,
    defaultValue: string,
    context?: unknown
  ): Promise<EvaluationDetails<string>> {
    return this.#typed(flagKey, defaultValue, context, 'string', true) as Promise<
      EvaluationDetails<string>
    >;
  }

  getNumberDetails(
    flagKey: string,
    defaultValue: number,
    context?: unknown
  ): Promise<EvaluationDetails<number>> {
    return this.#typed(flagKey, defaultValue, context, 'number', true) as Promise<
      EvaluationDetails<number>
    >;
  }

  getObjectDetails<T extends object>(
    flagKey: string,
    defaultValue: T,
    context?: unknown
  ): Promise<EvaluationDetails<T>> {
    return this.#typed(flagKey, defaultValue, context, 'object', true) as Promise<
      EvaluationDetails<T>
    >;
  }
}

export function makeBinding(env: { config?: unknown }): FlagshipImpl {
  return new FlagshipImpl(env.config);
}

export default makeBinding;
