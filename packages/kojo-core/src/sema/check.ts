/**
 * Kojo 语义检查层（设计稿 §16.6 S5.2 / S5.3 / S5.4）—— core 侧唯一的语义入口。
 *
 * ## 定位
 *
 * `parseSource` 只保证"形状对"；本模块在同一棵**只读** AST 上补齐三类判定：
 *
 * 1. **类型**（S5.2）：`# 变量` 初值 / `# 常量` 值 / `# 表` 值列 / `# 池` 分支可归约性 /
 *    赋值与 `@算` / 数组元素 / `@函` 参数默认值与 `@返` 返回种类；
 * 2. **结构**（S5.3 的 core 侧切片）：非 void 函数的"可证落空"路径；
 * 3. **能力**（S5.4）：只读 `GameAdapter` 的 `presentation` / `programFeatures` /
 *    `storageClasses`，经 `adapter.ts` 的既有 `check*` 函数判定。
 *
 * 产物是 `{ diagnostics, symbols }`：诊断只带既有码表里的码；`symbols` 是**事实**投影，
 * 供项目层（`analyzeProject` 的 `FunctionReturnFact`）与宿主补全/悬停复用，不在这里做 UI。
 *
 * ## 与 parser / lowering 的分工（不双报）
 *
 * - **parser 已负责的语法可达性**（字面量初值形状、重名、未知类型、保留前缀、`@算` 副作用）
 *   不重复报；本层只对 AST 不变量做**防御性复核**——手工构造 / 增量缓存 / 其他 AST 生产方
 *   可能绕过 parser，这类复核只在真的看到坏形状时才出声；
 * - **lowering 的产出口径**（backend 能力、SIF、隐藏槽、展开顺序）不在这里复制；本层读的是
 *   adapter **声明**，与 lowering 读 backend **落点**是两面（K2-FEATURE-GATE-UNIFY 收口）；
 * - `# 表` 值列同类型复用 `table.ts::validateTable` 的判定（唯一实现），只上浮
 *   `core/table/type-mismatch` 一条，不重复报重叠/缺 `否` 等结构错误；
 * - `# 池` 分支"可归约"= 分支体能归约出至少一行可打印内容，判据复用
 *   `lower/presentation.ts::narrativeHasOutput`（与 lowering 最后一道闸同源）。
 *
 * ## 名字解析链（写死；赋值目标与读表达式同一顺序）
 *
 * 1. **参数 / `@巡` 绑定**（函数作用域，最近）；
 * 2. **本文件声明**（`# 变量` / `# 常量` / `# 表` / `# 池` / `# 模板` / `@函`）；
 * 3. **adapter 外部变量**（`domainSymbols.variables`，additive 面；旧 adapter 省略 = 空）；
 * 4. 都没有 ⇒ `core/expr/unknown-symbol`（adapter 的 `unknown = 'raw'` 时放行）。
 *
 * 1、2 是既有口径（顺序不动，别翻）；3 只填"原本必然报错"的格子 ⇒ 旧 adapter 行为零翻转。
 * 外部变量默认是**标量**脸（旧 adapter 省略数组面 ⇒ `名[下标]` / `名.长度` 仍按"不是数组"报，
 * 宁缺不猜）；adapter 显式给了 `arraySize`（K2-SEMA-WIRING 的 additive 数组面）才认下标，
 * 常量下标越界报既有 `core/expr/index-out-of-range`。
 *
 * ## 保守口径（不误伤）
 *
 * - 表达式只有源切片（`KojoExprText`）：本层只做**保守类型推断**（字面量、已声明名字、
 *   表引用、`.长度`、数组元素、`{角色}的<属性>`、名字函数），其余一律 `unknown`——
 *   `unknown` 不参与判定；
 * - 非 void 函数只在**能静态证明存在落空路径**时报 `core/func/missing-return`；
 *   循环 / `@跳` / `@原生` 让路径证不出时只保留 `returnFlow: 'unproven'` 事实，不报错
 *   （与 spec §7.3 的"无法证明"相比更保守，宁可漏报也不误伤）。
 *
 * ## 确定性
 *
 * 纯函数、零 IO、零 Monaco、零游戏名词：游戏事实只从注入的 `GameAdapter` 读。
 * 诊断最后经 `project/ordering.ts::sortDiagnostics`（span → code → message，稳定）排序；
 * 符号事实按源文件书写顺序。同一 `(file, ctx)` 两次调用输出逐字节相同（测试钉住）。
 */
import type { GameAdapter, PresentationFeature, ProgramFeatureKey } from '../adapter.js';
import { checkPresentation, checkProgramFeature, checkStoragePeriod, findDomainVariable } from '../adapter.js';
import type {
  KojoAssignOp,
  KojoAssignStmt,
  KojoCallStmt,
  KojoConstDecl,
  KojoDispatchNode,
  KojoExprText,
  KojoFile,
  KojoForEachLoop,
  KojoFunctionDecl,
  KojoNarrativeNode,
  KojoPoolDecl,
  KojoSpan,
  KojoTableDecl,
  KojoTextLine,
  KojoVarDecl,
  KojoVarStorage,
} from '../ast.js';
import type { CoreDiagnosticCode, KojoDiagnostic } from '../diagnostics.js';
import { severityOf } from '../diagnostics.js';
import { decodeIntegerLiteral, decodeQuotedLiteral, isIdentifier } from '../lexer.js';
import { FOREACH_COLLECTION_BINDINGS } from '../lower/expand/foreach.js';
import type { ForeachBindingName } from '../lower/expand/foreach.js';
import { narrativeHasOutput } from '../lower/presentation.js';
import { offsetToPosition } from '../positions.js';
import { sortDiagnostics } from '../project/ordering.js';
import { collectIntegerConstants, validateTable } from '../table.js';
import type { KojoSemaType } from './types.js';
import { assignable, semaTypeLabel, semaTypeOfLiteral, semaTypeOfValueType } from './types.js';

/* ============================== 公共面 ============================== */

/** 语义检查上下文：只读游戏事实 + 文件身份（`filePath` 只回填符号事实，不进诊断文案） */
export interface KojoSemaContext {
  readonly adapter: GameAdapter;
  /** 文件身份（项目层事实需要；core 不读盘，缺省空串） */
  readonly filePath?: string;
  /**
   * 报告口径（additive；K2-SEMA-WIRING）：本层是"唯一判定者"还是"与编译主链并跑"。
   *
   * - `standalone`（缺省）：查询面 / 独立检查——本层手上没有 lowering，能力闸（adapter 声明面）、
   *   `@返` 混用、落空全部由本层报；
   * - `with-lowering`：编译主链（`lower/expand/index.ts::runCompile`）。主链已有更知情/落点更精确的
   *   同族判定，本层让出三类，避免双报：
   *
   *   1. **落点能力闸**（programFeatures / presentation）：主链是**单源**（adapter 声明 ∧
   *      backend 落点，`lower/feature-gate.ts`），比本层的 adapter-only 判定更知情；若本层也报，
   *      "adapter 与 backend 不一致"时会同时出现主链的声明面冲突（span = null）与本层的
   *      use-site "未开启"（同码不同 span，`(code, span)` 去重管不到），作者会被指向错的修法；
   *   2. **`core/func/return-mixed`**：主链的递归分析落在**具体那条 `@返` 行**，比本层的函数
   *      声明行更精确；
   *   3. 其余（类型 / 名字链 / 数组越界 / `missing-return` / 存储期）本层**独占**，照报——
   *      这些是主链根本不判的格子，让出去就是静默。
   */
  readonly reporting?: 'standalone' | 'with-lowering';
}

