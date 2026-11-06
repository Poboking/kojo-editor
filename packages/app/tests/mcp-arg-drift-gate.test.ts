/**
 * B19 · MCP 入参双向漂移机械闸
 *
 * B11×B16 相撞暴露的结构性洞：`resumeBySlice` 只写在腿里、没进 schema，严格化一落地
 * 合法调用被校验层当场拒收，而「腿取用什么」的两侧测试全绿（一边只查 schema，
 * 另一边是手抄表）。本闸把三张表接起来做**双向**对拍，任何一边多出 / 缺失都红：
 *  1. **schema 声明的 properties** ↔ **执行腿源码实际取用集**（扫描器现场扫，不手抄）；
 *  2. **B11 取用参考表 `CONSUMED`** ↔ 同一份扫描结果（参考表旧了同样红）；
 *  3. **Rust 宿主 `host_required_tier` 档位真源** ↔ mcp-host 三张契约表的 `tier`。
 *
 * 失败方式（本闸的立身之本）：
 *  - 扫描器解析不出（`unresolved` / 整只 args 交给解析不到的函数 / 面找不到执行体）⇒ 红；
 *  - 面声明了、腿不取用、又不在**逐条点名带理由**的挂账里 ⇒ 红；
 *  - 腿取用了、面没声明 ⇒ 红（严格化会挡掉合法调用）；
 *  - 挂账条目在线上不存在（面/键已消失）⇒ 红（挂账要跟着销）。
 *
 * 通路判据：声明侧用例真走 `createMcpCapabilityRegistry(...).callTool`（工具分发 +
 * `validateAgainstSchema` 校验层），不是直接调校验器；只有注入 harness 的假绿不算数。
 * 静态扫描侧则直接读**线上执行腿源码**（`LEG_CORPUS`），不碰 search 车道文件。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  KERNEL_IO_TOOL_SPECS,
  McpFailure,
  PAGE_SIZE_ARG_ALIASES,
  SEMANTIC_TOOL_SPECS,
  SUPPLEMENTAL_TOOL_SPECS,
  createMcpCapabilityRegistry,
  isMcpFailure,
  type McpHostDeps,
  type McpSessionScope,
} from '@kojo/mcp-host';
import { REPO_ROOT, inspectCorpus, scanCorpus, type ScanConfig } from './helpers/mcp-leg-arg-scan';

/* ------------------------------- 0. 在册面 ------------------------------- */

const HOST_SPECS = [...SEMANTIC_TOOL_SPECS, ...KERNEL_IO_TOOL_SPECS, ...SUPPLEMENTAL_TOOL_SPECS];
const specByName = new Map(HOST_SPECS.map((s) => [s.name, s]));

const scope: McpSessionScope = {
  sessionId: 'b19-s',
  clientId: 'b19-c',
  tier: 'privileged',
  approvedRoots: ['D:\\proj'],
  approvedTools: HOST_SPECS.filter((s) => s.tier === 'privileged').map((s) => s.name),
};

function propsOf(name: string): Record<string, unknown> {
  const spec = specByName.get(name);
  expect(spec, `${name} 必须在三张契约表里在册`).toBeDefined();
  return (spec!.inputSchema as Record<string, unknown>)['properties'] as Record<string, unknown>;
}

/** 真零参面（与 B11 同一口径，白名单现场对拍）。 */
const NO_ARG_TOOLS = ['app.dataDir', 'editor.cursor', 'project.info'] as const;

/* ------------------------------- 1. 扫描配置（逐条点名执行体） ------------------------------- */

/**
 * `new Map([...])` 派生腿表覆盖不到的面 → 显式入口（文件 + 符号），逐条点名。
 * 派生腿表覆盖到的（UI 补齐 / IO / 编辑器写 / 启动器 / 任务）**不走这里**：
 * 它们由源码里的 `new Map([['工具名', 标识符]])` 现场解析，避免第二份手抄名单。
 */
