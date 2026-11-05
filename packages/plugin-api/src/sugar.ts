/**
 * 语法糖契约（v0.3 批 S1）——**运行时面**：失败错误 / 路径与扩展名 / 类型守卫。
 *
 * 类型面（AST / 服务接口 / 诊断 / 选项 / 文档模型）已拆到 `./sugar-types`：本文件在
 * **开机静态值依赖图**里（桶 `index.ts` 的值导出把它拉进来），而
 * `packages/app/tests/ps10-eager-graph.test.ts` 按**源码字节**数图内文件——纯类型只有
 * 搬到 `import type` 那一侧才能不占首屏预算。拆分的完整理由见 `sugar-types.ts` 头注。
 *
 * 口径（改本文件前先读）：
 * - **类型一律写进 `sugar-types.ts`**，这里只留 `const` / `function` / `class`；
 * - 需要类型处写 `import type { … } from './sugar-types'`（type-only import 会被擦除，
 *   不会把类型文件拽回图里）；
 * - **不许在本文件 re-export 类型**（`export type { … } from './sugar-types'` 会让桶的
 *   消费方以为类型还住这里，长出第二处真源）；
 * - 文件头那一份契约设计说明（分层 / 规范出处 / 稳健性原则）住 `sugar-types.ts`。
 */

import type {
  AliasValue,
  HeartLine,
  Interpolation,
  RawFunctionBlock,
  RawLine,
  SugarDiagnostic,
  SugarExprNode,
  SugarLiftCandidate,
  SugarLiftResult,
  SugarNode,
  SugarPreviewArchive,
  SugarPreviewLine,
  SugarPreviewMessageBlock,
  SugarPreviewResult,
  SugarTopLevelNode,
  TextLine,
} from './sugar-types';

/* ============================== 编译失败错误（S3 批） ============================== */

/**
 * 编译失败错误（fail-closed）。
 *
 * 与 `WriteNotAllowedError` 的分工：路径越权**原样传播** `WriteNotAllowedError`
 * （内核第一道闸的语义，消费方按类型判定）；本错误承载**编译域**的失败
 * （error 诊断阻止写盘 / 回读验证不一致），并**携带上下文**（目标路径 +
 * 备份位置），便于 UI 精确提示"原文件已备份于 X"。
 */
export class SugarCompileError extends Error {
  /** 目标产物路径（可能尚未写入——如 error 诊断在写盘前拒绝） */
  readonly targetPath: string;
  /** 若已写入或已备份：备份路径（未备份时为 null） */
  readonly backupPath: string | null;
  /** 触发失败的诊断（编译拒绝时有值；回读失败时为空数组） */
  readonly diagnostics: readonly SugarDiagnostic[];

  constructor(
    message: string,
    info: { targetPath: string; backupPath?: string | null; diagnostics?: readonly SugarDiagnostic[] },
  ) {
    super(message);
    this.name = 'SugarCompileError';
    this.targetPath = info.targetPath;
    this.backupPath = info.backupPath ?? null;
    this.diagnostics = info.diagnostics ?? [];
  }
}

/* ============================== 保存目标推导与前置检查（S7 批） ============================== */

/**
 * 全角空格（`U+3000`）——**语料里的排版陷阱**（规范 §8：保存期告警）。
 *
 * 属**语言层事实**（非游戏知识），故住契约层并作为**单一真源**：预览面板与
 * 保存前置检查共用（两处各写一遍会让"什么算全角空格"的判据悄悄分叉）。
 *
 * 证据（eraTW 4.980 全量实测）：口上语料 3,599,696 行中含 `U+3000` 者 55,565
 * 行（1.54%），**全部为行中用途**（注释分隔 `;【TARGET】　欲情の珠`、以及编译器
 * 生成的台词缩进 `PRINTFORMW 　「…」`），**行首出现 0 次**。故它是"正常但极易
 * 与半角空格混看"的字符——保存期**告警**（不阻断），由作者判断是否本意。
 */
export const FULLWIDTH_SPACE = '\u3000';

/**
 * 含全角空格（`U+3000`）的源行号（1 基，按升序）。
 *
 * 判据与既有预览面板一致：**行内任一位置**出现 `U+3000` 即计入（不做"仅行首"
 * 收窄——上游 S4-UI 批已按整行判定冻结，收窄会与面板相矛盾）。
 */
export function fullwidthSpaceLines(source: string): number[] {
  const out: number[] = [];
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.includes(FULLWIDTH_SPACE)) out.push(i + 1);
  }
  return out;
}

