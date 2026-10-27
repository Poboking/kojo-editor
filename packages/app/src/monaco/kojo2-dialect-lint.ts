/**
 * `dialect lint` —— **方言一致性体检**（LAU-D2；`ARCH-language-unification.md` §5.5 原表七项）。
 *
 * ## 它回答什么
 *
 * "这份文件看起来像本方言的写法，但有几个事实其实属于另一个游戏"——打开工程跑一次，
 * 把这类提示变成一张**按 `(诊断码, 方言)` 聚合过的清单**，而不是几百条同类波浪线。
 *
 * ## 七项与它们的**唯一事实源**（重写判据是禁止的，这里全部复用既有分析）
 *
 * | # | 检查 | 码 | 判据从哪来 |
 * |---|---|---|---|
 * | 1 | 事件名不在 `eventCatalog` 里 | `core/event/unknown` | 本模块（事件挂点 ＝ `kojo2-event-sites.ts`） |
 * | 2 | 事件写在了错误的载体上 | `core/event/wrong-carrier` | 本模块（`carriers[].validates` ＋ 已解析的 `carrier`） |
 * | 3 | 名字不在 `domainSymbols` 里 | `core/expr/unknown-symbol` | **同一次编译的诊断**（sema 判据，零重算） |
 * | 4 | 只读别名 / 常量出现在赋值左值 | `core/expr/readonly-target` / `core/expr/assign-to-constant` | 同上 |
 * | 5 | 演出未声明（`@颜绘` / 心形 / 着色 / 选项） | `core/feature/unsupported`（`color` / `face` 各有专码，见下） | 同上（主链能力闸是单源） |
 * | 6 | 文件不在任何载体归属里 | `core/carrier/unowned` | **方言解析**（`resolveDialectBinding` 已发） |
 * | 7 | 缺 `waitDefault` 却出现无「续」的台词 | `core/wait/no-profile` / `core/profile/missing` | 本模块（词法行的等待三态 ＋ `profile.waitDefault`） |
 *
 * 第 3–5 项刻意**不**在这里再跑一遍 sema：同一次编译（`compileKojoSource`）已经把这三族
 * 事实算出来了（`lower/expand/index.ts` 的 `mergeSema`），再算一次就是两份判据、两处报同一件事。
 * 本模块吃的是"那次编译的诊断"这一份**文档事实**，只做筛选与重新归类。
 * 第 6 项同理：`resolveDialectBinding` 是 `core/carrier/unowned` 的生产者，本模块只把它接进
 * 同一张清单（同一枚 diagnostic 实例，不重造成第二条）。
 *
 * ## 未绑定 / 没事实 ⇒ **不校验也不猜**
 *
 * `facts === null`（没有 2.0 面 / 未绑定方言）时本模块交 `null`：零诊断。绝不因为"认不出方言"
 * 就报"未知事件"——那是把"没有事实"读成"事实不符"（§9-9 的反面）。
 * 载体同理：方言**声明了** `carriers` 而这文件没归上任何一条 ⇒ 事件面整面跳过
 * （归属不明时"属于哪个载体"没有依据，猜出来的错比不说更坏；`core/carrier/unowned` 已由解析器说过）。
 *
 * ## 呈现纪律（§5.5 末段）
 *
 * 诊断 → {@link aggregateKojo2DialectLint} 按 `(码, 方言)` 聚成一条 →
 * {@link kojo2DialectLintProblems} 翻成**既有**问题面板的行（`EditorProblem`）。
 * 本模块**不产生 markers**（波浪线只属于编译/方言解析那一条链）：一张清单一条汇总，
 * 明细（行号）落在同一条消息里，点行跳到第一处。
 */
import {
  eventNames,
  factKindsOf,
  findEvent,
  severityOf,
  type CarrierBinding,
  type CoreDiagnosticCode,
  type DialectBinding,
  type DialectFactKind,
  type DialectId,
  type GameAdapter,
  type KojoDiagnostic,
  type KojoSpan,
} from '@kojo/kojo-core';
import {
  kojo2DocumentOf,
  type Kojo2Document,
} from '@kojo/kojo-lang';
import { kojo2EventSitesOf, type Kojo2EventSite } from './kojo2-event-sites';
import type { EditorProblem } from '../ui/problem-store';

