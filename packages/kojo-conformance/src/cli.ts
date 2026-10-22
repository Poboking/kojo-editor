/**
 * conformance CLI · 纯逻辑入口（零 `process.exit`、零 `node:fs`、零宿主）。
 *
 * 定位（设计稿 §16.9 K8.2 / K8.3）：
 * - `runConformanceCli(argv, deps)` 只做 argv 解析 + 用例编排 + 报告组装，**返回**退出码；
 *   谁调用谁决定怎么退出（`src/main.ts` 薄壳读 `process.argv`、落 `process.exitCode`）。
 * - 目录遍历与文件读取全部经注入的 `ConformanceIoPort`（`{ readText, listFiles }`），
 *   因此本模块可在 vitest 里用内存 IO 完整覆盖，不需要真盘。
 * - 失败不静默：每条失败都带稳定 `code` + `case` + `file` + `sourceLine`，
 *   golden / differential 另附逐行 diff；不存在 warning 降级通道。
 *
 * 目录约定（`check --dir`）：
 * - 目录内每个 `*.kojo2` 逐文件编译；
 * - 同名 `<文件>.golden.erb` 存在 → golden 逐字节对拍（基线先剥 UTF-8 BOM：BOM 属于
 *   encoding 面，不参与 golden 字节）；
 * - 同名 `<文件>.erb` 存在 → differential 行为序列对拍（BOM/EOL/整行注释由 kit 归一化）；
 * - 每个文件都跑 encoding/EOL 取证（源文本形状 ⇄ 契约编码 round-trip、EOL/BOM 不变性）。
 */
import type { GameAdapter, KojoDiagnostic, KojoEmitBackend, TextEncoding } from '@kojo/kojo-core';
import type { ArtifactLineDiff } from './differential.js';
import type { ConformanceEol } from './encoding.js';
import { detectEol, encodeConformanceTextPreservingEol } from './encoding.js';
import type {
  AdapterConformanceCase,
  ConformanceCaseReport,
  ConformanceCheck,
  ConformanceCheckSummary,
  ConformanceFailure,
  ConformanceFailureCode,
} from './kit.js';
import { runAdapterConformance } from './kit.js';
import { BUILTIN_CONFORMANCE_CASES, builtinConformanceCases } from './suite.js';

/* ============================== 1. 公共形状 ============================== */

/** 注入的 IO 端口：只给文本 + 文件清单，不给字节；目录读取不碰宿主 API */
export interface ConformanceIoPort {
  /** 读一段 UTF-8 文本；不存在/不可读时抛错（CLI 会把它记成 conformance/input 失败） */
  readonly readText: (path: string) => string;
  /** 列目录下的文件（**相对路径**，分隔符可 `/` 或 `\`）；不存在时抛错 */
  readonly listFiles: (dir: string) => readonly string[];
}

/** 一个可被 `--adapter` 选中的 adapter + 它的产物 backend */
export interface ConformanceAdapterRegistration {
  readonly adapter: GameAdapter;
  readonly backend: KojoEmitBackend;
}

/** CLI 依赖：IO 端口 + adapter 注册表 + 可选默认值；测试全部注入 */
export interface ConformanceCliDeps {
  readonly io: ConformanceIoPort;
  readonly adapters: Readonly<Record<string, ConformanceAdapterRegistration>>;
  /** 未显式给 `--adapter` 时用哪个已注册 adapter（默认 `fixture`） */
  readonly defaultAdapter?: string;
  /** 覆盖内建用例（默认 `suite.ts` 的三条；测试可注入自己的） */
  readonly builtinCases?: readonly AdapterConformanceCase[];
}

/** CLI 自己产生的失败用 `cli` 归类；kit 的失败保留原 check */
export type ConformanceCliCheck = ConformanceCheck | 'cli';

/** 单文件报告：路径 / 源形状 / 产物读数 / 该文件跑了哪些用例 */
export interface ConformanceCliFileReport {
  readonly path: string;
  readonly ok: boolean;
  readonly source: {
    readonly utf8Bytes: number;
    readonly eol: ConformanceEol;
    readonly bom: boolean;
  } | null;
  readonly artifact: {
    readonly utf8Bytes: number;
    readonly lines: number;
  } | null;
  readonly cases: readonly string[];
}