/** 一个形参的静态事实 */
export interface KojoSemaParamSymbol {
  readonly name: string;
  /** 由默认值字面量推断；无默认值 = `unknown`（2.0 没有形参类型标注语法） */
  readonly type: KojoSemaType;
  readonly hasDefault: boolean;
  readonly span: KojoSpan;
}

/**
 * 返回路径事实（保守三态）：
 * - `returns`：结构上证明每条可达路径都以 `@返` 结束；
 * - `falls-through`：结构上证明存在落到函数末尾的路径（可报 missing-return）；
 * - `unproven`：循环 / 跳转 / 原生块让路径证不出（**不报错**，事实留给上层）。
 */
export type KojoReturnFlow = 'returns' | 'falls-through' | 'unproven';

/** 一个 `@函` 的语义事实 */
export interface KojoSemaFunctionSymbol {
  readonly name: string;
  readonly filePath: string;
  readonly span: KojoSpan;
  readonly params: readonly KojoSemaParamSymbol[];
  readonly hasValueReturn: boolean;
  readonly hasBareReturn: boolean;
  /** 非 void（有值 `@返` 且无无值 `@返`） */
  readonly returnsValue: boolean;
  readonly returnFlow: KojoReturnFlow;
  /** `returnFlow === 'returns'`（直接可喂 `FunctionReturnFact.allPathsReturn`） */
  readonly allPathsReturn: boolean;
}

/** 一条文件级声明事实（变量/常量/表/池/模板；函数另见 {@link KojoSemaFunctionSymbol}） */
export interface KojoSemaDeclarationSymbol {
  readonly name: string;
  readonly kind: 'var' | 'const' | 'table' | 'pool' | 'template';
  readonly type: KojoSemaType;
  readonly isArray: boolean;
  /** 静态可解析的声明长度；null = 标量或长度不可静态求值 */
  readonly arraySize: number | null;
  /** 变量存储期；非变量为 null */
  readonly storage: KojoVarStorage | null;
  readonly span: KojoSpan;
}

/** 文件符号事实（稳定序 = 源文件书写顺序） */
export interface KojoSemaSymbols {
  readonly declarations: readonly KojoSemaDeclarationSymbol[];
  readonly functions: readonly KojoSemaFunctionSymbol[];
}

export interface KojoSemaResult {
  /** 本层新增的诊断（**不含** `file.diagnostics`；parser 诊断由调用方并表） */
  readonly diagnostics: readonly KojoDiagnostic[];
  readonly symbols: KojoSemaSymbols;
}

/**
 * 检查一份已解析的 2.0 文件（纯函数；不读盘、不改 AST）。
 *
 * 诊断只覆盖本层职责：类型 / 结构 / 能力。词法/文法诊断仍在 `file.diagnostics` 里，
 * 由 compile 主链并入（避免同一个错在两条路径各报一次）。
 */
export function checkKojoFile(file: KojoFile, context: KojoSemaContext): KojoSemaResult {
  return new FileChecker(file, context).run();
}

/* ============================== 内部：声明索引 ============================== */

type DeclKind = 'var' | 'const' | 'table' | 'pool' | 'template' | 'function';

/** 名字解析所需的声明事实（不持 AST 引用，避免误改） */
interface DeclInfo {
  readonly kind: DeclKind;
  readonly type: KojoSemaType;
  readonly isArray: boolean;
  readonly arraySize: number | null;
  readonly storage: KojoVarStorage | null;
}

/**
 * adapter 外部变量的事实投影（`domainSymbols.variables`；additive 面）。
 *
 * - `type`：标量值类型，或数组的**元素**类型（`elementKind ?? valueKind`）；
 * - `isArray`：条目给了 `arraySize` 键（含 `null`）；
 * - `arraySize`：`null` = 数组但长度不可静态求值（不做越界判定）。
 */
interface DomainVariableFact {
  readonly type: KojoSemaType;
  readonly readonly: boolean;
  readonly isArray: boolean;
  readonly arraySize: number | null;
}

/** 赋值目标形状（`KojoAssignTarget.text` 的解析结果） */
type ParsedTarget =
  | { readonly kind: 'name'; readonly name: string }
  | { readonly kind: 'element'; readonly name: string; readonly index: string }
  | { readonly kind: 'length'; readonly name: string }
  | { readonly kind: 'attribute'; readonly attribute: string }
  | { readonly kind: 'unknown' };

type Scope = ReadonlyMap<string, KojoSemaType>;

/** 返回路径三态（与 {@link KojoReturnFlow} 同形，内部用短名） */
type Flow = 'returns' | 'continues' | 'unknown';

const EMPTY_SCOPE: Scope = new Map<string, KojoSemaType>();

const ELEMENT_TARGET_RE = /^([\p{L}_][\p{L}\p{N}_]*)\[([\s\S]*)\]$/u;
const LENGTH_TARGET_RE = /^([\p{L}_][\p{L}\p{N}_]*)\.长度$/u;
/** `{角色}的<属性>`：组 1 = 角色槽，组 2 = 属性名（角色槽由 adapter 解析，本层只判属性） */
const ATTRIBUTE_RE = /^\{\s*([^{}]+?)\s*\}的\s*([\s\S]+)$/u;
const BRACE_REF_RE = /^\{\s*([\p{L}_][\p{L}\p{N}_]*)\s*\}$/u;
const ELEMENT_REF_RE = /^([\p{L}_][\p{L}\p{N}_]*)\[([\s\S]*)\]$/u;
const LENGTH_REF_RE = /^([\p{L}_][\p{L}\p{N}_]*)\.长度$/u;

/** 表达式内扫描用的名字判据（与 lexer 的标识符口径一致；只用于切片内定位） */
const IDENT_START_RE = /[\p{L}_]/u;
const IDENT_PART_RE = /[\p{L}\p{N}_]/u;

/** 跳过 `"…"`（含 `\` 转义），返回闭引号之后的偏移 */
function skipQuoted(text: string, open: number): number {
  let index = open + 1;
  while (index < text.length) {
    const ch = text[index]!;
    if (ch === '\\') {
      index += 2;
      continue;
    }
    index++;
    if (ch === '"') return index;
  }
  return text.length;
}

/** `text[open] === '['` 时返回配对 `]` 的偏移（跳过 `"…"`；允许嵌套下标） */
function bracketEnd(text: string, open: number): number {
  let depth = 0;
  let index = open;
  while (index < text.length) {
    const ch = text[index]!;
    if (ch === '"') {
      index = skipQuoted(text, index);
      continue;
    }
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) return index;
    }
    index++;
  }
  return -1;
}

/** 声明种类标签（`assign-to-constant` 文案用；语言词，不是游戏名词） */
const DECL_KIND_LABELS: Readonly<Record<Exclude<DeclKind, 'var'>, string>> = Object.freeze({
  const: '常量',
  table: '表',
  pool: '池',
  template: '模板',
  function: '函数',
});