/** 体检清单的来源标签（问题面板那一列；与 `Kojo 2.0` 波浪线那条分开说得出"谁报的"） */
export const KOJO2_DIALECT_LINT_SOURCE = 'Kojo 2.0 方言体检';

/**
 * 第 3–5 项：由**同一次编译**产出的、属于本清单的码。
 * 不在表里的编译诊断（文法 / 结构 / 类型 …）不归体检管，一条也不抓。
 *
 * 演出面为什么有四枚码：§5.5 第 5 行写的是"复用 `core/feature/unsupported`"，而 core 的
 * 能力闸按**演出种类**各发一枚（`PRESENTATION_UNSUPPORTED_CODES`：`heart` / `options` 落
 * `core/feature/unsupported`，`color` / `face` 各有自己的码）。体检按**生产者实际发出的码**
 * 收（否则"用了 `@颜绘` 而方言没声明"这一格会静默漏掉）——码表一个字没改。
 */
export const KOJO2_LINT_COMPILE_CODES: readonly CoreDiagnosticCode[] = Object.freeze([
  'core/expr/unknown-symbol',
  'core/expr/readonly-target',
  'core/expr/assign-to-constant',
  'core/feature/unsupported',
  'core/color/unsupported',
  'core/face/unsupported',
] satisfies CoreDiagnosticCode[]);

/** 第 6 项：由方言解析产出的、属于本清单的码（解析器是唯一生产者） */
export const KOJO2_LINT_RESOLVER_CODES: readonly CoreDiagnosticCode[] = Object.freeze([
  'core/carrier/unowned',
] satisfies CoreDiagnosticCode[]);

/** 本清单自己判的三项（1 / 2 / 7） */
export const KOJO2_LINT_OWN_CODES: readonly CoreDiagnosticCode[] = Object.freeze([
  'core/event/unknown',
  'core/event/wrong-carrier',
  'core/wait/no-profile',
  'core/profile/missing',
] satisfies CoreDiagnosticCode[]);

/** 七项检查可能产出的全部码（聚合与筛选的唯一名单） */
export const KOJO2_LINT_CODES: readonly CoreDiagnosticCode[] = Object.freeze([
  ...KOJO2_LINT_OWN_CODES,
  ...KOJO2_LINT_COMPILE_CODES,
  ...KOJO2_LINT_RESOLVER_CODES,
] satisfies CoreDiagnosticCode[]);

/** 体检的输入面（纯数据；零 IO、零 Monaco） */
export interface Kojo2DialectLintInput {
  /** 文件正文（事件挂点与等待三态从它来） */
  readonly source: string;
  /** 方言事实；`null` / 缺省 = 未绑定 ⇒ 本次体检交 `null`（不校验也不猜） */
  readonly facts?: GameAdapter | null;
  /**
   * 已解析的方言绑定（`resolveDialectBinding` 的结果）。
   * 给了它才能答"这份文件是哪个载体"（第 2 项）；不给 = 不做载体归属。
   */
  readonly binding?: DialectBinding | null;
  /**
   * 同一次编译的诊断（第 3–5 项的唯一来源）。缺省 = 只做 1 / 2 / 7 三项。
   */
  readonly diagnostics?: readonly KojoDiagnostic[];
  /**
   * 方言解析那一轮的诊断（第 6 项 `core/carrier/unowned` 的来源）。
   * 缺省 = 只从 {@link KOJO2_LINT_COMPILE_CODES} 那一路取，不含载体归属项。
   */
  readonly resolutionDiagnostics?: readonly KojoDiagnostic[];
}

/** 一次体检的结果：`dialect` + 诊断（**未绑定 ⇒ `null`**，调用方据此零上账） */
export interface Kojo2DialectLintReport {
  readonly dialect: DialectId;
  readonly diagnostics: readonly KojoDiagnostic[];
}