/** 单用例报告；`ok === null` 只出现在 `list-cases`（列出但未执行） */
export interface ConformanceCliCaseReport {
  readonly name: string;
  readonly kind: AdapterConformanceCase['kind'];
  readonly file: string | null;
  readonly ok: boolean | null;
  readonly failures: number;
  readonly description: string | null;
}

/**
 * 一条失败：`code` / `case` / `file` / `sourceLine` 是硬要求（CLI 报告消费方按这四格定位），
 * 其余字段保留 kit 的证据（diff / diagnostics）与可读上下文。
 */
export interface ConformanceCliFailure {
  readonly code: ConformanceFailureCode;
  readonly case: string;
  readonly file: string | null;
  readonly sourceLine: number | null;
  readonly check: ConformanceCliCheck;
  readonly field: string;
  readonly artifactLine: number | null;
  readonly message: string;
  readonly expected: string | null;
  readonly actual: string | null;
  readonly diff: readonly ArtifactLineDiff[];
  readonly diagnostics: readonly KojoDiagnostic[];
}

/** 汇总读数：契约、各检查面计数、源/产物体量（全部确定性，无计时） */
export interface ConformanceCliReadings {
  readonly contract: {
    readonly ok: boolean;
    readonly adapterId: string;
    readonly backendId: string;
    readonly events: number;
    readonly diagnostics: number;
  } | null;
  readonly byCheck: readonly ConformanceCheckSummary[];
  readonly source: {
    readonly files: number;
    readonly utf8Bytes: number;
    readonly eol: {
      readonly crlf: number;
      readonly lf: number;
      readonly mixed: number;
      readonly none: number;
    };
    readonly bom: number;
  };
  readonly artifact: {
    readonly utf8Bytes: number;
    readonly lines: number;
  };
}

/** 机器可读报告：顶层字段序**固定**为 adapter / files / cases / failures / readings / usage */
export interface ConformanceCliReport {
  readonly adapter: string;
  readonly files: readonly ConformanceCliFileReport[];
  readonly cases: readonly ConformanceCliCaseReport[];
  readonly failures: readonly ConformanceCliFailure[];
  readonly readings: ConformanceCliReadings;
  /** 非 null = 用法/帮助文本（exit 2 或 help）；`--json` 对它不生效 */
  readonly usage: string | null;
}

/** `runConformanceCli` 的返回值：退出码由调用方使用，本模块从不调用 `process.exit` */
export interface ConformanceCliResult {
  readonly exitCode: 0 | 1 | 2;
  readonly report: ConformanceCliReport;
}

export const CONFORMANCE_CLI_USAGE = [
  '用法:',
  '  kojo-conformance check --dir <目录> --adapter <名称> [--json]',
  '  kojo-conformance check --golden <源.kojo2>:<产物.erb> [--adapter <名称>] [--json]',
  '  kojo-conformance check --suite [--adapter <名称>] [--json]',
  '  kojo-conformance language [--adapter <名称>] [--dir <fixture 目录>] [--json]',
  '  kojo-conformance list-cases [--adapter <名称>] [--json]',
  '  kojo-conformance help',
  '',
  '目录约定:',
  '  <目录> 内 *.kojo2 逐文件编译；同名 <文件>.golden.erb 走 golden 逐字节对拍，',
  '  同名 <文件>.erb 走 differential 行为序列对拍；每个文件都跑 encoding/EOL 取证。',
  '',
  'language 子命令 = 语言面全语法套件（§16.2 C2.13）：',
  '  fixture 目录默认 packages/kojo-conformance/tests/fixtures/language；',
  '  <case>.golden.erb 逐字节 / <case>.diagnostics.json 诊断快照；--adapter 见 language help。',
  '',
  '退出码: 0 全绿 / 1 有失败 / 2 用法错误',
].join('\n');

/* ============================== 2. 内部形状 ============================== */

type CliCommand = 'check' | 'list-cases' | 'help';

interface ParsedArgs {
  readonly command: CliCommand | null;
  readonly json: boolean;
  readonly adapter: string | null;
  readonly dir: string | null;
  readonly golden: string | null;
  readonly suite: boolean;
  readonly error: string | null;
}

