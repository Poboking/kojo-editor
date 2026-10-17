/**
 * 引擎内置·通用规则：语法糖侧约定 = **转译器诊断的投影**（RULE-DEDUP 批）。
 *
 * ## 这一条为什么不再自己扫文本
 *
 * 本文件此前用纯文本扫描重做了 `kojo-sugar` 转译器已有的 4 条判据
 * （`cont-inside-quotes` / `choice-multiple` / `expr-missing-else` /
 * `readonly-alias-assignment`），并在头注自承"保守近似、宁可漏报"。两套判据各跑各的后果
 * 是可观察的错账：同一行糖问题在 `.kojo` 波浪线上是转译器的码/严重级/列位，在校验面板
 * 是这份近似的码/固定 error/行首 ⇒ 计数与等级两边对不上，中文文案也抄了两份。
 *
 * 现在**判据只有一处**：转译器（服务键 `sugar.transpile`）。本规则只做三件事——
 * ① 从转译器诊断里挑出属于"糖侧写法约定"的那几条码；② 把 `SugarDiagnostic` 投影成
 * `ConventionIssue`（`ruleId` = `sugar.<转译器码>`，`severity` / `message` / `line`
 * **逐字取自诊断**——零二次判断、零复制文案，中文单源仍是 `diagnostic-copy.ts`）；
 * ③ 把结论按文件喂进引擎的分区缓存。
 *
 * ## 缺席就 fail-open，但绝不静默
 *
 * - 项目里没有 `.kojo`（本规则无事可做）⇒ 正常零产出，不制造噪声；
 * - 有 `.kojo` 却拿不到转译服务（插件未激活 / 装配未接线）⇒ **本规则本轮没有结论**：
 *   `partition.key()` 抛 `SugarTranspileUnavailableError`，引擎按既有通道把它记进
 *   `report.failedRules`（可见、带原因、区分两种缺席），既不猜也不伪造"没问题"。
 *
 * ## 缓存口径（PERF-12b / PERF-13，不许回退）
 *
 * 判定只依赖**单文件正文** ⇒ 继续走分区：引擎按 `ErbIndex.fileMtimes` 逐文件复用贡献，
 * 每轮只重算 mtime 变过的那些 `.kojo`；转译本身又复用转译服务自己的 `(source, filePath)`
 * 共享缓存（波浪线 / 预览 / 保存链与本规则同一条结果）。于是"改一棵"既不会重读全库正文，
 * 也不会把同一份 `.kojo` 再算一遍。转译器换代（字典 / 分野表）由 `expect.fingerprint`
 * 里的 `project.inputDigest` 把守；`key()` 另加 `adapterId` + 服务实例序号两道门
 * （任一不符 ⇒ 该规则分区整条作废重算，绝不拿旧贡献配新转译器）。
 */

import type {
  ConventionCheckContext,
  ConventionIssue,
  ConventionRule,
  SugarDiagnostic,
  SugarDiagnosticCode,
  SugarTranspileService,
} from '@kojo/plugin-api';
import { isKojoFile } from '@kojo/plugin-api';

/* ====================== 判据子集：本规则认领的转译器码（唯一清单） ====================== */

/**
 * 糖侧「约定」子集 = 转译器诊断码里面向作者写法的那四条（规范 §8 lint 清单）。
 * 其余码（缩进 / 插值 / 时机命名……）属编辑器诊断面，不进校验面板——两边各管各的账，
 * 但**同一份判据**（都出自转译器），不会再出现两个严重级。
 */
export const SUGAR_LINT_DIAGNOSTIC_CODES = [
  'cont-inside-quotes',
  'choice-multiple',
  'expr-missing-else',
  'readonly-alias-assignment',
] as const satisfies readonly SugarDiagnosticCode[];

export type SugarLintDiagnosticCode = (typeof SUGAR_LINT_DIAGNOSTIC_CODES)[number];

/** 糖族面板 ruleId 的前缀（唯一一份；逆运算见 {@link sugarFamilyCodeOf}） */
export const SUGAR_RULE_ID_PREFIX = 'sugar.';

/**
 * 转译器码 → 面板规则 id 的**唯一**命名空间加法（码本体原样来自转译器）。
 *
 * 2026-10-19 起这个前缀还是**波浪线归属的判据**（`diagnostics.ts` 靠它认出"这一族的面上行
 * 由 `ui-sugar-editor#sugar-diagnostics` 发布"）⇒ 前缀与它的逆运算 `sugarFamilyCodeOf`
 * 必须成对住在这里，别处再拼一次 `'sugar.'` 就是第三把尺子。
 */
export function sugarLintRuleIdOf(code: string): string {
  return `${SUGAR_RULE_ID_PREFIX}${code}`;
}