const ENTRY_OVERRIDES: Readonly<Record<string, { file: string; symbol: string }>> = {
  'semantic.definitionAt': { file: 'packages/app/src/mcp/real-sources.ts', symbol: 'definitionAt' },
  'semantic.referencesAt': { file: 'packages/app/src/mcp/real-sources.ts', symbol: 'referencesAt' },
  'semantic.diagnostics': { file: 'packages/app/src/mcp/real-sources.ts', symbol: 'diagnostics' },
  'semantic.hoverAt': { file: 'packages/app/src/mcp/real-sources.ts', symbol: 'hoverAt' },
  'semantic.suggestAt': { file: 'packages/app/src/mcp/real-sources.ts', symbol: 'suggestAt' },
  'semantic.documentSymbols': { file: 'packages/app/src/mcp/real-sources.ts', symbol: 'documentSymbols' },
  'semantic.tokens': { file: 'packages/app/src/mcp/real-sources.ts', symbol: 'tokens' },
  'semantic.codeActionsAt': { file: 'packages/app/src/mcp/real-sources.ts', symbol: 'codeActionsAt' },
  'project.info': { file: 'packages/app/src/mcp/real-sources-io.ts', symbol: 'projectInfo' },
  'fs.tree': { file: 'packages/app/src/mcp/real-sources-io.ts', symbol: 'fileTree' },
  'search.all': { file: 'packages/app/src/mcp/real-sources-io.ts', symbol: 'searchAll' },
};

/**
 * 没有执行腿的面（显式 NOT_WIRED）——逐条理由，不许整类豁免。
 * 这些面的 schema 仍保留属性是**迁移期预留契约**（旧客户端照旧可发、不会被严格化误拒）；
 * 但它们永远不会到达执行体，所以必须在这里点名，不能悄悄算「取用」。
 */
const NOT_WIRED: Readonly<Record<string, string>> = {
  'diff.compare': '无执行腿（real-sources-io default 分支显式 NOT_WIRED）；schema 属性是迁移期预留契约，暂不接线',
  'state.replay': '无执行腿（同上）；schema 属性是迁移期预留契约，暂不接线',
  'preview.document': '无执行腿（同上）；schema 属性是迁移期预留契约，暂不接线',
};

/**
 * 整只 args 交给「成员表达式」目标（`requireTaskLegs(x).start(args)`）——
 * 扫描器解析不到成员背后是哪个函数，只能逐条挂账：文件 + 锚文本 + 目标符号 + 理由。
 * 锚文本必须真命中一次；腿改道 / 符号消失 ⇒ 挂账陈旧 ⇒ 红。
 */
const HANDOFFS = [
  {
    id: 'tasks.start',
    file: 'packages/app/src/mcp/real-sources-io.ts',
    anchor: "requireTaskLegs('tasks.start').start(args ?? {}, scope)",
    targetFile: 'packages/app/src/mcp/real-sources-tasks.ts',
    targetSymbol: 'start',
    reason: '成员表达式 requireTaskLegs(...).start 解析不到目标；任务腿真源在本文件',
  },
  {
    id: 'tasks.status',
    file: 'packages/app/src/mcp/real-sources-io.ts',
    anchor: "requireTaskLegs('tasks.status').status(args ?? {}, scope)",
    targetFile: 'packages/app/src/mcp/real-sources-tasks.ts',
    targetSymbol: 'status',
    reason: '成员表达式 requireTaskLegs(...).status 解析不到目标；任务腿真源在本文件',
  },
  {
    id: 'tasks.cancel',
    file: 'packages/app/src/mcp/real-sources-io.ts',
    anchor: "requireTaskLegs('tasks.cancel').cancel(args ?? {}, scope)",
    targetFile: 'packages/app/src/mcp/real-sources-tasks.ts',
    targetSymbol: 'cancel',
    reason: '成员表达式 requireTaskLegs(...).cancel 解析不到目标；任务腿真源在本文件',
  },
] as const;

