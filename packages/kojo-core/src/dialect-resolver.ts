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
 * 5. **事实对账**：`factsFor(effective)` 交回的事实 `GameAdapter.id` 必须等于 `effective`；
 *    不等 ⇒ `core/dialect/response-mismatch`（error）并**按未绑定返回**（不给半个事实）。
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
   *
   * 交回的事实必须**自证同源**：`GameAdapter.id === dialect`。不等 ⇒
   * `core/dialect/response-mismatch` 并按未绑定返回（查询表映错键时绝不静默通过）。
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
  /**
   * 未绑定：没有可用方言 id，或有 id 但该方言没有 2.0 事实面，或交回的事实自证的是
   * **另一个**方言（`core/dialect/response-mismatch`）⇒ 事实类一律降级（绝不返回半个事实）。
   */
  | {
      readonly kind: 'unbound';
      readonly binding: null;
      readonly resolvedDialect: DialectId | null;
      readonly diagnostics: readonly KojoDiagnostic[];
    };

/* ============================== 2. glob 归属（纯函数） ============================== */

/**
 * 载体 glob 的**匹配子集**（口径写死，别扩）：
 * - 分隔符固定 `/`；glob 与路径都先过 `normalizePath`（反斜杠 → 正斜杠、剥开头的 `./`），
 *   两侧同一套归一，免得"写在 glob 里的 `./`"变成永远命中不了的条件；
 * - `*` = 不跨段的一串；`?` = 段内单字；`**` = 跨段；`**` 紧跟一个分隔符时额外吞掉自己那一段（可缺省）；
 * - **大小写敏感**（归属是数据不是宽恕：盘上的路径大小写不一致就该判不出来，而不是悄悄并档）；
 * - 不支持花括号展开——需要两枚落点就写两条 `carriers`（数据比语法好读）。
 *
 * ## 实现口径（别改回正则展开）
 *
 * 旧实现把跨段量词展成正则交给引擎：失配时要试遍组合切分，实测指数级（读数见
 * `tests/dialect-carriers.test.ts` 头注）。这里改成**按字符的记忆化 DP**，
 * 每条 `(模式位置, 路径位置)` 只算一次，O(|glob| × |path|)，语义逐字同义。
 * 非字符串入参（宿主装载从不跑 `validateGameAdapter`）按**不命中**返回，绝不抛。
 */
