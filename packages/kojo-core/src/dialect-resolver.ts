/**
 * 方言解析（LAU-D1；`ARCH-language-unification.md` §5.3 / §5.4 第 1、2 行）。
 *
 * **这是一个薄壳**：它只做"解析 + 对账 + 归属"，不产生事实、不读盘、不认游戏。
 * 真源仍是已经上线的那条识别链（内核轮询全部 `game.adapter` 候选 → `adapter.detect()` →
 * 恰一命中才 `loadProject`，并强制 `project.adapterId === gameId`），
 * 本文件吃的是它的**结论**（`project.adapterId`），不是它的过程：
 *
 * 1. **识别链结论**（`detectedDialect`）——默认口径；
 * 2. **工作区 `meta` 覆盖**（`workspaceOverride`）——作者显式说"这个工程按某方言对待"；
 *    与识别链不一致 ⇒ `core/dialect/mismatch`（error）**并以覆盖为准**（冲突可见，铁律 4）；
 * 3. **文件内的方言断言**（`fileAssertion`，由语言层解析 `# 方言 <id>` 后**注入**）——
 *    只自证、不赋值：与解析结果不一致同样报 `core/dialect/mismatch`，
 *    解析结果**不因断言而改变**（否则就是第三真源）；
 * 4. 三者都拿不到 ⇒ **未绑定**：`binding = null` + 一条 `core/dialect/unbound`。
 *
 * ⚠ 本文件**没有** `fallbackDialect` 这一格，也不写任何默认方言常量（D12）：
 * 未绑定就交出空事实，绝不借别方言的事实给当前文件出提示。
 *
 * 依赖方向：只吃 `adapter.ts` 的契约类型与 `diagnostics.ts` 的码表，**不 import** kernel /
 * plugin-api（内核零游戏知识、契约层零依赖），故 `facts` 由调用方以查询函数注入。
 */
import type { CarrierBinding, DialectBinding, DialectFactKind, DialectId, GameAdapter } from './adapter.js';
import type { CoreDiagnosticCode, KojoDiagnostic } from './diagnostics.js';
import { severityOf } from './diagnostics.js';

/* ============================== 1. 输入形状 ============================== */

/** `resolveDialectBinding` 的输入（全部为**已解析好的值**；本层零 IO、零异步） */
export interface ResolveDialectBindingInput {
  /** 识别链结论（`project.adapterId`）；`null` = 没认出工程（未打开工程 / `detect()` 零命中） */
  readonly detectedDialect: DialectId | null;
  /** 工作区 `meta` 的显式覆盖（`workspace.json` 的 `meta.dialect`）；缺省 / `null` = 没有覆盖 */
  readonly workspaceOverride?: DialectId | null;
  /**
   * 文件内的方言**断言**（`# 方言 <id>` 的取值）。
   * 由语言层（文法 + 词位）解析后注入——本批不碰文法，只把它当字符串吃；
   * 缺省 / `null` = 这份文件没有自证。
   */
  readonly fileAssertion?: DialectId | null;
  /**
   * 方言 id → 事实（`GameAdapter`）的**查询函数**，由宿主注册表提供。
   * 返回 `null` / `undefined` = 该方言没有 2.0 事实面（今天有四枚只有 v1 面的适配器）⇒
   * 按未绑定处理，**不猜**、不借别方言的表。
   */
  readonly factsFor?: (dialect: DialectId) => GameAdapter | null | undefined;
  /**
   * 待归属的文件路径（**相对项目根**、分隔符归一为正斜杠；绝对路径请由调用方先剥掉根前缀）。
   * 给了且该方言声明了 `carriers` ⇒ 做载体归属；缺省 = 不做归属（`binding.carrier = null`，
   * 且**不报** `core/carrier/unowned`——没问就不判）。
   */
  readonly filePath?: string | null;
}

/** 解析结果：`kind` 说明这一格到底绑上了没有，`diagnostics` 一律可见（不静默） */
export type DialectBindingResolution =
  /** 绑定成功且无冲突（`diagnostics` 可能仍有 `core/carrier/unowned` 这类 warning） */
  | { readonly kind: 'bound'; readonly binding: DialectBinding; readonly diagnostics: readonly KojoDiagnostic[] }
  /** 断言/覆盖与识别链对不上：**以覆盖为准**出结果，同时报告冲突（error） */
  | {
      readonly kind: 'mismatch';
      readonly binding: DialectBinding | null;
      readonly resolvedDialect: DialectId;
      readonly diagnostics: readonly KojoDiagnostic[];
    }
  /** 未绑定：没有可用方言 id，或有 id 但该方言没有 2.0 事实面 ⇒ 事实类一律降级 */
  | {
      readonly kind: 'unbound';
      readonly binding: null;
      readonly resolvedDialect: DialectId | null;
      readonly diagnostics: readonly KojoDiagnostic[];
    };