/** `@巡` 绑定名的静态类型（绑定名真源在 `lower/expand/foreach.ts`，这里只补类型） */
const FOREACH_BINDING_TYPES: Readonly<Record<ForeachBindingName, KojoSemaType>> = Object.freeze({
  值: 'unknown',
  下标: 'int',
  角: 'character',
  名: 'string',
  项: 'unknown',
  键: 'unknown',
});

function parseTarget(text: string): ParsedTarget {
  const trimmed = text.trim();
  const attribute = ATTRIBUTE_RE.exec(trimmed);
  if (attribute !== null) return { kind: 'attribute', attribute: attribute[2]!.trim() };
  const length = LENGTH_TARGET_RE.exec(trimmed);
  if (length !== null) return { kind: 'length', name: length[1]! };
  const element = ELEMENT_TARGET_RE.exec(trimmed);
  if (element !== null) return { kind: 'element', name: element[1]!, index: element[2]!.trim() };
  if (isIdentifier(trimmed)) return { kind: 'name', name: trimmed };
  return { kind: 'unknown' };
}

/* ============================== 内部：主检查器 ============================== */

class FileChecker {
  private readonly file: KojoFile;
  private readonly adapter: GameAdapter;
  private readonly filePath: string;
  private readonly reporting: 'standalone' | 'with-lowering';
  private readonly diagnostics: KojoDiagnostic[] = [];
  private readonly decls = new Map<string, DeclInfo>();
  private readonly functions = new Map<string, KojoFunctionDecl>();
  private readonly declarationSymbols: KojoSemaDeclarationSymbol[] = [];
  private readonly functionSymbols: KojoSemaFunctionSymbol[] = [];
  private constantValues: ReadonlyMap<string, number> = new Map<string, number>();

  constructor(file: KojoFile, context: KojoSemaContext) {
    this.file = file;
    this.adapter = context.adapter;
    this.filePath = context.filePath ?? '';
    this.reporting = context.reporting ?? 'standalone';
  }

  run(): KojoSemaResult {
    this.indexFile();
    this.checkDeclarations();
    this.walkDeclarationBodies();
    for (const scene of this.file.scenes) this.walkNarrative(scene.items, EMPTY_SCOPE);
    const diagnostics = sortDiagnostics(this.diagnostics);
    return Object.freeze({
      diagnostics: Object.freeze(diagnostics),
      symbols: Object.freeze({
        declarations: Object.freeze([...this.declarationSymbols]),
        functions: Object.freeze([...this.functionSymbols]),
      }),
    });
  }

  /* ------------------------------ 诊断 ------------------------------ */

  private report(code: CoreDiagnosticCode, message: string, span: KojoSpan | null): void {
    this.diagnostics.push({ code, severity: severityOf(code), message, span });
  }

  /** 能力闸（adapter 既有 `check*` 的返回值原样入表；null = 通过） */
  private gate(diagnostic: KojoDiagnostic | null): void {
    if (diagnostic !== null) this.diagnostics.push(diagnostic);
  }

  /**
   * 落点能力闸（programFeatures / presentation）：`context.reporting === 'with-lowering'` 时**不报**。
   * 编译主链自己有一份更知情的单源判定（adapter ∧ backend），见 {@link KojoSemaContext.reporting}。
   */
  private gateProgram(feature: ProgramFeatureKey, span: KojoSpan): void {
    if (this.reporting === 'with-lowering') return;
    this.gate(checkProgramFeature(this.adapter, feature, span));
  }

  private gatePresentation(feature: PresentationFeature, span: KojoSpan): void {
    if (this.reporting === 'with-lowering') return;
    this.gate(checkPresentation(this.adapter, feature, span));
  }

  /* ------------------------------ 索引 ------------------------------ */

  private indexFile(): void {
    const consts = this.file.decls.filter((decl): decl is KojoConstDecl => decl.kind === 'const');
    this.constantValues = collectIntegerConstants(consts);

    for (const decl of this.file.decls) {
      switch (decl.kind) {
        case 'var': {
          const isArray = decl.arraySize !== undefined;
          const arraySize = this.resolveArraySize(decl);
          const type = semaTypeOfValueType(decl.valueType);
          this.register(decl.name, { kind: 'var', type, isArray, arraySize, storage: decl.storage });
          this.declarationSymbols.push({
            name: decl.name,
            kind: 'var',
            type,
            isArray,
            arraySize,
            storage: decl.storage,
            span: decl.span,
          });
          break;
        }
        case 'const': {
          const type = semaTypeOfLiteral(decl.value);
          this.register(decl.name, { kind: 'const', type, isArray: false, arraySize: null, storage: null });
          this.declarationSymbols.push({
            name: decl.name,
            kind: 'const',
            type,
            isArray: false,
            arraySize: null,
            storage: null,
            span: decl.span,
          });
          break;
        }
        case 'table': {
          const type = tableValueType(decl);
          this.register(decl.name, { kind: 'table', type, isArray: false, arraySize: null, storage: null });
          this.declarationSymbols.push({
            name: decl.name,
            kind: 'table',
            type,
            isArray: false,
            arraySize: null,
            storage: null,
            span: decl.span,
          });
          break;
        }
        case 'pool': {
          this.register(decl.name, { kind: 'pool', type: 'unknown', isArray: false, arraySize: null, storage: null });
          this.declarationSymbols.push({
            name: decl.name,
            kind: 'pool',
            type: 'unknown',
            isArray: false,
            arraySize: null,
            storage: null,
            span: decl.span,
          });
          break;
        }
        case 'template': {
          this.register(decl.name, { kind: 'template', type: 'unknown', isArray: false, arraySize: null, storage: null });
          this.declarationSymbols.push({
            name: decl.name,
            kind: 'template',
            type: 'unknown',
            isArray: false,
            arraySize: null,
            storage: null,
            span: decl.span,
          });
          break;
        }
        case 'function': {
          // 重名由 parser / 项目层 Layer 判定；这里同名保留第一条（诊断顺序无关）
          if (!this.functions.has(decl.name)) this.functions.set(decl.name, decl);
          this.register(decl.name, { kind: 'function', type: 'unknown', isArray: false, arraySize: null, storage: null });
          break;
        }
        default:
          break;
      }
    }
  }

  private register(name: string, info: DeclInfo): void {
    if (!this.decls.has(name)) this.decls.set(name, info);
  }

  /** `# 变量 名 类型[N]` 的 N：整数字面量或已声明整数 `# 常量`；证不出 = null */
  private resolveArraySize(decl: KojoVarDecl): number | null {
    const size = decl.arraySize;
    if (size === undefined) return null;
    const text = size.text.trim();
    const literal = decodeIntegerLiteral(text);
    if (literal !== null) return literal;
    if (isIdentifier(text)) return this.constantValues.get(text) ?? null;
    return null;
  }

  /* ------------------------------ 声明层 ------------------------------ */

  private checkDeclarations(): void {
    for (const decl of this.file.decls) {
      switch (decl.kind) {
        case 'var':
          this.checkVarDecl(decl);
          break;
        case 'const':
          this.checkConstDecl(decl);
          break;
        case 'table':
          this.checkTableDecl(decl);
          break;
        case 'pool':
          this.checkPoolDecl(decl);
          break;
        default:
          break;
      }
    }
  }