/**
 * 由 `.kojo1` 源路径推导目标 `.erb` 产物路径（**纯函数**；不触达磁盘）。
 *
 * 规则：**同目录、同基名，扩展名 `.kojo1` → `.ERB`**（大小写不敏感，`\` / `/`
 * 分隔符一律保留原样）。非这枚（或空路径）→ `null`。
 *
 * **`.kojo` 已不在这里**（LAU-3b 翻转，2026-10-27 用户口径）：`.kojo` 归 2.0，
 * 它的正文不是表层 DSL，转成 `.ERB` 只会产出一份错的产物。表层 DSL 只剩封存层
 * （kojo1），它的源文件就是 `.kojo1`。
 *
 * 依据（真实语料）：产物布局为 `個人口上/{编号 名称}/{口上名}/M_KOJO_K{n}_{分野}.ERB`，
 * 源由编辑器"新建向导"与产物**同目录**生成、并沿用产物基名（`K{No}` +
 * 分野都已在源文件名里，见 `M_KOJO_K49_指令.kojo1` 惯例）——故"换扩展名"即正确
 * 推导。**不做跨目录/改名**：那属新建向导与命名校验的职责（后者需 adapter 的
 * `M_KOJO_K{No}` 命名知识，不在本通用函数内）。
 */
export function resolveSugarTarget(sourcePath: string): string | null {
  if (!sourcePath) return null;
  const m = /\.kojo1$/i.exec(sourcePath);
  if (!m) return null;
  return `${sourcePath.slice(0, sourcePath.length - m[0].length)}.ERB`;
}

/**
 * 2.0 的**主**源扩展名（**契约层唯一清单**；DRIFT-APP 3，2026-10-19 上移）。
 *
 * `kojo` 是审计 A 钦定的跨游戏术语（不是某个游戏的领域知识），故这张清单住契约层，
 * 与 `erb-ext.ts` 的方言清单平级。宿主侧（`app/ui/reference-utils`）指回这里，
 * Monaco 注册面（`app/monaco/kojo2-language`）指回 {@link kojoMonacoExtensions}——
 * 改前注册处自己写着 `['.kojo']` 一份小抄，同一族文件的大写形态在编辑器与 Monaco
 * 语言映射之间各说各话。
 *
 * ⚠ **2026-10-27 起 `.kojo` 归 2.0**（LAU-3b 翻转，用户口径：kojo1 只等删除）。
 * 本常量仍叫这个名字是因为它是"kojo 语言的源扩展名"这一事实，名字本身不带版本；
 * **封存层（kojo1）的源扩展名是 {@link KOJO_LEGACY_SOURCE_EXTENSION}（`.kojo1`）**，
 * 两枚不要混用：任何"v1 源"判据都走 {@link KOJO_V1_SOURCE_EXTENSIONS}。
 */
export const KOJO_SOURCE_EXTENSION = '.kojo';

/**
 * **封存层**（kojo1）的源扩展名（LAU-3b）。
 *
 * 2026-10-27 用户口径：`.kojo` 当场让给 2.0，kojo1 封存只为后续彻底删除。
 * 所以本仓不再有"过渡期两枚并认"——**kojo1 的源就是 `.kojo1`，一枚**。
 * 盘上还没改名的旧文件（`.kojo` 里装着 v1 正文）由两条路收：迁移（原地改写成 2.0）
 * 或改名工具（`ui/kojo1-rename*`，把内容确认是旧写法的文件标成 `.kojo1`）。
 */
export const KOJO_LEGACY_SOURCE_EXTENSION = '.kojo1';

/** v1 源扩展名全集（翻转之后只剩封存标记这一枚；判断"这是不是 v1 源"只走这一处） */
export const KOJO_V1_SOURCE_EXTENSIONS: readonly string[] = [KOJO_LEGACY_SOURCE_EXTENSION];

/**
 * Monaco 的 `extensions` 入参：把一份扩展名清单逐枚展开成「原样 + 全大写」两种写法
 * ——与 `erb-ext.erbMonacoExtensions` **同形态**（同一个理由：Monaco 的语言注册按
 * 字面量匹配扩展名，只给小写会让盘上的大写文件落到别的语言）。
 *
 * 缺省参数 = v1 源（`.kojo1`），即 `app/monaco/kojo-language` 的注册面；2.0 的注册面
 * 传自己的清单（`.kojo` + `.kojo2`）走同一个函数，不另写一套大写展开。
 *
 * 大小写形态是这里**现算的派生物**，不是第二处手抄：消费方不得在 app 里再写
 * `['.kojo', '.KOJO']`，要加形态只改这一处。
 */
export function kojoMonacoExtensions(exts: readonly string[] = KOJO_V1_SOURCE_EXTENSIONS): string[] {
  const out: string[] = [];
  for (const e of exts) {
    out.push(e, e.toUpperCase());
  }
  return out;
}

/* ============================== 升糖应用失败错误（S5-UI 批） ============================== */

/**
 * 升糖应用失败错误（fail-closed；S5-UI 批）。
 *
 * 与 `SugarCompileError` 同构（同名同形状的字段），理由：两者的失败模式
 * 完全一致（校验拒绝 / 写盘失败 / 回读不一致），消费方（UI）应当用**同一套
 * 提示逻辑**处理，不该因为"这次是升糖而不是编译"就分叉。
 *
 * 与 `WriteNotAllowedError` 的分工同 `SugarCompileError`：路径越权**原样传播**。
 */