/* ============================== 1 / 2. 事件名与事件落点 ============================== */

function pointSpan(line: number, column = 1): KojoSpan {
  return { start: { line, column }, end: { line, column } };
}

function make(code: CoreDiagnosticCode, message: string, span: KojoSpan | null): KojoDiagnostic {
  return Object.freeze({ code, severity: severityOf(code), message, span });
}

/** 方言声明的载体表（`undefined` = 未声明；空数组 = 显式"零条归属"，同样声明过） */
function declaredCarriers(facts: GameAdapter): readonly CarrierBinding[] | undefined {
  const raw: unknown = facts.carriers;
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return [];
  const out: CarrierBinding[] = [];
  for (const item of raw as readonly unknown[]) {
    const binding = item as CarrierBinding | null;
    if (binding !== null && typeof binding === 'object' && typeof binding.glob === 'string') {
      out.push(binding);
    }
  }
  return out;
}

/** 一件事的"该不该在这一面上校验"：`validates` 省略 = 全部事实类 */
function validatesKind(binding: CarrierBinding | undefined, kind: DialectFactKind): boolean {
  if (binding === undefined) return true;
  return factKindsOf(binding).includes(kind);
}

/**
 * 事件挂点 → 诊断（第 1、2 项）。
 *
 * 判定顺序（写死，别调）：
 * 1. 方言**声明了** `carriers` 且这份文件没归上任何一条 ⇒ **整面跳过**（归属不明，不猜）；
 * 2. 这份文件的载体**不校验事件**，而方言别处声明了校验事件的载体 ⇒ 每个挂点一条
 *    `core/event/wrong-carrier`（"事件有、地方错"，修法是把这段挪到那个 glob 覆盖的文件里）；
 * 3. 否则每个挂点对 `eventCatalog` 校验：不在表里 ⇒ `core/event/unknown`（位置 = 事件名那一段）。
 */
export function kojo2EventDiagnosticsOf(
  sites: readonly Kojo2EventSite[],
  facts: GameAdapter,
  binding: DialectBinding | null | undefined,
): KojoDiagnostic[] {
  if (sites.length === 0) return [];
  const declared = declaredCarriers(facts);
  const carrier = binding?.carrier ?? null;
  // ① 归属不明：载体级校验整面跳过（解析器已用 core/carrier/unowned 说过这件事）
  if (declared !== undefined && carrier === null) return [];

  const actual = carrier === null ? undefined : declared?.find((item) => item.carrier === carrier);
  if (!validatesKind(actual, 'event')) {
    // ② 这份文件所在的载体不校验事件：方言若在别的载体上校验事件 ⇒ 事件写错了地方
    const expected = declared?.find((item) => factKindsOf(item).includes('event'));
    if (expected === undefined) return [];
    return sites.map((site) =>
      make(
        'core/event/wrong-carrier',
        `事件“${site.name}”属于 ${expected.carrier} 载体，这份文件是 ${String(carrier)}：` +
          `挪到 ${expected.glob} 覆盖的文件里。`,
        pointSpan(site.line, site.startColumn),
      ),
    );
  }

  // ③ 名字面：目录里有 ⇒ 通过；没有 ⇒ core/event/unknown（error，指到事件名那一段）
  const out: KojoDiagnostic[] = [];
  for (const site of sites) {
    if (findEvent(facts, site.name) !== undefined) continue;
    const available = eventNames(facts);
    out.push(
      make(
        'core/event/unknown',
        `${site.machine ? '`# 机`' : '`@织`'} 的事件“${site.name}”不在方言 ${facts.id} 的事件目录里` +
          `（可用事件：${available.length === 0 ? '(无)' : available.join('、')}）。`,
        {
          start: { line: site.line, column: site.startColumn },
          end: { line: site.line, column: site.endColumn },
        },
      ),
    );
  }
  return out;
}

/* ============================== 7. 等待面 ============================== */