/** 这条面板规则 id 属不属于糖族（只看前缀，不查码表：转译器新增码时不必两头改） */
export function isSugarFamilyRuleId(ruleId: string): boolean {
  return ruleId.startsWith(SUGAR_RULE_ID_PREFIX);
}

/**
 * 糖族面板 ruleId → **转译器码本名**（`sugarLintRuleIdOf` 的逆运算，唯一一份）。
 * 面上那条波浪线的 `code` 就是这个本名（发布方 `ui-sugar-editor` 不认得面板前缀），
 * 于是"💡 认领的就是画上那一条"仍然逐字成立（身份键 = 严重级 + 行 + 消息 + 码）。
 */
export function sugarFamilyCodeOf(ruleId: string): string {
  return isSugarFamilyRuleId(ruleId) ? ruleId.slice(SUGAR_RULE_ID_PREFIX.length) : ruleId;
}

const SUGAR_LINT_CODE_SET: ReadonlySet<string> = new Set<string>(SUGAR_LINT_DIAGNOSTIC_CODES);

/** 本规则可能产出的全部子 ruleId（= 面板组描述登记清单；单一来源，别再抄一份） */
export const SUGAR_LINT_RULE_IDS: readonly string[] = SUGAR_LINT_DIAGNOSTIC_CODES.map(sugarLintRuleIdOf);

/** 子 ruleId 常量（保留 `index.ts` 既有 re-export 面；值一律由码表推导） */
export const CONT_INSIDE_QUOTES_RULE_ID = sugarLintRuleIdOf('cont-inside-quotes');
export const MULTIPLE_CHOICE_BLOCKS_RULE_ID = sugarLintRuleIdOf('choice-multiple');
export const EXPR_MISSING_ELSE_RULE_ID = sugarLintRuleIdOf('expr-missing-else');
export const READONLY_ALIAS_ASSIGN_RULE_ID = sugarLintRuleIdOf('readonly-alias-assignment');

/* ============================== 转译服务的取用通道 ============================== */

/**
 * 转译服务提供者（装配点接线用）。三态约定（**两种缺席要能分辨**）：
 * - 返回服务对象 ⇒ 正常；
 * - 返回 `null` ⇒ 已接线但这一轮拿不到实例（kojo-sugar 未激活 / 适配器无转译能力）；
 * - 返回 `undefined` ⇒ 通道本身是空的（装配未接线，属我们的接线漏了）。
 */
export type SugarTranspileProvider = () => SugarTranspileService | null | undefined;

/**
 * 转译服务缺席（且本轮确有 `.kojo` 要判）——**不等于**"没查出问题"。
 * 引擎把消息原样收进 `report.failedRules` ⇒ 面板/日志可见，不静默。
 */
export class SugarTranspileUnavailableError extends Error {
  /** 可读原因（两种缺席形态分别成文；就是 `failedRules.error` 的正文） */
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = 'SugarTranspileUnavailableError';
    this.reason = reason;
  }
}

/** 装配未接线（宿主没给本规则服务通道） */
const NOT_WIRED_REASON =
  'sugar.transpile 服务未接线（装配点缺 `setSugarTranspileProvider`）：本轮 `.kojo` 约定判定已跳过——未报问题不等于没有问题';

/** 已接线但取不到服务实例 */
const NO_SERVICE_REASON =
  'sugar.transpile 服务缺席（kojo-sugar 未激活 / 当前适配器无转译能力）：本轮 `.kojo` 约定判定已跳过——未报问题不等于没有问题';

let defaultProvider: SugarTranspileProvider | null = null;

/**
 * 装配点接线（宿主 `activate` 里一行）：把 `sugar.transpile` 的取用通道交给内置规则。
 *
 * 之所以给**惰性 getter**而不是服务实例：装配顺序不该被本规则绑死（kojo-sugar 可以晚于
 * 本插件激活），且服务对象在 kojo-sugar 内部按适配器代际复用——取用时才反映当前代际。
 * 传 `null` = 解除接线（测试复位用）。
 */
export function setSugarTranspileProvider(provider: SugarTranspileProvider | null): void {
  defaultProvider = provider;
}

/** 默认通道当前是否已接线（自证 / 装配体检用；不改变任何行为） */
export function sugarTranspileProviderWired(): boolean {
  return defaultProvider !== null;
}

type ServiceResolution = { readonly service: SugarTranspileService } | { readonly unavailable: string };

function resolveService(provider: SugarTranspileProvider | null): ServiceResolution {
  if (provider === null) return { unavailable: NOT_WIRED_REASON };
  const service = provider();
  // `undefined` = 通道空（未接线）；`null` = 接了线但这一轮没有实例 —— 两种原因分开成文
  if (service === undefined) return { unavailable: NOT_WIRED_REASON };
  if (service === null) return { unavailable: NO_SERVICE_REASON };
  return { service };
}