export function carrierGlobMatches(glob: string, path: string): boolean {
  if (typeof glob !== 'string' || typeof path !== 'string') return false;
  const pattern = normalizePath(glob);
  const target = normalizePath(path);
  const plen = pattern.length;
  const tlen = target.length;
  const stride = tlen + 1;
  /** `match(pi, si)` 的记忆表；`star(...)` 单独一张（键空间不同，不能混） */
  const matchMemo = new Map<number, boolean>();
  const starMemo = new Map<number, boolean>();

  /**
   * 星号（`*` 或 `**`）：吞 ≥0 个字符后从 `np` 继续。
   * `cross` = 跨段（`**`）时可吞 `/`；否则遇到 `/` 就得停（`*` 不跨段）。
   */
  const star = (np: number, si: number, cross: boolean): boolean => {
    const key = (np * stride + si) * 2 + (cross ? 1 : 0);
    const hit = starMemo.get(key);
    if (hit !== undefined) return hit;
    let value = match(np, si);
    if (!value && si < tlen && (cross || target[si] !== '/')) value = star(np, si + 1, cross);
    starMemo.set(key, value);
    return value;
  };

  const match = (pi: number, si: number): boolean => {
    if (pi === plen) return si === tlen;
    if (si > tlen) return false;
    const key = pi * stride + si;
    const hit = matchMemo.get(key);
    if (hit !== undefined) return hit;
    let value: boolean;
    const ch = pattern[pi]!;
    if (ch === '*') {
      const double = pattern[pi + 1] === '*';
      const afterStars = pi + (double ? 2 : 1);
      if (double) {
        // `**/`：自己那一段可缺省（旧口径 `(?:.*/)?` 的零段分支）
        value = (pattern[afterStars] === '/' && match(afterStars + 1, si)) || star(afterStars, si, true);
      } else {
        value = star(afterStars, si, false);
      }
    } else if (ch === '?') {
      value = si < tlen && target[si] !== '/' && match(pi + 1, si + 1);
    } else {
      value = si < tlen && target[si] === ch && match(pi + 1, si + 1);
    }
    matchMemo.set(key, value);
    return value;
  };

  return match(0, 0);
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

/** 载体声明的**形状读数**（宿主装载从不跑 `validateGameAdapter`，所以这里必须自己防） */
interface CarrierDeclaration {
  /** `carriers` 字段出现过（**含空数组**）⇒ 声明过；`undefined` = 未声明 */
  readonly declared: boolean;
  /** 可参与归属的条目（`glob` 是字符串的那些，保持声明顺序） */
  readonly usable: readonly CarrierBinding[];
  /** 形状坏、被跳过的条目数（`carriers` 不是数组时记 1） */
  readonly skipped: number;
}
/**
 * 读 `carriers` 的声明面（**"声明过"的判据是 `!== undefined`，不是 `length > 0`**）：
 * 空数组 = 声明了"零条归属"（`adapter.ts` 口径），要为每个文件报 `core/carrier/unowned`；
 * 未声明 = 一概不问。坏条目按"不命中"跳过并计数，由调用方报成一条 warning（不静默）。
 */
function readCarrierDeclaration(adapter: GameAdapter): CarrierDeclaration {
  const raw: unknown = adapter.carriers;
  if (raw === undefined) return { declared: false, usable: [], skipped: 0 };
  if (!Array.isArray(raw)) return { declared: true, usable: [], skipped: 1 };
  const usable: CarrierBinding[] = [];
  let skipped = 0;
  for (const item of raw as readonly unknown[]) {
    const binding = item as Partial<CarrierBinding> | null;
    if (binding !== null && typeof binding === 'object' && typeof binding.glob === 'string') {
      usable.push(binding as CarrierBinding);
    } else {
      skipped += 1;
    }
  }
  return { declared: true, usable, skipped };
}

/**
 * 找出这份文件的载体归属（声明顺序 = 优先顺序，第一条命中即返回）。
 * 没声明（或声明了零条）`carriers` ⇒ `undefined`，与"声明了但没命中"是两件事：
 * 后者要报 `core/carrier/unowned`，前者什么都不报。坏条目一律跳过不抛。
 */
export function findCarrierBinding(
  adapter: GameAdapter,
  filePath: string,
): CarrierBinding | undefined {
  return readCarrierDeclaration(adapter).usable.find((binding) =>
    carrierGlobMatches(binding.glob, filePath),
  );
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
 * 4. **交回的事实必须属于这个方言**：`facts.id !== effective` ⇒ `core/dialect/response-mismatch`
 *    （error）并**按未绑定返回**（不给"方言 A + 事实 B"的半个结果）；
 * 5. 绑上了且给了 `filePath` ⇒ 按 `carriers` 定载体；**声明过**（含空数组）却没命中 ⇒
 *    `core/carrier/unowned`；坏条目跳过并各报一条同码 warning。
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

  /*
   * ③.5 事实对账（§5.4 第 2 行「错事实不报错」的**执行点**）：登记表把 `erafl` 映到一份
   * `id` 别家的事实上时，此前会写出"方言=erafl + 别家事实"的绑定并静默通过。分叉一定是
   * 供方/宿主接线错了（`facts.id` 是自证，不是第二真源）⇒ error + **按未绑定返回**。
   */
  if (facts.id !== effective) {
    diagnostics.push(
      make(
        'core/dialect/response-mismatch',
        `方言响应错配：本次要的是方言 ${effective}，交回的事实自证为方言 ${String(facts.id)}` +
          `（契约版本 ${String(facts.version)}）⇒ 按未绑定处理，结果已丢弃（不借错方言的事实）。`,
      ),
    );
    return freeze({ kind: 'unbound', binding: null, resolvedDialect: effective, diagnostics });
  }

  /* ④ 载体归属 */
  let carrier: DialectBinding['carrier'] = null;
  let validates: readonly DialectFactKind[] | undefined;
  const filePath = typeof input.filePath === 'string' ? normalizePath(input.filePath) : null;
  const carriers = readCarrierDeclaration(facts);
  if (filePath !== null && carriers.declared) {
    // 声明了却读不成条目（宿主装载不跑 validateGameAdapter）⇒ 可见的 warning，不抛
    if (carriers.skipped > 0) {
      diagnostics.push(
        make(
          'core/carrier/unowned',
          `方言 ${effective} 的 carriers 里有 ${carriers.skipped} 条归属形状坏了（条目不是对象，或 glob 不是字符串）` +
            '：这些条目**按不命中跳过**，它们名下文件的载体级校验会落空——请检查适配器数据。',
        ),
      );
    }
    const matched = carriers.usable.find((binding) => carrierGlobMatches(binding.glob, filePath));
    if (matched === undefined) {
      diagnostics.push(
        make(
          'core/carrier/unowned',
          `文件 ${filePath} 不在方言 ${effective} 声明的任何载体归属里` +
            `${carriers.usable.length === 0 ? '（carriers 声明了零条归属）' : '（carriers 的 glob 都没命中）'}` +
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