  private checkVarDecl(decl: KojoVarDecl): void {
    // 存储期：adapter 未声明 = error（不能猜落点，§3.4.4）
    this.gate(checkStoragePeriod(this.adapter, decl.storage, decl.span));

    if (decl.arraySize !== undefined) {
      // 数组是 program feature：adapter 未开启 = error（§9.1）
      this.gateProgram('arrays', decl.span);
      const size = this.resolveArraySize(decl);
      const sizeText = decl.arraySize.text.trim();
      if (size !== null && size <= 0 && isIdentifier(sizeText)) {
        this.report(
          'core/decl/bad-array-size',
          `数组“${decl.name}”的长度解析成 ${size}：必须是正整数（或值为正整数的整数 # 常量，§3.4.2）。`,
          decl.arraySize.span,
        );
      }
    }

    if (decl.init === undefined) return;

    if (decl.arraySize !== undefined) {
      this.report(
        'core/decl/bad-initializer',
        `数组“${decl.name}”不允许初值：元素按类型默认值初始化（§3.4.3）。`,
        decl.span,
      );
      return;
    }
    const result = assignable(semaTypeOfLiteral(decl.init), semaTypeOfValueType(decl.valueType));
    if (!result.ok) {
      this.report(
        'core/decl/bad-initializer',
        `变量“${decl.name}”的初值与声明类型不符：${result.reason}（§3.4.3）。`,
        decl.span,
      );
    }
  }

  /** 防御性复核：parser 已把非字面量常量挡在 AST 之外；这里只兜住绕过 parser 的 AST */
  private checkConstDecl(decl: KojoConstDecl): void {
    const raw: unknown = decl.value;
    if (typeof raw !== 'number' && typeof raw !== 'string') {
      this.report(
        'core/decl/const-not-constant',
        `常量“${decl.name}”的值不是字面量：常量初值只允许字面量（§3.4.3）。`,
        decl.span,
      );
      return;
    }
    const result = assignable(semaTypeOfLiteral(raw), semaTypeOfValueType(decl.valueType));
    if (!result.ok) {
      this.report(
        'core/decl/bad-initializer',
        `常量“${decl.name}”的初值与声明类型不符：${result.reason}（§3.4.3）。`,
        decl.span,
      );
    }
  }

  /** 值列同类型：判定只有一份（`table.ts`），这里只上浮 type-mismatch 一条 */
  private checkTableDecl(decl: KojoTableDecl): void {
    const validation = validateTable(decl, { integerConstants: this.constantValues });
    for (const diagnostic of validation.diagnostics) {
      if (diagnostic.code === 'core/table/type-mismatch') this.diagnostics.push(diagnostic);
    }
  }

  /** 池分支可归约性：每个分支至少要能归约出一行可打印内容（§7.1） */
  private checkPoolDecl(decl: KojoPoolDecl): void {
    for (const branch of decl.branches) {
      if (narrativeHasOutput(branch.body)) continue;
      this.report(
        'core/pool/empty-branch',
        `池“${decl.name}”有一个分支归约不出任何可打印内容：每个分支至少要有一行文本（嵌套 ? 也要最终能打印，§7.1）。`,
        branch.span,
      );
    }
  }

  /* ------------------------------ 声明体走法 ------------------------------ */

  private walkDeclarationBodies(): void {
    for (const decl of this.file.decls) {
      switch (decl.kind) {
        case 'function':
          this.analyzeFunction(decl);
          break;
        case 'weave':
        case 'template':
          this.walkNarrative(decl.body, EMPTY_SCOPE);
          break;
        case 'pool':
          for (const branch of decl.branches) {
            if (branch.test !== null) this.checkExpr(branch.test);
            this.walkNarrative(branch.body, EMPTY_SCOPE);
          }
          break;
        default:
          break;
      }
    }
  }

  private analyzeFunction(decl: KojoFunctionDecl): void {
    const params = new Map<string, KojoSemaType>();
    for (const param of decl.params) {
      // 2.0 没有形参类型标注：默认值字面量是唯一的静态类型事实；无默认值 = 动态
      params.set(param.name, param.defaultValue === undefined ? 'unknown' : semaTypeOfLiteral(param.defaultValue));
    }

    const facts = { hasValueReturn: false, hasBareReturn: false };
    this.collectReturns(decl.body, facts);
    const returnsValue = facts.hasValueReturn && !facts.hasBareReturn;
    const flow = this.flowOfDispatchList(decl.body);

    if (facts.hasValueReturn && facts.hasBareReturn) {
      // with-lowering：主链的递归分析把同一条事实落在**具体 @返 行**（更精确），本层不重复
      if (this.reporting === 'standalone') {
        this.report(
          'core/func/return-mixed',
          `函数“${decl.name}”的 @返 混用：既有带值 @返，又有无值 @返——同一函数必须全部有值或全部无值（§7.3）。`,
          decl.span,
        );
      }
    } else if (returnsValue && flow === 'continues') {
      this.report(
        'core/func/missing-return',
        `非 void 函数“${decl.name}”存在不以 @返 结束的可达路径：core 不做隐式默认返回，请补全分支或在末尾写 @返（§7.3）。`,
        decl.span,
      );
    }

    this.functionSymbols.push({
      name: decl.name,
      filePath: this.filePath,
      span: decl.span,
      params: decl.params.map((param) => ({
        name: param.name,
        type: param.defaultValue === undefined ? 'unknown' : semaTypeOfLiteral(param.defaultValue),
        hasDefault: param.defaultValue !== undefined,
        span: param.span,
      })),
      hasValueReturn: facts.hasValueReturn,
      hasBareReturn: facts.hasBareReturn,
      returnsValue,
      returnFlow: flow === 'returns' ? 'returns' : flow === 'continues' ? 'falls-through' : 'unproven',
      allPathsReturn: flow === 'returns',
    });

    this.walkDispatch(decl.body, params);
  }

  /* ------------------------------ 叙事区走法 ------------------------------ */

  private walkNarrative(nodes: readonly KojoNarrativeNode[], scope: Scope): void {
    for (const node of nodes) {
      switch (node.kind) {
        case 'conditionChain':
          for (const branch of node.branches) {
            if (branch.test !== null) this.checkExpr(branch.test);
            this.walkNarrative(branch.body, scope);
          }
          break;
        case 'colorBlock':
          this.gatePresentation('color', node.span);
          this.checkExpr(node.color);
          this.walkNarrative(node.body, scope);
          break;
        case 'faceLine':
          this.gatePresentation('face', node.span);
          for (const arg of node.args) this.checkExpr(arg);
          break;
        case 'optionsBlock':
          this.gatePresentation('options', node.span);
          for (const item of node.items) this.walkNarrative(item.body, scope);
          break;
        case 'randomBlock':
          for (const candidate of node.candidates) {
            if (candidate.kind === 'randomGroup') this.walkNarrative(candidate.body, scope);
          }
          break;
        case 'sandboxBlock':
          this.walkDispatch(node.body, scope);
          break;
        case 'whileLoop':
          this.gateProgram('while', node.span);
          this.checkExpr(node.test);
          this.walkDispatch(node.body, scope);
          break;
        case 'repeatLoop':
          this.gateProgram('repeat', node.span);
          this.checkExpr(node.count);
          this.walkDispatch(node.body, scope);
          break;
        case 'forEachLoop':
          this.gateProgram('foreach', node.span);
          this.checkExpr(node.collection);
          this.walkNarrative(node.body, this.forEachScope(scope, node));
          break;
        case 'label':
        case 'jump':
          this.gateProgram('goto', node.span);
          break;
        case 'textLine':
          this.checkTextLine(node);
          break;
        case 'call':
          this.checkCall(node, scope);
          break;
        default:
          break;
      }
    }
  }