/** 服务必须是有的（本轮确有 `.kojo`）——拿不到就抛，让缺席进 `failedRules` */
function requireService(provider: SugarTranspileProvider | null): SugarTranspileService {
  const got = resolveService(provider);
  if ('unavailable' in got) throw new SugarTranspileUnavailableError(got.unavailable);
  return got.service;
}

/* ============================== 服务代际门（分区判据） ============================== */

/**
 * 服务实例序号（`WeakMap` 赋值）：只把"换了一枚服务对象"折进分区判据。
 * 服务**内容**（字典 / 分野表）换代不在这里体现——那一门由 `expect.fingerprint`
 * 里的 `project.inputDigest` 把守（见文件头注）。
 */
const serviceOrdinal = new WeakMap<object, number>();
let serviceCounter = 0;

function serviceGeneration(service: SugarTranspileService): number {
  const key = service as unknown as object;
  let n = serviceOrdinal.get(key);
  if (n === undefined) {
    n = ++serviceCounter;
    serviceOrdinal.set(key, n);
  }
  return n;
}

/* ============================== 诊断 → ConventionIssue 投影 ============================== */

// 糖源判定**用契约那一枚** `plugin-api/sugar-panels#isKojoFile`（波浪线归属问的就是
// "这一棵是不是 `.kojo`"，本层再写一份正则 = 同一件事两把尺：发布方改大小写口径这里就漏报）。

/** 这条转译器诊断是否属于本规则认领的"糖侧约定" */
export function isSugarLintDiagnostic(diag: SugarDiagnostic): boolean {
  return SUGAR_LINT_CODE_SET.has(diag.code);
}

/**
 * 一条转译器诊断 → 一条面板条目。
 * `severity` / `message` / `line` 逐字来自诊断；`key` 带列位，保证同一行的多条诊断
 * 不会被引擎的去重合并成一条（转译器对同一行可以报多次，如多处引号内的 `续`）。
 */
export function sugarDiagnosticToIssue(diag: SugarDiagnostic, filePath: string): ConventionIssue {
  const ruleId = sugarLintRuleIdOf(diag.code);
  const line = diag.loc?.line;
  const column = diag.loc?.column;
  return {
    ruleId,
    severity: diag.severity,
    message: diag.message,
    filePath,
    ...(line === undefined ? {} : { line }),
    key: `${ruleId}|${filePath}|${line ?? 0}|${column ?? 0}`,
  };
}

/** 从一次转译结果里挑出本规则认领的诊断（顺序 = 转译器产出顺序，不重排） */
export function sugarLintIssuesFrom(
  diagnostics: readonly SugarDiagnostic[],
  filePath: string,
): ConventionIssue[] {
  const out: ConventionIssue[] = [];
  for (const d of diagnostics) {
    if (isSugarLintDiagnostic(d)) out.push(sugarDiagnosticToIssue(d, filePath));
  }
  return out;
}

/**
 * 一棵 `.kojo` 的糖侧约定判定：读正文（引擎轮内记忆化）→ 转译（服务共享缓存）→ 投影。
 * 返回 `undefined` = **本文件本轮没有结论**（只有一种来源：读盘失败，与改造前的
 * "warn + 跳过"口径逐字同形）。
 *
 * **转译抛错一律外抛**（不咽）：契约承诺转译器自身异常会落成 `internal` 诊断而不是抛错，
 * 真抛出 = 服务实现异常 ⇒ 让引擎把整条规则判为"本轮没有结论"（`failedRules`），
 * 绝不把它伪装成"这棵树没问题"。
 */
async function transpileFileIssues(
  ctx: ConventionCheckContext,
  service: SugarTranspileService,
  path: string,
): Promise<ConventionIssue[] | undefined> {
  const text = await readKojoText(ctx, path);
  if (text === undefined) return undefined;
  const result = service.transpile(text, { filePath: path });
  return sugarLintIssuesFrom(result.diagnostics, path);
}

/** 读正文（与改造前同口径：读盘失败只 warn 跳过 = 本文件本轮没有结论） */
async function readKojoText(ctx: ConventionCheckContext, path: string): Promise<string | undefined> {
  try {
    return await ctx.readFile(path);
  } catch (err) {
    ctx.log.warn(`sugar conventions: 读取 ${path} 失败，跳过：${String(err)}`);
    return undefined;
  }
}

function hasKojoFile(ctx: ConventionCheckContext): boolean {
  for (const path of ctx.index.files.keys()) {
    if (isKojoFile(path)) return true;
  }
  return false;
}

/* ============================== 规则装配 ============================== */