const SCAN_CONFIG: ScanConfig = {
  entries: ENTRY_OVERRIDES,
  notWired: NOT_WIRED,
  handoffs: HANDOFFS,
};

/* ------------------------------- 2. 读 B11 取用参考表（源码解析，不 import 测试文件） ------------------------------- */

const SHARED: Record<string, readonly string[]> = {
  SHARED_TEXT: [...PAGE_SIZE_ARG_ALIASES, 'cursor', 'offset'],
  SHARED_LIST: [...PAGE_SIZE_ARG_ALIASES, 'cursor'],
  SHARED_WINDOW: [...PAGE_SIZE_ARG_ALIASES, 'cursor', 'offset'],
};

/** 从 B11 测试源码里抠出纯数据对象字面量并求值（只认字符串数组 / SHARED_* 展开）。 */
function readB11Table(constName: string): Record<string, readonly string[]> {
  const src = readFileSync(resolve(REPO_ROOT, 'packages/app/tests/mcp-arg-strictness.test.ts'), 'utf8');
  const head = `const ${constName}`;
  const at = src.indexOf(head);
  expect(at, `B11 参考表 ${constName} 解析失败（源码锚不存在）`).toBeGreaterThanOrEqual(0);
  const open = src.indexOf('{', at);
  expect(open, `B11 参考表 ${constName} 的 { 解析失败`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  expect(end, `B11 参考表 ${constName} 的 } 解析失败`).toBeGreaterThan(open);
  const body = src.slice(open + 1, end);
  const out: Record<string, readonly string[]> = {};
  for (const rawLine of body.split('\n')) {
    const line = rawLine.replace(/\/\/.*$/, '').trim();
    if (!line.startsWith("'")) continue;
    const m = /^'([^']+)'\s*:\s*(.*?),\s*$/.exec(line);
    expect(m, `B11 参考表 ${constName} 有一行解析不出来：${rawLine}`).not.toBeNull();
    if (!m) continue;
    const [, key, expr] = m;
    out[key!] = evalExpr(expr!, constName);
  }
  return out;
}

function evalExpr(expr: string, table: string): string[] {
  if (expr in SHARED) return [...SHARED[expr]!];
  if (!expr.startsWith('[') || !expr.endsWith(']')) {
    throw new Error(`${table} 的 ${expr} 不是可求值形状（只认数组字面量 / SHARED_*）`);
  }
  const out: string[] = [];
  for (const part of expr.slice(1, -1).split(',')) {
    const token = part.trim();
    if (token === '') continue;
    if (token.startsWith('...')) {
      const name = token.slice(3);
      if (!(name in SHARED)) throw new Error(`${table} 的展开 ${name} 不认识`);
      out.push(...SHARED[name]!);
      continue;
    }
    const lit = /^'([^']*)'$/.exec(token);
    if (!lit) throw new Error(`${table} 的数组项 ${token} 不是字符串字面量`);
    out.push(lit[1]!);
  }
  return out;
}

const REF_CONSUMED = readB11Table('CONSUMED');
const REF_DECLARED_NOT_CONSUMED = readB11Table('DECLARED_BUT_NOT_CONSUMED');

/* ------------------------------- 3. Rust 档位真源 ------------------------------- */

/** 解析 Rust 身数组字面量：`pub const NAME: &[&str] = &[ "a", "b" ];` */
function readRustList(name: string): string[] {
  const src = readFileSync(resolve(REPO_ROOT, 'packages/app/src-tauri/src/mcp/protocol.rs'), 'utf8');
  const at = src.indexOf(`pub const ${name}`);
  expect(at, `Rust ${name} 解析失败（锚不存在）`).toBeGreaterThanOrEqual(0);
  const open = src.indexOf('&[', at);
  expect(open, `Rust ${name} 的 &[ 解析失败`).toBeGreaterThanOrEqual(0);
  const close = src.indexOf('];', open);
  expect(close, `Rust ${name} 的 ]; 解析失败`).toBeGreaterThan(open);
  return [...src.slice(open + 2, close).matchAll(/"([^"]*)"/g)].map((m) => m[1]!);
}