  /** `@巡` 绑定名进入作用域（绑定名真源见 `lower/expand/foreach.ts`；值类型按集合事实补） */
  private forEachScope(scope: Scope, node: KojoForEachLoop): Scope {
    const locals = new Map(scope);
    for (const names of Object.values(FOREACH_COLLECTION_BINDINGS)) {
      for (const name of names) locals.set(name, FOREACH_BINDING_TYPES[name]);
    }
    const collection = node.collection.text.trim();
    if (isIdentifier(collection)) {
      const info = this.decls.get(collection);
      if (info !== undefined && info.isArray) locals.set('值', info.type);
    }
    return locals;
  }

  /* ------------------------------ 调度区走法 ------------------------------ */

  private walkDispatch(nodes: readonly KojoDispatchNode[], scope: Scope): void {
    for (const node of nodes) {
      switch (node.kind) {
        case 'assign':
          this.checkAssign(node, scope);
          break;
        case 'call':
          this.checkCall(node, scope);
          break;
        case 'dispatchCondition':
          for (const branch of node.branches) {
            if (branch.test !== null) this.checkExpr(branch.test);
            this.walkDispatch(branch.body, scope);
          }
          break;
        case 'sandboxBlock':
          this.walkDispatch(node.body, scope);
          break;
        case 'whileLoop':
          this.gateProgram('while', node.span);
          this.checkExpr(node.test);
          this.walkDispatch(node.body, scope);
          break;
        case 'repeatLoop':
          this.gateProgram('repeat', node.span);
          this.checkExpr(node.count);
          this.walkDispatch(node.body, scope);
          break;
        case 'forEachLoop':
          this.gateProgram('foreach', node.span);
          this.checkExpr(node.collection);
          this.walkNarrative(node.body, this.forEachScope(scope, node));
          break;
        case 'label':
        case 'jump':
          this.gateProgram('goto', node.span);
          break;
        case 'faceLine':
          this.gatePresentation('face', node.span);
          for (const arg of node.args) this.checkExpr(arg);
          break;
        case 'textLine':
          this.checkTextLine(node);
          break;
        default:
          break;
      }
    }
  }

  /* ------------------------------ 赋值 ------------------------------ */

  private checkAssign(stmt: KojoAssignStmt, scope: Scope): void {
    this.checkExpr(stmt.value);
    const target = parseTarget(stmt.target.text);
    const rhs = this.inferExprType(stmt.value, scope);
    switch (target.kind) {
      case 'name':
        this.checkNameAssign(target.name, stmt.op, rhs, stmt.target.span, scope);
        return;
      case 'element':
        this.checkElementAssign(target.name, target.index, stmt.op, rhs, stmt.target.span, scope);
        return;
      case 'length':
        this.checkLengthAssign(target.name, stmt.target.span, scope);
        return;
      case 'attribute':
        this.checkAttributeAssign(target.attribute, stmt.op, rhs, stmt.target.span);
        return;
      case 'unknown':
        this.report(
          'core/expr/unknown-symbol',
          `赋值目标 \`${stmt.target.text}\` 解析不到：左边只写 名字 / 数组元素 / {角色}的<属性>（§9.6）。`,
          stmt.target.span,
        );
    }
  }

  private checkNameAssign(
    name: string,
    op: KojoAssignOp,
    rhs: KojoSemaType,
    span: KojoSpan,
    scope: Scope,
  ): void {
    const local = scope.get(name);
    if (local !== undefined) {
      this.checkValueAssign(op, local, rhs, span, `参数 / 循环绑定“${name}”`);
      return;
    }
    const info = this.decls.get(name);
    if (info === undefined) {
      /*
       * 第三档（additive）：adapter 声明的外部变量（`domainSymbols.variables`）。
       * 旧 adapter 省略该面 ⇒ `domainVariable` 恒 null ⇒ 落到下面报未声明（与今天逐字节一致）。
       * 放在文件声明之后：作者文件里的同名声明优先（adapter 不知道作者文件，作者自己的声明更近）。
       */
      const variable = this.domainVariable(name);
      if (variable !== null) {
        /*
         * 数组面（additive；K2-SEMA-WIRING）：整名赋值一律不收——换什么值都不行，
         * 这是"目标形状"问题（与文件内 `# 变量 名 类型[N]` 同一条判据、同一个码）。
         */
        if (variable.isArray) {
          this.report(
            'core/array/whole-assign',
            `“${name}”是外部数组（adapter 的 domainSymbols.variables 声明了 arraySize）：2.0 不支持数组整体赋值，请写元素（\`${name}[下标]\`，§9.2）。`,
            span,
          );
          return;
        }
        if (variable.readonly) {
          this.report(
            'core/expr/readonly-target',
            `域符号变量“${name}”在 adapter 里声明为只读，不能赋值（§9.6）。`,
            span,
          );
          return;
        }
        this.checkValueAssign(op, variable.type, rhs, span, `域符号变量“${name}”`);
        return;
      }
      // adapter 的 `domainSymbols.unknown = 'raw'`：未知符号原样放行（与 checkSymbol 同口径）
      if (this.adapter.domainSymbols.unknown === 'raw') return;
      this.report(
        'core/expr/unknown-symbol',
        `“${name}”没有声明：2.0 禁止对未声明名字赋值（外部变量需由 adapter 的 domainSymbols.variables 声明，§3.4.5）。`,
        span,
      );
      return;
    }
    switch (info.kind) {
      case 'var':
        if (info.isArray) {
          // 目标形状本身不收（换什么值都不行）⇒ 计划面的码，不借用 type-mismatch（S5.6）。
          this.report(
            'core/array/whole-assign',
            `“${name}”是数组：2.0 不支持数组整体赋值，请写元素（\`${name}[下标]\`，§9.2）。`,
            span,
          );
          return;
        }
        this.checkValueAssign(op, info.type, rhs, span, `变量“${name}”`);
        return;
      default:
        this.report(
          'core/expr/assign-to-constant',
          `“${name}”是${DECL_KIND_LABELS[info.kind]}，不能赋值（§9.6）。`,
          span,
        );
    }
  }

