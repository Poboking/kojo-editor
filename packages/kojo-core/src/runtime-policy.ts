/**
 * M3 runtime match policy：纯数据、adapter 可声明、core 统一消费。
 *
 * 匹配和 dispatch ERB 共用这里的展开结果，禁止 matcher 与 renderer 各写一套别名规则。
 */

export interface RuntimeTimeRange {
  readonly min: number;
  readonly max: number;
}

export interface RuntimeMatchPolicy {
  readonly id: string;
  /** token -> 同义 token（双向匹配由 expand 统一处理）。 */
  readonly locationAliases?: Readonly<Record<string, readonly string[]>>;
  /** token -> 父级 token（子地点/子时段继承父级）。 */
  readonly locationParents?: Readonly<Record<string, readonly string[]>>;
  readonly timeAliases?: Readonly<Record<string, readonly string[]>>;
  readonly timeParents?: Readonly<Record<string, readonly string[]>>;
  /** token -> 引擎数值（eraTW: TIME:2 的 1..7）。 */
  readonly timeValues?: Readonly<Record<string, readonly number[]>>;
  /** token -> 数值区间（闭区间）。 */
  readonly timeRanges?: Readonly<Record<string, readonly RuntimeTimeRange[]>>;
}

export type RuntimeCondition =
  | { readonly kind: "location-equals"; readonly value: string }
  | { readonly kind: "time-equals"; readonly value: number }
  | { readonly kind: "time-range"; readonly min: number; readonly max: number }
  | { readonly kind: "time-raw"; readonly value: string };

export interface RuntimeBranchConditions {
  readonly location: readonly RuntimeCondition[];
  readonly time: readonly RuntimeCondition[];
}

export interface RuntimeDomainQuery {
  readonly raw: string | null;
  readonly tags?: readonly string[];
  readonly value?: number | null;
}

function edgeMap(
  map: Readonly<Record<string, readonly string[]>> | undefined,
  key: string,
): readonly string[] {
  return map?.[key] ?? [];
}