const PRIVILEGED_EXACT = readRustList('PRIVILEGED_EXACT');
const COMMAND_PANEL_PREFIXES = readRustList('COMMAND_PANEL_PREFIXES');
const EDIT_TOOL_PREFIXES = readRustList('EDIT_TOOL_PREFIXES');
const EDIT_TOOLS_EXACT = readRustList('EDIT_TOOLS_EXACT');

/** 与 `protocol.rs::host_required_tier` 同口径（逐支对齐，不读 WebView annotations）。 */
function rustRequiredTier(name: string): 'read' | 'edit' | 'privileged' {
  const privileged =
    name.startsWith('market_') ||
    name.startsWith('launcher_') ||
    COMMAND_PANEL_PREFIXES.some((p) => name.startsWith(p)) ||
    PRIVILEGED_EXACT.includes(name) ||
    name.startsWith('remove_');
  if (privileged) return 'privileged';
  if (EDIT_TOOLS_EXACT.includes(name)) return 'edit';
  const lower = name.toLowerCase();
  if (EDIT_TOOL_PREFIXES.some((p) => lower.startsWith(p))) return 'edit';
  return 'read';
}

/* ------------------------------- 4. 扫描 ------------------------------- */

const scan = scanCorpus(
  HOST_SPECS.map((s) => s.name),
  SCAN_CONFIG,
);
if (process.env['B19_DEBUG'] === '1') {
  // eslint-disable-next-line no-console
  console.log('SCALE', scan.faces.size, 'faces /', [...scan.faces.values()].reduce((n, f) => n + f.consumed.length, 0), '取用点');
  // eslint-disable-next-line no-console
  console.log('fileStats', scan.fileStats);
  // eslint-disable-next-line no-console
  console.log('derived', [...scan.derivedEntries.entries()].slice(0, 10));
  console.log('tables', inspectCorpus().map((f) => [f.rel, f.legTables.length]));
  const want = ['requireId', 'pageSizeOf', 'paginateByCursor', 'pageParamsFor', 'pagedMarkerReading', 'requireText'];
  for (const f of inspectCorpus()) {
    for (const d of f.defs) if (d.name && want.includes(d.name)) console.log('DEF', f.rel, d.name, JSON.stringify(d.params));
  }
}
if (process.env['B19_DEFS']) {
  const hit = inspectCorpus().find((f) => f.rel.includes(process.env['B19_DEFS']!));
  // eslint-disable-next-line no-console
  console.log('DEFS', JSON.stringify(hit?.defs.map((d) => [d.name, d.startLine])));
}
if (process.env['B19_FACE']) {
  const f = scan.faces.get(process.env['B19_FACE']);  // eslint-disable-next-line no-console
  console.log('ENTRY', f?.entry, 'CONSUMED', JSON.stringify(f?.consumed));
  // eslint-disable-next-line no-console
  console.log('SITES', JSON.stringify(f?.sites, null, 1));
}

function faceOf(name: string) {
  const face = scan.faces.get(name);
  expect(face, `${name} 没有扫描结果（无执行体或扫描器没解析到）`).toBeDefined();
  return face!;
}

/* ------------------------------- 判据 1：扫描器本身不许静默 ------------------------------- */