  private checkElementAssign(
    name: string,
    index: string,
    op: KojoAssignOp,
    rhs: KojoSemaType,
    span: KojoSpan,
    scope: Scope,
  ): void {
    // 参数 / 循环绑定没有静态数组事实：不猜，直接放行
    if (scope.has(name)) return;
    const info = this.decls.get(name);
    if (info === undefined) {
      /*
       * 第三档（additive）：adapter 声明的**外部数组**。判据与文件内数组同源：
       * 声明了 `arraySize`（`null` 也算）才认下标，否则仍按"不是数组"报（宁缺不猜）。
       */
      const variable = this.domainVariable(name);
      if (variable !== null) {
        if (!variable.isArray) {
          this.report(
            'core/expr/bad-index',
            `“${name}”不是数组：adapter 的 domainSymbols.variables 里它是标量（省略了 arraySize），不能写下标（§9.2）。`,
            span,
          );
          return;
        }
        if (variable.readonly) {
          this.report(
            'core/expr/readonly-target',
            `外部数组“${name}”在 adapter 里声明为只读，不能写元素（§9.6）。`,
            span,
          );
          return;
        }
        this.checkIndex(index, variable.arraySize, span);
        this.checkValueAssign(op, variable.type, rhs, span, `外部数组“${name}”的元素`);
        return;
      }
      if (this.adapter.domainSymbols.unknown === 'raw') return;
      this.report(
        'core/expr/unknown-symbol',
        `数组“${name}”没有声明：2.0 禁止对未声明名字赋值（§3.4.5）。`,
        span,
      );
      return;
    }
    if (info.kind !== 'var' || !info.isArray) {
      this.report(
        'core/expr/bad-index',
        `“${name}”不是数组：下标语法只用于 \`# 变量 名 类型[N]\` 声明的一维数组（§9.2）。`,
        span,
      );
      return;
    }
    this.checkIndex(index, info.arraySize, span);
    this.checkValueAssign(op, info.type, rhs, span, `数组“${name}”的元素`);
  }

  private checkLengthAssign(name: string, span: KojoSpan, scope: Scope): void {
    if (scope.has(name)) return;
    const info = this.decls.get(name);
    if (info === undefined) {
      // 外部数组也有声明长度（`.长度` 同口径）；标量外部变量与未声明名走同一条"没有 .长度"
      const variable = this.domainVariable(name);
      if (variable !== null && variable.isArray) {
        this.report(
          'core/expr/readonly-target',
          `“${name}.长度”是只读的声明长度（adapter 的 domainSymbols.variables.arraySize），不能赋值（§9.2）。`,
          span,
        );
        return;
      }
      if (variable !== null) {
        this.report(
          'core/expr/bad-index',
          `“${name}”没有 \`.长度\`：adapter 的 domainSymbols.variables 里它是标量（省略了 arraySize）（§9.2）。`,
          span,
        );
        return;
      }
      if (this.adapter.domainSymbols.unknown === 'raw') return;
      this.report(
        'core/expr/unknown-symbol',
        `“${name}”没有声明：不能给未声明名字的 \`.长度\` 赋值（§9.2）。`,
        span,
      );
      return;
    }
    if (info.kind !== 'var' || !info.isArray) {
      this.report(
        'core/expr/bad-index',
        `“${name}”没有 \`.长度\`：该属性只属于 \`# 变量 名 类型[N]\` 声明的一维数组（§9.2）。`,
        span,
      );
      return;
    }
    this.report(
      'core/expr/readonly-target',
      `“${name}.长度”是只读的声明长度，不能赋值（§9.2）。`,
      span,
    );
  }

  private checkAttributeAssign(
    attribute: string,
    op: KojoAssignOp,
    rhs: KojoSemaType,
    span: KojoSpan,
  ): void {
    const type = this.attributeType(attribute);
    if (type === null) {
      if (this.adapter.domainSymbols.unknown === 'raw') return;
      this.report(
        'core/expr/unknown-symbol',
        `角色属性“${attribute}”未声明：当前 adapter 的 domainSymbols.attributes 里没有它（§9.6）。`,
        span,
      );
      return;
    }
    const attr = this.adapter.domainSymbols.attributes.find((item) => item.name === attribute);
    if (attr !== undefined && attr.readonly) {
      this.report(
        'core/expr/readonly-target',
        `角色属性“${attribute}”在 adapter 里声明为只读，不能赋值（§9.6）。`,
        span,
      );
      return;
    }
    this.checkValueAssign(op, type, rhs, span, `角色属性“${attribute}”`);
  }

  /** 赋值类型判定（增量运算符只用于整数；字符串只做整体赋值，§9.6） */
  private checkValueAssign(
    op: KojoAssignOp,
    target: KojoSemaType,
    rhs: KojoSemaType,
    span: KojoSpan,
    label: string,
  ): void {
    if (op !== '=') {
      if (target === 'string') {
        this.report(
          'core/expr/type-mismatch',
          `${label} 用了 \`${op}\`：增量运算符只用于整数；字符串只能整体赋值（§9.6）。`,
          span,
        );
        return;
      }
      if (target !== 'int' && target !== 'character' && target !== 'unknown') {
        this.report(
          'core/expr/type-mismatch',
          `${label} 用了 \`${op}\`：增量运算符要求整数目标（§9.6）。`,
          span,
        );
        return;
      }
    }
    const result = assignable(rhs, target);
    if (!result.ok) {
      this.report('core/expr/type-mismatch', `${label}：${result.reason}（§3.4.2）。`, span);
    }
  }

  /** 下标静态判定：只判字面量与整数常量（§9.2：动态下标不做自动边界检查） */
  private checkIndex(text: string, size: number | null, span: KojoSpan): void {
    const trimmed = text.trim();
    const literal = decodeIntegerLiteral(trimmed);
    if (literal !== null) {
      this.checkBounds(literal, size, span);
      return;
    }
    if (isIdentifier(trimmed)) {
      const info = this.decls.get(trimmed);
      if (info === undefined) return; // 未声明 / adapter 符号：不猜
      if (info.kind !== 'const') return;
      if (info.type !== 'int') {
        this.report(
          'core/expr/bad-index',
          `下标“${trimmed}”是${semaTypeLabel(info.type)}常量：数组下标必须是整数（§9.2）。`,
          span,
        );
        return;
      }
      const value = this.constantValues.get(trimmed);
      if (value !== undefined) this.checkBounds(value, size, span);
      return;
    }
    if (decodeQuotedLiteral(trimmed) !== null) {
      this.report(
        'core/expr/bad-index',
        '数组下标是字符串字面量：下标必须是整数（§9.2）。',
        span,
      );
      return;
    }
    // 其余表达式：静态证不出越界（§9.2 不做自动边界检查）
  }

  private checkBounds(index: number, size: number | null, span: KojoSpan): void {
    if (index < 0) {
      this.report(
        'core/expr/index-out-of-range',
        `数组下标 ${index} 为负：下标 0 基，合法范围从 0 开始（§9.2）。`,
        span,
      );
      return;
    }
    if (size !== null && index >= size) {
      this.report(
        'core/expr/index-out-of-range',
        `数组下标 ${index} 越界：声明长度 ${size}，合法范围 0..${size - 1}（§9.2）。`,
        span,
      );
    }
  }

  /* ------------------------------ 函数调用 ------------------------------ */

  /**
   * `! 函名(...)` 的实参个数与实参/形参默认值类型。
   *
   * 个数（S5.6 additive，`core/func/arg-count`）：2.0 只按位置传参、没有可变参数，
   * 缺必填 / 多给都落不到函数签名上——此前**静默**（产物照发，语义由引擎猜）。
   * 类型：2.0 没有形参类型标注：默认值字面量是唯一的静态类型事实；无默认值的形参是动态类型，
   * 传什么都不判（§7.3：core 不做跨函数类型推断）。
   */
  private checkCall(call: KojoCallStmt, scope: Scope): void {
    for (const arg of call.args) this.checkExpr(arg);
    const fn = this.functions.get(call.name);
    if (fn !== undefined) {
      this.checkArgCount(call, fn);
      for (let index = 0; index < call.args.length; index++) {
        const arg = call.args[index]!;
        const param = fn.params[index];
        if (param === undefined || param.defaultValue === undefined) continue;
        const expected = semaTypeOfLiteral(param.defaultValue);
        const result = assignable(this.inferExprType(arg, scope), expected);
        if (!result.ok) {
          this.report(
            'core/expr/type-mismatch',
            `函数“${call.name}”第 ${index + 1} 个参数“${param.name}”的默认值是${semaTypeLabel(expected)}：${result.reason}（§7.3）。`,
            arg.span,
          );
        }
      }
    }
    if (call.body !== undefined) this.walkNarrative(call.body, scope);
  }