/** 单文件的构建期读数（kit 跑完后才拿到产物体量） */
interface FileMeta {
  readonly path: string;
  readonly sourceText: string | null;
}

interface FinishInput {
  readonly adapterName: string;
  readonly registration: ConformanceAdapterRegistration;
  readonly cases: readonly AdapterConformanceCase[];
  readonly caseFiles: ReadonlyMap<string, string>;
  readonly metas: readonly FileMeta[];
  readonly preFailures: readonly ConformanceCliFailure[];
}

interface GoldenPair {
  readonly source: string;
  readonly artifact: string;
}

/* ============================== 3. 纯工具 ============================== */

function cmpText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emptyReadings(): ConformanceCliReadings {
  return {
    contract: null,
    byCheck: [],
    source: { files: 0, utf8Bytes: 0, eol: { crlf: 0, lf: 0, mixed: 0, none: 0 }, bom: 0 },
    artifact: { utf8Bytes: 0, lines: 0 },
  };
}

function emptyReport(adapter: string, usage: string | null): ConformanceCliReport {
  return { adapter, files: [], cases: [], failures: [], readings: emptyReadings(), usage };
}

function usageResult(reason: string, adapter = ''): ConformanceCliResult {
  return {
    exitCode: 2,
    report: emptyReport(adapter, `${CONFORMANCE_CLI_USAGE}\n\n错误：${reason}`),
  };
}

function helpResult(): ConformanceCliResult {
  return { exitCode: 0, report: emptyReport('', CONFORMANCE_CLI_USAGE) };
}

function registeredAdapterNames(deps: ConformanceCliDeps): string {
  const names = Object.keys(deps.adapters).sort(cmpText);
  return names.length === 0 ? '(无)' : names.join(', ');
}

function resolveAdapter(
  deps: ConformanceCliDeps,
  name: string,
): { readonly ok: true; readonly name: string; readonly registration: ConformanceAdapterRegistration } | { readonly ok: false; readonly reason: string } {
  const registration = deps.adapters[name];
  if (registration === undefined) {
    return { ok: false, reason: `未知 adapter：${name}（已注册：${registeredAdapterNames(deps)}）` };
  }
  return { ok: true, name, registration };
}

/** 统一分隔符：CLI 只做字符串拼接，不 import `node:path`（纯逻辑可跨宿主） */
function normalizeDir(dir: string): string {
  const slashed = dir.replaceAll('\\', '/');
  if (slashed === '/' || slashed === '') return slashed;
  return slashed.replace(/\/+$/, '');
}

function normalizeRelPath(entry: string): string {
  let value = entry.replaceAll('\\', '/');
  while (value.startsWith('./')) value = value.slice(2);
  while (value.startsWith('/')) value = value.slice(1);
  return value;
}

function joinPath(dir: string, rel: string): string {
  if (dir === '' || dir === '.') return rel;
  if (dir === '/') return `/${rel}`;
  return `${dir}/${rel}`;
}

/** `a/b.kojo2` + `.golden.erb` → `a/b.golden.erb`；只认 `.kojo2` 结尾（调用方已过滤） */
function sidecarPath(rel: string, suffix: string): string {
  return `${rel.slice(0, rel.length - '.kojo2'.length)}${suffix}`;
}

function hasBom(text: string): boolean {
  return text.charCodeAt(0) === 0xfeff;
}