describe('B19 判据 1 · 扫描器必须真解析到每一枚执行腿（解析不了 ⇒ 红）', () => {
  it('每一枚在册面都有扫描结果（NOT_WIRED 除外）', () => {
    const missing = HOST_SPECS.map((s) => s.name)
      .filter((n) => !NOT_WIRED[n] && !scan.faces.has(n));
    expect(missing, `这些面扫描器没解析到执行体：${missing.join(' / ')}`).toEqual([]);
  });

  it('扫描器没有任何 unresolved / 交接失败', () => {
    const bad = [...scan.faces.values()]
      .filter((f) => f.unresolved.length > 0)
      .map((f) => `${f.face}(${f.unresolved.length})`);
    expect(bad, `扫描器解析不出这些取用形态：${bad.join(' / ')}；明细=${JSON.stringify(
      [...scan.faces.values()].flatMap((f) => f.unresolved),
      null,
      2,
    )}`).toEqual([]);
    expect(scan.problems, `扫描器问题：${scan.problems.join(' / ')}`).toEqual([]);
  });

  it('扫描规模自证（不是拿空表跑出来的绿）', () => {
    expect(scan.faces.size).toBeGreaterThanOrEqual(HOST_SPECS.length - Object.keys(NOT_WIRED).length);
    const totalKeys = [...scan.faces.values()].reduce((n, f) => n + f.consumed.length, 0);
    expect(totalKeys).toBeGreaterThan(250);
  });
});

/* ------------------------------- 判据 2：schema ↔ 腿（双向） ------------------------------- */

/** 声明了、腿确实不取用的逐条挂账（理由逐条；禁止整类豁免）。 */
const DECLARED_NOT_CONSUMED: Readonly<Record<string, readonly string[]>> = {
  ...REF_DECLARED_NOT_CONSUMED,
  // 无执行腿面的全部声明：理由已在 NOT_WIRED 里逐条写死
  'diff.compare': ['mode', 'left', 'right'],
  'state.replay': ['step', 'maxEvents'],
  'preview.document': ['relPath', 'maxLines'],
};

describe('B19 判据 2 · schema 声明 ↔ 执行腿取用（任何一边多出 / 缺失都红）', () => {
  it('腿取用了、schema 没声明 ⇒ 红（严格化会挡掉合法调用）', () => {
    const missing: string[] = [];
    for (const spec of HOST_SPECS) {
      if (NOT_WIRED[spec.name]) continue;
      const face = faceOf(spec.name);
      const declared = Object.keys(propsOf(spec.name));
      for (const key of face.consumed) {
        if (!declared.includes(key)) missing.push(`${spec.name}.${key}`);
      }
    }
    expect(missing, `这些腿取用名不在 schema 里：${missing.join(' / ')}`).toEqual([]);
  });

  it('schema 声明了、腿不取用 ⇒ 必须在逐条挂账里，且挂账条目必须真实存在', () => {
    const undeclared: string[] = [];
    for (const spec of HOST_SPECS) {
      const declared = Object.keys(propsOf(spec.name));
      const consumed = new Set(NOT_WIRED[spec.name] ? [] : faceOf(spec.name).consumed);
      const ledger = new Set(DECLARED_NOT_CONSUMED[spec.name] ?? []);
      for (const key of declared) {
        if (!consumed.has(key) && !ledger.has(key)) undeclared.push(`${spec.name}.${key}`);
      }
    }
    expect(undeclared, `这些声明在册、腿不取用，且没有逐条理由：${undeclared.join(' / ')}`).toEqual([]);

    for (const [name, keys] of Object.entries(DECLARED_NOT_CONSUMED)) {
      const spec = specByName.get(name);
      expect(spec, `挂账面 ${name} 已不在册（残项）`).toBeDefined();
      const declared = Object.keys(propsOf(name));
      for (const key of keys) {
        expect(declared, `${name}.${key} 挂账了但声明里没有（残项）`).toContain(key);
        if (!NOT_WIRED[name]) {
          expect(faceOf(name).consumed, `${name}.${key} 腿已经取用了（挂账应销）`).not.toContain(key);
        }
      }
    }
  });

  it('零参面与零参腿双向对齐', () => {
    const actuallyNoArg = HOST_SPECS.filter((s) => Object.keys(propsOf(s.name)).length === 0).map((s) => s.name).sort();
    expect(actuallyNoArg).toEqual([...NO_ARG_TOOLS].sort());
  });
});