  /**
   * 实参个数判定（`core/func/arg-count`；只对**本文件已声明**的 `@函` 做，外部名字不猜）。
   *
   * 必填下界按**位置**取：最后一个"没有默认值"的形参的序号 + 1——默认值可以写在中间
   * （parser 不强制尾部），若只看"无默认值形参个数"，`函(a=1, b)` 给 1 个实参就会被
   * 误判成"没缺"。上界 = 形参表长度。
   */
  private checkArgCount(call: KojoCallStmt, fn: KojoFunctionDecl): void {
    const params = fn.params;
    const given = call.args.length;
    if (given > params.length) {
      this.report(
        'core/func/arg-count',
        `函数“${call.name}”只有 ${params.length} 个形参：多出的 ${given - params.length} 个实参不会传给函数（§7.3）。`,
        call.span,
      );
      return;
    }
    let required = 0;
    for (let index = 0; index < params.length; index++) {
      if (params[index]!.defaultValue === undefined) required = index + 1;
    }
    if (given < required) {
      const param = params[required - 1]!;
      this.report(
        'core/func/arg-count',
        `函数“${call.name}”的第 ${required} 个形参“${param.name}”没有默认值：实参至少要给 ${required} 个，这里只给了 ${given} 个（§7.3）。`,
        call.span,
      );
    }
  }

  /* ------------------------------ 表达式里的数组下标 ------------------------------ */

  /**
   * 扫一个表达式切片里的 `名字[下标]`（跳过 `"…"`），对**已声明数组**的字面量/整数常量下标
   * 做越界判定（§9.2：动态下标不做自动边界检查）。
   *
   * 不解析表达式语法（那是表达式管线的事）：只识别"名字紧跟 `[`"这一种最保守的位置。
   */
  private checkExpr(expr: KojoExprText): void {
    const text = expr.text;
    let index = 0;
    while (index < text.length) {
      const ch = text[index]!;
      if (ch === '"') {
        index = skipQuoted(text, index);
        continue;
      }
      if (!IDENT_START_RE.test(ch)) {
        index++;
        continue;
      }
      const start = index;
      index++;
      while (index < text.length && IDENT_PART_RE.test(text[index]!)) index++;
      const name = text.slice(start, index);
      let cursor = index;
      while (cursor < text.length && (text[cursor] === ' ' || text[cursor] === '\t')) cursor++;
      if (text[cursor] !== '[') continue;
      const end = bracketEnd(text, cursor);
      if (end < 0) continue;
      const info = this.decls.get(name);
      if (info !== undefined && info.kind === 'var' && info.isArray) {
        this.checkIndex(text.slice(cursor + 1, end), info.arraySize, this.spanWithin(expr, cursor, end - cursor + 1));
      } else if (info === undefined) {
        // 外部数组（additive）：与文件内数组同一条越界判据
        const variable = this.domainVariable(name);
        if (variable !== null && variable.isArray) {
          this.checkIndex(text.slice(cursor + 1, end), variable.arraySize, this.spanWithin(expr, cursor, end - cursor + 1));
        }
      }
      index = end + 1;
    }
  }

  /** 表达式切片内的局部偏移 → 源文件 span（1 基行 / UTF-16 列，与 ast 同口径） */
  private spanWithin(expr: KojoExprText, offset: number, length: number): KojoSpan {
    const toGlobal = (local: { readonly line: number; readonly column: number }) =>
      local.line === 1
        ? { line: expr.span.start.line, column: expr.span.start.column + local.column - 1 }
        : { line: expr.span.start.line + local.line - 1, column: local.column };
    return {
      start: toGlobal(offsetToPosition(expr.text, offset)),
      end: toGlobal(offsetToPosition(expr.text, offset + length)),
    };
  }

  private checkTextLine(line: KojoTextLine): void {
    for (const part of line.parts) {
      if (part.kind === 'text') continue;
      this.checkExpr(part.expr);
      if (part.cond !== undefined) {
        this.checkExpr(part.cond.cond);
        this.checkExpr(part.cond.then);
        this.checkExpr(part.cond.else);
      }
    }
  }

  /* ------------------------------ 表达式类型推断（保守） ------------------------------ */

  private resolveName(name: string, scope: Scope): KojoSemaType {
    const local = scope.get(name);
    if (local !== undefined) return local;
    const info = this.decls.get(name);
    if (info === undefined) {
      const variable = this.domainVariable(name);
      // 裸外部数组名没有静态值语义（元素要靠下标）：不猜，留 unknown
      if (variable === null || variable.isArray) return 'unknown';
      return variable.type;
    }
    if (info.kind === 'function' || info.kind === 'pool' || info.kind === 'template') return 'unknown';
    return info.type;
  }

  /**
   * adapter 外部变量（`domainSymbols.variables`）的静态事实；`null` = 本 adapter 没声明它。
   *
   * 旧 adapter 省略这一面 ⇒ 恒 `null` ⇒ 名字解析链与今天**逐字节一致**（仍报未声明）。
   * `valueKind` 直接进值类型格：`character` 只可能从这里来（AST 的 `# 变量` 没有这个词）。
   *
   * 数组面（additive；K2-SEMA-WIRING）：`arraySize` 键**存在**（含 `null`）= 数组；
   * 元素类型 = `elementKind ?? valueKind`（adapter 不另给元素类型时，条目的 valueKind 就是
   * 元素类型）；`arraySize: null` = 长度不可静态求值 ⇒ 认下标但不判越界。
   */
  private domainVariable(name: string): DomainVariableFact | null {
    const found = findDomainVariable(this.adapter, name);
    if (found === undefined) return null;
    const isArray = found.arraySize !== undefined;
    return {
      type: found.elementKind ?? found.valueKind,
      readonly: found.readonly === true,
      isArray,
      arraySize: isArray ? (found.arraySize ?? null) : null,
    };
  }

  private attributeType(attribute: string): KojoSemaType | null {
    const found = this.adapter.domainSymbols.attributes.find((item) => item.name === attribute);
    return found === undefined ? null : semaTypeOfValueType(found.valueKind);
  }

  private isNameFunction(name: string): boolean {
    return this.adapter.domainSymbols.nameFunctions.some((item) => item.name === name);
  }