/** 分区判据前缀（代际门 = 前缀 + 服务实例序号 + adapterId） */
const PARTITION_KEY_PREFIX = 'sugar.transpile#';
/** 分区判据里"这轮压根没有 `.kojo`"的固定值（不需要服务，也就不受转译器代际门影响） */
const NO_KOJO_KEY = `${PARTITION_KEY_PREFIX}no-kojo`;

/**
 * 造一条糖侧约定规则（**依赖注入形态**：装配点把 `sugar.transpile` 的取用通道传进来）。
 * 导出的 `sugarStaticConventionsRule` = 本工厂 + 模块级惰性默认通道，为的是既有
 * `engine.ts` 静态内置清单零改动；装配点要显式注入也走这里。
 */
export function createSugarStaticConventionsRule(
  provider: SugarTranspileProvider | null,
): ConventionRule {
  return {
    id: SUGAR_STATIC_CONVENTIONS_RULE_ID,
    description:
      '.kojo 语言约定（判据 = `sugar.transpile` 的转译器诊断，本规则只做投影、不做第二套判断）：' +
      '「续」写在引号内、一个时机多个「选项」/「菜单」块、表达式「如果」/「当」缺「否则」、只读别名作赋值左值',
    severity: 'error',
    source: '判据实现 = kojo-sugar 转译器；文案单源 = plugin-api/src/diagnostic-copy.ts（规范 §8）',
    partition: {
      async key(ctx): Promise<string> {
        if (!hasKojoFile(ctx)) return NO_KOJO_KEY;
        // 有糖源文件却拿不到服务 ⇒ 抛错：引擎把原因记进 failedRules（本轮该规则没有结论）
        const service = requireService(provider);
        return `${PARTITION_KEY_PREFIX}${serviceGeneration(service)}@${ctx.project.adapterId || ''}`;
      },
      async fileUnit(ctx, file): Promise<ConventionIssue[] | null | undefined> {
        const path = file.path;
        if (!isKojoFile(path)) return null; // 不是糖源 ⇒ "没扫，结论是不适用"（可缓存）
        // 缺席 ⇒ 抛（与 `key()` 同一份原因文本）。引擎的分区路径正常情况下走不到这里：
        // `key()` 先抛 ⇒ 整条规则本轮没有结论；这里抛是给非分区调用方兜底，绝不静默。
        const service = requireService(provider);
        return await transpileFileIssues(ctx, service, path);
      },
      combine(_ctx, entries): ConventionIssue[] {
        const issues: ConventionIssue[] = [];
        for (const e of entries) {
          if (Array.isArray(e.unit)) issues.push(...(e.unit as ConventionIssue[]));
        }
        return issues;
      },
      isUnit(v): boolean {
        if (v === null) return true;
        if (!Array.isArray(v)) return false;
        return v.every(
          (i) =>
            typeof i === 'object' &&
            i !== null &&
            typeof (i as ConventionIssue).ruleId === 'string' &&
            typeof (i as ConventionIssue).message === 'string' &&
            typeof (i as ConventionIssue).severity === 'string' &&
            isSugarFamilyRuleId((i as ConventionIssue).ruleId) &&
            // 盘上旧形态（本规则曾经的文本扫描产物，子 ruleId 是自造名）一律判死重算：
            // 现在的子 ruleId 只能是转译器码投影出来的那几个
            SUGAR_LINT_CODE_SET.has(sugarFamilyCodeOf((i as ConventionIssue).ruleId)),
        );
      },
    },
    async check(ctx): Promise<ConventionIssue[]> {
      // 分区路径不调用它（引擎的 `check` 对拍基准 + 判据不全时的兜底路径）
      if (!hasKojoFile(ctx)) return [];
      const service = requireService(provider);
      const issues: ConventionIssue[] = [];
      for (const file of ctx.index.files.values()) {
        const path = file.path;
        if (!isKojoFile(path)) continue;
        const produced = await transpileFileIssues(ctx, service, path);
        if (produced) issues.push(...produced);
      }
      return issues;
    },
  };
}

/* ============================== 规则导出 ============================== */

/** 合成一条引擎规则的 id（四项判据同属"糖侧写法约定"，报告口径归为一条语义单元；issue 各带子 ruleId） */
export const SUGAR_STATIC_CONVENTIONS_RULE_ID = 'sugar.static-conventions';

/**
 * 内置规则单例（`engine.ts` 静态清单消费的那一枚）。
 * 服务经模块级**惰性默认通道**取用 ⇒ 装配点一行 `setSugarTranspileProvider`、插件间零 import。
 * 通道为 `null`（未接线）时 provider 返回 `undefined` ⇒ 原因文本区分"未接线 / 服务缺席"。
 */
export const sugarStaticConventionsRule: ConventionRule = createSugarStaticConventionsRule(
  () => (defaultProvider === null ? undefined : defaultProvider()),
);