/* ------------------------------- 判据 3：B11 取用参考表 ↔ 扫描（表旧了也红） ------------------------------- */

describe('B19 判据 3 · B11 手抄取用表必须与源码扫描逐面相等', () => {
  it('参考表逐面与扫描结果双向相等', () => {
    const mismatches: string[] = [];
    const names = new Set([...scan.faces.keys(), ...Object.keys(REF_CONSUMED)]);
    for (const name of names) {
      if (NOT_WIRED[name]) continue;
      const scanned = [...(scan.faces.get(name)?.consumed ?? [])].sort();
      const table = [...(REF_CONSUMED[name] ?? [])].sort();
      const missed = scanned.filter((k) => !table.includes(k));
      const stale = table.filter((k) => !scanned.includes(k));
      if (missed.length || stale.length) {
        mismatches.push(
          `${name}: 扫描多出 [${missed.join(', ')}] / 参考表多出 [${stale.join(', ')}]`,
        );
      }
    }
    expect(mismatches, `B11 取用表与源码漂移：\n${mismatches.join('\n')}`).toEqual([]);
  });

  it('三张契约表的面在参考表里一个不少', () => {
    const absent = HOST_SPECS.map((s) => s.name).filter((n) => !(n in REF_CONSUMED));
    expect(absent, `B11 参考表缺这些面：${absent.join(' / ')}`).toEqual([]);
  });
});

/* ------------------------------- 判据 4：档位真源（Rust ↔ mcp-host tier） ------------------------------- */

describe('B19 判据 4 · 工具档位与 Rust host_required_tier 同源', () => {
  it('三张契约表逐面档位与 Rust 一致', () => {
    const drift: string[] = [];
    for (const spec of HOST_SPECS) {
      const rust = rustRequiredTier(spec.name);
      const mcp = spec.tier ?? 'read';
      if (rust !== mcp) drift.push(`${spec.name}: WebView=${mcp} / Rust=${rust}`);
    }
    expect(drift, `档位漂移：${drift.join(' / ')}`).toEqual([]);
  });
});

/* ------------------------------- 判据 5：真走注册表 / tools-call 的通路 ------------------------------- */

/**
 * 声明属性 ⇒ 合法样例值（判据 5 真走 `callTool`，所以样例值必须**过得了校验层**）。
 * 逐支按 `enum / type / pattern / minLength+maxLength / minimum+maximum / items / properties+required` 递推；
 * 造不出合法值的属性**点名进 failures**（＝挂账可见），绝不许「这一枚跳过」。
 * pattern 用运行时真值当场验（不抄源码字面量，避免转义口径漂移）：候选池里没有能过闸的值 ⇒ 红。
 */
const STRING_CANDIDATES = [
  'x', 'a.txt', 'dir/a.md', 'ws:0123abcd', '0123abcd:1', 'inst-1', 'pack.1', 'plan-1', 'task-1', 'utf-8', 'outline',
];

type Sample = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly reason: string };

function sampleString(schema: Record<string, unknown>): Sample {
  const pattern = typeof schema['pattern'] === 'string' ? schema['pattern'] : null;
  const min = typeof schema['minLength'] === 'number' ? schema['minLength'] : 0;
  const max = typeof schema['maxLength'] === 'number' ? schema['maxLength'] : Number.POSITIVE_INFINITY;
  let re: RegExp | null = null;
  try {
    re = pattern ? new RegExp(pattern) : null;
  } catch (err) {
    return { ok: false, reason: `pattern 无法编译：${pattern}（${String(err)}）` };
  }
  for (const c of STRING_CANDIDATES) {
    if (c.length < min || c.length > max) continue;
    if (re && !re.test(c)) continue;
    return { ok: true, value: c };
  }
  return { ok: false, reason: `候选串池过不了这道形状闸（minLength=${min} maxLength=${max} pattern=${pattern ?? '无'}）` };
}