function stripLeadingBom(text: string): string {
  return hasBom(text) ? text.slice(1) : text;
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** 文本 → 契约编码字节（BOM 由编码自带，文本里的 BOM 先剥掉，避免双 BOM） */
function encodeSourceText(text: string): { readonly bytes: Uint8Array; readonly encoding: TextEncoding } {
  const bom = hasBom(text);
  const body = bom ? text.slice(1) : text;
  return {
    bytes: encodeConformanceTextPreservingEol(body, bom ? 'utf-8-bom' : 'utf-8'),
    encoding: bom ? 'utf-8-bom' : 'utf-8',
  };
}

/**
 * `--golden` 的 `<源>:<产物>` 切分。
 *
 * Windows 盘符（`C:\...`）里的冒号不算分隔符：索引 1、前一个字符是字母、后一个字符是
 * 路径分隔符时跳过。其余第一个冒号即分隔符；两侧都不许为空。
 */
export function splitGoldenPair(spec: string): GoldenPair | null {
  for (let i = 0; i < spec.length; i++) {
    if (spec.charAt(i) !== ':') continue;
    const next = spec.charAt(i + 1);
    if (i === 1 && /[A-Za-z]/.test(spec.charAt(0)) && (next === '\\' || next === '/')) continue;
    const source = spec.slice(0, i);
    const artifact = spec.slice(i + 1);
    if (source.length === 0 || artifact.length === 0) return null;
    return { source, artifact };
  }
  return null;
}

function cliFailure(input: {
  readonly code: ConformanceFailureCode;
  readonly check: ConformanceCliCheck;
  readonly case: string;
  readonly file: string | null;
  readonly sourceLine?: number | null;
  readonly field?: string;
  readonly message: string;
  readonly expected?: string | null;
  readonly actual?: string | null;
}): ConformanceCliFailure {
  return {
    code: input.code,
    case: input.case,
    file: input.file,
    sourceLine: input.sourceLine ?? null,
    check: input.check,
    field: input.field ?? '',
    artifactLine: null,
    message: input.message,
    expected: input.expected ?? null,
    actual: input.actual ?? null,
    diff: Object.freeze([]),
    diagnostics: Object.freeze([]),
  };
}

function mapFailure(failure: ConformanceFailure, caseFiles: ReadonlyMap<string, string>): ConformanceCliFailure {
  return {
    code: failure.code,
    case: failure.case,
    file: caseFiles.get(failure.case) ?? null,
    sourceLine: failure.location.sourceLine,
    check: failure.check,
    field: failure.location.field,
    artifactLine: failure.location.artifactLine,
    message: failure.message,
    expected: failure.expected,
    actual: failure.actual,
    diff: failure.diff,
    diagnostics: failure.diagnostics,
  };
}

/* ============================== 4. argv 解析 ============================== */

function isValueToken(token: string | undefined): token is string {
  return token !== undefined && token.length > 0 && !token.startsWith('--');
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const first = argv[0];
  if (first === 'help' || argv.includes('--help') || argv.includes('-h')) {
    return { command: 'help', json: argv.includes('--json'), adapter: null, dir: null, golden: null, suite: false, error: null };
  }

  let command: CliCommand | null = null;
  let json = false;
  let adapter: string | null = null;
  let dir: string | null = null;
  let golden: string | null = null;
  let suite = false;
  let error: string | null = null;
  const fail = (message: string): void => {
    if (error === null) error = message;
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] ?? '';
    if (token === '') {
      fail('空参数');
      continue;
    }
    if (token === '--json') {
      if (json) fail('重复参数：--json');
      json = true;
      continue;
    }
    if (token === '--suite') {
      if (suite) fail('重复参数：--suite');
      suite = true;
      continue;
    }
    if (token === '--adapter' || token === '--dir' || token === '--golden') {
      const value = argv[i + 1];
      if (!isValueToken(value)) {
        fail(`缺少 ${token} 的值`);
        continue;
      }
      i++;
      if (token === '--adapter') {
        if (adapter !== null) fail('重复参数：--adapter');
        else adapter = value;
      } else if (token === '--dir') {
        if (dir !== null) fail('重复参数：--dir');
        else if (value.trim().length === 0) fail('--dir 的值不能为空');
        else dir = value;
      } else {
        if (golden !== null) fail('重复参数：--golden');
        else golden = value;
      }
      continue;
    }
    if (token.startsWith('-')) {
      fail(`未知参数：${token}`);
      continue;
    }
    if (command === null) {
      if (token === 'check' || token === 'list-cases') command = token;
      else fail(`未知命令：${token}`);
    } else {
      fail(`多余的位置参数：${token}`);
    }
  }

  return { command, json, adapter, dir, golden, suite, error };
}

/* ============================== 5. 报告组装 ============================== */