/* ============================== 2. glob 归属（纯函数） ============================== */

/** glob 里需要转义的正则元字符（`*` / `?` 由本层自己展开，不进这里） */
const GLOB_META = /[.^$+{}()|[\]\\]/g;

function escapeLiteral(ch: string): string {
  return ch.replace(GLOB_META, '\\$&');
}

/**
 * 载体 glob 的**匹配子集**（口径写死，别扩）：
 * - 分隔符固定 `/`；glob 与路径都先过 `normalizePath`（反斜杠 → 正斜杠、剥开头的 `./`），
 *   两侧同一套归一，免得"写在 glob 里的 `./`"变成永远命中不了的条件；
 * - `*` = 不跨段的一串；`?` = 段内单字；`**` = 跨段；`**` 紧跟一个分隔符时额外吞掉自己那一段（可缺省）；
 * - **大小写敏感**（归属是数据不是宽恕：盘上的路径大小写不一致就该判不出来，而不是悄悄并档）；
 * - 不支持花括号展开——需要两枚落点就写两条 `carriers`（数据比语法好读）。
 */
export function carrierGlobMatches(glob: string, path: string): boolean {
  const normalized = normalizePath(path);
  let pattern = '';
  let i = 0;
  const source = normalizePath(glob);
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === '*') {
      const double = source[i + 1] === '*';
      i += double ? 2 : 1;
      if (double && source[i] === '/') {
        i += 1;
        pattern += '(?:.*/)?';
      } else {
        pattern += double ? '.*' : '[^/]*';
      }
      continue;
    }
    if (ch === '?') {
      pattern += '[^/]';
      i += 1;
      continue;
    }
    pattern += escapeLiteral(ch);
    i += 1;
  }
  let re: RegExp;
  try {
    re = new RegExp(`^${pattern}$`, 'u');
  } catch {
    // 归一化后的 pattern 理论上不会失配；真失配就当"不命中"——判不出归属比判错归属好，
    // 且调用方会因未命中而报 `core/carrier/unowned`，不会静默。
    return false;
  }
  return re.test(normalized);
}

/** 路径归一：反斜杠 → 正斜杠、剥掉开头的 `./`（大小写**不动**） */
function normalizePath(path: string): string {
  const slashed = path.replaceAll('\\', '/');
  return slashed.startsWith('./') ? slashed.slice(2) : slashed;
}

/**
 * 一条归属声明里**实际参与校验的事实类**（`validates` 省略 = 全部四格）。
 * 供 LAU-D2/D3 的接线用，本批不做校验发射。
 */
export function factKindsOf(binding: CarrierBinding): readonly DialectFactKind[] {
  return binding.validates ?? ['event', 'symbol', 'presentation', 'storage'];
}

/**
 * 找出这份文件的载体归属（声明顺序 = 优先顺序，第一条命中即返回）。
 * 该方言**没声明** `carriers` 时返回 `undefined`，与"声明了但没命中"是两件事——
 * 后者要报 `core/carrier/unowned`，前者什么都不报（未声明 = 合法缺省）。
 */
export function findCarrierBinding(
  adapter: GameAdapter,
  filePath: string,
): CarrierBinding | undefined {
  const carriers = adapter.carriers;
  if (carriers === undefined || carriers.length === 0) return undefined;
  return carriers.find((binding) => carrierGlobMatches(binding.glob, filePath));
}

/* ============================== 3. 诊断构造（不静默） ============================== */

function make(code: CoreDiagnosticCode, message: string): KojoDiagnostic {
  return Object.freeze({ code, severity: severityOf(code), message, span: null });
}

/** 方言 id 的可用性判定：非空、去空白后仍有内容（空白串当"没有这一格"，不当方言名） */
function usableDialect(value: DialectId | null | undefined): DialectId | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/* ============================== 4. 解析主函数 ============================== */