  private inferExprType(expr: KojoExprText, scope: Scope): KojoSemaType {
    const text = expr.text.trim();
    if (text.length === 0) return 'unknown';
    if (decodeQuotedLiteral(text) !== null) return 'string';
    const literal = decodeIntegerLiteral(text);
    if (literal !== null) return 'int';

    const braceRef = BRACE_REF_RE.exec(text);
    if (braceRef !== null) return this.resolveName(braceRef[1]!, scope);

    const attribute = ATTRIBUTE_RE.exec(text);
    if (attribute !== null) return this.attributeType(attribute[2]!.trim()) ?? 'unknown';

    const lengthRef = LENGTH_REF_RE.exec(text);
    if (lengthRef !== null) {
      const info = this.decls.get(lengthRef[1]!);
      if (info !== undefined) return info.isArray ? 'int' : 'unknown';
      // 外部数组的 `.长度` 也是声明长度（additive 数组面）
      return this.domainVariable(lengthRef[1]!)?.isArray === true ? 'int' : 'unknown';
    }

    const elementRef = ELEMENT_REF_RE.exec(text);
    if (elementRef !== null) {
      const info = this.decls.get(elementRef[1]!);
      if (info !== undefined) return info.isArray ? info.type : 'unknown';
      const variable = this.domainVariable(elementRef[1]!);
      return variable !== null && variable.isArray ? variable.type : 'unknown';
    }

    if (isIdentifier(text)) {
      const local = scope.get(text);
      if (local !== undefined) return local;
      const info = this.decls.get(text);
      if (info !== undefined) {
        if (info.kind === 'function' || info.kind === 'pool' || info.kind === 'template') return 'unknown';
        return info.type;
      }
      const variable = this.domainVariable(text);
      // 裸外部数组名（additive）：元素要靠下标取，裸名没有静态值语义 ⇒ 不猜
      if (variable !== null) return variable.isArray ? 'unknown' : variable.type;
      return this.isNameFunction(text) ? 'string' : 'unknown';
    }
    return 'unknown';
  }

  /* ------------------------------ 返回路径（保守三态） ------------------------------ */

  private collectReturns(nodes: readonly KojoDispatchNode[], facts: { hasValueReturn: boolean; hasBareReturn: boolean }): void {
    for (const node of nodes) {
      switch (node.kind) {
        case 'return':
          if (node.value === undefined) facts.hasBareReturn = true;
          else facts.hasValueReturn = true;
          break;
        case 'dispatchCondition':
          for (const branch of node.branches) this.collectReturns(branch.body, facts);
          break;
        case 'sandboxBlock':
        case 'whileLoop':
        case 'repeatLoop':
          this.collectReturns(node.body, facts);
          break;
        case 'forEachLoop':
          this.collectReturnsFromNarrative(node.body, facts);
          break;
        case 'call':
          if (node.body !== undefined) this.collectReturnsFromNarrative(node.body, facts);
          break;
        default:
          break;
      }
    }
  }

  private collectReturnsFromNarrative(
    nodes: readonly KojoNarrativeNode[],
    facts: { hasValueReturn: boolean; hasBareReturn: boolean },
  ): void {
    for (const node of nodes) {
      switch (node.kind) {
        case 'conditionChain':
          for (const branch of node.branches) this.collectReturnsFromNarrative(branch.body, facts);
          break;
        case 'colorBlock':
          this.collectReturnsFromNarrative(node.body, facts);
          break;
        case 'optionsBlock':
          for (const item of node.items) this.collectReturnsFromNarrative(item.body, facts);
          break;
        case 'randomBlock':
          for (const candidate of node.candidates) {
            if (candidate.kind === 'randomGroup') this.collectReturnsFromNarrative(candidate.body, facts);
          }
          break;
        case 'sandboxBlock':
        case 'whileLoop':
        case 'repeatLoop':
          this.collectReturns(node.body, facts);
          break;
        case 'forEachLoop':
          this.collectReturnsFromNarrative(node.body, facts);
          break;
        case 'call':
          if (node.body !== undefined) this.collectReturnsFromNarrative(node.body, facts);
          break;
        default:
          break;
      }
    }
  }

  private flowOfDispatchList(nodes: readonly KojoDispatchNode[]): Flow {
    let sawUnknown = false;
    for (const node of nodes) {
      const flow = this.flowOfDispatchNode(node);
      if (flow === 'returns') return 'returns';
      if (flow === 'unknown') sawUnknown = true;
    }
    return sawUnknown ? 'unknown' : 'continues';
  }

  private flowOfDispatchNode(node: KojoDispatchNode): Flow {
    switch (node.kind) {
      case 'return':
        return 'returns';
      case 'dispatchCondition':
        return this.flowOfBranches(node.branches, (body) => this.flowOfDispatchList(body));
      case 'sandboxBlock':
        return this.flowOfDispatchList(node.body);
      case 'whileLoop':
      case 'repeatLoop':
      case 'forEachLoop':
        // 循环可能零轮、也可能永不退出：证不出"每条路径都返回"，也证不出"一定落空"
        return 'unknown';
      case 'jump':
        return 'unknown';
      case 'nativeBlock':
        // 原生块里可能有 return / goto：不解释，保守
        return 'unknown';
      default:
        return 'continues';
    }
  }

  private flowOfNarrativeList(nodes: readonly KojoNarrativeNode[]): Flow {
    let sawUnknown = false;
    for (const node of nodes) {
      const flow = this.flowOfNarrativeNode(node);
      if (flow === 'returns') return 'returns';
      if (flow === 'unknown') sawUnknown = true;
    }
    return sawUnknown ? 'unknown' : 'continues';
  }

  private flowOfNarrativeNode(node: KojoNarrativeNode): Flow {
    switch (node.kind) {
      case 'conditionChain':
        return this.flowOfBranches(node.branches, (body) => this.flowOfNarrativeList(body));
      case 'colorBlock':
        return this.flowOfNarrativeList(node.body);
      case 'sandboxBlock':
        return this.flowOfDispatchList(node.body);
      case 'whileLoop':
      case 'repeatLoop':
      case 'forEachLoop':
        return 'unknown';
      case 'jump':
        return 'unknown';
      case 'nativeBlock':
        return 'unknown';
      case 'optionsBlock':
        // 玩家选择哪一条无法静态确定
        return 'unknown';
      case 'randomBlock': {
        for (const candidate of node.candidates) {
          if (candidate.kind === 'randomGroup' && this.flowOfNarrativeList(candidate.body) !== 'continues') {
            return 'unknown';
          }
        }
        return 'continues';
      }
      default:
        return 'continues';
    }
  }

  private flowOfBranches<T>(
    branches: readonly { readonly test: KojoExprText | null; readonly body: readonly T[] }[],
    bodyFlow: (body: readonly T[]) => Flow,
  ): Flow {
    if (branches.length === 0) return 'continues';
    const hasElse = branches[branches.length - 1]!.test === null;
    let sawContinues = false;
    let sawUnknown = false;
    for (const branch of branches) {
      const flow = bodyFlow(branch.body);
      if (flow === 'continues') sawContinues = true;
      else if (flow === 'unknown') sawUnknown = true;
    }
    if (hasElse && !sawContinues && !sawUnknown) return 'returns';
    if (sawContinues || !hasElse) return 'continues';
    return sawUnknown ? 'unknown' : 'returns';
  }
}

/** `# 表` 的值类型（全部行同类型才算数；混类型已由 validateTable 报错，这里给 unknown） */
function tableValueType(decl: KojoTableDecl): KojoSemaType {
  let type: KojoSemaType | null = null;
  for (const row of decl.rows) {
    const rowType: KojoSemaType = typeof row.value === 'number' ? 'int' : 'string';
    if (type === null) type = rowType;
    else if (type !== rowType) return 'unknown';
  }
  return type ?? 'unknown';
}