function finishResult(input: FinishInput): ConformanceCliResult {
  const report = runAdapterConformance({
    adapter: input.registration.adapter,
    backend: input.registration.backend,
    cases: input.cases,
  });

  const caseReports = report.cases.map((item: ConformanceCaseReport) => ({
    name: item.name,
    kind: item.kind,
    file: input.caseFiles.get(item.name) ?? null,
    ok: item.ok,
    failures: item.failures.length,
    description: null,
  }));

  const failures = [...input.preFailures, ...report.failures.map((item) => mapFailure(item, input.caseFiles))];
  const fileRank = new Map<string, number>();
  input.metas.forEach((meta, index) => fileRank.set(meta.path, index));
  const rankOf = (file: string | null): number => (file === null ? -1 : fileRank.get(file) ?? Number.MAX_SAFE_INTEGER);
  failures.sort(
    (left, right) =>
      rankOf(left.file) - rankOf(right.file) ||
      cmpText(left.case, right.case) ||
      cmpText(left.code, right.code) ||
      (left.sourceLine ?? -1) - (right.sourceLine ?? -1) ||
      cmpText(left.message, right.message),
  );

  const casesByFile = new Map<string, ConformanceCaseReport[]>();
  for (const item of report.cases) {
    const file = input.caseFiles.get(item.name);
    if (file === undefined) continue;
    const bucket = casesByFile.get(file);
    if (bucket === undefined) casesByFile.set(file, [item]);
    else bucket.push(item);
  }

  let sourceBytes = 0;
  let bomFiles = 0;
  const eol = { crlf: 0, lf: 0, mixed: 0, none: 0 };
  const files: ConformanceCliFileReport[] = input.metas.map((meta) => {
    const related = casesByFile.get(meta.path) ?? [];
    const firstCase = related[0];
    const text = meta.sourceText;
    let source: ConformanceCliFileReport['source'] = null;
    if (text !== null) {
      const detected = detectEol(text);
      const bytes = utf8Length(text);
      const bom = hasBom(text);
      eol[detected]++;
      sourceBytes += bytes;
      if (bom) bomFiles++;
      source = { utf8Bytes: bytes, eol: detected, bom };
    }
    const artifact =
      firstCase === undefined
        ? null
        : {
            utf8Bytes: firstCase.observations.erbBytes ?? 0,
            lines: firstCase.observations.readings?.artifactLines ?? 0,
          };
    const fileFailures = failures.filter((failure) => failure.file === meta.path);
    return {
      path: meta.path,
      ok: fileFailures.length === 0 && related.every((item) => item.ok),
      source,
      artifact,
      cases: related.map((item) => item.name),
    };
  });

  const artifact = files.reduce(
    (sum, file) => ({
      utf8Bytes: sum.utf8Bytes + (file.artifact?.utf8Bytes ?? 0),
      lines: sum.lines + (file.artifact?.lines ?? 0),
    }),
    { utf8Bytes: 0, lines: 0 },
  );

  const readings: ConformanceCliReadings = {
    contract: {
      ok: report.contract.ok,
      adapterId: report.contract.adapterId,
      backendId: report.contract.backendId,
      events: report.contract.events.length,
      diagnostics: report.contract.diagnostics.length,
    },
    byCheck: report.summary.byCheck,
    source: { files: input.metas.length, utf8Bytes: sourceBytes, eol, bom: bomFiles },
    artifact,
  };

  return {
    exitCode: failures.length === 0 ? 0 : 1,
    report: {
      adapter: input.adapterName,
      files,
      cases: caseReports,
      failures,
      readings,
      usage: null,
    },
  };
}

/* ============================== 6. check --dir ============================== */