/**
 * 解析这份文件/这次请求的方言绑定。
 *
 * 判定顺序（**写死，别调**）：
 * 1. `effective = 覆盖 ?? 识别链`——覆盖优先（作者的显式意志），但冲突一定进 diagnostics；
 * 2. 断言只做**对账**：与 `effective` 不符 ⇒ `core/dialect/mismatch`；`effective` 为空时
 *    断言同样**不能**把方言绑上（只断言不赋值），此时也是 mismatch + 未绑定；
 * 3. `effective` 非空但查不到事实 ⇒ 未绑定（带该方言名的 `core/dialect/unbound`）；
 * 4. 绑上了且给了 `filePath` ⇒ 按 `carriers` 定载体；声明了却没命中 ⇒ `core/carrier/unowned`。
 *
 * 任何分支都**不回落默认方言**，也不返回"半个事实"。
 */
export function resolveDialectBinding(input: ResolveDialectBindingInput): DialectBindingResolution {
  const detected = usableDialect(input.detectedDialect);
  const override = usableDialect(input.workspaceOverride);
  const assertion = usableDialect(input.fileAssertion);
  const diagnostics: KojoDiagnostic[] = [];

  /* ① 覆盖 vs 识别链 */
  const effective = override ?? detected;
  if (override !== null && detected !== null && override !== detected) {
    diagnostics.push(
      make(
        'core/dialect/mismatch',
        `方言冲突：工作区覆盖为 ${override}，识别链结论为 ${detected}——按覆盖（${override}）处理，冲突已记录。`,
      ),
    );
  }

  /* ② 文件断言只自证，不赋值 */
  if (assertion !== null) {
    if (effective !== null && assertion !== effective) {
      diagnostics.push(
        make(
          'core/dialect/mismatch',
          `方言冲突：文件内断言为 ${assertion}，解析结果（${override !== null ? '工作区覆盖' : '识别链'}）为 ${effective}` +
            '——断言只自证、不改变解析结果，冲突已记录。',
        ),
      );
    } else if (effective === null) {
      diagnostics.push(
        make(
          'core/dialect/mismatch',
          `文件内断言为 ${assertion}，但没有可对照的解析结果（识别链没认下工程、也没有工作区覆盖）` +
            '——断言不产生方言绑定，按未绑定处理。',
        ),
      );
    }
  }

  /* ③ 未绑定：没有方言 id ⇒ 事实类为空 */
  if (effective === null) {
    diagnostics.push(
      make(
        'core/dialect/unbound',
        '未绑定方言：识别链没有结论、工作区也没有覆盖 ⇒ 事实类服务按无事实降级（不回落到任何默认方言）。',
      ),
    );
    return freeze({ kind: 'unbound', binding: null, resolvedDialect: null, diagnostics });
  }

  const facts = input.factsFor?.(effective) ?? null;
  if (facts === null) {
    diagnostics.push(
      make(
        'core/dialect/unbound',
        `方言 ${effective} 已认出，但没有 2.0 事实面（该方言的 GameAdapter 未注册）` +
          '⇒ 2.0 事实类服务按无事实降级；v1 面不受这一格影响。',
      ),
    );
    return freeze({ kind: 'unbound', binding: null, resolvedDialect: effective, diagnostics });
  }

  /* ④ 载体归属 */
  let carrier: DialectBinding['carrier'] = null;
  let validates: readonly DialectFactKind[] | undefined;
  const filePath = typeof input.filePath === 'string' ? normalizePath(input.filePath) : null;
  const declaredCarriers = facts.carriers ?? [];
  if (filePath !== null && declaredCarriers.length > 0) {
    const matched = findCarrierBinding(facts, filePath);
    if (matched === undefined) {
      diagnostics.push(
        make(
          'core/carrier/unowned',
          `文件 ${filePath} 不在方言 ${effective} 声明的任何载体归属里（carriers 的 glob 都没命中）` +
            '：这一面的载体级校验跳过。',
        ),
      );
    } else {
      carrier = matched.carrier;
      validates = matched.validates;
    }
  }

  const binding: DialectBinding = Object.freeze({
    dialect: effective,
    facts,
    factsVersion: facts.version,
    carrier,
    ...(validates === undefined ? {} : { validates }),
  });

  const kind = diagnostics.some((item) => item.code === 'core/dialect/mismatch') ? 'mismatch' : 'bound';
  return freeze(
    kind === 'mismatch'
      ? { kind: 'mismatch' as const, binding, resolvedDialect: effective, diagnostics }
      : { kind: 'bound' as const, binding, diagnostics },
  );
}

/** 结果深冻结：解析产物是只读数据，供方拿到也不许改（与 `freezeAdapter` 同一口径） */
function freeze<T extends { readonly diagnostics: readonly KojoDiagnostic[] }>(value: T): T {
  return Object.freeze({ ...value, diagnostics: Object.freeze([...value.diagnostics]) });
}