function sampleNumber(schema: Record<string, unknown>): Sample {
  const min = typeof schema['minimum'] === 'number' ? schema['minimum'] : null;
  const max = typeof schema['maximum'] === 'number' ? schema['maximum'] : null;
  const exclusiveMin = typeof schema['exclusiveMinimum'] === 'number' ? schema['exclusiveMinimum'] : null;
  const low = Math.max(min ?? Number.NEGATIVE_INFINITY, exclusiveMin === null ? Number.NEGATIVE_INFINITY : exclusiveMin + 1);
  const isInt = schema['type'] === 'integer';
  const pick = (n: number): unknown => (isInt ? Math.trunc(n) : n);
  const cands = Number.isFinite(low) ? [low, low + 1] : [1, 0];
  for (const c of cands) {
    const v = pick(c);
    if (typeof v !== 'number') continue;
    if (max !== null && v > max) continue;
    if (min !== null && v < min) continue;
    if (exclusiveMin !== null && v <= exclusiveMin) continue;
    if (isInt && !Number.isInteger(v)) continue;
    return { ok: true, value: v };
  }
  return { ok: false, reason: `数值范围取不出整数/有限值（minimum=${min ?? '-'} maximum=${max ?? '-'}）` };
}

function sampleValue(key: string, schema: Record<string, unknown>, depth = 0): Sample {
  if (depth > 3) return { ok: false, reason: `嵌套超过 3 层（${key}）` };
  const enumValues = schema['enum'];
  if (Array.isArray(enumValues) && enumValues.length > 0) return { ok: true, value: enumValues[0] };
  const type = schema['type'];
  if (type === 'string') return sampleString(schema);
  if (type === 'number' || type === 'integer') return sampleNumber(schema);
  if (type === 'boolean') return { ok: true, value: true };
  if (type === 'array') {
    const items = schema['items'] as Record<string, unknown> | undefined;
    const minItems = typeof schema['minItems'] === 'number' ? schema['minItems'] : 0;
    const count = Math.max(1, minItems);
    if (!items) return { ok: true, value: [] };
    const one = sampleValue(`${key}[]`, items, depth + 1);
    if (!one.ok) return { ok: false, reason: `数组项 ${key}[]：${one.reason}` };
    const maxItems = typeof schema['maxItems'] === 'number' ? schema['maxItems'] : count;
    return { ok: true, value: Array.from({ length: Math.min(count, Math.max(maxItems, 1)) }, () => one.value) };
  }
  if (type === 'object' || schema['properties']) {
    const props = (schema['properties'] ?? {}) as Record<string, unknown>;
    const required = (schema['required'] as string[] | undefined) ?? Object.keys(props);
    const out: Record<string, unknown> = {};
    for (const k of required) {
      const sub = props[k];
      if (!sub) return { ok: false, reason: `${key} 的必填子字段 ${k} 没形状声明` };
      const s = sampleValue(k, sub as Record<string, unknown>, depth + 1);
      if (!s.ok) return { ok: false, reason: `${key}.${k}：${s.reason}` };
      out[k] = s.value;
    }
    return { ok: true, value: out };
  }
  return { ok: false, reason: `${key} 没有可判定的 type（type=${String(type)}）` };
}

/** 每个面一条最小合法入参：required 全填（造不出就点名，不静默省略）。 */
function requiredArgsFor(spec: (typeof HOST_SPECS)[number], failures: string[]): Record<string, unknown> {
  const schema = spec.inputSchema as Record<string, unknown>;
  const props = (schema['properties'] ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of (schema['required'] as string[] | undefined) ?? []) {
    const s = sampleValue(key, props[key] as Record<string, unknown>);
    if (!s.ok) {
      failures.push(`${spec.name}.!(required ${key})：造不出合法样例值——${s.reason}`);
      continue;
    }
    out[key] = s.value;
  }
  return out;
}