function runDirCheck(dirArg: string, adapterName: string, registration: ConformanceAdapterRegistration, deps: ConformanceCliDeps): ConformanceCliResult {
  const dir = normalizeDir(dirArg);
  let entries: readonly string[];
  try {
    entries = deps.io.listFiles(dir);
  } catch (error: unknown) {
    return {
      exitCode: 1,
      report: {
        adapter: adapterName,
        files: [],
        cases: [],
        failures: [
          cliFailure({
            code: 'conformance/input',
            check: 'cli',
            case: '(io)',
            file: dir,
            field: 'dir',
            message: `无法列出目录 ${dir}：${errorMessage(error)}`,
          }),
        ],
        readings: emptyReadings(),
        usage: null,
      },
    };
  }

  const normalized = [...new Set(entries.map(normalizeRelPath).filter((entry) => entry.length > 0))].sort(cmpText);
  const entrySet = new Set(normalized);
  const sources = normalized.filter((entry) => entry.endsWith('.kojo2'));

  const cases: AdapterConformanceCase[] = [];
  const caseFiles = new Map<string, string>();
  const metas: FileMeta[] = [];
  const preFailures: ConformanceCliFailure[] = [];

  for (const rel of sources) {
    const sourcePath = joinPath(dir, rel);
    let sourceText: string;
    try {
      sourceText = deps.io.readText(sourcePath);
    } catch (error: unknown) {
      preFailures.push(
        cliFailure({
          code: 'conformance/input',
          check: 'cli',
          case: rel,
          file: rel,
          field: 'source',
          message: `无法读取源文件 ${sourcePath}：${errorMessage(error)}`,
        }),
      );
      metas.push({ path: rel, sourceText: null });
      continue;
    }

    metas.push({ path: rel, sourceText });

    if (sourceText.includes('\u0000')) {
      preFailures.push(
        cliFailure({
          code: 'conformance/encoding',
          check: 'encoding',
          case: `${rel}:encoding`,
          file: rel,
          field: 'source',
          message:
            '源文本含 NUL：IO 端口只提供文本，无法取证 UTF-16/二进制编码；' +
            '请先用 UTF-8 保存该文件，或改用字节级 IO 的调用方。',
        }),
      );
      continue;
    }

    const addCase = (testCase: AdapterConformanceCase): void => {
      cases.push(testCase);
      caseFiles.set(testCase.name, rel);
    };

    const goldenRel = sidecarPath(rel, '.golden.erb');
    if (entrySet.has(goldenRel)) {
      try {
        const expectedErb = stripLeadingBom(deps.io.readText(joinPath(dir, goldenRel)));
        addCase({ kind: 'golden', name: `${rel}:golden`, source: sourceText, expectedErb });
      } catch (error: unknown) {
        preFailures.push(
          cliFailure({
            code: 'conformance/input',
            check: 'cli',
            case: `${rel}:golden`,
            file: rel,
            field: 'expectedErb',
            message: `无法读取 golden 基线 ${joinPath(dir, goldenRel)}：${errorMessage(error)}`,
          }),
        );
      }
    }

    const baselineRel = sidecarPath(rel, '.erb');
    if (entrySet.has(baselineRel)) {
      try {
        const baseline = deps.io.readText(joinPath(dir, baselineRel));
        addCase({ kind: 'differential', name: `${rel}:differential`, source: sourceText, baseline });
      } catch (error: unknown) {
        preFailures.push(
          cliFailure({
            code: 'conformance/input',
            check: 'cli',
            case: `${rel}:differential`,
            file: rel,
            field: 'baseline',
            message: `无法读取 differential 基线 ${joinPath(dir, baselineRel)}：${errorMessage(error)}`,
          }),
        );
      }
    }

    const sourceBytes = encodeSourceText(sourceText);
    addCase({
      kind: 'encoding',
      name: `${rel}:encoding`,
      bytes: sourceBytes.bytes,
      encoding: { sourceEncoding: sourceBytes.encoding, sourceEol: detectEol(sourceText) },
    });
  }

  return finishResult({ adapterName, registration, cases, caseFiles, metas, preFailures });
}

/* ============================== 7. check --golden / --suite / list-cases ============================== */