/** 等待面缺省值的读数（`undefined` = 没有 / 非法 ⇒ 不能替作者选"等"还是"不等"） */
function waitDefaultOf(facts: GameAdapter): 'wait' | 'continue' | undefined {
  try {
    const profile: unknown = facts.profile;
    if (profile === null || typeof profile !== 'object') return undefined;
    const value = (profile as { waitDefault?: unknown }).waitDefault;
    return value === 'wait' || value === 'continue' ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 等待面（第 7 项）：`waitDefault` 缺席时，"这一行没有行尾「续」"就没有落点。
 *
 * 判据只看**词法行的等待三态**（`default` = 作者没写「续」）：`wait` / `continue` 是作者
 * 明写的，一律不问。报在第一处，位置指到那一行——同一份文件里 400 行无「续」台词是同一个
 * 病根（profile 缺格），不该上 400 条。
 */
export function kojo2WaitDiagnosticsOf(
  document: Kojo2Document,
  facts: GameAdapter,
): KojoDiagnostic[] {
  if (waitDefaultOf(facts) !== undefined) return [];
  const out: KojoDiagnostic[] = [];
  let profileMissing = false;
  try {
    profileMissing = facts.profile === undefined || facts.profile === null;
  } catch {
    profileMissing = true;
  }
  if (profileMissing) {
    out.push(
      make(
        'core/profile/missing',
        `方言 ${facts.id} 没有 profile：取色 / 等待 / 池与随机落点都没有默认值（等待面按"不能说"处理）。`,
        null,
      ),
    );
  }
  for (const line of document.lines) {
    // 等待三态只在叙事文本行与 `空行` 行上存在（其余 kind 没有这一格）
    if (!('wait' in line) || line.wait !== 'default') continue;
    out.push(
      make(
        'core/wait/no-profile',
        `这一行没有行尾「续」，但方言 ${facts.id} 的 profile 没有 waitDefault：` +
          '不能替作者选“等”还是“不等”（补 profile.waitDefault 或给这一行写「续」）。',
        pointSpan(line.number),
      ),
    );
    break; // 同一病根只报第一处（其余同类由聚合条数体现，不刷屏）
  }
  return out;
}

/* ============================== 总入口 ============================== */

/**
 * 跑一次方言体检（纯函数）。
 *
 * 返回 `null` = 未绑定 / 没有 2.0 事实面 ⇒ **一条都不报**（"没有事实"不等于"事实不符"）。
 * 返回的报告里 `diagnostics` 按源码序（行 → 列）排序，`code` 稳定——聚合与测试都靠这两条。
 */
export function lintKojo2Dialect(input: Kojo2DialectLintInput): Kojo2DialectLintReport | null {
  const facts = input.facts ?? null;
  if (facts === null || typeof facts !== 'object' || typeof facts.id !== 'string') return null;
  const document = kojo2DocumentOf(input.source);
  const diagnostics: KojoDiagnostic[] = [];

  // 1 / 2：事件挂点（同一份词法行，一次投影）
  diagnostics.push(
    ...kojo2EventDiagnosticsOf(kojo2EventSitesOf(document), facts, input.binding ?? null),
  );
  // 7：等待面
  diagnostics.push(...kojo2WaitDiagnosticsOf(document, facts));
  // 3 / 4 / 5：同一次编译的诊断（筛选，不重算）
  if (input.diagnostics !== undefined) {
    for (const diagnostic of input.diagnostics) {
      if (KOJO2_LINT_COMPILE_CODES.includes(diagnostic.code as CoreDiagnosticCode)) {
        diagnostics.push(diagnostic);
      }
    }
  }
  // 6：方言解析那一轮已经发过的载体归属项（同一枚实例，不重造）
  if (input.resolutionDiagnostics !== undefined) {
    for (const diagnostic of input.resolutionDiagnostics) {
      if (KOJO2_LINT_RESOLVER_CODES.includes(diagnostic.code as CoreDiagnosticCode)) {
        diagnostics.push(diagnostic);
      }
    }
  }
  return { dialect: facts.id, diagnostics: sortDiagnostics(diagnostics) };
}

/** 源码序（行 → 列 → 码）；没有 span 的（适配器数据面）排在最后，保持输入序 */
function sortDiagnostics(diagnostics: readonly KojoDiagnostic[]): KojoDiagnostic[] {
  const keyed = diagnostics.map((diagnostic, index) => ({ diagnostic, index }));
  keyed.sort((a, b) => {
    const left = a.diagnostic.span;
    const right = b.diagnostic.span;
    if (left === null && right === null) return a.index - b.index;
    if (left === null) return 1;
    if (right === null) return -1;
    return (
      left.start.line - right.start.line ||
      left.start.column - right.start.column ||
      a.index - b.index
    );
  });
  return keyed.map((item) => item.diagnostic);
}

/* ============================== 聚合（呈现纪律） ============================== */

/** 一条聚合行（键 = `(诊断码, 方言)`）：**同类只出一条** */
export interface Kojo2DialectLintGroup {
  readonly code: CoreDiagnosticCode;
  readonly dialect: DialectId;
  readonly severity: 'error' | 'warning';
  readonly count: number;
  /** 明细：出现点行号（升序去重；没有 span 的码为空数组） */
  readonly lines: readonly number[];
  /** 汇总文案（含前几处行号；面板那一行显示的就是它） */
  readonly message: string;
}

/** 汇总文案里最多列几处行号（再多的用"等 N 处"收口；明细仍可从面板按码过滤看全） */
const LINT_DETAIL_LINES = 6;

/**
 * 诊断数组 → 按 `(码, 方言)` 聚合的清单（纯函数）。
 *
 * 顺序 = 首次出现序（先 error 后 warning 再按源码序，与 `sortDiagnostics` 同源）；
 * 同类 400 条 ⇒ 1 条，`count = 400`，`lines` 是那 400 行的去重升序列表。
 */
export function aggregateKojo2DialectLint(
  report: Kojo2DialectLintReport,
): Kojo2DialectLintGroup[] {
  const groups = new Map<string, { code: CoreDiagnosticCode; items: KojoDiagnostic[] }>();
  for (const diagnostic of report.diagnostics) {
    const code = diagnostic.code as CoreDiagnosticCode;
    const key = `${code}\u0000${report.dialect}`;
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, { code, items: [diagnostic] });
    else bucket.items.push(diagnostic);
  }
  const out: Kojo2DialectLintGroup[] = [];
  for (const bucket of groups.values()) {
    const lines = [...new Set(bucket.items.map((item) => item.span?.start.line).filter((line): line is number => typeof line === 'number'))].sort((a, b) => a - b);
    const first = bucket.items[0]!;
    const shown = lines.slice(0, LINT_DETAIL_LINES);
    const tail = lines.length > shown.length ? `、…（共 ${lines.length} 处行号）` : '';
    const where = shown.length === 0 ? '' : `（第 ${shown.join('、')} 行${tail}；点这一行跳到第一处）`;
    out.push({
      code: bucket.code,
      dialect: report.dialect,
      severity: severityOf(bucket.code),
      count: bucket.items.length,
      lines,
      message: `方言体检 · ${report.dialect}：${first.message} 共 ${bucket.items.length} 处${where}`,
    });
  }
  return out;
}

/**
 * 聚合清单 → **既有问题面板**的行（一条聚合 = 一行；`code` 原样进行，面板按码归组/过滤）。
 *
 * `path` = 这份文件（行可点、可跳）；`line` = 第一处出现行（没有行号时落 1）。
 * 本函数**不碰 markers**：波浪线仍只由编译 / 方言解析那条链发布（§5.5 呈现纪律）。
 */
export function kojo2DialectLintProblems(
  path: string,
  groups: readonly Kojo2DialectLintGroup[],
): EditorProblem[] {
  return groups.map((group) => ({
    path,
    line: group.lines[0] ?? 1,
    severity: group.severity,
    message: group.message,
    code: group.code,
    source: KOJO2_DIALECT_LINT_SOURCE,
  }));
}