/** 假腿只把入参原样带回：用于证明「校验层放行 + 分发真的到了腿」，不是替腿判绿。 */
function stubRegistry(): { registry: ReturnType<typeof createMcpCapabilityRegistry>; calls: Map<string, unknown> } {
  const calls = new Map<string, unknown>();
  const echo = (name: string) => (args: Record<string, unknown>) => {
    calls.set(name, args);
    return { tool: name, args };
  };
  const semantic: Record<string, unknown> = {};
  for (const m of ['definitionAt', 'referencesAt', 'diagnostics', 'hoverAt', 'suggestAt', 'documentSymbols', 'tokens', 'codeActionsAt']) {
    semantic[m] = echo(`semantic.${m}`);
  }
  const kernelIo = {
    projectInfo: echo('project.info'),
    fileTree: echo('fs.tree'),
    searchAll: echo('search.all'),
  };
  const deps: McpHostDeps = {
    semantic: semantic as McpHostDeps['semantic'],
    kernelIo,
    runSupplemental: (name, args) => {
      calls.set(name, args);
      return { tool: name, args };
    },
  };
  return { registry: createMcpCapabilityRegistry(deps), calls };
}

describe('B19 判据 5 · 声明属性真走 tools/call 校验层（不是直调校验器）', () => {
  const { registry, calls } = stubRegistry();

  it('每一枚带参面的每一条声明属性都能穿过校验层并分发到腿', async () => {
    const failures: string[] = [];
    for (const spec of HOST_SPECS) {
      const props = propsOf(spec.name);
      const base = requiredArgsFor(spec, failures);
      // required 组合本身先过一次闸：不干净的话，逐枚属性的失败会假指到被测试的那一枚上
      const baseErr = await registry.callTool(spec.name, base, scope).catch((e: unknown) => e);
      if (isMcpFailure(baseErr) && baseErr.code === 'INVALID_ARGS') {
        failures.push(`${spec.name}.!(required 组合): ${baseErr.message}`);
      }
      for (const key of Object.keys(props)) {
        const s = sampleValue(key, props[key] as Record<string, unknown>);
        if (!s.ok) {
          failures.push(`${spec.name}.${key}: 造不出合法样例值——${s.reason}（不许跳过，要么扩候选池要么接腿）`);
          continue;
        }
        const args = { ...base, [key]: s.value };
        try {
          await registry.callTool(spec.name, args, scope);
        } catch (err) {
          if (isMcpFailure(err) && err.code === 'INVALID_ARGS') {
            failures.push(`${spec.name}.${key}: ${err.message}`);
          }
        }
      }
    }
    expect(failures, `这些合法声明被校验层挡住：\n${failures.join('\n')}`).toEqual([]);
  });

  it('B16 漂移回归：resumeBySlice 真走 tools/call 到腿', async () => {
    await registry.callTool('search.all', { query: 'x', resumeBySlice: true }, scope);
    expect(calls.get('search.all'), 'search.all 未分发到腿').toMatchObject({ query: 'x', resumeBySlice: true });
    await registry.callTool('workspace.searchAll', { query: 'x', resumeBySlice: true }, scope);
    expect(calls.get('workspace.searchAll'), 'workspace.searchAll 未分发到腿').toMatchObject({
      query: 'x',
      resumeBySlice: true,
    });
  });

  it('严格化闸没被本批放松：未知键仍 INVALID_ARGS', async () => {
    const err = await registry.callTool('search.all', { query: 'x', corridor: 'x' }, scope).catch((e: unknown) => e);
    expect(isMcpFailure(err), '未知键必须被校验层拒绝').toBe(true);
    expect((err as McpFailure).code).toBe('INVALID_ARGS');
  });
});