function runGoldenCheck(spec: string, adapterName: string, registration: ConformanceAdapterRegistration, deps: ConformanceCliDeps): ConformanceCliResult {
  const pair = splitGoldenPair(spec);
  if (pair === null) {
    return usageResult(`--golden 需要 <源.kojo2>:<产物.erb>（收到：${spec}）`);
  }

  const preFailures: ConformanceCliFailure[] = [];
  let sourceText: string | null = null;
  try {
    sourceText = deps.io.readText(pair.source);
  } catch (error: unknown) {
    preFailures.push(
      cliFailure({
        code: 'conformance/input',
        check: 'cli',
        case: pair.source,
        file: pair.source,
        field: 'source',
        message: `无法读取源文件 ${pair.source}：${errorMessage(error)}`,
      }),
    );
  }

  let expectedErb: string | null = null;
  try {
    expectedErb = stripLeadingBom(deps.io.readText(pair.artifact));
  } catch (error: unknown) {
    preFailures.push(
      cliFailure({
        code: 'conformance/input',
        check: 'cli',
        case: `${pair.source}:golden`,
        file: pair.source,
        field: 'expectedErb',
        message: `无法读取 golden 基线 ${pair.artifact}：${errorMessage(error)}`,
      }),
    );
  }

  const cases: AdapterConformanceCase[] = [];
  const caseFiles = new Map<string, string>();
  if (sourceText !== null && expectedErb !== null) {
    const name = `${pair.source}:golden`;
    cases.push({ kind: 'golden', name, source: sourceText, expectedErb });
    caseFiles.set(name, pair.source);
  }

  return finishResult({
    adapterName,
    registration,
    cases,
    caseFiles,
    metas: [{ path: pair.source, sourceText }],
    preFailures,
  });
}

function runSuiteCheck(adapterName: string, registration: ConformanceAdapterRegistration, deps: ConformanceCliDeps): ConformanceCliResult {
  const cases = deps.builtinCases ?? builtinConformanceCases();
  const caseFiles = new Map<string, string>();
  return finishResult({ adapterName, registration, cases, caseFiles, metas: [], preFailures: [] });
}

function runListCases(parsed: ParsedArgs, deps: ConformanceCliDeps): ConformanceCliResult {
  const defaultName = deps.defaultAdapter ?? 'fixture';
  let adapterName = parsed.adapter ?? (deps.adapters[defaultName] === undefined ? '' : defaultName);
  if (parsed.adapter !== null) {
    const resolved = resolveAdapter(deps, parsed.adapter);
    if (!resolved.ok) return usageResult(resolved.reason);
    adapterName = resolved.name;
  }

  const descriptions = new Map(BUILTIN_CONFORMANCE_CASES.map((entry) => [entry.case.name, entry.description]));
  const cases: ConformanceCliCaseReport[] = (deps.builtinCases ?? builtinConformanceCases()).map((testCase) => ({
    name: testCase.name,
    kind: testCase.kind,
    file: null,
    ok: null,
    failures: 0,
    description: descriptions.get(testCase.name) ?? null,
  }));

  return {
    exitCode: 0,
    report: { adapter: adapterName, files: [], cases, failures: [], readings: emptyReadings(), usage: null },
  };
}

/* ============================== 8. 入口 ============================== */

function runCheck(parsed: ParsedArgs, deps: ConformanceCliDeps): ConformanceCliResult {
  const targets = (parsed.dir === null ? 0 : 1) + (parsed.golden === null ? 0 : 1) + (parsed.suite ? 1 : 0);
  if (targets === 0) return usageResult('check 需要一个目标：--dir <目录> / --golden <源:产物> / --suite');
  if (targets > 1) return usageResult('--dir / --golden / --suite 互斥，一次只跑一个目标');

  if (parsed.dir !== null) {
    if (parsed.adapter === null) return usageResult('check --dir 需要 --adapter <名称>（目录模式的 adapter 不设默认值）');
    const resolved = resolveAdapter(deps, parsed.adapter);
    if (!resolved.ok) return usageResult(resolved.reason);
    return runDirCheck(parsed.dir, resolved.name, resolved.registration, deps);
  }

  const adapterName = parsed.adapter ?? deps.defaultAdapter ?? 'fixture';
  const resolved = resolveAdapter(deps, adapterName);
  if (!resolved.ok) return usageResult(resolved.reason);

  if (parsed.golden !== null) return runGoldenCheck(parsed.golden, resolved.name, resolved.registration, deps);
  return runSuiteCheck(resolved.name, resolved.registration, deps);
}

/**
 * 主入口：解析 argv → 跑检查 → 返回 `{ exitCode, report }`。
 *
 * **零 `process.exit`**：退出码只是返回值；`src/main.ts` 负责把它落到 `process.exitCode`。
 * `help` 返回 0 + usage；任何用法错误返回 2 + usage；检查失败返回 1（失败项进 `failures`）。
 */