/** 展开 aliases + parents；稳定排序、去重、防环。 */
export function expandRuntimeTokens(
  raw: string,
  aliases: Readonly<Record<string, readonly string[]>> | undefined,
  parents: Readonly<Record<string, readonly string[]>> | undefined,
): readonly string[] {
  const seen = new Set<string>();
  const reverseAliases = new Map<string, string[]>();
  for (const [key, values] of Object.entries(aliases ?? {})) {
    for (const value of values) {
      const bucket = reverseAliases.get(value);
      if (bucket === undefined) reverseAliases.set(value, [key]);
      else bucket.push(key);
    }
  }
  const queue = [raw];
  while (queue.length > 0) {
    const token = queue.shift();
    if (token === undefined || seen.has(token)) continue;
    seen.add(token);
    queue.push(...edgeMap(aliases, token), ...(reverseAliases.get(token) ?? []), ...edgeMap(parents, token));
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

export function runtimeLocationTokens(policy: RuntimeMatchPolicy | null, raw: string): readonly string[] {
  return expandRuntimeTokens(raw, policy?.locationAliases, policy?.locationParents);
}

export function runtimeTimeTokens(policy: RuntimeMatchPolicy | null, raw: string): readonly string[] {
  return expandRuntimeTokens(raw, policy?.timeAliases, policy?.timeParents);
}

function collectTimeValues(policy: RuntimeMatchPolicy | null, tokens: readonly string[]): readonly number[] {
  const values = new Set<number>();
  for (const token of tokens) {
    for (const value of policy?.timeValues?.[token] ?? []) values.add(value);
  }
  return [...values].sort((a, b) => a - b);
}

function collectTimeRanges(policy: RuntimeMatchPolicy | null, tokens: readonly string[]): readonly RuntimeTimeRange[] {
  const ranges: RuntimeTimeRange[] = [];
  for (const token of tokens) {
    for (const range of policy?.timeRanges?.[token] ?? []) ranges.push(range);
  }
  return ranges;
}

function queryTokens(policy: RuntimeMatchPolicy | null, domain: "location" | "time", query: RuntimeDomainQuery): Set<string> {
  const tokens = new Set<string>();
  const expand = domain === "location"
    ? (raw: string) => runtimeLocationTokens(policy, raw)
    : (raw: string) => runtimeTimeTokens(policy, raw);
  if (query.raw !== null) for (const token of expand(query.raw)) tokens.add(token);
  for (const tag of query.tags ?? []) for (const token of expand(tag)) tokens.add(token);
  return tokens;
}

export function runtimeLocationMatches(
  policy: RuntimeMatchPolicy | null,
  theaterRaw: string,
  query: RuntimeDomainQuery,
): boolean {
  const theater = new Set(runtimeLocationTokens(policy, theaterRaw));
  const runtime = queryTokens(policy, "location", query);
  for (const token of runtime) if (theater.has(token)) return true;
  return false;
}

export function runtimeTimeMatches(
  policy: RuntimeMatchPolicy | null,
  theaterRaw: string,
  query: RuntimeDomainQuery,
): boolean {
  const theaterTokens = runtimeTimeTokens(policy, theaterRaw);
  const runtime = queryTokens(policy, "time", query);
  for (const token of runtime) if (theaterTokens.includes(token)) return true;
  const numeric = query.value ?? null;
  if (numeric === null) return false;
  if (collectTimeValues(policy, theaterTokens).includes(numeric)) return true;
  return collectTimeRanges(policy, theaterTokens).some((range) => numeric >= range.min && numeric <= range.max);
}

export function runtimeLocationConditions(policy: RuntimeMatchPolicy | null, raw: string): readonly RuntimeCondition[] {
  return runtimeLocationTokens(policy, raw).map((value) => ({ kind: "location-equals" as const, value }));
}

export function runtimeTimeConditions(policy: RuntimeMatchPolicy | null, raw: string): readonly RuntimeCondition[] {
  const tokens = runtimeTimeTokens(policy, raw);
  const values = collectTimeValues(policy, tokens);
  const ranges = collectTimeRanges(policy, tokens);
  const conditions: RuntimeCondition[] = [];
  for (const value of values) conditions.push({ kind: "time-equals", value });
  for (const range of ranges) conditions.push({ kind: "time-range", min: range.min, max: range.max });
  if (conditions.length === 0) for (const value of tokens) conditions.push({ kind: "time-raw", value });
  return conditions;
}

export function runtimeBranchConditions(
  policy: RuntimeMatchPolicy | null,
  location: { readonly kind: "unrestricted" | "exact"; readonly raw: string },
  time: { readonly kind: "unrestricted" | "named"; readonly raw: string },
): RuntimeBranchConditions {
  return {
    location: location.kind === "unrestricted" ? [] : runtimeLocationConditions(policy, location.raw),
    time: time.kind === "unrestricted" ? [] : runtimeTimeConditions(policy, time.raw),
  };
}

/** registry 校验用：只检查结构，不认识任何具体语义。 */
export function validateRuntimeMatchPolicy(policy: RuntimeMatchPolicy): readonly string[] {
  const issues: string[] = [];
  if (policy.id.trim().length === 0) issues.push("runtimeMatchPolicy.id 不能为空");
  const checkMap = (name: string, map: Readonly<Record<string, readonly string[]>> | undefined): void => {
    if (map === undefined) return;
    for (const [key, values] of Object.entries(map)) {
      if (key.length === 0) issues.push(`${name} 含空 key`);
      if (values.length === 0) issues.push(`${name}.${key} 不能为空数组`);
      for (const value of values) if (value.length === 0) issues.push(`${name}.${key} 含空 token`);
    }
  };
  checkMap("locationAliases", policy.locationAliases);
  checkMap("locationParents", policy.locationParents);
  checkMap("timeAliases", policy.timeAliases);
  checkMap("timeParents", policy.timeParents);
  for (const [key, values] of Object.entries(policy.timeValues ?? {})) {
    if (values.length === 0) issues.push(`timeValues.${key} 不能为空数组`);
    for (const value of values) if (!Number.isFinite(value)) issues.push(`timeValues.${key} 含非有限数`);
  }
  for (const [key, ranges] of Object.entries(policy.timeRanges ?? {})) {
    if (ranges.length === 0) issues.push(`timeRanges.${key} 不能为空数组`);
    for (const range of ranges) {
      if (!Number.isFinite(range.min) || !Number.isFinite(range.max)) issues.push(`timeRanges.${key} 含非有限数`);
      if (range.min > range.max) issues.push(`timeRanges.${key} 的 min > max`);
    }
  }
  return issues;
}