export class SugarApplyError extends Error {
  /** 目标源文件路径 */
  readonly targetPath: string;
  /** 若已备份：备份路径（未备份时为 null） */
  readonly backupPath: string | null;

  constructor(message: string, info: { targetPath: string; backupPath?: string | null }) {
    super(message);
    this.name = 'SugarApplyError';
    this.targetPath = info.targetPath;
    this.backupPath = info.backupPath ?? null;
  }
}

/* ============================== 显式类型守卫 ============================== */
/*
 * TS7 对"联合字面量属性"的判别式 narrow 不可靠（项目教训，IMPLEMENTATION-LOG §九-10）：
 * 即便写了 `if (v.kind === 'variable' || v.kind === 'character') return;`，
 * 后续代码也可能不把该变体排除。凡需要"组合判定"的地方一律走显式守卫——
 * 下述函数即契约层对外的标准判定入口（S2 / UI / linter 共用同一套语义）。
 */

/** 文本行 */
export function isTextLine(node: SugarNode): node is TextLine {
  return node.kind === 'textLine';
}

/** 心形行 */
export function isHeartLine(node: SugarNode): node is HeartLine {
  return node.kind === 'heartLine';
}

/** 值插值（`{表达式}`）；不含行内条件 */
export function isValueInterpolation(node: Interpolation): boolean {
  return node.form === 'expr';
}

/** 行内条件插值（`{条件 ? A : B}`） */
export function isConditionalInterpolation(node: Interpolation): node is Interpolation & { form: 'cond' } {
  return node.form === 'cond';
}

/** 变量别名（可读可写） */
export function isVariableAlias(value: AliasValue): value is Extract<AliasValue, { kind: 'variable' }> {
  return value.kind === 'variable';
}

/** 角色别名（只读） */
export function isCharacterAlias(value: AliasValue): value is Extract<AliasValue, { kind: 'character' }> {
  return value.kind === 'character';
}

/** 数值字面量别名（只读） */
export function isNumberAlias(value: AliasValue): value is Extract<AliasValue, { kind: 'number' }> {
  return value.kind === 'number';
}

/** 字符串字面量别名（只读） */
export function isStringAlias(value: AliasValue): value is Extract<AliasValue, { kind: 'string' }> {
  return value.kind === 'string';
}

/** 条件表达式别名（只读；右值展开为行内条件 `\@…\@`） */
export function isConditionalAlias(value: AliasValue): value is Extract<AliasValue, { kind: 'conditional' }> {
  return value.kind === 'conditional';
}

/**
 * 只读别名判定 —— **唯一的只读性真源**（消费者不要各自写 if 链）。
 *
 * 只读 = 角色引用 / 数值字面量 / 字符串字面量 / 条件表达式四种（规范 §3.1 表）。
 * 只有变量别名可作赋值左值。
 */
export function isReadonlyAlias(value: AliasValue): boolean {
  return value.kind !== 'variable';
}

/**
 * 别名可否作赋值左值。
 * 与 `!isReadonlyAlias` 等价——保留两个方向的名字，让调用点自解释
 * （判"能否写"比判"是否只读"在 lint 规则里更常见）。
 */
export function isWritableAlias(value: AliasValue): boolean {
  return value.kind === 'variable';
}

/** 表达式位置节点（赋值位置的 如果 / 当） */
export function isExprNode(node: SugarNode): node is SugarExprNode {
  return node.kind === 'ifExpr' || node.kind === 'whenExpr';
}

/** 原生直通（行或块） */
export function isRawNode(node: SugarNode): node is RawLine | RawFunctionBlock {
  return node.kind === 'rawLine' || node.kind === 'rawFunctionBlock';
}

/** 文档级节点（别名声明 / 时机块 / 自定指令块 / 用户函数块） */
export function isTopLevelNode(node: SugarTopLevelNode): boolean {
  return (
    node.kind === 'aliasDecl' ||
    node.kind === 'timingBlock' ||
    node.kind === 'custom-command' ||
    node.kind === 'functionBlock'
  );
}

/* ==================== 预览守卫（S4 批：契约层标准判定入口） ==================== */

/** 消息块是否可达 */
export function isReachableBlock(block: SugarPreviewMessageBlock): boolean {
  return block.reachability === 'reachable';
}

/** 某糖源行是否有产物（纯糖语法行 = false） */
export function hasGenerated(line: SugarPreviewLine): boolean {
  return line.generatedLines.length > 0;
}

/** 预览是否带状态（有存档且回放成功） */
export function hasArchive(result: SugarPreviewResult): result is SugarPreviewResult & { archive: SugarPreviewArchive } {
  return result.archive !== null;
}

/* ==================== 提升建议守卫（S5 批） ==================== */

/** 候选是否已通过 round-trip 自证（v1 恒 true；守卫留作未来低置信档的兼容位） */
export function isVerifiedCandidate(candidate: SugarLiftCandidate): boolean {
  return candidate.confidence === 'verified' && candidate.roundTrip.verified;
}

/** 结果是否有候选 */
export function hasCandidates(result: SugarLiftResult): boolean {
  return result.candidates.length > 0;
}