export function runConformanceCli(argv: readonly string[], deps: ConformanceCliDeps): ConformanceCliResult {
  const parsed = parseArgs(argv);
  if (parsed.command === 'help') return helpResult();
  if (parsed.error !== null) return usageResult(parsed.error);
  if (parsed.command === null) return usageResult('缺少命令（check / list-cases / help）');
  if (parsed.command === 'list-cases') return runListCases(parsed, deps);
  return runCheck(parsed, deps);
}

/* ============================== 9. 输出格式 ============================== */

function oneLine(text: string): string {
  return text.replace(/\r\n/g, ' / ').replace(/[\r\n]/g, ' / ');
}

function clip(text: string, limit = 240): string {
  const flat = oneLine(text);
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
}

/**
 * 人话报告 / JSON 二选一。
 *
 * - `report.usage !== null`（help / 用法错误）时永远输出 usage 文本，`--json` 不生效；
 * - `--json` 输出 `JSON.stringify(report, null, 2)`：顶层字段序固定，
 *   数组已按（文件路径、用例 kind、失败定位）稳定排序，可直接给机器消费；
 * - 人话报告含每个文件的 PASS/FAIL、失败清单（code/file:line/case）与读数汇总。
 */
export function formatConformanceReport(report: ConformanceCliReport, options: { readonly json?: boolean } = {}): string {
  if (report.usage !== null) return `${report.usage}\n`;
  if (options.json === true) return `${JSON.stringify(report, null, 2)}\n`;

  const lines: string[] = [];
  const listed = report.cases.length > 0 && report.cases.every((item) => item.ok === null);
  if (listed) {
    lines.push(`kojo-conformance · adapter=${report.adapter === '' ? '(未选)' : report.adapter} · ${report.cases.length} 个内建用例`);
    for (const item of report.cases) {
      const description = item.description === null ? '' : `  ${item.description}`;
      lines.push(`  - ${item.name}  [${item.kind}]${description}`);
    }
    return `${lines.join('\n')}\n`;
  }

  const failed = report.failures.length;
  lines.push(
    `kojo-conformance · adapter=${report.adapter} · ${report.files.length} files · ${report.cases.length} cases · ${failed} failures`,
  );
  for (const file of report.files) {
    const tags = file.cases.length === 0 ? '' : `  [${file.cases.join(', ')}]`;
    lines.push(`  ${file.ok ? 'PASS' : 'FAIL'}  ${file.path}${tags}`);
  }

  if (failed > 0) {
    lines.push('', `FAILURES (${failed})`);
    for (const failure of report.failures) {
      const where = failure.file ?? '(contract)';
      const at = failure.sourceLine === null ? '' : `:${failure.sourceLine}`;
      lines.push(`  [${failure.code}] ${where}${at}  case=${failure.case}  check=${failure.check}`);
      lines.push(`    ${oneLine(failure.message)}`);
      if (failure.expected !== null) lines.push(`    expected: ${clip(failure.expected)}`);
      if (failure.actual !== null) lines.push(`    actual: ${clip(failure.actual)}`);
      if (failure.artifactLine !== null) lines.push(`    artifact line: ${failure.artifactLine}`);
    }
  }

  const source = report.readings.source;
  const artifact = report.readings.artifact;
  const contract = report.readings.contract;
  lines.push(
    '',
    `readings: contract ${contract === null ? 'n/a' : contract.ok ? 'ok' : 'FAILED'}` +
      ` · files ${source.files} (${source.utf8Bytes} UTF-8 bytes;` +
      ` EOL crlf=${source.eol.crlf} lf=${source.eol.lf} mixed=${source.eol.mixed} none=${source.eol.none};` +
      ` BOM ${source.bom})` +
      ` · artifact ${artifact.utf8Bytes} UTF-8 bytes / ${artifact.lines} lines`,
  );
  const byCheck = report.readings.byCheck
    .map((item) => `${item.check} ${item.passed}/${item.failed}${item.skipped > 0 ? ` (skip ${item.skipped})` : ''}`)
    .join(' · ');
  if (byCheck !== '') lines.push(`checks: ${byCheck}`);
  lines.push(failed === 0 ? 'RESULT: PASS' : `RESULT: FAIL (${failed} failures, exit 1)`);
  return `${lines.join('\n')}\n`;
}
