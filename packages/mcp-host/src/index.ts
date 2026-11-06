/**
 * @kojo/mcp-host —— 面向模型的能力面（冻结契约 v1；第三波：能力面真正够用 + 覆盖登记）。
 *
 * 这一层只做三件事：**定义契约类型**、**把三路能力来源装配成工具/资源/提示清单**、
 * **按会话授权把守调用**。它不监听 Tauri 事件、不 import app/bridge/kernel/其它插件，
 * 也不认识任何游戏语义——具体能力的数据源一律通过 `deps` 注入（宿主/路 A 的
 * `host-bridge.ts` 负责装配）。所有失败都抛结构化 `{code,message}`（铁律 4：不静默）。
 *
 * 第二波（路 B 覆盖补齐）新增，纪律：
 * - 补齐「没登记成命令」的功能一律以**工具**形式补在 `SUPPLEMENTAL_TOOL_SPECS`（不动 UI 组件、
 *   不给开机图加 import 边）；每个工具有面向模型的 description + 严格 inputSchema；
 *   危险动作 `tier:'privileged'` + `annotations.destructiveHint`。
 * - 不给 MCP 暴露任意目标路径参数：写类工具只收「项目根内相对路径」（`RELATIVE_PATH_SCHEMA`
 *   用 pattern 拒绝绝对路径 / 盘符 / `..` 逃逸），执行层还须按 approvedRoots 复核域。
 * - resources：新增「当前文档与光标」，并对命令清单 / 插件状态 / 校验 failedRules /
 *   活动文档做**可读性投影**；文本一律有截断上限 + 显式 `truncated` 标记（fail loud，不静默）。
 * - prompts：只提供**零游戏名词的领域工作流骨架 + 槽消费逻辑**；游戏相关知识只能由
 *   `mcp.prompt` 槽（`*-adapter` 贡献）注入，骨架绝不硬编码、也不编造领域知识。
 *
 * 第三波（路 B「能力面真正够用」+「外部客户端接入」）新增，纪律：
 * - 把「有真源可接」的只读缺口（Rust IO 原语 / 语义读数面 / 已有 resource 数据面）补成
 *   具名工具，全部走 `runSupplemental` 钩子；**没有真源的缺口宁可留在缺口清单并显式标注**
 *   （`MCP_DEFERRED_GAP_NOTES`），绝不造一个返回空串的假实现。
 * - `MCP_TOOL_GAP_MAP` 逐条登记「工具 → 真源缺口」，供盘点脚本做覆盖对拍；交叉校验 tool/gap
 *   真实存在，对不上就如实降级，不假绿。
 * - resources 文本一律有截断上限 + 显式 `truncated` 标记；prompts 骨架保持零游戏名词。
 *
 * 只依赖 `@kojo/plugin-api`（workspace 声明；本模块不引用其运行时，保持零耦合、
 * 便于注入假实现单测）。
 */

/* ------------------------------------------------------------------ *
 * 1. 冻结契约 v1 —— 逐字导出，不得改名
 * ------------------------------------------------------------------ */

export type McpTier = 'read' | 'edit' | 'privileged';

export interface McpSessionScope {
  sessionId: string;
  clientId: string;
  tier: McpTier;
  approvedRoots: readonly string[];
  approvedTools: readonly string[];
  /**
   * additive（2026-11-06 写域多根）：第四张表显式批准的**常驻可写根枚举标识**。
   * 缺省 / 空 ⇒ 任何 rootId 都不可用（默认拒绝一字不变）。与 approvedRoots 是两张
   * 独立的账：前者选「哪个根」，后者限定「根内哪些相对前缀」。
   */
  approvedRootIds?: readonly string[];
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  tier: McpTier;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  run(args: Record<string, unknown>, scope: McpSessionScope): Promise<unknown>;
}

export interface McpResource {
  uri: string;
  name: string;
  description: string;
  mimeType?: string;
  read(scope: McpSessionScope): Promise<{ contents: { uri: string; text: string }[] }>;
}

export interface McpPrompt {
  name: string;
  description: string;
  arguments?: readonly { name: string; required?: boolean }[];
  render(
    args: Record<string, unknown>,
    scope: McpSessionScope,
  ): Promise<{ messages: { role: 'user' | 'assistant'; content: { type: 'text'; text: string } }[] }>;
}

export interface McpCapabilityRegistry {
  listTools(scope: McpSessionScope): readonly McpTool[];
  listResources(): readonly McpResource[];
  listPrompts(): readonly McpPrompt[];
  callTool(name: string, args: Record<string, unknown>, scope: McpSessionScope): Promise<unknown>;
  readResource(uri: string, scope: McpSessionScope): Promise<unknown>;
  getPrompt(name: string, args: Record<string, unknown>, scope: McpSessionScope): Promise<unknown>;
}

/* ------------------------------------------------------------------ *
 * 2. 结构化错误（{code,message}，可 JSON 化回给 MCP 客户端）
 * ------------------------------------------------------------------ */

export type McpErrorCode =
  | 'UNKNOWN_TOOL'
  | 'PERMISSION_DENIED'
  | 'INVALID_ARGS'
  | 'TOOL_EXECUTION_FAILED'
  | 'NOT_WIRED'
  | 'WRITE_DISABLED'
  | 'UNKNOWN_RESOURCE'
  | 'RESOURCE_UNAVAILABLE'
  | 'UNKNOWN_PROMPT'
  | 'MISSING_PROMPT_ARGUMENT'
  | 'PROMPT_RENDER_FAILED';

/** 结构化失败：既能被 `catch` 当 Error，也能 `JSON.stringify` 成 `{code,message}`。 */
export class McpFailure extends Error {
  readonly code: McpErrorCode;
  constructor(code: McpErrorCode, message: string) {
    super(message);
    this.name = 'McpFailure';
    this.code = code;
  }
  toJSON(): { code: McpErrorCode; message: string } {
    return { code: this.code, message: this.message };
  }
}

export function isMcpFailure(value: unknown): value is McpFailure {
  return value instanceof McpFailure;
}

/* ------------------------------------------------------------------ *
 * 3. 最小 inputSchema 校验器（自己写，零外部依赖）
 *
 * 刻意只认 JSON Schema 的一个小子集：`type` / `required` / `properties` /
 * `items` / `enum` / `minimum` / `maximum` / `pattern` / `minLength` / `maxLength` /
 * **`additionalProperties`（仅当逐字写成 `false` 时生效）**。
 * 不认识的关键字一律忽略（不因"没实现校验"而误拒合法入参），只拒绝**明确违反**
 * 已声明约束的取值。`pattern` 编译失败时同样忽略（不误拒），但合法 pattern 会真正
 * 生效——写类工具的「项目内相对路径」约束就靠它兜住。
 *
 * 入参严格化批（B11）：`additionalProperties:false` 此前只是**声明**，校验器根本不读它
 * ⇒ 写错的参数名（`maxResult` / `corridor` …）既不报错也不生效，调用方按默认页大小原地打转
 * 却以为在翻页（铁律 4 的「静默」）。本批把它变成真闸：面值只认 `false`（缺省＝不声明＝照旧
 * 宽松，零风险），`additionalProperties` 给 schema 对象或 `true` 时**仍不实现**（不认识＝忽略，
 * 绝不因"没实现"而误拒）。拒绝文案必带本面合法名清单 + 最接近的合法名，一次改对。
 * ------------------------------------------------------------------ */

/** 单次校验最多报出的违反项条数（入参越界类噪声有界；条数本身如实报出，不静默丢）。 */
const SCHEMA_ERROR_CAP = 12;

/** 违规项定位串：根上直接用键名（`maxEntry: …`），嵌套保留点路径（`$.resolutions[0].xx: …`）。 */
function keyLabel(path: string, key: string): string {
  return path === '' || path === '$' ? key : `${path}.${key}`;
}

/**
 * 距离度量＝归一化 Damerau-Levenshtein（含换位，专门兜 `maxRetuns` / `coridor` 这类手误），
 * 阈值 `SCHEMA_SUGGEST_MAX_DISTANCE`：算不出足够像的候选就**不给猜测**——
 * 与其把一个压根不相干的键名推到模型眼前，不如只让它照抄本面合法清单。
 */
const SCHEMA_SUGGEST_MAX_DISTANCE = 0.34;

function levenshtein(a: string, b: string): number {
  const n = a.length;
  const m = b.length;
  if (n === 0) return m;
  if (m === 0) return n;
  let prev2: number[] = [];
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i += 1) {
    const cur = [i];
    for (let j = 1; j <= m; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min((cur[j - 1] ?? 0) + 1, (prev[j] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
      // 换位一步（Damerau）：ab↔ba 与「两格之上 + 代价 1」同价，专门兜住相邻手误。
      // i>1 && j>1 时 prev2 必然已由上一轮赋值；兜 Infinity 只是给类型看，不参与取小。
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, prev2[j - 2] ?? Number.POSITIVE_INFINITY);
      }
      cur[j] = best;
    }
    prev2 = prev;
    prev = cur;
  }
  return prev[m] as number;
}

/** 本面合法名里与未知键最接近的一个；没有足够像的候选 ⇒ null（不硬猜）。 */
function nearestLegalKey(unknown: string, legal: readonly string[]): string | null {
  let best: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const key of legal) {
    const score = levenshtein(unknown.toLowerCase(), key.toLowerCase()) / Math.max(unknown.length, key.length);
    if (score < bestScore) {
      bestScore = score;
      best = key;
    }
  }
  return bestScore <= SCHEMA_SUGGEST_MAX_DISTANCE ? best : null;
}

/**
 * ---- 指回的第二条腿：值形状证据（B11 判据 3 的 `corridor → cursor` 那一格）----
 *
 * 为什么名字这一条腿到不了：`corridor` 与 `cursor` 的归一化 Damerau-Levenshtein 是 **0.500**，
 * 而 `size → line`、`min → line`、`count → column` 这些**毫不相干**的名字对也是同一个 0.500
 * ——把 `SCHEMA_SUGGEST_MAX_DISTANCE` 从 0.34 抬到 0.50 救不了 corridor（正好压在边界上），
 * 却会让三张表一起开始瞎指：现场量过（73 个常见参数词 × 77 枚面），抬到 0.50 后无依据的
 * 「最接近的合法名」从 188 条涨到 639 条（净多 451 条）。判据红线是
 * 「够不着的乱名字不瞎猜」，所以阈值一个字不动。
 *
 * 换证据说话：调用方**实际传进来的那个值**比键名诚实。未知键的值原样满足了本面一枚
 * 「窄形状」入参声明的 `pattern`，而这样的入参在本面**只有一个**，才指回它。
 * 「窄」不靠人肉认定：拿一组**普通参数词**去撞该 pattern，拒掉 ≥ `SCHEMA_SHAPE_SPECIFICITY_MIN`
 * 的才算证据——随便一个英文词都收得下的形状（相对路径只挡盘符 / 绝对 / `..` 上跳、
 * 实例 id 与组件 id 只挡字符集外的字符）没有鉴别力，指回去就等于把无关名字推到模型眼前。
 * 现场量过（三张表 77 枚面 × 七种取值 ＝ 539 组）：全表只有游标那一枚
 * `^[0-9a-f]{8}:\d{1,10}$` 过鉴别力闸，于是这条腿只在「值本身是合法游标」时出声
 * （25 组全指回 cursor），路径形 / id 形 / 裸整数 / 普通词 / 布尔一组都不出声。
 * 零个或两个以上候选收得下 ⇒ 照旧沉默，只把合法清单摊开。
 */
const SCHEMA_SHAPE_PROBES = [
  'limit',
  'offset',
  'size',
  'count',
  'min',
  'max',
  'name',
  'path',
  'text',
  'query',
  'search',
  'true',
] as const;

/** 普通词探针至少拒掉这个比例，才算「窄形状」（有指回价值）；否则视为兜底形状，不作证据。 */
const SCHEMA_SHAPE_SPECIFICITY_MIN = 0.75;

/** 编译一次、量一次：`null` ＝非法 pattern 或不是字符串（不参与值证据）。 */
const shapeSpecificityCache = new Map<string, number | null>();

function patternSpecificity(pattern: unknown): number | null {
  if (typeof pattern !== 'string') return null;
  const cached = shapeSpecificityCache.get(pattern);
  if (cached !== undefined) return cached;
  let score: number | null = null;
  try {
    const re = new RegExp(pattern);
    let rejected = 0;
    for (const probe of SCHEMA_SHAPE_PROBES) if (!re.test(probe)) rejected += 1;
    score = rejected / SCHEMA_SHAPE_PROBES.length;
  } catch {
    score = null; // 非法 pattern：不参与证据（与「不认识的关键字不误拒」同口径）
  }
  shapeSpecificityCache.set(pattern, score);
  return score;
}

/**
 * 值形状证据：未知键的**值**被本面恰好一枚窄形状入参原样收得下 ⇒ 返回那枚名字；
 * 收不下 / 不止一枚收得下 / 值不是字符串 ⇒ null（沉默，不猜）。
 */
function valueShapeEvidence(
  properties: Record<string, unknown>,
  unknownKey: string,
  unknownValue: unknown,
): string | null {
  if (typeof unknownValue !== 'string') return null;
  const hits: string[] = [];
  for (const [name, sub] of Object.entries(properties)) {
    if (name === unknownKey || !isPlainObject(sub)) continue;
    const specificity = patternSpecificity(sub['pattern']);
    if (specificity === null || specificity < SCHEMA_SHAPE_SPECIFICITY_MIN) continue; // 没有 pattern / 兜底形状
    if (validateAgainstSchema(sub, unknownValue).valid) hits.push(name);
  }
  return hits.length === 1 ? (hits[0] as string) : null;
}

/** 指回文案：名字那条腿优先，其次值形状那条腿；都没有 ⇒ 空串（只摊清单）。 */
function suggestLegalKey(
  properties: Record<string, unknown> | null,
  unknownKey: string,
  unknownValue: unknown,
  legal: readonly string[],
): string {
  const byName = nearestLegalKey(unknownKey, legal);
  if (byName) return `；最接近的合法名：${byName}`;
  if (properties) {
    const byValue = valueShapeEvidence(properties, unknownKey, unknownValue);
    if (byValue) return `；最接近的合法名：${byValue}（依据不是键名拼写，而是你传的这个值只有它收得下）`;
  }
  return '';
}

export interface SchemaValidation {
  readonly valid: boolean;
  readonly errors: readonly string[];
  /** 违反项超过 `SCHEMA_ERROR_CAP` 时被省略的条数（截断可见，不静默；0 ＝一条没少）。 */
  readonly omittedErrors: number;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function typeMatches(expected: string, v: unknown): boolean {
  switch (expected) {
    case 'object':
      return isPlainObject(v);
    case 'array':
      return Array.isArray(v);
    case 'number':
      return typeof v === 'number' && Number.isFinite(v);
    case 'integer':
      return typeof v === 'number' && Number.isInteger(v);
    case 'string':
      return typeof v === 'string';
    case 'boolean':
      return typeof v === 'boolean';
    case 'null':
      return v === null;
    default:
      return true; // 不认识的 type 名不拦
  }
}

/** 结构化校验：返回违反项（不提前退出），便于一次报清楚；超过 `SCHEMA_ERROR_CAP` 条如实记账。 */
export function validateAgainstSchema(schema: Record<string, unknown>, value: unknown): SchemaValidation {
  const errors: string[] = [];
  let omitted = 0;
  // 有界：入参整体走偏（对象套数组套对象）时违规项可能成百上千，只报前 SCHEMA_ERROR_CAP 条。
  // 「少报了几条」由返回体的 omittedErrors 如实说，并由 callTool 拼进 INVALID_ARGS 文案
  // （铁律 4：截断必须可见，绝不静默丢违规项）。
  const push = (message: string): void => {
    if (errors.length < SCHEMA_ERROR_CAP) errors.push(message);
    else omitted += 1;
  };
  if (!isPlainObject(schema)) return { valid: true, errors, omittedErrors: 0 };

  const walk = (s: Record<string, unknown>, v: unknown, path: string): void => {
    const expected = s['type'];
    if (typeof expected === 'string' && !typeMatches(expected, v)) {
      push(`${path || '$'}: 期望 ${expected}，实得 ${typeOf(v)}`);
      return; // 类型都不对，不再下钻，避免级联噪声
    }
    if (Array.isArray(s['enum'])) {
      const allowed = s['enum'] as readonly unknown[];
      if (!allowed.some((e) => e === v)) push(`${path || '$'}: 取值不在 enum 白名单内`);
    }
    if (typeof s['minimum'] === 'number' && typeof v === 'number' && v < (s['minimum'] as number)) {
      push(`${path || '$'}: 小于 minimum`);
    }
    if (typeof s['maximum'] === 'number' && typeof v === 'number' && v > (s['maximum'] as number)) {
      push(`${path || '$'}: 大于 maximum`);
    }
    if (typeof v === 'string') {
      if (typeof s['pattern'] === 'string') {
        let re: RegExp | null = null;
        try {
          re = new RegExp(s['pattern'] as string);
        } catch {
          re = null; // 非法 pattern 不误拒
        }
        if (re && !re.test(v)) push(`${path || '$'}: 不匹配 pattern ${String(s['pattern'])}`);
      }
      if (typeof s['minLength'] === 'number' && v.length < (s['minLength'] as number)) {
        push(`${path || '$'}: 短于 minLength`);
      }
      if (typeof s['maxLength'] === 'number' && v.length > (s['maxLength'] as number)) {
        push(`${path || '$'}: 长于 maxLength`);
      }
    }
    if (isPlainObject(v)) {
      const required = s['required'];
      if (Array.isArray(required)) {
        for (const key of required) {
          if (typeof key === 'string' && !(key in v)) push(`${path || '$'}: 缺必填字段 ${key}`);
        }
      }
      const properties = s['properties'];
      if (isPlainObject(properties)) {
        for (const [key, sub] of Object.entries(properties)) {
          if (key in v && isPlainObject(sub)) walk(sub, v[key], path ? `${path}.${key}` : key);
        }
      }
      // B11 入参严格化：面值逐字 `false` 才生效（缺省＝不声明＝照旧宽松，零风险）。未知键一律
      // 显式出声，并当场报回「本面只收这些名 + 最接近的合法名」——绝不让拼错的参数（`maxResult`
      // / `corridor` …）静默退回该面默认页大小，让调用方以为自己在翻页其实在原地打转。
      if (s['additionalProperties'] === false) {
        const legal = isPlainObject(properties) ? Object.keys(properties) : [];
        for (const key of Object.keys(v)) {
          if (legal.includes(key)) continue;
          const note = suggestLegalKey(isPlainObject(properties) ? properties : null, key, v[key], legal);
          push(
            `${keyLabel(path, key)}: 未知入参 '${key}'（本面不收它，也不会替它猜一个默认值——` +
              `本面只收这些入参：${legal.length > 0 ? legal.join(' / ') : '（一个入参都不收）'}${note}）`,
          );
        }
      }
    }
    if (Array.isArray(v) && isPlainObject(s['items'])) {
      v.forEach((item, i) => walk(s['items'] as Record<string, unknown>, item, `${path || '$'}[${i}]`));
    }
  };

  walk(schema, value, '$');
  return { valid: errors.length === 0, errors, omittedErrors: omitted };
}

/* ------------------------------------------------------------------ *
 * 4. deps 形状（由本包定义；全部可选 / 可注入假实现）
 * ------------------------------------------------------------------ */

/** 统一读数腿签名：args + scope 进、任意可 JSON 化的结果出。 */
export type McpReaderFn = (
  args: Record<string, unknown>,
  scope: McpSessionScope,
) => Promise<unknown> | unknown;

/** ① 命令面板登记命令（宿主把 buildCommandRegistry 的结果投影成这一形状）。 */
export interface McpCommandSource {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly argsSchema?: Record<string, unknown>;
  readonly tier?: McpTier;
  run(args: Record<string, unknown>, scope: McpSessionScope): Promise<unknown> | unknown;
}

/** ② 语义读数服务的 8 条纯读腿（见 app/src/mcp/semantic-service.ts）。 */
export interface McpSemanticReaders {
  definitionAt: McpReaderFn;
  referencesAt: McpReaderFn;
  diagnostics: McpReaderFn;
  hoverAt: McpReaderFn;
  suggestAt: McpReaderFn;
  documentSymbols: McpReaderFn;
  tokens: McpReaderFn;
  codeActionsAt: McpReaderFn;
}

/** ③ kernel IO 的只读能力（项目信息 / 文件树 / 全文检索）。 */
export interface McpKernelIo {
  projectInfo: McpReaderFn;
  fileTree: McpReaderFn;
  searchAll: McpReaderFn;
}

/** `mcp.prompt` 槽贡献投影成的领域知识片段（游戏知识只由 *-adapter 经槽注入）。 */
export interface McpPromptSlotFragment {
  /** 槽名（与骨架 `slots` 对齐）。 */
  readonly name: string;
  /** adapter 注入的领域知识文本；骨架只做搬运，不解释、不编造。 */
  readonly text: string;
  /** 来源标识（哪个 adapter），仅用于可读性标注。 */
  readonly source?: string;
}

export interface McpHostDeps {
  /** 命令面板登记命令 */
  readonly commands?: readonly McpCommandSource[];
  /** 语义读数（逐腿可缺席；缺席的腿仍列进工具，但调用时报 NOT_WIRED，可见不静默） */
  readonly semantic?: Partial<McpSemanticReaders>;
  /** kernel IO 只读能力 */
  readonly kernelIo?: Partial<McpKernelIo>;
  /** 内置 resource 的数据源：按 uri 供数；缺席 ⇒ read 报 RESOURCE_UNAVAILABLE */
  readonly readResourceData?: (uri: string, scope: McpSessionScope) => Promise<unknown> | unknown;
  /** 追加 / 覆盖 resource（同 uri 覆盖内置项） */
  readonly resources?: readonly McpResource[];
  /** mcp.prompt 槽贡献投影成的提示清单 */
  readonly prompts?: readonly McpPrompt[];
  /** 补齐功能（全工程检索 / quickfix / 文件树增删改 / diff / 状态回放 / 预览）的执行钩子 */
  readonly runSupplemental?: (name: string, args: Record<string, unknown>, scope: McpSessionScope) => Promise<unknown> | unknown;
  /**
   * `mcp.prompt` 槽贡献的领域片段。**提供该字段（哪怕是空数组）即把内置零游戏名词的
   * 领域工作流骨架并入 prompts 清单**；缺席时 prompts 只含 `prompts`，保持第一波行为不变。
   */
  readonly promptSlots?: readonly McpPromptSlotFragment[];
}

/* ------------------------------------------------------------------ *
 * 5. 工具/资源清单常量（可导出对拍；结构与第一波逐项同形，便于盘点脚本按源码锚解析）
 * ------------------------------------------------------------------ */

/** 危险工具名单（冻结契约 v1）：命中即 'privileged'，路 C 默认不进 tools/list。 */
export const DANGEROUS_TOOL_PATTERNS: readonly RegExp[] = [
  /^launcher_/,
  /^market_/,
  /^open_url_external$/,
  /^export_file$/,
  /^remove_/,
  /^rename_path$/,
];

export function isDangerousTool(name: string): boolean {
  return DANGEROUS_TOOL_PATTERNS.some((re) => re.test(name));
}

interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly tier: McpTier;
  readonly annotations?: McpTool['annotations'];
  readonly method?: keyof McpSemanticReaders | keyof McpKernelIo;
}

const POS_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: { line: { type: 'integer' }, column: { type: 'integer' } },
  required: ['line', 'column'],
};

/**
 * 写类工具的路径入参：**不暴露任意目标路径**。
 * - `pattern` 拒绝盘符开头（`C:`）、绝对路径分隔符开头、以及任何 `..` 段；
 * - 执行层（`runSupplemental` / headless）还须把相对路径 resolve 到 approvedRoots 内并拒绝域外。
 */
const RELATIVE_PATH_SCHEMA: Record<string, unknown> = {
  type: 'string',
  minLength: 1,
  maxLength: 512,
  pattern: '^(?![A-Za-z]:)(?![\\\\/])(?!.*(?:^|[\\\\/])\\.\\.(?:[\\\\/]|$)).+$',
  description:
    'Project-root-relative path only; absolute, drive-letter and ".." paths are rejected by this schema, and the execution layer resolves against approvedRoots and refuses out-of-domain targets (ADR-0003).',
};

/**
 * 分页入参里 `limit` 可复用的旧名（各面历史口径不一，游标是新能力，旧参数零改动）。
 * **这一序列就是「执行腿真正取用的页大小入参名」的真源**：`pageSizeOf` 按此顺序取第一个给了的
 * 数字，因此入参严格化批（B11）必须把这八个名字逐个**声明进每张分页面的 `properties`**——
 * 少声明一个不是「省掉一个别名」，而是把该面今天真的在用、也真的生效的入参变成拒收。
 * 导出给契约测试反查「properties ⊇ 取用序列」（漂移护栏，见 tests/mcp-arg-strictness.test.ts）。
 */
export const PAGE_SIZE_ARG_ALIASES = ['limit', 'length', 'maxChars', 'maxResults', 'maxEntries', 'maxRanges', 'maxEvents', 'maxLines'] as const;

/**
 * 写腿可选的多根**枚举标识**（additive，ADR-0013 写域多根批）：
 * - 形状钉死 `ws:` + 8 位小写十六进制；绝不是目标路径，不收盘符 / 绝对路径 / `..`；
 * - 候选值只能从只读 `io.workspaceRoots` 回执里的 `rootIds` 枚举出来（按根绝对路径做的
 *   稳定 FNV-1a 标识，不受增删顺序影响）；
 * - 还必须在本会话第四张表 `scope.approvedRootIds` 里**精确列名**批准，否则一律拒绝；
 * - Rust 端点按同尺形状 + 精确列名再复核一道（WebView 被替换也绕不过）。
 * 省略 `rootId` ⇒ 仍写当前项目根，行为一字不变，也不触发任何额外枚举 IPC。
 */
export const ROOT_ID_SCHEMA: Record<string, unknown> = {
  type: 'string',
  pattern: '^ws:[0-9a-f]{8}$',
  description:
    'Optional stable root identifier (ws: + 8 lowercase hex digits), NOT a path. Candidates come from the read-only io.workspaceRoots reply (rootIds, index-aligned with roots) and must also be explicitly approved in this session (approvedRootIds) by a human in the AI-access settings panel. Omit to stay on the current project root.',
};

/**
 * 分页入参的通用 schema 片段（B1 批：**只加可选入参，不加新工具名**）。
 * 定义必须早于下面几张工具表——表是模块级 const，`export const` 对象若定义在其后会在
 * 模块初始化时撞 TDZ（ReferenceError），只有函数声明可以后置。
 *
 * B22 去重批（形态 (c)＋同对象内 (a) 指针）：页大小/严格度口径原本被 152 个别名属性各抄
 * 一份 539 字符（81,389 字节纯重复），现在**每枚面只留一份完整口径**，落点就是本面
 * `properties.limit` 的 description（同一条 tools/list 记录里，客户端零额外跳转）；
 * 其余别名属性只带一句指针。属性名、`type`、`minimum`、`required` 一字未动。
 */
const PAGE_SIZE_CANON_NOTE =
  'Page size - ONE knob. `limit` is its real name; the page defaults to this surface\'s existing cap and that cap is never widened. ' +
  'Legacy synonyms declared on this surface are the same knob, not a second page size: the shared gate takes the FIRST value present in the order limit > length > maxChars > maxResults > maxEntries > maxRanges > maxEvents > maxLines and ignores the rest, while a name this surface does not declare is refused. ' +
  'Send `limit` when new. This schema runs with additionalProperties:false, so an argument name absent from `properties` is rejected with the full legal list, never silently dropped to the default page size.';

export const PAGE_CURSOR_SCHEMA_PROPS: Record<string, unknown> = {
  limit: {
    type: 'integer',
    minimum: 1,
    description: PAGE_SIZE_CANON_NOTE,
  },
  cursor: {
    type: 'string',
    minLength: 10,
    maxLength: 32,
    pattern: '^[0-9a-f]{8}:\\d{1,10}$',
    description:
      "Opaque cursor copied verbatim from the previous response's nextCursor; omit for the first page. changedDuringPaging:true on a reply means the snapshot moved mid-paging - that page restarts from the head and must not be spliced with earlier ones.",
  },
};

/** 分页面 description 的共用完整性尾注（口径统一）。
 * B22 去重批：原本这里还完整复述一遍「页大小只有一个旋钮 + 未声明显式拒收」（375 字符 × 23 枚），
 * 现在那一口径每枚面只在本面 inputSchema 的 `limit` 说明里写一份，描述侧改指过去——
 * 同一帧 tools/list 内的同一条记录，跳转零次。完整性账（字段集、nextCursor、
 * changedDuringPaging）逐字仍在本句，一个字都没删。 */
export const PAGE_ACCOUNT_NOTE =
  'Every page carries the completeness account {total (spelled `textLength` on text surfaces), offset, limit, truncated, hasMore, nextCursor, fingerprint}; pass nextCursor back verbatim. ' +
  'changedDuringPaging:true means the snapshot changed mid-paging: that page restarts from the head and must not be spliced with earlier ones. ' +
  "Page size (ONE knob, `limit` is the real name) and the reject-undeclared-argument-names rule are stated once in this tool's inputSchema `limit` description.";

/** 语义读数服务 → 8 枚只读工具（tier 'read' + readOnlyHint）。
 *
 * 分页游标批（B1）：列举面（diagnostics / documentSymbols）补 **可选** `limit` + `cursor`，
 * 单页上限取该面今天已有的硬闸（DIAGNOSTIC_LIMIT / SYMBOL_LIMIT＝200），不放宽；
 * 真·零参面（projectInfo）不再用裸 `{type:'object'}` 兜底，改成严格空对象（拒绝任何入参）。
 * `semantic.tokens` 原本就有 `lineFrom`/`lineTo` 窗口，本批保持其形状不动（它是本批的形状参照）。
 *
 * 入参严格化批（B11）：两张列举面逐字 `additionalProperties:false` 并补齐共用分页腿真收的页大小
 * 别名；定位面走 `STRICT_POS_SCHEMA`；`semantic.referencesAt` 单独用 `REFERENCES_SCHEMA`——它的腿
 * 一直就在读 `includeDeclaration`，此前没写进 properties 属于「声明不全」而不是「多收」，本批补上。
 */
const PAGE_PROPS = PAGE_CURSOR_SCHEMA_PROPS;

/** 严格零参入参形状：诚实声明「不收任何入参」，由零参闸逐个登记（见 NO_ARG_TOOLS 测试）。 */
const STRICT_NO_ARG_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

/**
 * 入参严格化批（B11）：把 `pageSizeOf` 那条**既有的**页大小取值序列写进各分页面的 `properties`。
 *
 * 为什么一次声明八个而不是「本文档里点过名的那两个」：取值序列是共用腿的一部分，任何走
 * `paginateText` / `paginateByCursor` / `pageParamsFor` 的面，今天这八个名字**每一个**都真的被当成
 * 页大小读（先到先得，见 `pageSizeOf`）。`additionalProperties:false` 一生效，少声明一个就不是
 * 「省掉一个别名」，而是把该面今天真在用的入参变成拒收——判据「旧别名照旧生效」当场红。
 *
 * 只有一个真参数：正名 `limit`，其余七个是同义旧名。B22 去重批把「同一个旋钮 + 序列先到先得 +
 * 新 callers 请写 limit + 未声明显式拒收」这份完整口径收进本面 `properties.limit` 的描述
 * （`PAGE_SIZE_CANON_NOTE`），别名属性只留一句同对象内的指针——信息等价性由
 * `packages/app/tests/mcp-tools-list-payload.test.ts` 的「指针落点」一条钉住。
 * 这里刻意**不带 `maximum`**：体积闸在腿侧 clamp（B11 一个闸值都没动），在 schema 再钉一次上限等于
 * 给旧别名新增一类「改前收、改后拒」的取值，那是收紧到行为变化，不是本批要的事。
 */
const PAGE_SIZE_ALIAS_POINTER =
  'Legacy synonym of `limit` on this surface - the same single knob. This object\'s `limit` description carries the acceptance order and the additionalProperties:false reject rule.';

/**
 * `limit` 之外、本面经共用分页腿**真正取用**的页大小别名。
 * - `declared`：该面已单独写过描述的名字（fs.tree 的 `maxEntries` 等），跳过即可，面上字面量不动；
 * - `omit`：共用序列里、但本面执行腿**并不会取用**的名字——不声明它们，让它们落进
 *   「未知入参 ⇒ 显式拒收」。「收下却不用」正是 B11 要消灭的那种静默，不能靠声明把它合法化。
 *   （例：problems.diagnostics 的腿先把 `maxResults` clamp 一遍再注入，序列里排在它之后的
 *   `maxEntries`/`maxRanges`/`maxEvents`/`maxLines` 在该面从来不起作用。）
 */
function pageSizeAliasProps(declared: readonly string[] = [], omit: readonly string[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const alias of PAGE_SIZE_ARG_ALIASES) {
    if (alias === 'limit' || declared.includes(alias) || omit.includes(alias)) continue;
    out[alias] = { type: 'integer', minimum: 1, description: PAGE_SIZE_ALIAS_POINTER };
  }
  return out;
}

/** 本面已有的旧别名描述补一句「与 limit 是同一个旋钮，完整口径看本面对象的 limit」（不动 maximum / default 闸值）。 */
const ALIAS_OF_LIMIT = ' Same single knob as `limit`; this object\'s `limit` description carries the acceptance order and the reject rule. Prefer `limit`.';

/**
 * 位置入参（1 基 line/column）——B11 起严格。七枚定位面（definitionAt / hoverAt / suggestAt /
 * codeActionsAt / lang.highlightsAt / lang.signatureAt）的腿只取 `line` + `column`，一个字段都没多。
 */
const STRICT_POS_SCHEMA: Record<string, unknown> = {
  ...POS_SCHEMA,
  additionalProperties: false,
};

/**
 * `semantic.referencesAt` 的形状＝定位面 + `includeDeclaration`：这个字段**不是**新加的能力，
 * 判据腿（`buildSemanticReaders.referencesAt`）早就在按 `args['includeDeclaration'] !== false`
 * 过滤声明处，只是契约面一直没把它写进 properties（写了也不被拒＝静默）。严格化必须把它显式化。
 */
const REFERENCES_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    line: { type: 'integer' },
    column: { type: 'integer' },
    includeDeclaration: {
      type: 'boolean',
      description:
        'Keep the declaration itself in the result (default true; the leg has always read this field). false drops items whose kind is the definition.',
    },
  },
  required: ['line', 'column'],
  additionalProperties: false,
};

/* ---- B4 批（LaneS，2026-11-06）启动器族用到的入参形状（与宿主形状闸同尺） ---- */

/**
 * 实例 id：与 Rust `launcher::paths::valid_instance_id` 逐字同尺
 * （ASCII 字母数字 + `-`，长度 1..=64）。形状在闸上先挡一道，腿里再复核一次（纵深，fail-closed）。
 */
const LAUNCHER_INSTANCE_ID_SCHEMA: Record<string, unknown> = {
  type: 'string',
  minLength: 1,
  maxLength: 64,
  pattern: '^[A-Za-z0-9-]+$',
  description:
    "Instance id copied verbatim from launcher_instance_list / launcher_instance_get - never invent one. Host's own shape gate: ASCII letters/digits plus '-', 1..64 chars.",
};

/** 单段 id（包 id / 计划 id / 备份 id / 会话 id）：Rust `launcher::paths::valid_component` 同尺。 */
const LAUNCHER_COMPONENT_ID_SCHEMA: Record<string, unknown> = {
  type: 'string',
  minLength: 1,
  maxLength: 64,
  pattern: '^(?!\\.)[A-Za-z0-9._-]+$',
  description:
    'One host-side component id (pack / plan / backup / session id) copied verbatim from a read surface: ASCII letters, digits, - _ .; no leading dot; max 64 chars.',
};

/** 冲突裁决项：与契约 `ConflictResolution` 同形（三键、动作白名单）。 */
const LAUNCHER_RESOLUTION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    rootId: LAUNCHER_COMPONENT_ID_SCHEMA,
    path: { type: 'string', minLength: 1, maxLength: 512, description: 'Root-relative path of the colliding file, exactly as the plan reported it.' },
    action: { type: 'string', enum: ['skip', 'overwrite', 'replace'], description: 'How to resolve that one collision.' },
  },
  required: ['rootId', 'path', 'action'],
  additionalProperties: false,
};

/** 启动器族 description 的共用尾注（档位 + 批准口径统一，避免 27 条各写一套）。
 * B22 去重批：只把长句压成短句（形态 (b)），四个要点一个没丢——privileged、缺省不上帧、
 * 只认精确名（通配不算批准）、宿主自身闸照旧生效。 */
const LAUNCHER_TIER_NOTE =
  'Tier: privileged - absent from tools/list until this session approves this EXACT name (the 4th table; a wildcard such as launcher_* approves nothing), and every host-enforced approval gate still applies on the call.';


export const SEMANTIC_TOOL_SPECS: readonly ToolSpec[] = [
  { name: 'semantic.definitionAt', method: 'definitionAt', description: '转到定义（只读）', inputSchema: STRICT_POS_SCHEMA, tier: 'read', annotations: { readOnlyHint: true } },
  { name: 'semantic.referencesAt', method: 'referencesAt', description: '查找引用（只读）', inputSchema: REFERENCES_SCHEMA, tier: 'read', annotations: { readOnlyHint: true } },
  {
    name: 'semantic.diagnostics',
    method: 'diagnostics',
    description: `当前文档诊断（只读）。列举面：单页上限 200（与旧硬闸同尺，未放宽），零参调用＝第一页、行为与旧版逐字一致。页大小只有一个旋钮：正名 \`limit\`，本页同时接受它历史上的同义旧名（maxResults…，序列先到先得）——写错的参数名现在一律显式拒收，不再静默按默认页大小原地打转。${PAGE_ACCOUNT_NOTE}`,
    inputSchema: {
      type: 'object',
      properties: { ...PAGE_PROPS, ...pageSizeAliasProps() },
      additionalProperties: false,
    },
    tier: 'read',
    annotations: { readOnlyHint: true },
  },
  { name: 'semantic.hoverAt', method: 'hoverAt', description: '悬停信息（只读）', inputSchema: STRICT_POS_SCHEMA, tier: 'read', annotations: { readOnlyHint: true } },
  { name: 'semantic.suggestAt', method: 'suggestAt', description: '补全候选（只读）', inputSchema: STRICT_POS_SCHEMA, tier: 'read', annotations: { readOnlyHint: true } },
  {
    name: 'semantic.documentSymbols',
    method: 'documentSymbols',
    description: `文档符号（只读）。列举面：单页上限 200（与旧硬闸同尺，未放宽），零参调用＝第一页、行为与旧版逐字一致。页大小只有一个旋钮：正名 \`limit\`，其余同义旧名照旧接受（见 pageSize 说明）；不认识的入参名一律显式拒收。${PAGE_ACCOUNT_NOTE}`,
    inputSchema: {
      type: 'object',
      properties: { ...PAGE_PROPS, ...pageSizeAliasProps() },
      additionalProperties: false,
    },
    tier: 'read',
    annotations: { readOnlyHint: true },
  },
  { name: 'semantic.tokens', method: 'tokens', description: '词法 token（只读）', inputSchema: { type: 'object', properties: { lineFrom: { type: 'integer' }, lineTo: { type: 'integer' } }, additionalProperties: false }, tier: 'read', annotations: { readOnlyHint: true } },
  { name: 'semantic.codeActionsAt', method: 'codeActionsAt', description: '可用代码动作（只读，绝不 apply）', inputSchema: STRICT_POS_SCHEMA, tier: 'read', annotations: { readOnlyHint: true } },
];

/** kernel IO → 3 枚只读工具。`fs.tree` 是本批补游标的列举面；`project.info` 是真零参面。 */
export const KERNEL_IO_TOOL_SPECS: readonly ToolSpec[] = [
  {
    name: 'project.info',
    method: 'projectInfo',
    description: '当前项目信息（只读）：一次性摘要，无列举面、不收任何入参（严格空对象）。',
    inputSchema: STRICT_NO_ARG_SCHEMA,
    tier: 'read',
    annotations: { readOnlyHint: true },
  },
  {
    name: 'fs.tree',
    method: 'fileTree',
    description: `项目文件树（只读）。列举面：单页上限沿用本面已有的 maxEntries 上限（未放宽），零参调用＝第一页、行为与旧版逐字一致。页大小只有一个旋钮：正名 \`limit\`，本面历史名 \`maxEntries\` 照旧等价；不认识的入参名一律显式拒收（旧行为是静默按默认页大小，翻页的人会以为自己在翻页）。${PAGE_ACCOUNT_NOTE}`,
    inputSchema: {
      type: 'object',
      properties: {
        maxDepth: { type: 'integer', minimum: 0, maximum: 16, description: 'Recursion depth cap (default 6).' },
        maxEntries: { type: 'integer', minimum: 1, maximum: 5000, description: `Page size (default 500; the pre-existing cap, never widened).${ALIAS_OF_LIMIT}` },
        ...PAGE_PROPS,
        ...pageSizeAliasProps(['maxEntries']),
      },
      additionalProperties: false,
    },
    tier: 'read',
    annotations: { readOnlyHint: true },
  },
  {
    name: 'search.all',
    method: 'searchAll',
    description: `全工程检索（只读）。命中列表按 limit+cursor 分页；引擎自身封顶时显式给 knownTotal:false（不硬编假 total）。页大小只有一个旋钮：正名 \`limit\`，其余同义旧名照旧接受；本面收 \`query\` / \`offset\` / 页大小别名 / \`cursor\` / \`resumeBySlice\` / \`deadlineMs\`（软时限→partial）/ \`preview\`（none＝剥 preview 省 token），**不收 \`scope\`**（要按作品域收窄请用 workspace.searchAll——旧行为是把 scope 静默丢掉、照样全根扫）。给 \`resumeBySlice:true\` 才按互不相交的目录分片把 5,000 条以上的命中集逐片续取（缺省＝旧的一次性窗口应答，一字不变；deadlineMs 与 resumeBySlice 不同收）。${PAGE_ACCOUNT_NOTE}`,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        offset: { type: 'integer', minimum: 0, description: '0-based hit offset of this window start when paging without a cursor (default 0). Ignored (cursor wins) when `cursor` is given.' },
        deadlineMs: { type: 'integer', minimum: 1, maximum: 120000, description: 'Soft deadline in ms (S1): when spent the engine stops claiming NEW files and answers partial:true + partialReason:"deadline" (separate from truncated/cancelled). Default absent = no deadline, request byte-identical to legacy. Not accepted with resumeBySlice:true.' },
        preview: { type: 'string', enum: ['full', 'none'], description: 'Hit payload mode. Default "full" = verbatim legacy. "none" strips the preview field from every hit at the projection layer; accounting (total/cursor/fingerprint/knownTotal) is computed BEFORE stripping = bit-identical to "full" (cursors cross-mode); line text via fs.readRange.' },
        resumeBySlice: { type: 'boolean', description: 'B16: opt into slice-by-slice resume past the engine wall (default false = legacy single-window answer). When true the surface builds a plan of pairwise-disjoint depth-1 directories (plus capped file-root chunks), enumerates the tree once and pages through that plan; the page account gains planSlices / sliceIndex / sliceTotal / slicesRun / perSliceTruncated / prefixReverified / walkComplete / totalScope, and knownTotal stays false for any multi-slice plan (summing per-slice totals is NOT this surface\'s claim to make). Paging still follows the same cursor rules: a stale snapshot fingerprint restarts at slice 0 instead of splicing onto the old page.' },
        ...PAGE_PROPS,
        ...pageSizeAliasProps(),
      },
      required: ['query'],
      additionalProperties: false,
    },
    tier: 'read',
    annotations: { readOnlyHint: true },
  },
];

/**
 * 补齐「没登记成命令」的功能（最小登记）；危险的一律 'privileged' + destructiveHint。
 * 每条 description 面向模型：说明用途 / 入参 / 返回 / 副作用 / 只读或危险提示 / 路径约束。
 */
export const SUPPLEMENTAL_TOOL_SPECS: readonly ToolSpec[] = [
  {
    name: 'workspace.searchAll',
    description:
      'Search the whole project for a text query and return file/line hits. Read-only: never mutates files. Use `query` for the case-insensitive substring, optional `scope` to restrict to source files, `maxResults`/`limit` to size a page and `cursor` to resume the next one; optional `deadlineMs` (soft deadline -> partial:true, not with resumeBySlice) and `preview`:"none" (strip previews, compact) are additive. Returns {hits:[{path,line,preview}], total, truncated} plus the page account. Honesty note: the search engine itself has a hard hit wall (5000); when the engine reports it overflowed, this surface answers `knownTotal:false` and `engineTruncated:true` instead of pretending the union of pages equals the true match count — narrow the query or page the files with fs.readFile. Page size is ONE knob: `limit` is its real name, `maxResults` is this surface\'s historical synonym (both work, `limit` wins); anything not listed here is now rejected loudly instead of silently paging at the default size. ' +
      PAGE_ACCOUNT_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 512, description: 'Substring to find (case-insensitive).' },
        scope: { type: 'string', enum: ['all', 'sources'], description: 'Restrict to source files or search all files (default all).' },
        deadlineMs: { type: 'integer', minimum: 1, maximum: 120000, description: 'Soft deadline in ms (S1): when spent the engine stops claiming NEW files and answers partial:true + partialReason:"deadline" (separate from truncated/cancelled). Default absent = no deadline, request byte-identical to legacy. Not accepted with resumeBySlice:true.' },
        preview: { type: 'string', enum: ['full', 'none'], description: 'Hit payload mode. Default "full" = verbatim legacy. "none" strips the preview field from every hit at the projection layer; accounting (total/cursor/fingerprint/knownTotal) is computed BEFORE stripping = bit-identical to "full" (cursors cross-mode); line text via fs.readRange.' },
        maxResults: { type: 'integer', minimum: 1, maximum: 200, description: `Page size (default 50; the pre-existing cap, never widened).${ALIAS_OF_LIMIT}` },
        offset: { type: 'integer', minimum: 0, description: '0-based hit offset of this window start when paging without a cursor (default 0); the cursor wins when given.' },
        resumeBySlice: { type: 'boolean', description: 'B16: set true to resume past the 5000-hit engine wall by paging a plan of pairwise-disjoint depth-1 directories (plus capped file-root chunks) built from one whole-tree enumeration. Default false keeps the legacy single-window behaviour verbatim (knownTotal:false + engineTruncated on wall hit, no slice account). With true, each page carries planSlices / sliceIndex / sliceTotal / slicesRun / perSliceTruncated / prefixReverified / walkComplete / totalScope; multi-slice plans keep knownTotal:false with the accumulator reason, and the true total is the client summing sliceTotal while walkComplete is true. A snapshot change mid-paging restarts at slice 0 rather than splicing onto the old page. Hidden entries never enter the plan and nested roots are excluded per-entry, so pages cannot overlap.' },
        ...PAGE_PROPS,
        ...pageSizeAliasProps(['maxResults']),
      },
      required: ['query'],
      additionalProperties: false,
    },
    tier: 'read',
    annotations: { readOnlyHint: true },
  },
  {
    name: 'problems.quickFix',
    description:
      'Apply ONE quick-fix action that was previously listed by problems.diagnostics / semantic.codeActionsAt. Mutates document content (edit tier). Pass the exact `actionId` from that read-only listing plus a 1-based `line`/`column`. Never invent an action id; never apply a fix before inspecting it. Runs only inside authorized roots.',
    inputSchema: {
      type: 'object',
      properties: {
        actionId: { type: 'string', minLength: 1, maxLength: 256, description: 'Id copied verbatim from a read-only code-action/diagnostic listing.' },
        line: { type: 'integer', minimum: 1, description: '1-based line of the finding.' },
        column: { type: 'integer', minimum: 1, description: '1-based column of the finding.' },
      },
      required: ['actionId', 'line', 'column'],
      additionalProperties: false,
    },
    tier: 'edit',
    annotations: { idempotentHint: false },
  },
  {
    name: 'problems.diagnostics',
    description:
      'List current problems-panel diagnostics for the active document/project. Read-only. Returns {items:[{message,line,severity,source?}], total, truncated} plus the page account. This surface pages: `maxResults`/`limit` size a page and `cursor` resumes it, so every finding is enumerable — they are ONE knob (`limit` is the real name, `maxResults` this surface\'s synonym), and an unlisted argument name is now rejected instead of silently paging at the default size. Stated rather than hidden: this face clamps `maxResults` BEFORE the shared page-size gate, so the aliases that rank behind `maxResults` (`maxEntries` / `maxRanges` / `maxEvents` / `maxLines`) never took effect here and are deliberately NOT accepted — send `limit` or `maxResults`. Inspect available actions before proposing any problems.quickFix; a `truncated:true` result means more pages exist (or that you must narrow the query) — never assume completeness. ' +
      PAGE_ACCOUNT_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        maxResults: { type: 'integer', minimum: 1, maximum: 500, description: `Page size (default 200; the pre-existing cap, never widened).${ALIAS_OF_LIMIT}` },
        ...PAGE_PROPS,
        ...pageSizeAliasProps(['maxResults'], ['maxEntries', 'maxRanges', 'maxEvents', 'maxLines']),
      },
      additionalProperties: false,
    },
    tier: 'read',
    annotations: { readOnlyHint: true },
  },
  {
    name: 'fileTree.create',
    description:
      'Create a new file or directory inside the authorized project root. `relPath` MUST be a project-root-relative path (schema rejects absolute paths, drive letters and ".."); the execution layer resolves it against approvedRoots and refuses out-of-domain targets. Optional `rootId` selects one explicitly approved persistent workspace root instead of the project root (enumerate via io.workspaceRoots; human approval required). Mutates the filesystem, does NOT overwrite an existing entry.',
    inputSchema: {
      type: 'object',
      properties: {
        relPath: RELATIVE_PATH_SCHEMA,
        kind: { type: 'string', enum: ['file', 'directory'], description: 'What to create.' },
        content: { type: 'string', maxLength: 1_000_000, description: 'Initial file content (file only).' },
        rootId: ROOT_ID_SCHEMA,
      },
      required: ['relPath', 'kind'],
      additionalProperties: false,
    },
    tier: 'edit',
    annotations: { idempotentHint: false },
  },
  {
    name: 'fileTree.update',
    description:
      'Overwrite the full text content of an existing file inside the authorized project root. `relPath` is project-root-relative (schema + approvedRoots domain check). This REPLACES the whole content. For a targeted in-document edit use `problems.quickFix` (wired since 2026-11-06: it applies ONE listed code action inside the editor model as a single undo step, does not write to disk) — this tool is the whole-file path. Optional `rootId` selects one explicitly approved persistent workspace root instead of the project root (enumerate via io.workspaceRoots; human approval required). Idempotent for identical `content`. Mutates the filesystem. Refuses (WRITE_DISABLED) when the session-approved roots or the kernel write domain do not cover the target.',
    inputSchema: {
      type: 'object',
      properties: {
        relPath: RELATIVE_PATH_SCHEMA,
        content: { type: 'string', maxLength: 1_000_000, description: 'Full replacement text.' },
        rootId: ROOT_ID_SCHEMA,
      },
      required: ['relPath', 'content'],
      additionalProperties: false,
    },
    tier: 'edit',
    annotations: { idempotentHint: true },
  },
  {
    name: 'fileTree.remove',
    description:
      'Delete a file or directory inside the authorized project root. PRIVILEGED + destructive: requires per-tool approval (approvedTools) in this session. `relPath` is project-root-relative and domain-checked against approvedRoots. Optional `rootId` selects one explicitly approved persistent workspace root instead of the project root (enumerate via io.workspaceRoots; human approval required). Irreversible from the model perspective; use only after an explicit, itemized approval.',
    inputSchema: {
      type: 'object',
      properties: {
        relPath: RELATIVE_PATH_SCHEMA,
        recursive: { type: 'boolean', description: 'Allow removing a non-empty directory (default false).' },
        rootId: ROOT_ID_SCHEMA,
      },
      required: ['relPath'],
      additionalProperties: false,
    },
    tier: 'privileged',
    annotations: { destructiveHint: true, idempotentHint: false, readOnlyHint: false },
  },
  {
    name: 'fileTree.rename',
    description:
      'Rename/move an entry inside the authorized project root. PRIVILEGED + destructive: requires per-tool approval. Both `from` and `to` are project-root-relative and domain-checked against approvedRoots; any out-of-domain target is refused. Optional `rootId` selects one explicitly approved persistent workspace root for BOTH ends (enumerate via io.workspaceRoots; human approval required). Read the entry first; this changes the path others may reference.',
    inputSchema: {
      type: 'object',
      properties: { from: RELATIVE_PATH_SCHEMA, to: RELATIVE_PATH_SCHEMA, rootId: ROOT_ID_SCHEMA },
      required: ['from', 'to'],
      additionalProperties: false,
    },
    tier: 'privileged',
    annotations: { destructiveHint: true, idempotentHint: false, readOnlyHint: false },
  },
  {
    name: 'fileTree.applyChangeset',
    description:
      'Apply a BATCH of whole-file replacements inside the authorized project root in ONE round trip (edit tier, mutating; MCP-PERF-S3). `changes` is 1..32 items of {path, content}; every `path` is project-root-relative (same gate as fileTree.update: schema rejects absolute paths, drive letters and ".."; the execution layer additionally resolves against approvedRoots and refuses out-of-domain targets). Semantics per item are EXACTLY fileTree.update: the target must already exist (a missing file is reported per-item as refused, never silently turned into a create), the whole content is replaced, encoding/EOL default to preserve. One call = one MCP round trip + one backup manifest + one burst of per-file refresh events the host already debounce-merges into a single invalidation/diagnostics pass — instead of 20 separate fileTree.update calls each paying its own round trip. The reply itemizes the outcome: `applied` (per-file receipt incl. `bytes` from a post-write batch stat and `backupPath` taken BEFORE the write via the kernel\'s own backup primitive) and `refused` (per-file `code`/`message`; a partial failure never aborts the whole batch, but schema/authorization-level defects — more than 32 items, duplicate paths within the batch, an unknown or unapproved `rootId` — reject the ENTIRE batch before any write happens). Optional `rootId` selects one explicitly approved persistent workspace root for the WHOLE batch (enumerate via io.workspaceRoots; human approval required); per-item roots are deliberately not supported — one batch, one root, no mixed-domain writes.',
    inputSchema: {
      type: 'object',
      properties: {
        changes: {
          type: 'array',
          minItems: 1,
          maxItems: 32,
          items: {
            type: 'object',
            properties: {
              path: RELATIVE_PATH_SCHEMA,
              content: { type: 'string', maxLength: 1_000_000, description: 'Full replacement text (same cap as fileTree.update).' },
              encoding: {
                type: 'string',
                enum: ['utf-8', 'utf-8-bom', 'shift_jis', 'gbk', 'gb18030', 'big5', 'utf-16le', 'utf-16be', 'preserve'],
                description: 'Defaults to preserve: keep the encoding probed at read time (identical to fileTree.update).',
              },
              eol: {
                type: 'string',
                enum: ['crlf', 'lf', 'preserve'],
                description: 'Defaults to preserve: keep each original line ending (identical to fileTree.update).',
              },
            },
            required: ['path', 'content'],
            additionalProperties: false,
          },
          description: '1..32 whole-file replacements applied in order; a duplicate path within the batch is a batch-level error.',
        },
        rootId: ROOT_ID_SCHEMA,
      },
      required: ['changes'],
      additionalProperties: false,
    },
    tier: 'edit',
    annotations: { idempotentHint: true },
  },
  {
    name: 'fileTree.patchLines',
    description:
      'Apply a batch of line-level patch hunks to ONE existing file inside the authorized project root in ONE round trip (edit tier, mutating; MCP-PERF-S6) - patch-level write for large files: edit a 50,000-line file by sending only the hunks, not the whole text (whole-file paths remain fileTree.update / fileTree.applyChangeset). ' +
      '`relPath` is project-root-relative (same gate as fileTree.update: absolute paths, drive letters and ".." are rejected; the execution layer resolves against approvedRoots (ADR-0003)); optional `rootId` selects one explicitly approved persistent workspace root (enumerate via io.workspaceRoots; human approval required). ' +
      '`hunks` is 1..32 items, each EXACTLY ONE form: (a) LINE RANGE {startLine, endLine, replacement} - 1-based inclusive line numbers matching Monaco positions; lines split on CRLF/LF/CR like fs.readRange (trailing newline = final empty line); the whole-line span is replaced by `replacement` ("" deletes the span; multi-line text expands it). Coordinates refer to the ORIGINAL file: line hunks merge in one top-down pass; overlapping ranges reject the ENTIRE call. (b) ANCHOR {oldText, newText} - `oldText` must occur EXACTLY once; zero/multiple hits refuse that hunk. Line hunks apply first (top-down), then anchors in array order. ' +
      'Per call: read file -> apply hunks in memory -> ONE backup via the kernel backup primitive -> kernel writeText save path (encoding/EOL preserved, like fileTree.update) -> read back and verify -> ONE file.changed refresh. ' +
      'Reply: per-hunk `applied`/`refused` receipts, a `diff` summary (lines/chars before-after-delta), `backupPath` taken BEFORE the write, post-write `bytes`. Shape defects (>32 hunks, a hunk mixing both forms, non-1-based lines, startLine > endLine, empty oldText, unapproved `rootId`) reject the ENTIRE call before any write; every hunk refused = zero side effects. Prefer fileTree.update when a whole-file replacement fits the budget.',
    inputSchema: {
      type: 'object',
      properties: {
        relPath: RELATIVE_PATH_SCHEMA,
        hunks: {
          type: 'array',
          minItems: 1,
          maxItems: 32,
          items: {
            type: 'object',
            properties: {
              startLine: { type: 'integer', minimum: 1, description: 'FORM A (line range): 1-based first line of the span (Monaco position line; 0-based values are rejected).' },
              endLine: { type: 'integer', minimum: 1, description: 'FORM A: 1-based LAST line of the span, inclusive; beyond the file end refuses that hunk (writes never clamp).' },
              replacement: { type: 'string', maxLength: 1_000_000, description: 'FORM A: new content for the span; "" deletes the span; multi-line text expands it.' },
              oldText: { type: 'string', minLength: 1, maxLength: 1_000_000, description: 'FORM B (anchor): exact text to find; must occur EXACTLY once (zero/multiple hits refuse the hunk).' },
              newText: { type: 'string', maxLength: 1_000_000, description: 'FORM B: replacement text; "" deletes the anchor.' },
            },
            additionalProperties: false,
            description: 'EXACTLY ONE form per hunk: A = {startLine, endLine, replacement} or B = {oldText, newText}; mixing forms or missing keys is a batch-level error.',
          },
          description: '1..32 patch hunks applied to ONE file; overlapping line ranges are a batch-level error (nothing is written).',
        },
        rootId: ROOT_ID_SCHEMA,
      },
      required: ['relPath', 'hunks'],
      additionalProperties: false,
    },
    tier: 'edit',
    annotations: { idempotentHint: true },
  },
  {
    name: 'diff.compare',
    description:
      'Compute a structured diff between two document versions (working buffer vs last snapshot, or two project-root-relative files). Read-only; never writes. Returns {hunks:[...], truncated}. Use `mode` to select the comparison; `left`/`right` are optional relative paths for file-vs-file.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['working-vs-snapshot', 'file-vs-file'], description: 'Which two versions to compare.' },
        left: RELATIVE_PATH_SCHEMA,
        right: RELATIVE_PATH_SCHEMA,
      },
      required: ['mode'],
      additionalProperties: false,
    },
    tier: 'read',
    annotations: { readOnlyHint: true },
  },
  {
    name: 'state.replay',
    description:
      'Read a recorded state-replay snapshot / step list. Read-only: does NOT mutate live editor state. Use `step` to select a recorded index and `maxEvents` to cap the event list. Returns {steps:[...], total, truncated}.',
    inputSchema: {
      type: 'object',
      properties: {
        step: { type: 'integer', minimum: 0, description: 'Recorded step index (0-based, default latest).' },
        maxEvents: { type: 'integer', minimum: 1, maximum: 500, description: 'Cap on returned events (default 100).' },
      },
      additionalProperties: false,
    },
    tier: 'read',
    annotations: { readOnlyHint: true },
  },
  {
    name: 'preview.document',
    description:
      'Render a neutral, structured preview of a document (2.0 surface) WITHOUT executing any domain logic. Read-only: the preview is a projection, never a write. `relPath` is project-root-relative; `maxLines` caps output. Returns {blocks:[...], truncated}. Domain-specific rendering knowledge is supplied by adapters via mcp.prompt slots, never hardcoded here.',
    inputSchema: {
      type: 'object',
      properties: {
        relPath: RELATIVE_PATH_SCHEMA,
        maxLines: { type: 'integer', minimum: 1, maximum: 2000, description: 'Cap on previewed lines (default 200).' },
      },
      additionalProperties: false,
    },
    tier: 'read',
    annotations: { readOnlyHint: true },
  },

  /* ---- 第三波（路 B 能力面真正够用）：把「有真源可接」的只读缺口补成具名工具 ----
   * 全部走 runSupplemental 钩子（宿主注入真源）；宿主未接线 ⇒ NOT_WIRED 可见，
   * 绝不返回空串兜底。真源：Rust IO 原语 / 语义读数面 / 已有 resource 数据面。
   * 每条 description 面向模型，写清用途 / 入参 / 返回 / 只读 / 截断 / 路径约束。
   */
  {
    name: 'commands.list',
    description:
      'List the commands registered in the command palette (id / title / description / tier). Read-only. Same data source as the kojo://project/commands resource, but this surface pages: `maxResults` (or `limit` — one and the same knob) sizes a page and `cursor` from the previous response resumes it, so every registered command is enumerable — `total` is the full count and `hasMore`/`nextCursor` say how to get the rest. A page-size name that is not declared here is now rejected instead of silently paging at the default size. ' +
      PAGE_ACCOUNT_NOTE +
      ' Discover real ids here before calling any command; never invent a command id.',
    inputSchema: {
      type: 'object',
      properties: {
        maxResults: { type: 'integer', minimum: 1, maximum: 500, description: `Page size (default 200; the pre-existing cap, never widened).${ALIAS_OF_LIMIT}` },
        ...PAGE_PROPS,
        ...pageSizeAliasProps(['maxResults']),
      },
      additionalProperties: false,
    },
    tier: 'read',
    annotations: { readOnlyHint: true },
  },
  {
    name: 'document.active',
    description:
      'Read the active document text and cursor position as a read-only projection. Same data source as the kojo://project/active-document resource, but this surface pages: `offset` (0-based character offset) + `length` (alias `maxChars`) address a sub-range, and `cursor` from the previous response resumes exactly where it ended — `textLength` is the FULL length, so concatenating pages reproduces the buffer character-for-character. Page size: default 8000, max 65000 characters (the host sanitizer cuts any untrusted string at 65536, so pages are kept under that gate rather than reported-then-trimmed). `limit` / `length` / `maxChars` are ONE knob (`limit` is the real name; the other two are this surface\'s historical synonyms, still honored) — an undeclared argument name is now rejected loudly rather than silently defaulting. ' +
      PAGE_ACCOUNT_NOTE +
      ' Read-first: do not infer any text beyond what is returned.',
    inputSchema: {
      type: 'object',
      properties: {
        offset: { type: 'integer', minimum: 0, description: '0-based character offset of the window start (default 0).' },
        length: { type: 'integer', minimum: 1, maximum: 65_000, description: `Characters in this page (default 8000, max 65000).${ALIAS_OF_LIMIT}` },
        maxChars: { type: 'integer', minimum: 1, maximum: 65_000, description: 'Legacy alias of `length`; values above 65000 are clamped down to the host gate.' + ALIAS_OF_LIMIT },
        ...PAGE_PROPS,
        ...pageSizeAliasProps(['length', 'maxChars']),
      },
      additionalProperties: false,
    },
    tier: 'read',
    annotations: { readOnlyHint: true },
  },
  {
    name: 'fs.readFile',
    description:
      'Read the text content of one file inside the authorized project root (read-only), page by page. `relPath` MUST be a project-root-relative path — the schema rejects absolute paths, drive letters and ".." traversal, and the execution layer re-checks it against approvedRoots. Backed by the Rust read_file_bytes primitive: the whole file is decoded host-side, this tool returns ONE window. Use `offset` (0-based character offset) + `length` (alias `maxChars`, kept for backwards compatibility) to address a sub-range; a plain `cursor` from the previous page is equivalent and self-checking. ' +
      'Completeness: `textLength` is the FULL character length of the file; `hasMore` says whether characters remain after this page; `nextCursor` resumes exactly where this page ended, so concatenating pages reproduces the file character-for-character. If the file changed between pages the response carries `changedDuringPaging:true` and restarts from offset 0 — do not splice that page with earlier ones. ' +
      'Page size is gated: default 24000 characters, maximum 65000 characters (`length` is clamped). The 65000 ceiling is not a convenience — the host sanitizer cuts any single untrusted string at 65536 characters, so a larger page would have been silently re-truncated after this tool reported its account. One knob, several historical names: `limit` is the real name, `length` / `maxChars` are synonyms this surface keeps accepting; any name NOT declared here is rejected with the legal list instead of silently paging at the default size. Never writes to disk.',
    inputSchema: {
      type: 'object',
      properties: {
        relPath: RELATIVE_PATH_SCHEMA,
        offset: { type: 'integer', minimum: 0, description: '0-based character offset of the window start (default 0). Ignored (treated as head-restart) when a cursor is given.' },
        length: { type: 'integer', minimum: 1, maximum: 65_000, description: `Characters to return in this page (default 24000, max 65000 — see the host string gate).${ALIAS_OF_LIMIT}` },
        maxChars: { type: 'integer', minimum: 1, maximum: 65_000, description: 'Legacy alias of `length`. Values above 65000 are clamped down to the host gate, not up.' + ALIAS_OF_LIMIT },
        ...PAGE_PROPS,
        ...pageSizeAliasProps(['length', 'maxChars']),
      },
      required: ['relPath'],
      additionalProperties: false,
    },
    tier: 'read',
    annotations: { readOnlyHint: true },
  },
  {
    name: 'fs.stat',
    description:
      'Query metadata (existence, kind, size, modification time) for one path inside the authorized project root (read-only). `relPath` is project-root-relative and domain-checked against approvedRoots; out-of-domain targets are refused. Backed by the Rust stat_file / path_exists primitives. Never writes to disk and never follows a path outside the approved roots.',
    inputSchema: {
      type: 'object',
      properties: { relPath: RELATIVE_PATH_SCHEMA },
      required: ['relPath'],
      additionalProperties: false,
    },
    tier: 'read',
    annotations: { readOnlyHint: true },
  },
  {
    name: 'io.listDir',
    description:
      'List the direct children of one directory inside the authorized project root (read-only). `relPath` is optional (defaults to the project root) and must be project-root-relative; `maxEntries` / `limit` size a page and `cursor` resumes the next one, so a large directory is fully enumerable; `maxDepth` bounds recursion and the result carries an explicit `truncated` flag. Backed by the Rust list_dir / walk_dir primitives. Use it to confirm a relative path exists before any write. Page size is ONE knob (`limit` is the real name, `maxEntries` this surface\'s historical synonym); an argument name outside the declared list is now rejected instead of being silently ignored. Never writes to disk. ' +
      PAGE_ACCOUNT_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        relPath: RELATIVE_PATH_SCHEMA,
        maxEntries: { type: 'integer', minimum: 1, maximum: 5000, description: `Page size (default 500; the pre-existing cap, never widened).${ALIAS_OF_LIMIT}` },
        maxDepth: { type: 'integer', minimum: 0, maximum: 16, description: 'Recursion depth cap (default 1).' },
        ...PAGE_PROPS,
        ...pageSizeAliasProps(['maxEntries']),
      },
      additionalProperties: false,
    },
    tier: 'read',
    annotations: { readOnlyHint: true },
  },
  {
    name: 'io.workspaceRoots',
    description:
      'List the workspace roots registered for the current session (read-only). Backed by the Rust workspace_roots primitive. `maxResults`/`limit` size a page (one and the same knob) and `cursor` resumes it; the list carries `total` + `hasMore` so it is fully enumerable. Undeclared argument names are rejected, never silently dropped to the default page. The additive `rootIds` array is index-aligned with `roots`: each is a stable `ws:` identifier usable as the optional `rootId` on the four fileTree write tools — but only after a human explicitly approves that identifier in this session (approvedRootIds). Use this to learn the legitimate domain for subsequent relative paths; it never grants write access outside approvedRoots and never mutates state. ' +
      PAGE_ACCOUNT_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        maxResults: { type: 'integer', minimum: 1, maximum: 200, description: `Page size (default 50; the pre-existing cap, never widened).${ALIAS_OF_LIMIT}` },
        ...PAGE_PROPS,
        ...pageSizeAliasProps(['maxResults']),
      },
      additionalProperties: false,
    },
    tier: 'read',
    annotations: { readOnlyHint: true },
  },
  {
    name: 'editor.info',
    description:
      'Read editor/runtime metadata (read-only): which surface is active, document counts, and capability flags. Backed by the semantic `info` read. `section` narrows the projection; the result carries an explicit `truncated` flag. A read-only information surface — it never changes editor state and never invents values that the source did not report.',
    inputSchema: {
      type: 'object',
      properties: {
        section: { type: 'string', enum: ['all', 'editor', 'document'], description: 'Which metadata section to project (default all).' },
        maxResults: { type: 'integer', minimum: 1, maximum: 500, description: 'Cap on returned fields (default 200).' },
      },
      additionalProperties: false,
    },
    tier: 'read',
    annotations: { readOnlyHint: true },
  },
  {
    name: 'editor.selfCheck',
    description:
      'Run a read-only self-check of the language/validation layer and return its findings (rule / message / severity). Backed by the semantic `selfCheck` read. `maxResults`/`limit` size a page and `cursor` resumes it, so every finding is enumerable (page size is ONE knob; the historical name `maxResults` keeps working); an undeclared argument name is rejected rather than silently paging at the default. The result carries an explicit `truncated` flag. It is a diagnostic projection, never a fix and never a write; do not treat it as an authorization to edit. ' +
      PAGE_ACCOUNT_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        maxResults: { type: 'integer', minimum: 1, maximum: 500, description: `Page size (default 200; the pre-existing cap, never widened).${ALIAS_OF_LIMIT}` },
        ...PAGE_PROPS,
        ...pageSizeAliasProps(['maxResults']),
      },
      additionalProperties: false,
    },
    tier: 'read',
    annotations: { readOnlyHint: true },
  },
  {
    name: 'lang.foldingRanges',
    description:
      'Return folding ranges for the active document (read-only). Backed by the semantic `foldingRanges` read. `lineFrom` / `lineTo` restrict the window and `maxRanges` caps the result with an explicit `truncated` flag. A structural projection only — it never edits the document and never applies any domain rule.',
    inputSchema: {
      type: 'object',
      properties: {
        lineFrom: { type: 'integer', minimum: 0, description: '0-based first line of the window.' },
        lineTo: { type: 'integer', minimum: 0, description: '0-based last line of the window.' },
        maxRanges: { type: 'integer', minimum: 1, maximum: 2000, description: 'Cap on returned ranges (default 500).' },
      },
      additionalProperties: false,
    },
    tier: 'read',
    annotations: { readOnlyHint: true },
  },
  {
    name: 'lang.highlightsAt',
    description:
      'Return document highlights for the symbol at a 1-based line/column (read-only). Backed by the semantic `highlightsAt` read. Returns the matched ranges without mutating the document. Use the read-only result to understand symbol usage before proposing any edit; never apply a change from this call.',
    inputSchema: STRICT_POS_SCHEMA,
    tier: 'read',
    annotations: { readOnlyHint: true },
  },
  {
    name: 'lang.signatureAt',
    description:
      'Return signature help at a 1-based line/column (read-only). Backed by the semantic `signatureAt` read. Returns candidate signatures / active parameter without mutating the document. Domain wording, if any, comes only through mcp.prompt slots; this tool reports the raw language-service output.',
    inputSchema: STRICT_POS_SCHEMA,
    tier: 'read',
    annotations: { readOnlyHint: true },
  },
  {
    name: 'lang.markers',
    description:
      'Return the current marker set for the active document (read-only). Backed by the semantic `markers` read. `maxResults`/`limit` size a page (ONE knob; `maxResults` is this surface\'s historical synonym) and `cursor` resumes it, so the full marker set is enumerable; an undeclared argument name is now rejected instead of silently paging at the default size. The result carries an explicit `truncated` flag. This is a read-only problem/decoration projection — it never clears or edits a marker and never fabricates a finding. ' +
      PAGE_ACCOUNT_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        maxResults: { type: 'integer', minimum: 1, maximum: 500, description: `Page size (default 200; the pre-existing cap, never widened).${ALIAS_OF_LIMIT}` },
        ...PAGE_PROPS,
        ...pageSizeAliasProps(['maxResults']),
      },
      additionalProperties: false,
    },
    tier: 'read',
    annotations: { readOnlyHint: true },
  },

  /* ---- 第四波（LaneF，2026-11-06）：11 条 cheap-read 逐条判性后登记 6 枚只读具名工具 ----
   * 全部按只读档登记并带 readOnlyHint:true，走 runSupplemental 钩子（宿主注入真源）；缺真源 ⇒ NOT_WIRED 可见。
   * 另 5 条刻意不登记（理由见 MCP_DEFERRED_GAP_NOTES 与 commit 回执）：
   *   read_file_bytes_raw / read_files_raw（ipc::Response 二进制帧，无模型可调用的结构化数据面）、
   *   updater_relaunch / debug.type（非只读动作）、debug.actions（真源对 MCP 注入面不可达）。
   * B2 批（LaneT，2026-11-06）改判其中一条：read_files_raw 的结构化子集由具名只读工具
   *   fs.readMany 覆盖（走 kernel.io.readTexts 的 TextFile 投影 + 逐条项目根内相对路径），
   *   二进制帧本身仍 deferred；逐条理由见下面 fs.readMany 的 description 与台账条目。
   */
  {
    name: 'app.dataDir',
    description:
      'Read the application data directory path as a plain string (read-only, no arguments). Backed by the Rust app_data_dir primitive. Informational only: it does NOT grant read/write access outside approvedRoots, does not list or touch any file, and must never be used as a write target. Single path string, no truncation.',
    // 诚实零参契约：显式拒绝任何入参，不用空 {type:'object'} 兜底（见 mcp-host.test.ts 的 schema 闸）。
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    tier: 'read',
    annotations: { readOnlyHint: true },
  },
  {
    name: 'codec.encodeString',
    description:
      'Encode a text string into bytes with a named character encoding and return the result as base64 (read-only, pure conversion, no IO). `encoding` is a fixed whitelist (utf-8, utf-8-bom, shift_jis, gbk, gb18030, big5, utf-16le, utf-16be); unsupported characters produce a visible error, never a silent replacement. Backed by the Rust encode_string primitive. Returns {encoding, charLength, base64}. Never writes a file; persisting bytes is a separate authorized edit tool.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', maxLength: 1_000_000, description: 'Text to encode.' },
        encoding: { type: 'string', enum: ['utf-8', 'utf-8-bom', 'shift_jis', 'gbk', 'gb18030', 'big5', 'utf-16le', 'utf-16be'], description: 'Target encoding (fixed whitelist).' },
      },
      required: ['text', 'encoding'],
      additionalProperties: false,
    },
    tier: 'read',
    annotations: { readOnlyHint: true },
  },
  {
    name: 'fs.pathExists',
    description:
      'Check whether one path exists inside the authorized project root (read-only). `relPath` MUST be a project-root-relative path — the schema rejects absolute paths, drive letters and ".." traversal, and the execution layer resolves it against approvedRoots and refuses any out-of-domain target. Backed by the Rust path_exists primitive. Returns {path, exists} with the real filesystem answer; never writes to disk.',
    inputSchema: {
      type: 'object',
      properties: { relPath: RELATIVE_PATH_SCHEMA },
      required: ['relPath'],
      additionalProperties: false,
    },
    tier: 'read',
    annotations: { readOnlyHint: true },
  },
  {
    name: 'fs.statFiles',
    description:
      'Batch-query metadata (existence, size, modification time) for several paths inside the authorized project root (read-only). `relPaths` is an array of project-root-relative paths; EACH is schema-checked and resolved against approvedRoots, and any out-of-domain target is refused. `maxResults` caps the returned items with an explicit `truncated` flag; input order is preserved. Backed by the Rust stat_files primitive — a missing file yields exists:false with null size/mtimeMs (never a fabricated zero). Read-only; never writes to disk.',
    inputSchema: {
      type: 'object',
      properties: {
        relPaths: { type: 'array', items: RELATIVE_PATH_SCHEMA, minItems: 1, maxItems: 200, description: 'Project-root-relative paths (each domain-checked).' },
        maxResults: { type: 'integer', minimum: 1, maximum: 200, description: 'Cap on returned stat items (default 200).' },
      },
      required: ['relPaths'],
      additionalProperties: false,
    },
    tier: 'read',
    annotations: { readOnlyHint: true },
  },
  /* ---- B2 批（LaneT，2026-11-06）：结构化批读面（一次调用读多文件）----
   * 判性（拆掉 read_files_raw 留在台账上的两条理由，逐条）：
   *  ①「无面向模型的结构化只读数据面」⇒ 本工具的输出是 kernel.io.readTexts 的 TextFile 投影
   *    （正文 / 编码 / EOL / mtime + 逐条分页账），不是 ipc::Response 裸字节帧；二进制帧那条
   *    开项目热路径性能通道**继续 deferred**（台账条目已改写）。
   *  ②「收任意 paths 数组 ⇒ 暴露任意目标路径参数」⇒ 本工具只收**项目根内相对路径**，逐条走与
   *    fs.readFile / fs.statFiles 同一个 resolveWithinRoot（绝对路径 / 盘符 / ".." 整批显式
   *    INVALID_ARGS，域外路径绝不送到壳层），并加单次 ≤64 条硬上限（超限显式报错，绝不静默截断）。
   * 只读自证：只调内核批量读原语与只读 stat_files；零写命令、零索引重建、零落盘。
   */
  {
    name: 'fs.readMany',
    description:
      'Read the text of SEVERAL files inside the authorized project root in ONE call (read-only) — the batch counterpart of fs.readFile, backed by the kernel primitive io.readTexts (one batch IPC instead of a round trip per file). ' +
      '`relPaths` are project-root-relative and EACH is schema-checked plus resolved against the authorized project root: an absolute path, drive letter or ".." entry rejects the WHOLE batch with INVALID_ARGS, so nothing out-of-domain reaches the shell. Hard cap 64 paths per call — more is an explicit error telling you to split into batches, never a silently dropped tail. ' +
      'Per-file paging uses the same text gates as fs.readFile: `offset` (0-based character offset applied to every file) and `limit` (default 24000 / maximum 65000 characters per file — no gate widened); every item carries its own {textLength, truncated, hasMore, nextCursor, fingerprint} and an item cursor feeds straight back to fs.readFile for that one file. The batch nextCursor keys on the relPaths-list fingerprint plus the character offset, so a changed list answers changedDuringPaging:true and restarts at offset 0 — pages never splice silently. ' +
      'Nothing is hidden in the account: items[] is 1:1 with relPaths (duplicate paths included); a file the kernel could not read stays an explicit {path, ok:false, error:{code,message}} slot — never an empty string, never a skipped entry — and failed slots are triaged by ONE batched stat_files into NOT_FOUND vs READ_FAILED (inconclusive is reported as such, never dressed up as NOT_FOUND). Top-level {requested, succeeded, failed, charsReturned, truncated, hasMore, maxPathsPerCall, overLimit} is always present. ' +
      'Stated rather than hidden: the batch primitive may answer a slot from the session text cache (validated by mtime+size, so the text still matches what is on disk, whereas fs.readFile always re-reads), and each item adds encoding / eol / mtimeMs plus its own fsFreshness verdict. Never writes to disk, never rebuilds an index; for ONE file use fs.readFile.',
    inputSchema: {
      type: 'object',
      properties: {
        relPaths: {
          type: 'array',
          items: RELATIVE_PATH_SCHEMA,
          minItems: 1,
          maxItems: 64,
          description:
            'Project-root-relative paths, each domain-checked (absolute paths, drive letters and ".." traversal are refused for the whole batch). Duplicates are answered 1:1. Hard cap 64 per call; above that the call fails with INVALID_ARGS instead of truncating the list.',
        },
        offset: {
          type: 'integer',
          minimum: 0,
          description:
            '0-based character offset applied to EVERY file in this batch (default 0). A bare offset carries no continuity guarantee — each item still reports its own text fingerprint.',
        },
        ...PAGE_PROPS,
      },
      required: ['relPaths'],
      additionalProperties: false,
    },
    tier: 'read',
    annotations: { readOnlyHint: true },
  },
  {
    name: 'lang.lensesAt',
    description:
      'Return code lenses for the active document (read-only). Backed by the codeLensProvider registry through the same read-only provider collection used by lang.highlightsAt / lang.foldingRanges. `provideCodeLenses` is a whole-document call; an optional 1-based `line` filters to lenses whose range covers that line. Results are raw provider output: each item reports its range and, when the provider already supplied a command, its title/commandId; MCP does NOT call resolveCodeLens, so an item with no command is reported with resolved:false, never fabricated. `maxResults` caps the list with an explicit `truncated` flag; `providers`/`answered` keep the three-state account. Never applies a command or edits the document.',
    inputSchema: {
      type: 'object',
      properties: {
        line: { type: 'integer', minimum: 1, description: 'Optional 1-based line filter.' },
        maxResults: { type: 'integer', minimum: 1, maximum: 200, description: 'Cap on returned lenses (default 30).' },
      },
      additionalProperties: false,
    },
    tier: 'read',
    annotations: { readOnlyHint: true },
  },
  {
    name: 'lang.selectionRangesAt',
    description:
      'Return selection-range (smart-expand) chains for a 1-based line/column (read-only). Backed by the selectionRangeProvider registry through the same read-only provider collection used by lang.highlightsAt. Each chain is reported in the provider-supplied order (near to far) as a list of ranges; MCP does NOT do the UI merge/sort/dedup post-processing. `maxChains` caps the list with an explicit `truncated` flag; `providers`/`answered` keep the three-state account. A projection only — never changes the selection or edits the document.',
    inputSchema: {
      type: 'object',
      properties: {
        line: { type: 'integer', minimum: 1 },
        column: { type: 'integer', minimum: 1 },
        maxChains: { type: 'integer', minimum: 1, maximum: 200, description: 'Cap on returned chains (default 8).' },
      },
      required: ['line', 'column'],
      additionalProperties: false,
    },
    tier: 'read',
    annotations: { readOnlyHint: true },
  },

  /* ---- 第五波（LaneH，2026-11-06）：Wave4 #4 判性落地 →（B10 批 LaneV 同日收口其中一枚）----
   * Wave4 #4 的判性**在当时成立**，四条证据一条都没被推翻：
   *   · editor.revealLocation（App.tsx 的通用导航落地点）是唯一真实的「打开 + 定位」通道，而它是
   *     fire-and-forget 事件：无 ack / 无落地确认；落地走 React setState 异步重渲染；
   *     routeOpenPath 只过 .kojo2 入口闸、不校验路径是否在项目根内；订阅者只在 App 组件挂载时存在；
   *   · EditorCommandContext（slots-types.ts）只读投影，无 open / reveal 句柄；
   *     McpRealSourceHost 只有三个只读 getter；CommandEntry.run 忽略 args、返回 void，
   *     gotoLine 经 editor.action.request 触发 Monaco 交互式输入框；
   *     file-tree-ops + 内核 io.readText 是读内容通道，不打开 GUI 文档。
   * B10 批改判的是**观察件**而不是通道：editor-pane-registry 那张登记簿从 B3 批起已被证明可在执行时
   * 动态 import 并按 paneId 反查（`editor-write-legs.ts`），于是「这条 path 有没有真上屏」
   * 变成读得回来的事实 ⇒
   *   ✔ editor.openDocument：**已登记**为具名 edit 工具（本文件 B10 规格块 + app `editor-open-legs.ts`）。
   *     形态 = 发射宿主既有事件 → 有界轮询登记簿 → 用读数说话；读不到显式失败，登记簿读不到时在发射前
   *     NOT_WIRED。Wave4 #4 里「routeOpenPath 不校验项目根域」这一条由 MCP 侧的 resolveWithinRoot
   *     补上（与 fs.readFile 同尺），宿主事件永远拿不到域外落点。
   *   ✘ editor.revealPosition：**继续不登记**。视口定位与光标定位已分别由 editor.revealLine /
   *     editor.setCursor 覆盖且各自带读回核对，paneId 又由 editor.openDocument / document.active 交回；
   *     这条「一步做两件事」的组合面没有独立诚实数据面，登记它只会造出第二条没有核对的跳转。
   *     runSupplemental 对这一枚保留前置兜底，误调必得带判性理由的可见 NOT_WIRED。
   * editor.cursor 是分开记账的只读读数加法（真源 = 焦点编辑器 getPosition），不冒充写工具。
   * 写盘边界不变：打开文档不写盘，落盘仍只经第四张表 approvedRoots × 内核 writablePaths 双闸与
   * exportFile 对话框（铁律 5/6/7：本批零新增写盘通道）。
   * 本注释刻意不写规格字面量，避免干扰盘点脚本对规格块的正则解析。
   */
  // 与上面的面分开记账：这是安全的只读读数加法（真源 = 焦点编辑器 getPosition，
  // 与 document.active / editor.info 同源），不是打开 / 定位写工具，绝不拿来冒充写能力。
  {
    name: 'editor.cursor',
    description:
      'Read the caret position of the active editor (read-only). Returns {path, language, line, column, lineCount} for the focused document; the 1-based cursor comes from the focused editor, not the model. No arguments, no side effects: never moves the caret and never opens a file. Backed by the same read-only workspace source as document.active / editor.info. When no editor is focused the call fails with a visible NOT_WIRED (never a fabricated {line:1,column:1}). This is a READ tool, deliberately separate from the editor.openDocument edit tool and from the editor.revealPosition gap that stays unregistered.',
    // 诚实零参契约：显式拒绝任何入参，不用空 {type:'object'} 兜底（见 mcp-host.test.ts 的 schema 闸）。
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    tier: 'read',
    annotations: { readOnlyHint: true },
  },


  /* ---- Wave4 余项⑤（LaneL，2026-11-06）：长任务 progress = ADR-0013 P5「Tasks over MCP」 ----
   * 判性落地（逐条证据见 real-sources-tasks.ts 模块头与 commit 回执）：只登记**三件套齐备**的族
   * ——进度有真源、取消有真源、状态可查询。目前两族：
   *   · search —— 进度真源 = 壳层 `kojo:search-progress`（按文件数与时间双条件节流、按 searchId
   *     认领），取消真源 = `cancel_search`（同一 cancelled 集合，检索线程逐文件读），
   *     完成态由 `search_text` 返回值收口；
   *   · validation —— 启动/终态真源 = 内核 `convention.linter` 的 run/report，取消真源 =
   *     ConventionRunOptions.signal（引擎只在文件单元间隙看这颗闸），**运行中没有逐单元进度回调**
   *     ⇒ progress 显式 known:false + reason，只有终态那一轮由引擎陈述 incomplete（事后读数）。
   * 刻意不登记：索引构建（无取消位 + 会改写 GUI 在用的全局索引）、导出（对话框即授权、无进度无取消、
   * 任务参数绝不允许变成可选落点）；启动器任务表三件套齐全但另有主人与第三张表 ⇒ 本批不并表，
   * 缺席事实在 kojo://tasks 的 notIncluded[] 里可见（不静默）。
   * 传输形态纪律：MCP 端点是无状态单请求 HTTP，**进度契约＝轮询读**（tasks.status / kojo://tasks）；
   * 本批不把 capabilities 的 resources.subscribe 抬成 true，也不伪造 notification。
   * 落盘边界：两族都不写项目目录（校验快照走内核既有 storage 命名空间），roots 只由项目载荷投影，
   * 不接受调用方给的绝对路径 ⇒ 不新建任何写通道。
   * 本注释刻意不写规格字面量，避免干扰盘点脚本对规格块的正则解析。
   */
  {
    name: 'tasks.start',
    description:
      'Register one long operation as a queryable, cancellable task instead of a single blocking tools/call. kind "search" runs the same native project-wide search the shell runs (throttled progress frames feed done/total/matchCount); kind "validation" starts one convention-linter round, which has NO live per-unit progress (progress.known:false, done/total stay null - never 0%) and only reports incomplete{unitsDone,unitsTotal} at the end. Returns the task view immediately WITHOUT awaiting it: {taskId, status, progress, cancelRequested}. Poll with tasks.status or read the kojo://tasks resource - this endpoint is request/response, the server never pushes. Bounded by design: at most 2 running tasks per session and 32 table rows with lazy retention; over capacity the call fails visibly with RESOURCE_UNAVAILABLE instead of queueing. Roots come from the open project contract only (no path arguments), and neither kind writes to the project. Export and index building are deliberately NOT registered as tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['search', 'validation'],
          description: 'Which long operation to model as a task (default: search).',
        },
        query: { type: 'string', minLength: 1, maxLength: 512, description: 'search kind only: case-insensitive substring to find.' },
        scope: {
          type: 'string',
          enum: ['all', 'sources'],
          description: 'search kind only: scan the project root (all) or the contract source dirs (sources).',
        },
        maxResults: {
          type: 'integer',
          minimum: 1,
          maximum: 500,
          description: 'search kind only: hit cap handed to the shell (default 200, values are clamped).',
        },
        force: { type: 'boolean', description: 'validation kind only: bypass the snapshot cache and re-check every unit.' },
      },
      // B11 入参严格化：这五枚名字就是 real-sources-tasks.ts 的 `startTask` 唯一取用的入参
      // （`kind` / `query` / `scope` / `maxResults` / `force`），改前多发的名字会被照收并静默忽略
      // ——正是本批要消灭的静默；旧名字一个没删，零参调用仍走 `kind:'search'` 的既有缺省。
      additionalProperties: false,
    },
    tier: 'edit',
    annotations: { readOnlyHint: false, idempotentHint: false },
  },
  {
    name: 'tasks.status',
    description:
      'Poll one task started by tasks.start inside THIS session (read-only, zero side effects). Returns {taskId, kind, status, progress{known, phase, done, total, percent, frames, lastFrameAgeMs}, cancelRequested, cancelApplied, result}. progress.done/total are null before the first throttled frame and stay null when the operation has no live progress source (progress.known:false plus the reason) - null means "not reported", NOT 0% and NOT "nothing is happening"; readings between frames keep the last frame with its age. The stored result projection is bounded and carries an explicit truncated flag. An unknown id, a recycled row (retention is 10 minutes; reloading the editor page clears the whole table) or another session\'s task all fail visibly with RESOURCE_UNAVAILABLE - never an empty frame. Poll, do not subscribe: the transport does not push progress.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', minLength: 1, maxLength: 128, description: 'The id returned by tasks.start.' },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
    tier: 'read',
    annotations: { readOnlyHint: true },
  },
  {
    name: 'tasks.cancel',
    description:
      'Request cancellation of one task in THIS session. Cancellation is a REQUEST, not an acknowledgement: a search task forwards the shell cancel for its own search id (the worker checks the flag between files and reports cancelled in the final result), a validation task sets this run\'s abort signal - and if the round merged with one the GUI already started, this task\'s flag does not apply. Read tasks.status for the fact: status "cancelled" with cancelApplied:true; cancelApplied:false states honestly that it finished first. A task already in a terminal state returns idempotently with alreadyFinished:true (no error, and no claim of having cancelled something); a missing cancel primitive fails visibly with NOT_WIRED instead of pretending success. Never touches files, the write domains or the export dialog.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', minLength: 1, maxLength: 128, description: 'The id returned by tasks.start.' },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
    tier: 'edit',
    annotations: { readOnlyHint: false, idempotentHint: true },
  },

  /* ---- B3 批（LaneO，2026-11-06）：编辑器写 / 光标副作用 5 枚具名工具（tier 'edit'）----
   * 真源 = debug/install-debug.ts 已实现并测过的同一批腿（回读核对 / normalizeCursorTarget /
   * editorReadOnly），执行体见 app `mcp/editor-write-legs.ts`（ioTools 腿表）。差别只在：MCP 面
   * 按 paneId 显式反查实例，**没有「当前聚焦」这个语义**；只读实例的内容写两枚显式拒绝。
   * 五枚都只改 Monaco 模型：`saved:false` 恒定如实回报，磁盘写仍是 fileTree.update +
   * 第四张表双闸那条唯一法定通道（铁律 5/6/7：本批零新增写盘通道）。
   */
  {
    name: 'editor.setValue',
    description:
      'Replace the ENTIRE text of one open document in the editor model (edit tier, mutating). `paneId` is required — this tool has no notion of a "focused" editor, so pass the id reported by document.active / editor.info. Coordinates are irrelevant here: `text` is the whole new content. The call verifies the change by reading the model back: an unchanged or refused write fails with [E_EDITOR_APPLY_UNVERIFIED] instead of reporting success. A read-only editor is refused outright ([E_EDITOR_READ_ONLY], PERMISSION_DENIED). This mutates the in-memory model ONLY — the reply always carries saved:false, disk bytes are untouched; persisting goes through fileTree.update under the approvedRoots x writablePaths double gate. Undo is not recorded for a whole-model setValue; use editor.type for a single undo step.',
    inputSchema: {
      type: 'object',
      properties: {
        paneId: { type: 'string', minLength: 1, maxLength: 128, description: 'Editor pane id copied from document.active / editor.info (required, no "focused editor" fallback).' },
        text: { type: 'string', maxLength: 4_000_000, description: 'Complete new document content (the whole model is replaced).' },
      },
      required: ['paneId', 'text'],
      additionalProperties: false,
    },
    tier: 'edit',
    annotations: { idempotentHint: false },
  },
  {
    name: 'editor.type',
    description:
      'Insert `text` at the current caret of one open document, the way typing does (edit tier, mutating). `paneId` is required (no "focused editor" semantics on this surface). Runs through Monaco executeEdits, so it is ONE undo step (Ctrl+Z once) and moves the caret. The result is verified by reading the model back: a refused or no-op insertion fails with [E_EDITOR_APPLY_UNVERIFIED] rather than pretending success. A read-only editor is refused outright ([E_EDITOR_READ_ONLY], PERMISSION_DENIED). Model-only: the reply always carries saved:false and the real dirty flag; nothing is written to disk (persisting is fileTree.update under the double gate).',
    inputSchema: {
      type: 'object',
      properties: {
        paneId: { type: 'string', minLength: 1, maxLength: 128, description: 'Editor pane id (required).' },
        text: { type: 'string', minLength: 1, maxLength: 200_000, description: 'Text to insert at the caret (not truncated).' },
      },
      required: ['paneId', 'text'],
      additionalProperties: false,
    },
    tier: 'edit',
    annotations: { idempotentHint: false },
  },
  {
    name: 'editor.setCursor',
    description:
      'Move the caret of one open editor pane to a 1-based `line` / `column` (edit tier: it changes user-visible editor state, so a read session must not be able to move the caret). `paneId` is required — there is no "focused editor" fallback. Coordinates are validated strictly 1-based positive integers by the same normalizer the debug surface uses; dirty values (0-based, fractional, missing line) fail with INVALID_ARGS instead of silently landing elsewhere. Out-of-document lines are refused, not clamped. The reply reports both `requested` and the read-back `cursor` plus a `clamped` flag, so a clamp by Monaco is visible rather than a false "it moved". Content is untouched: dirty/contentChanged stay honest and saved:false always holds (no disk write).',
    inputSchema: {
      type: 'object',
      properties: {
        paneId: { type: 'string', minLength: 1, maxLength: 128, description: 'Editor pane id (required).' },
        line: { type: 'integer', minimum: 1, description: '1-based target line.' },
        column: { type: 'integer', minimum: 1, description: '1-based target column (omitted = line start, column 1).' },
      },
      required: ['paneId', 'line'],
      additionalProperties: false,
    },
    tier: 'edit',
    annotations: { idempotentHint: true },
  },
  {
    name: 'editor.setSelection',
    description:
      'Set the selection range of one open editor pane with 1-based `startLine`/`startColumn`/`endLine`/`endColumn` (edit tier — user-visible editor state, not a read operation). `paneId` is required (no "focused editor" semantics). Dirty or 0-based coordinates fail with INVALID_ARGS; `endLine` must be >= `startLine`; lines beyond the document are refused, while columns beyond the line end are clamped to the line end and reported in the `clamped` flag with the read-back `selection`. Content is not modified (contentChanged:false) and nothing is persisted: the reply always carries saved:false plus the model dirty flag.',
    inputSchema: {
      type: 'object',
      properties: {
        paneId: { type: 'string', minLength: 1, maxLength: 128, description: 'Editor pane id (required).' },
        startLine: { type: 'integer', minimum: 1, description: '1-based selection start line.' },
        startColumn: { type: 'integer', minimum: 1, description: '1-based selection start column.' },
        endLine: { type: 'integer', minimum: 1, description: '1-based selection end line (>= startLine).' },
        endColumn: { type: 'integer', minimum: 1, description: '1-based selection end column (clamped to the line end; the clamp is reported).' },
      },
      required: ['paneId', 'startLine', 'startColumn', 'endLine', 'endColumn'],
      additionalProperties: false,
    },
    tier: 'edit',
    annotations: { idempotentHint: true },
  },
  {
    name: 'editor.revealLine',
    description:
      'Scroll one open editor pane so a 1-based `line` is visible (edit tier: viewport state the user sees, so it is not exposed to read sessions). `paneId` is required — this surface has no "focused editor". `reveal` selects the alignment: "center", "top" (near top) or "nearest" (default, minimal scrolling); there is no invented "bottom" variant. A line beyond the document is clamped to the last line and the clamp is reported explicitly (requestedLine vs revealedLine). The viewport method failing is reported as an error instead of a silent success. No content change and no disk write: contentChanged:false and saved:false always hold.',
    inputSchema: {
      type: 'object',
      properties: {
        paneId: { type: 'string', minLength: 1, maxLength: 128, description: 'Editor pane id (required).' },
        line: { type: 'integer', minimum: 1, description: '1-based line to reveal (clamped to the last line; the clamp is reported).' },
        reveal: { type: 'string', enum: ['center', 'top', 'nearest'], description: 'Alignment variant (default nearest).' },
      },
      required: ['paneId', 'line'],
      additionalProperties: false,
    },
    tier: 'edit',
    annotations: { idempotentHint: true },
  },

  /* ---- B10 批（LaneV，2026-11-06）：打开文档面收口（Wave4 #4 那条 NOT_WIRED 判性的重判）----
   * 判性证据一条没被推翻：`editor.revealLocation` 至今仍是 fire-and-forget 事件（无 ack / 无落地
   * 确认 / 落地走 React setState 异步重渲染 / 订阅者只在 GUI 挂载时存在）。本批**没给它加 ack，
   * 也没有新造第二条跳转**——变的是观察件：B3 之后 MCP 面能在执行时动态反查 `livePanes` 登记簿，
   * 于是「发射宿主既有事件 → 有界轮询登记簿 → 把落地事实读回来」可以诚实回报。
   * 判据（执行腿 `editor-open-legs.ts`）：只有「某实例的活动文件就是这条 path，且上屏 model 就是它那一份
   * 标签的 model」才回 opened:true；窗内读不到 ⇒ 显式失败，并交代等了多久、看到几个实例、
   * 每个实例正显示什么、为什么判没打开；登记簿读不到（GUI 未挂载 / 无头宿）⇒ 发射之前就 NOT_WIRED，
   * 零副作用。入参只收项目根内相对路径，与 fs.readFile 同一条闸（域外路径永远到不了宿主事件）。
   * 打开文档不写盘、不改模型、不改光标：回包恒 saved:false / persisted:false / contentChanged:false。
   * 「定位」那一面本批**仍不登记**（见本文件 Wave4 #4 块与台账的 B10 条目）：视口与光标已分别由
   * editor.revealLine / editor.setCursor 覆盖且都带读回核对，paneId 由本工具与 document.active 交回；
   * 组合面没有独立诚实数据面 ⇒ 重复登记等于造第二条无核对通道。本注释刻意不写规格字面量。
   */
  {
    name: 'editor.openDocument',
    description:
      'Open ONE document of the open project in the editor GUI and report what actually landed (edit tier: it changes which file is on screen, so a read session cannot move the author off their file). ' +
      'Input: a project-root-relative path only, gated exactly like fs.readFile - an absolute path, a drive letter, a ".." segment or any other escape gets INVALID_ARGS before the host event bus, so the host never receives an out-of-domain target. ' +
      "Execution reuses the host's own navigation channel (the editor.revealLocation event that Go-to-definition / the problem panel / the outline already use) - this tool adds NO second open mechanism, only observation. " +
      "opened:true is answered ONLY after reading the pane registry back: some pane's active file is this path AND the model on screen is that tab's own model (the same check refuses the transient where the path switched but the previous model still shows). The reply carries what was read back - paneId, path, active, lineCount, language, modelUri, readOnly, derivedView (a sugar projection on screen: write tools still refuse there), tabCount - plus the observation account (waitedMs, polls, pollIntervalMs, deadlineMs, intent with channel and subscriber count, alreadyOpen when nothing was emitted). " +
      'If it cannot be verified the call FAILS loudly instead of pretending the open happened: an exhausted window says how long it waited, how many panes it saw and what each displays (TOOL_EXECUTION_FAILED); an unreadable registry (GUI not mounted, headless host, no subscriber for the channel) refuses BEFORE emitting, with NOT_WIRED; no project open gives RESOURCE_UNAVAILABLE. ' +
      'Nothing on disk or in the model changes: contentChanged:false, dirty stays null with the reason, saved:false and persisted:false always hold - persisting stays on the fileTree.update double-gate / exportFile dialog paths. Positioning is deliberately NOT part of this tool: use editor.setCursor / editor.revealLine with the returned paneId (both read their result back).',
    inputSchema: {
      type: 'object',
      properties: {
        relPath: RELATIVE_PATH_SCHEMA,
        deadlineMs: {
          type: 'integer',
          minimum: 100,
          maximum: 10_000,
          description:
            'Bounded window to wait for the open to land (default 3000ms; hard cap 10000ms keeps this call inside the endpoint request budget). Outside that range the value is rejected, not clamped. The poll interval is a fixed 25ms.',
        },
      },
      required: ['relPath'],
      additionalProperties: false,
    },
    tier: 'edit',
    annotations: { readOnlyHint: false, idempotentHint: true },
  },

  /* ---- B4 批（LaneS，2026-11-06）：启动器族具名工具（tier 'privileged'）----
   * 真源 = kernel.launcherHost（一个方法 = 一条 Rust `launcher_*` 命令，执行腿见
   * `packages/app/src/mcp/real-sources-launcher.ts`）。命名一律 `launcher_<族>_<动词>`
   * 下划线形态：Rust `is_launcher_tool()` 与 WebView `PRIVILEGED_TOOL_PREFIXES` 都按
   * `launcher_` **前缀**判 privileged，点号形态（`launcher.instance.list`）不命中判定，
   * 会掉进「未知名字按 read 放行」的后门 —— 这条命名纪律不许改。
   * 档位判定与批准语义零改动：privileged 只认第四张表里的**精确名**（`launcher_*` 通配
   * 不构成批准），与 `fileTree.remove` / `fileTree.rename` 同源。
   * 授权面零放宽：第三张表（实例 × rootId 的逐根写授权，`launcher/approvals.json`，只由
   * 原生目录对话框写入）的复验全在宿主，本批没有任何一腿替模型拿落点决定权；
   * 需要「人选中的输入件绝对路径」的那几条（launcher_content_plan / launcher_save_import /
   * launcher_project_extract）、对话框即授权的那几条（launcher_pick_*）、信任授予
   * （launcher_trust_executable）、OS shell 面向人（launcher_instance_open_folder）、
   * 导出（launcher_log_export / launcher_save_export）、宿主未落地的 launcher_runtime_*
   * 以及 market_* 全族 ⇒ **刻意不登记**，逐条判性见 MCP_DEFERRED_GAP_NOTES（铁律 4：不静默）。
   * 本注释刻意不写规格字面量，避免干扰盘点脚本对规格块的正则解析。
   */
  {
    name: 'launcher_instance_list',
    description:
      'List the launcher instances registered on this machine (read-only). Returns {instances:[...], total, offset, limit, truncated, hasMore, nextCursor, fingerprint}: each row is the host DTO verbatim (id, adapterId, gameId, createdAt, sourceRoot|null, isolation, instanceRoot, gameRoot, executableTrust, state, name, tags, notes). An empty list is the real reading (zero registered instances), never a wiring failure; if no launcher surface exists at all the call fails visibly with NOT_WIRED instead of returning []. Start paging here and reuse the ids you read. Page size is ONE knob (`limit` plus the legacy synonyms this face keeps accepting); anything not declared is rejected instead of silently paging at the default. ' +
      PAGE_ACCOUNT_NOTE + ' ' + LAUNCHER_TIER_NOTE,
    inputSchema: {
      type: 'object',
      properties: { ...PAGE_PROPS, ...pageSizeAliasProps() },
      additionalProperties: false,
    },
    tier: 'privileged',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'launcher_instance_get',
    description:
      'Inspect one launcher instance (read-only): {instance, executable, runtime, paths, diskUsageBytes, warnings} exactly as the host reports it. `executable` carries the resolved relative path plus the recorded sha256 and whether the trust record exists (approvedAt comes from the native confirmation dialog only - trust can never be granted through MCP). A missing instance id fails with the host structured error (code + retryable + detail in the message), never with a null object. ' +
      LAUNCHER_TIER_NOTE,
    inputSchema: { type: 'object', properties: { instanceId: LAUNCHER_INSTANCE_ID_SCHEMA }, required: ['instanceId'], additionalProperties: false },
    tier: 'privileged',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'launcher_content_list',
    description:
      'List the content packs the host has installed into one instance (read-only), reading its own state.json / ownership.json on disk. Returns {contents:[{manifest, installedAt, ownedFiles, enabled, status}], + the page account}; unknown manifest fields are preserved by the host and passed through untouched. `contents[].manifest.id` is the packId other launcher_* tools need. Empty list = nothing installed; an absent P1 surface fails visibly with NOT_WIRED. ' +
      PAGE_ACCOUNT_NOTE + ' ' + LAUNCHER_TIER_NOTE,
    inputSchema: {
      type: 'object',
      properties: { instanceId: LAUNCHER_INSTANCE_ID_SCHEMA, ...PAGE_PROPS, ...pageSizeAliasProps() },
      required: ['instanceId'],
      additionalProperties: false,
    },
    tier: 'privileged',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'launcher_content_diagnose',
    description:
      "Diagnose an instance's installed content against what is actually on disk (read-only). Returns {instanceId, issues:[{packId, code, path?, message}], + the page account}. Honesty note on the code table: the host reports two codes the domain contract does not have - 'orphan-file' and 'load-order' - and this surface passes them through instead of folding them into 'conflict', because an orphaned file is otherwise invisible. Zero issues is a real reading; the diagnosis never repairs anything. " +
      PAGE_ACCOUNT_NOTE + ' ' + LAUNCHER_TIER_NOTE,
    inputSchema: {
      type: 'object',
      properties: { instanceId: LAUNCHER_INSTANCE_ID_SCHEMA, ...PAGE_PROPS, ...pageSizeAliasProps() },
      required: ['instanceId'],
      additionalProperties: false,
    },
    tier: 'privileged',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'launcher_process_list',
    description:
      'List the game processes currently supervised by the launcher host (read-only): {processes:[{instanceId, state, pid, sessionId, startedAt, elapsedMs, exitCode, exitReason, lastError}], + the page account}. This is the host process table, not the OS process list - a game started outside the launcher is not in it. Empty array = no supervised process, which is a reading, not an error. ' +
      PAGE_ACCOUNT_NOTE + ' ' + LAUNCHER_TIER_NOTE,
    inputSchema: {
      type: 'object',
      properties: { ...PAGE_PROPS, ...pageSizeAliasProps() },
      additionalProperties: false,
    },
    tier: 'privileged',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'launcher_process_status',
    description:
      'Read the process state of one instance (read-only): {instanceId, state, pid, sessionId, startedAt, elapsedMs, exitCode, exitReason, lastError} straight from the host supervisor. `state` is one of idle|starting|running|stopping|exited|crashed; null pid / sessionId means "not running", never "unknown". Poll this after launcher_start and launcher_stop instead of assuming a transition happened. ' +
      LAUNCHER_TIER_NOTE,
    inputSchema: { type: 'object', properties: { instanceId: LAUNCHER_INSTANCE_ID_SCHEMA }, required: ['instanceId'], additionalProperties: false },
    tier: 'privileged',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'launcher_task_list',
    description:
      "List the launcher task centre's rows (read-only): {tasks:[{id, kind, instanceId, state, progress, createdAt, startedAt, endedAt, error, result, cancellable}], + the page account} plus a faceNote. This table is deliberately its OWN surface: launcher tasks belong to the third table (per-root approvals) and are NOT merged into kojo://tasks, so a launcher job never shows up in the long-task face and vice versa. Rows are how you verify a lifecycle call: take the taskRowId from that reply and read it here. " +
      PAGE_ACCOUNT_NOTE + ' ' + LAUNCHER_TIER_NOTE,
    inputSchema: {
      type: 'object',
      properties: { ...PAGE_PROPS, ...pageSizeAliasProps() },
      additionalProperties: false,
    },
    tier: 'privileged',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'launcher_save_list',
    description:
      'List the save files the host can see under an instance (read-only). The host answer is NOT a bare entry array: it is {entries:[{rootId, path, name, bytes, mtimeMs}], roots:[{rootId, approved, exists?}], warnings:[...]} plus the page account over `entries`. `roots[].approved` is the write-back gate for shared/overlay instances (it comes from launcher/approvals.json, written only by the native directory dialog), and `roots[].exists` is the disk reading - read both before proposing launcher_save_restore or launcher_save_apply_import. ' +
      PAGE_ACCOUNT_NOTE + ' ' + LAUNCHER_TIER_NOTE,
    inputSchema: {
      type: 'object',
      properties: { instanceId: LAUNCHER_INSTANCE_ID_SCHEMA, ...PAGE_PROPS, ...pageSizeAliasProps() },
      required: ['instanceId'],
      additionalProperties: false,
    },
    tier: 'privileged',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'launcher_save_backups',
    description:
      'List the backups stored in the instance backup directory (read-only): {backups:[{id, instanceId, createdAt, label, bytes, entryCount, reason}], + the page account}. `reason` is manual|pre-restore|pre-plugin|auto and explains who made the row. backupId is what launcher_save_restore / launcher_save_delete_backup require - never invent one. ' +
      PAGE_ACCOUNT_NOTE + ' ' + LAUNCHER_TIER_NOTE,
    inputSchema: {
      type: 'object',
      properties: { instanceId: LAUNCHER_INSTANCE_ID_SCHEMA, ...PAGE_PROPS, ...pageSizeAliasProps() },
      required: ['instanceId'],
      additionalProperties: false,
    },
    tier: 'privileged',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'launcher_log_sessions',
    description:
      'List recorded log sessions of one instance (read-only): {sessions:[{id, instanceId, startedAt, stdoutBytes, stderrBytes}], + the page account}. The session id is the handle launcher_log_read needs; byte counters are the host reading of the raw stream files, not decoded line counts. ' +
      PAGE_ACCOUNT_NOTE + ' ' + LAUNCHER_TIER_NOTE,
    inputSchema: {
      type: 'object',
      properties: { instanceId: LAUNCHER_INSTANCE_ID_SCHEMA, ...PAGE_PROPS, ...pageSizeAliasProps() },
      required: ['instanceId'],
      additionalProperties: false,
    },
    tier: 'privileged',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'launcher_log_tail',
    description:
      'Read the tail of the newest log session of one instance (read-only), exactly as the host returns it: {session, truncatedByBytes, chunks:[{stream, ts, byteLength, truncated, bytesBase64}], + the page account over chunks}. Two honesty points, both load-bearing: (1) the payload is RAW BYTES in base64 - the host does not decode and neither does this face, because the charset decision belongs to the launcher core log service; concatenate bytesBase64 across pages in nextCursor order and decode afterwards. (2) The host default is 1 MiB per stream; this face TIGHTENS the read to at most 40960 bytes per stream so a page stays under the host untrusted-string gate. `truncatedByBytes` is the host byte reading, the account `truncated`/`hasMore` is the chunk-page reading - they are deliberately two different fields. Byte size per stream is `maxBytes` (never more than the gate); the page-size names (`limit` and its legacy synonyms) size the CHUNK list, not the byte budget - `maxLines` therefore pages chunks and does not truncate by lines, because the host truncates by bytes only. ' +
      PAGE_ACCOUNT_NOTE + ' ' + LAUNCHER_TIER_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        instanceId: LAUNCHER_INSTANCE_ID_SCHEMA,
        stream: { type: 'string', enum: ['stdout', 'stderr', 'all'], description: 'Which stream to read (default all, i.e. both chunks).' },
        maxBytes: { type: 'integer', minimum: 1, maximum: 40960, description: 'Per-stream byte cap handed to the host (default and hard ceiling 40960 - tighter than the host 1 MiB on purpose). This is the BYTE budget, a different knob from the page size.' },
        ...PAGE_PROPS,
        ...pageSizeAliasProps(),
      },
      required: ['instanceId'],
      additionalProperties: false,
    },
    tier: 'privileged',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'launcher_log_read',
    description:
      'Read one recorded log session by id (read-only) - same answer shape as launcher_log_tail ({session, chunks:[{stream, ts, byteLength, truncated, bytesBase64}], + the page account}), the difference being the addressing: `sessionId` must come from launcher_log_sessions (the host also verifies session ownership). Bytes stay raw base64 here: charset decoding is the launcher core log service job, so splice pages first, then decode. Per-stream cap is tightened to 40960 bytes, never widened; `maxBytes` is that byte budget while `limit` and its legacy synonyms page the CHUNK list. ' +
      PAGE_ACCOUNT_NOTE + ' ' + LAUNCHER_TIER_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: LAUNCHER_COMPONENT_ID_SCHEMA,
        stream: { type: 'string', enum: ['stdout', 'stderr', 'all'], description: 'Which stream to read (default all).' },
        maxBytes: { type: 'integer', minimum: 1, maximum: 40960, description: 'Per-stream byte cap (default and ceiling 40960). The BYTE budget, a different knob from the page size.' },
        ...PAGE_PROPS,
        ...pageSizeAliasProps(),
      },
      required: ['sessionId'],
      additionalProperties: false,
    },
    tier: 'privileged',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'launcher_project_hash',
    description:
      'Stream-hash one plugin source project (read-only): pass {projectDir, artifactDir, entries:[posix-relative paths]} and get {digests:[{path, sha256, size}], requestedEntries, + the page account} back, `path` echoed exactly as requested so pages can be paired. This is the ONLY launcher face that takes an absolute path, and it is an INPUT root, never a write target: the host re-checks that projectDir lies inside the registered writable roots (app data / user-approved workspace roots) and that resolved entries cannot escape artifactDir. This tool does not build, does not pack and does not install anything. ' +
      PAGE_ACCOUNT_NOTE + ' ' + LAUNCHER_TIER_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        projectDir: { type: 'string', minLength: 1, maxLength: 512, description: 'Absolute project root (host-verified against the writable-root registry; read-only input).' },
        artifactDir: { type: 'string', minLength: 1, maxLength: 64, description: 'Single artifact directory name inside the project (entries resolve under it).' },
        entries: {
          type: 'array',
          minItems: 1,
          maxItems: 2000,
          items: { type: 'string', minLength: 1, maxLength: 512, description: 'Path relative to artifactDir, POSIX separators.' },
          description: 'The file list to hash, in the order the manifest declares (order is the pairing key). Hard cap 2000 entries, never a silently dropped tail.',
        },
        ...PAGE_PROPS,
        ...pageSizeAliasProps(),
      },
      required: ['projectDir', 'artifactDir', 'entries'],
      additionalProperties: false,
    },
    tier: 'privileged',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'launcher_instance_update',
    description:
      'Update the descriptive fields of one instance (mutating, privileged): give instanceId plus at least one of `name` / `notes` / `tags` and the host applies its own field whitelist, returning the updated instance row. This face DELIBERATELY does not accept executableRelativePath, launch arguments or environment variables - what gets run stays a human decision (trust is granted only in the native confirmation dialog). The host re-checks everything; a rejected field arrives as its structured error code. ' +
      LAUNCHER_TIER_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        instanceId: LAUNCHER_INSTANCE_ID_SCHEMA,
        name: { type: 'string', minLength: 1, maxLength: 120, description: 'New display name.' },
        notes: { type: 'string', maxLength: 2000, description: 'Free-text notes field.' },
        tags: { type: 'array', maxItems: 32, items: { type: 'string', maxLength: 64 }, description: 'Tag list (replaces the existing tags).' },
      },
      required: ['instanceId'],
      additionalProperties: false,
    },
    tier: 'privileged',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'launcher_instance_duplicate',
    description:
      'Duplicate one instance into a new instance (mutating, privileged): {instanceId, name?} returns {instance, task} - the copy runs as a task row when isolation requires file copying, so read task.id and follow it with launcher_task_list / launcher_task_cancel. Nothing is deleted; the source instance keeps working. ' +
      LAUNCHER_TIER_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        instanceId: LAUNCHER_INSTANCE_ID_SCHEMA,
        name: { type: 'string', minLength: 1, maxLength: 120, description: 'Optional name for the copy (host default naming when omitted).' },
      },
      required: ['instanceId'],
      additionalProperties: false,
    },
    tier: 'privileged',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: 'launcher_instance_remove',
    description:
      'Remove an instance registration (DESTRUCTIVE, privileged): the host stops the process first, then drops the record and optionally the instance directory. `deleteFiles` must be given explicitly - true deletes the instance root, false only unregisters - and there is no default, because guessing here destroys data. `keepBackups` (explicit true) keeps the backup directory even when files go. Returns the void/terminal answer honestly; the deletion is irreversible from the model side, so only call it after the user itemized the target. ' +
      LAUNCHER_TIER_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        instanceId: LAUNCHER_INSTANCE_ID_SCHEMA,
        deleteFiles: { type: 'boolean', description: 'Required explicit decision: true = delete the instance directory too.' },
        keepBackups: { type: 'boolean', description: 'Optional; keep backup files when deleteFiles is true (host default false).' },
      },
      required: ['instanceId', 'deleteFiles'],
      additionalProperties: false,
    },
    tier: 'privileged',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  },
  {
    name: 'launcher_content_apply',
    description:
      'Second half of the content-pack install (mutating, privileged): consume a one-shot `planId` produced by the UI-side import wizard and optionally carry per-file conflict `resolutions`, then return the task row {taskRowId, taskState, taskCancellable, task} plus the query/cancel faces. Writing only ever lands in roots the user approved per instance and rootId (third table, approvals.json) - the host re-verifies each target and refuses unapproved roots; a stale or consumed planId fails with the host structured error instead of silently re-planning. This face takes NO archive path: launcher_content_plan is deliberately not registered (its archivePath is a native-dialog-produced input file). ' +
      LAUNCHER_TIER_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        planId: LAUNCHER_COMPONENT_ID_SCHEMA,
        resolutions: { type: 'array', maxItems: 200, items: LAUNCHER_RESOLUTION_SCHEMA, description: 'Per-collision decisions; omit to let the host abort on any unresolved conflict.' },
      },
      required: ['planId'],
      additionalProperties: false,
    },
    tier: 'privileged',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  },
  {
    name: 'launcher_content_set_enabled',
    description:
      'Enable or disable one installed content pack (mutating, privileged; writes the manifest state and returns the task row). `enabled` must be an explicit boolean. Restart semantics are a separate decision: the host does not kill a running game for you, so check launcher_process_status first and stop it when the pack requires a restart. ' +
      LAUNCHER_TIER_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        instanceId: LAUNCHER_INSTANCE_ID_SCHEMA,
        packId: LAUNCHER_COMPONENT_ID_SCHEMA,
        enabled: { type: 'boolean', description: 'Required explicit target state.' },
      },
      required: ['instanceId', 'packId', 'enabled'],
      additionalProperties: false,
    },
    tier: 'privileged',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'launcher_content_set_order',
    description:
      'Set the load order of installed content packs (mutating, privileged): `packIds` must be a permutation of the ids the instance already has (read them from launcher_content_list) - duplicates are refused here, ids the host does not know are refused by it. Returns a void execution answer, honestly labelled; nothing is added or removed, only the order changes. ' +
      LAUNCHER_TIER_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        instanceId: LAUNCHER_INSTANCE_ID_SCHEMA,
        packIds: { type: 'array', minItems: 1, maxItems: 200, items: LAUNCHER_COMPONENT_ID_SCHEMA, description: 'Complete permutation of installed pack ids, in desired load order.' },
      },
      required: ['instanceId', 'packIds'],
      additionalProperties: false,
    },
    tier: 'privileged',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'launcher_content_uninstall',
    description:
      'Uninstall one content pack (DESTRUCTIVE, privileged). The tool takes only instanceId + packId: the exclusive-file list handed to the host is COMPUTED here from the host own ownership readings (this pack ownedFiles minus every other pack ownedFiles), never from a list the model writes, and the host still re-checks ownership.json - shared files belonging to another pack are left in place. Returns the task row (taskRowId / taskState / taskCancellable) plus ownedFileCount / exclusiveFileCount / sharedFileCount so the blast radius is stated. ' +
      LAUNCHER_TIER_NOTE,
    inputSchema: {
      type: 'object',
      properties: { instanceId: LAUNCHER_INSTANCE_ID_SCHEMA, packId: LAUNCHER_COMPONENT_ID_SCHEMA },
      required: ['instanceId', 'packId'],
      additionalProperties: false,
    },
    tier: 'privileged',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  },
  {
    name: 'launcher_start',
    description:
      'Start the game of one instance (mutating, privileged, launches a real OS process). The whole validation chain runs inside the host - instance ready, executable legitimate, recorded executable trust, runtime resolved, per-instance lock - and none of it can be skipped from MCP: executable trust can only be granted by a human in the native confirmation dialog, so an untrusted executable arrives as that host error code. Returns the process status reading; poll launcher_process_status for the truth. ' +
      LAUNCHER_TIER_NOTE,
    inputSchema: { type: 'object', properties: { instanceId: LAUNCHER_INSTANCE_ID_SCHEMA }, required: ['instanceId'], additionalProperties: false },
    tier: 'privileged',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: 'launcher_stop',
    description:
      'Stop the running game of one instance (mutating, privileged). Default is a graceful stop with the host timeout; `force:true` terminates the process tree and can lose unsaved in-game state, so it must be an explicit decision, and `timeoutMs` is capped at 120000. Returns the post-stop process status (state, exitCode, exitReason) - read that as the fact, do not assume the process is gone. ' +
      LAUNCHER_TIER_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        instanceId: LAUNCHER_INSTANCE_ID_SCHEMA,
        force: { type: 'boolean', description: 'Optional; true = hard kill (risk of losing unsaved game state).' },
        timeoutMs: { type: 'integer', minimum: 0, maximum: 120000, description: 'Optional graceful-stop budget (0..120000).' },
      },
      required: ['instanceId'],
      additionalProperties: false,
    },
    tier: 'privileged',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  },
  {
    name: 'launcher_task_cancel',
    description:
      'Request cancellation of one launcher task (mutating, privileged) - the cancel half of the launcher task face, which stays separate from kojo://tasks by design. Cancellation is a request, not an acknowledgement: only cancellable kinds are accepted, rollback is performed by the task itself, and the fact is read back from launcher_task_list. An unknown / already-finished row arrives as the host answer, never as a silent success. `taskId` must come from a task row this host produced. ' +
      LAUNCHER_TIER_NOTE,
    inputSchema: { type: 'object', properties: { taskId: LAUNCHER_COMPONENT_ID_SCHEMA }, required: ['taskId'], additionalProperties: false },
    tier: 'privileged',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'launcher_save_backup',
    description:
      'Back up save files of one instance (mutating, privileged): the host only ever writes into the instance backup directory - there is no target path argument on this face at all. Optional `label`, `reason` (manual | pre-restore | pre-plugin; the host-internal auto slot is not offered) and an `entries` subset of {rootId, path} pairs as reported by launcher_save_list (omitted = all save roots). Returns the terminal task row plus backupId read from task.result.backupId, so the restore handle is never guessed. ' +
      LAUNCHER_TIER_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        instanceId: LAUNCHER_INSTANCE_ID_SCHEMA,
        label: { type: 'string', minLength: 1, maxLength: 120, description: 'Human-readable label for the backup row.' },
        reason: { type: 'string', enum: ['manual', 'pre-restore', 'pre-plugin'], description: 'Backup reason bucket (default manual).' },
        entries: {
          type: 'array',
          maxItems: 200,
          items: {
            type: 'object',
            properties: {
              rootId: LAUNCHER_COMPONENT_ID_SCHEMA,
              path: { type: 'string', minLength: 1, maxLength: 512, description: 'Save-root-relative path exactly as launcher_save_list reported it.' },
            },
            required: ['rootId', 'path'],
            additionalProperties: false,
          },
          description: 'Optional subset; omit to back up every save root.',
        },
      },
      required: ['instanceId'],
      additionalProperties: false,
    },
    tier: 'privileged',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: 'launcher_save_restore',
    description:
      'Restore save files from one backup (DESTRUCTIVE, mutating, privileged). The host ALWAYS takes a fresh automatic backup of the current state first (backupCurrent defaults to true; explicit false disables it and is reported back in the answer), then unpacks, verifies and swaps files through temp + rename. Write-back still obeys the third table: a save root without a per-root approval is refused by the host, and a running game is a refusal, not an overwrite. Returns the terminal task row. ' +
      LAUNCHER_TIER_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        instanceId: LAUNCHER_INSTANCE_ID_SCHEMA,
        backupId: LAUNCHER_COMPONENT_ID_SCHEMA,
        backupCurrent: { type: 'boolean', description: 'Optional; default true = the host backs up the current saves before restoring.' },
      },
      required: ['instanceId', 'backupId'],
      additionalProperties: false,
    },
    tier: 'privileged',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  },
  {
    name: 'launcher_save_delete_backup',
    description:
      'Delete one backup row from the instance backup directory (DESTRUCTIVE, mutating, privileged). Only that directory and only that backupId are touched - the host re-checks that the id resolves inside the backup root, and there is no target path argument. Irreversible: read launcher_save_backups first, confirm the exact id with the user, and remember this is the only copy for backups that were not also exported. ' +
      LAUNCHER_TIER_NOTE,
    inputSchema: {
      type: 'object',
      properties: { instanceId: LAUNCHER_INSTANCE_ID_SCHEMA, backupId: LAUNCHER_COMPONENT_ID_SCHEMA },
      required: ['instanceId', 'backupId'],
      additionalProperties: false,
    },
    tier: 'privileged',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  },
  {
    name: 'launcher_save_apply_import',
    description:
      'Second half of the save-import flow (DESTRUCTIVE, mutating, privileged): consume the one-shot `planId` produced by the UI-side import wizard (plus optional per-entry conflict `resolutions`) and return the terminal task row. The archive itself is never chosen here - launcher_save_import takes a native-dialog absolute path and is deliberately NOT registered as a model tool, so an unknown / expired planId arrives as the host structured error rather than being re-planned behind your back. Write-back is still gated per root by the third table. ' +
      LAUNCHER_TIER_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        planId: LAUNCHER_COMPONENT_ID_SCHEMA,
        resolutions: { type: 'array', maxItems: 200, items: LAUNCHER_RESOLUTION_SCHEMA, description: 'Per-collision decisions; omit to let the host abort on unresolved conflicts.' },
      },
      required: ['planId'],
      additionalProperties: false,
    },
    tier: 'privileged',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  },

  /* ---- MCP-PERF-S4（LaneK，2026-11-07）：范围读（行区间）----
   * TRAE 性能分析 P1：「范围读/结构读：read_range（行区间）＋outline（函数列表）必须先有，
   * 否则 agent 只能整文件读 5 万行」。本面＝fs.readFile 的行号投影：1 基行号与 Monaco
   * position 同口径；行号→内容走 fs.readFile 同一条读取通道；路径闸同一条 resolveWithinRoot
   * （根内相对路径），可选 rootId 与写腿同一条 resolveWriteRoot 三道拦截（缺席 ⇒ 项目根
   * 零额外 IPC；给了 ⇒ 形状 + 第四张表精确列名 + workspace_roots 反查，默认拒绝一字不变）。
   * 越界与 start>end 的账照 paginateText 既有语义：越界夹取 + truncated 可见、start>end
   * INVALID_ARGS 点名——不发明新账。零写、零新授权面。
   */
  {
    name: 'fs.readRange',
    description:
      'Read a LINE RANGE of one file inside the authorized project root (read-only) - the line-addressed projection of fs.readFile for large files: read a 50,000-line file window by window instead of whole. ' +
      '`relPath` MUST be a project-root-relative path (same gate as fs.readFile: the schema rejects absolute paths, drive letters and ".." traversal, and the execution layer re-checks the resolution); optional `rootId` selects one explicitly approved persistent workspace root instead of the project root (enumerate via io.workspaceRoots; human approval required; omit to stay on the project root). ' +
      '`startLine` / `endLine` are 1-BASED and INCLUSIVE, matching Monaco positions (line 1 is the first line). Lines split on CRLF/LF/CR, so a trailing newline yields a final empty line exactly like the editor. The reply lists {line, text} pairs plus the account: `totalLines` is the FULL line count of the file, `lineCount` the returned rows, `hasMore` whether lines remain after `endLine` (continue with startLine = returned endLine + 1 - no cursor needed), and `requested` echoes the raw bounds so clamping is visible. ' +
      'Out-of-range bounds are clamped into [1, totalLines] and the clamp is VISIBLE via truncated + requested (window semantics, never silent); `startLine > endLine` is rejected with INVALID_ARGS naming both fields. One call returns at most 2000 lines (hard batch cap; a larger window is cut at the cap with truncated:true, not an error). ' +
      'Never writes to disk. For character-precise windows or cursors use fs.readFile.',
    inputSchema: {
      type: 'object',
      properties: {
        relPath: RELATIVE_PATH_SCHEMA,
        rootId: ROOT_ID_SCHEMA,
        startLine: { type: 'integer', minimum: 1, description: '1-based first line of the window (Monaco position line; 0-based values are rejected).' },
        endLine: { type: 'integer', minimum: 1, description: '1-based LAST line of the window, inclusive. Clamped down to the file end; a window larger than the batch cap is cut at the cap.' },
      },
      required: ['relPath', 'startLine', 'endLine'],
      additionalProperties: false,
    },
    tier: 'read',
    annotations: { readOnlyHint: true },
  },

  /* ---- MCP-PERF-S4（LaneK，2026-11-07）：结构读（全项目函数清单）----
   * 走 erb-parser 既有 byName 索引（99,975 函数单扫 3.88ms 的那份），paginateByCursor 分页，
   * 无编辑器依赖。侦察结论（本批现取）：semantic.documentSymbols 的腿依赖 requireWorkspace
   * （打开的编辑器 + documentSymbolProvider 注册表）⇒ 抬不成 project 范围，本面直连
   * kernel.services.tryGet('erb.parser') 的 currentIndex()/ensureIndex()（与宿主
   * editor-global-providers 的软取同一条键，零插件 import）。它没有对应的 rust/debug
   * 缺口名 ⇒ 按 editor.openDocument 先例不进 MCP_TOOL_GAP_MAP（硬造会被盘点判
   * orphanedWires 假绿），判性记在这里。零写：索引由宿主建、本面只读。
   */
  {
    name: 'semantic.projectSymbols',
    description:
      'List EVERY function definition in the open project from the ERB index (read-only, no editor needed) - the project-wide counterpart of semantic.documentSymbols, which needs an open editor and only answers for the active document. ' +
      'Each item is {name, path (project-root-relative), startLine, endLine} plus `nameColumn` when the index has it; read the body with fs.readRange on that path. ' +
      'Optional `query` filters by order-independent substring tokens (empty/absent = every definition, verbatim legacy); the paging account then applies to the FILTERED set, so pages from different queries never splice. ' +
      'Paged with `limit` + `cursor` (page size ONE knob, see the inputSchema `limit` description); the completeness account {total, offset, limit, truncated, hasMore, nextCursor, fingerprint} rides on every page, pass nextCursor back verbatim, and a snapshot change mid-paging restarts at page 0 as changedDuringPaging instead of splicing. Zero-arg call = first page. ' +
      '`index` repeats the provider\'s own state facts {phase, coverage, filesScanned, functions} so a degraded or still-scanning index is visible instead of silent - do not treat a `partial` coverage list as the whole project. ' +
      'The surface never mutates anything: the index is built once by the host and only read here.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', maxLength: 512, description: 'Optional order-independent substring filter over definition names: whitespace splits tokens, EVERY token must appear in the (upper-cased, case-insensitive) name, token order is free ("face draw" matches DRAW_FACE). Filters the byName index in place - no rescan; empty/absent = all (verbatim legacy).' },
        ...PAGE_PROPS,
        ...pageSizeAliasProps(),
      },
      additionalProperties: false,
    },
    tier: 'read',
    annotations: { readOnlyHint: true },
  },
];

/**
 * 工具 → 真源缺口登记（供 `tools/mcp-inventory.mjs` 静态解析做覆盖对拍；不参与运行时）。
 * 每项一行纯字面量：`tool` 是工具名，`gap` 是盘点缺口清单里的名字，`source` 指明缺口所在真源。
 * `source:'tool-surface'` 的工具是为「与 headless 只读面同形」登记的能力，不对应具体缺口。
 * 盘点脚本会交叉校验：tool 必须在 *_TOOL_SPECS 清单里、gap 必须在真实缺口里——
 * 对不上就如实降级为「未覆盖」，绝不假绿（铁律 4：不静默、不伪造读数）。
 */
export const MCP_TOOL_GAP_MAP: readonly {
  readonly tool: string;
  readonly gap: string;
  readonly source: 'rust' | 'debug' | 'tool-surface';
}[] = [
  { tool: 'semantic.definitionAt', gap: 'definitionAt', source: 'debug' },
  { tool: 'semantic.referencesAt', gap: 'referencesAt', source: 'debug' },
  { tool: 'semantic.diagnostics', gap: 'diagnostics', source: 'debug' },
  { tool: 'semantic.hoverAt', gap: 'hoverAt', source: 'debug' },
  { tool: 'semantic.suggestAt', gap: 'suggestAt', source: 'debug' },
  { tool: 'semantic.documentSymbols', gap: 'documentSymbols', source: 'debug' },
  { tool: 'semantic.tokens', gap: 'tokens', source: 'debug' },
  { tool: 'semantic.codeActionsAt', gap: 'codeActionsAt', source: 'debug' },
  { tool: 'fs.tree', gap: 'walk_dir', source: 'rust' },
  { tool: 'search.all', gap: 'search_text', source: 'rust' },
  { tool: 'workspace.searchAll', gap: 'search_text', source: 'rust' },
  { tool: 'problems.diagnostics', gap: 'diagnostics', source: 'debug' },
  // 写腿批（2026-11-06）：fileTree.create / fileTree.update 执行体已接线（app real-sources-io.ts
  // 走内核 io 写原语 createFileExclusive/writeText，双闸＝第四张表 approvedRoots + 内核写允许域；
  // 内核写域拒绝 ⇒ WRITE_DISABLED）。本两行保留为**覆盖声明**（create_file_exclusive /
  // write_file_bytes 经具名工具覆盖，不再是「需宿主接线」的剩余缺口），数据结构形状不变。
  { tool: 'fileTree.create', gap: 'create_file_exclusive', source: 'rust' },
  { tool: 'fileTree.update', gap: 'write_file_bytes', source: 'rust' },
  // fileTree.remove / fileTree.rename 执行体同样已接线（privileged：第四张表 approvedRoots
  // × 内核写允许域双闸，逐闸拒绝显式报错）——写腿读数 wired 5 / NOT_WIRED 0。
  { tool: 'fileTree.remove', gap: 'remove_file', source: 'rust' },
  { tool: 'fileTree.rename', gap: 'rename_path', source: 'rust' },
  { tool: 'commands.list', gap: 'commands', source: 'tool-surface' },
  { tool: 'document.active', gap: 'active-document', source: 'tool-surface' },
  { tool: 'fs.readFile', gap: 'read_file_bytes', source: 'rust' },
  { tool: 'fs.stat', gap: 'stat_file', source: 'rust' },
  { tool: 'io.listDir', gap: 'list_dir', source: 'rust' },
  { tool: 'io.workspaceRoots', gap: 'workspace_roots', source: 'rust' },
  { tool: 'editor.info', gap: 'info', source: 'debug' },
  { tool: 'editor.selfCheck', gap: 'selfCheck', source: 'debug' },
  { tool: 'lang.foldingRanges', gap: 'foldingRanges', source: 'debug' },
  { tool: 'lang.highlightsAt', gap: 'highlightsAt', source: 'debug' },
  { tool: 'lang.signatureAt', gap: 'signatureAt', source: 'debug' },
  { tool: 'lang.markers', gap: 'markers', source: 'debug' },
  // 第四波（LaneF，2026-11-06）：11 条 cheap-read 逐条判性后登记 6 枚只读具名工具。
  // debug 类 gap 名不带 debug. 前缀（盘点脚本 gapSets.debug 口径）；另 5 条刻意不登记，见回执。
  { tool: 'app.dataDir', gap: 'app_data_dir', source: 'rust' },
  { tool: 'codec.encodeString', gap: 'encode_string', source: 'rust' },
  { tool: 'fs.pathExists', gap: 'path_exists', source: 'rust' },
  { tool: 'fs.statFiles', gap: 'stat_files', source: 'rust' },
  { tool: 'lang.lensesAt', gap: 'lensesAt', source: 'debug' },
  { tool: 'lang.selectionRangesAt', gap: 'selectionRangesAt', source: 'debug' },
  // Wave4 余项⑤（LaneL）：长任务面的两条 Rust 真源。tasks.start 的检索 kind 就是同一条
  // search_text（进度帧 / 取消都按同一 searchId 认领，缺口早由 search.all 覆盖 ⇒ 不改 wired 计数）；
  // tasks.cancel 的取消真源是 cancel_search —— 它此前作为「写/授权/UI 之外的生命周期原语」留在
  // 剩余缺口里，本批起它由具名工具覆盖（诚实降级 deferred 计数，不是凭空宣布覆盖）。
  { tool: 'tasks.start', gap: 'search_text', source: 'rust' },
  { tool: 'tasks.cancel', gap: 'cancel_search', source: 'rust' },
  // B3 批（LaneO，2026-11-06）：编辑器写 / 光标副作用五枚登记为具名 edit 工具，真源同调试面
  // （install-debug.ts 的 applySetValue / applyTypedEdit / normalizeCursorTarget / editorReadOnly），
  // 执行腿见 app `mcp/editor-write-legs.ts`（ioTools 腿表）。`debug:format` 刻意留在缺口里
  // （异步 provider 通道 + 长度读数，本期不登记，不挂半截实现）。
  { tool: 'editor.setValue', gap: 'setValue', source: 'debug' },
  { tool: 'editor.type', gap: 'type', source: 'debug' },
  { tool: 'editor.setCursor', gap: 'setCursor', source: 'debug' },
  { tool: 'editor.setSelection', gap: 'setSelection', source: 'debug' },
  { tool: 'editor.revealLine', gap: 'revealLine', source: 'debug' },
  // B10 批（LaneV，2026-11-06）：`editor.openDocument` 已登记为具名 edit 工具（腿表命中 ⇒ 盘点按
  // writeLegs 记 wired），但它**不进本表**：四处真源里没有一条缺口名对应「打开 GUI 文档」
  // （Rust 命令族没有 open 原语、debug 面没有开文件读数、宿主那条是总线事件而非命令）。
  // 硬造一条 tool→gap 只会被交叉校验判 orphanedWires（假绿），故这里如实留空，判性写在
  // MCP_DEFERRED_GAP_NOTES 的 B10 条目。
  // B2 批（LaneT，2026-11-06）：结构化批读面 fs.readMany 接 kernel.io.readTexts（其实现在
  // Tauri 侧就是那条 read_files_raw 批量二进制帧，但工具输出是 TextFile 投影 + 逐条
  // resolveWithinRoot 的项目根内相对路径 + ≤64 条硬上限），故「无结构化数据面 / 暴露任意目标
  // 路径参数」两条理由对本条不再成立 ⇒ read_files_raw 由 deferred 转为 wired（诚实降级 deferred
  // 计数，不是凭空宣布覆盖）；同源的单文件二进制帧 read_file_bytes_raw 仍留在 deferred。
  { tool: 'fs.readMany', gap: 'read_files_raw', source: 'rust' },
  // B4 批（LaneS，2026-11-06）：启动器族 27 枚具名 privileged 工具逐条覆盖同名 Rust 命令缺口
  // （一工具 = 一条 `launcher_*` 命令，真源腿表在 app `real-sources-launcher.ts`，经 ioTools 登记）。
  // 其余 launcher_* / market_* 命令刻意不登记，逐条判性见 MCP_DEFERRED_GAP_NOTES 的 B4 条目。
  { tool: 'launcher_instance_list', gap: 'launcher_instance_list', source: 'rust' },
  { tool: 'launcher_instance_get', gap: 'launcher_instance_get', source: 'rust' },
  { tool: 'launcher_instance_update', gap: 'launcher_instance_update', source: 'rust' },
  { tool: 'launcher_instance_remove', gap: 'launcher_instance_remove', source: 'rust' },
  { tool: 'launcher_instance_duplicate', gap: 'launcher_instance_duplicate', source: 'rust' },
  { tool: 'launcher_content_list', gap: 'launcher_content_list', source: 'rust' },
  { tool: 'launcher_content_diagnose', gap: 'launcher_content_diagnose', source: 'rust' },
  { tool: 'launcher_content_apply', gap: 'launcher_content_apply', source: 'rust' },
  { tool: 'launcher_content_uninstall', gap: 'launcher_content_uninstall', source: 'rust' },
  { tool: 'launcher_content_set_enabled', gap: 'launcher_content_set_enabled', source: 'rust' },
  { tool: 'launcher_content_set_order', gap: 'launcher_content_set_order', source: 'rust' },
  { tool: 'launcher_process_list', gap: 'launcher_process_list', source: 'rust' },
  { tool: 'launcher_process_status', gap: 'launcher_process_status', source: 'rust' },
  { tool: 'launcher_task_list', gap: 'launcher_task_list', source: 'rust' },
  { tool: 'launcher_task_cancel', gap: 'launcher_task_cancel', source: 'rust' },
  { tool: 'launcher_save_list', gap: 'launcher_save_list', source: 'rust' },
  { tool: 'launcher_save_backups', gap: 'launcher_save_backups', source: 'rust' },
  { tool: 'launcher_save_backup', gap: 'launcher_save_backup', source: 'rust' },
  { tool: 'launcher_save_restore', gap: 'launcher_save_restore', source: 'rust' },
  { tool: 'launcher_save_delete_backup', gap: 'launcher_save_delete_backup', source: 'rust' },
  { tool: 'launcher_save_apply_import', gap: 'launcher_save_apply_import', source: 'rust' },
  { tool: 'launcher_log_sessions', gap: 'launcher_log_sessions', source: 'rust' },
  { tool: 'launcher_log_tail', gap: 'launcher_log_tail', source: 'rust' },
  { tool: 'launcher_log_read', gap: 'launcher_log_read', source: 'rust' },
  { tool: 'launcher_project_hash', gap: 'launcher_project_hash', source: 'rust' },
  { tool: 'launcher_start', gap: 'launcher_start', source: 'rust' },
  { tool: 'launcher_stop', gap: 'launcher_stop', source: 'rust' },
];

/**
 * 刻意不补成工具的缺口类别（显式标注，铁律 4：不静默）。
 * 这些缺口没有「模型可安全调用的数据面」，或属危险 / 写 / UI 动作，故留在盘点缺口清单里，
 * 绝不造一个返回空串的假实现。盘点脚本会把这些类别连同每条剩余缺口的原因一起输出。
 */
export const MCP_DEFERRED_GAP_NOTES: readonly { readonly scope: string; readonly reason: string }[] = [
  { scope: 'launcher_* / market_* / open_url_external / export_file / remove_* / rename_path', reason: '危险工具（privileged）：默认不进 tools/list，须宿主经第四张表逐会话批准，annotations 不可信。' },
  { scope: 'mcp_* 会话控制 / 审计', reason: '宿主线协议与第四张表内建命令，不作为模型可调用工具。' },
  { scope: 'choose_* / pick_* / show_in_folder 等原生对话框', reason: '面向人的 UI 交互，无模型可调用的数据面。' },
  { scope: 'format（编辑器写副作用 · B3 批后仅剩这一条）', reason: '编辑器写/光标副作用一族里 revealLine / setCursor / setSelection / setValue（含 type）已于 B3 批登记为具名 edit 工具（editor.* 五枚，真源 = debug/install-debug.ts 的实现腿）；format 仍留缺口：它是异步 provider 通道（editor.action.formatDocument.run + 前后长度读数），本期刻意不登记半截实现，绝不挂空串假成功。' },
  { scope: 'ui.* 槽贡献（面板 / 装饰 / 语言服务注册）', reason: '纯 UI / 注册贡献，无独立数据面；领域知识只经 mcp.prompt 槽注入。' },
  { scope: '其余未登记只读原语', reason: '真源存在但本波未登记为具名工具：保留在缺口清单，宿主后续按需补，绝不挂空串假实现。' },
  { scope: 'LaneF 第四波刻意不登记的 5 条 cheap-read（B2 批后余项 4 条：read_files_raw 已被具名工具结构化覆盖）', reason: 'read_files_raw 于 B2 批（LaneT 2026-11-06）由具名只读工具 fs.readMany 结构化覆盖：输出走 kernel.io.readTexts 的 TextFile 投影（不是 ipc::Response 裸字节帧）、逐条 resolveWithinRoot 只收项目根内相对路径（绝对路径 / 盘符 / .. 逃逸整批显式 INVALID_ARGS）、单次硬上限 64 条且超限显式报错不静默截断 ⇒ 原「无面向模型的结构化只读数据面」与「暴露任意目标路径参数」两条理由逐条拆除，该缺口由 deferred 转 wired。read_file_bytes_raw 继续 deferred：单文件 ipc::Response 二进制帧（前端拿 ArrayBuffer / 自定义帧），是开项目热路径的性能通道，没有面向模型的结构化数据面，且其 path 就是任意绝对目标路径参数——项目根内的单文件文本读已由 fs.readFile 覆盖、批量文本读已由 fs.readMany 覆盖，登记它只会把「不暴露任意目标路径参数」这条闸重新打开；updater_relaunch=app.restart() 重启动作、debug.type=applyTypedEdit 编辑器输入动作，均非只读；debug.actions 真源 focusedCtx().editorRef.current.getSupportedActions() 对 MCP 注入面不可达，绝不挂空数组假实现。' },
  { scope: 'Wave4 #4 · editor.revealPosition（LaneH 判性 · B10 批 LaneV 复核后仍不登记）', reason: '定位这一面已由两枚具名 edit 工具各自覆盖并带读回核对：editor.revealLine 管视口（回读 revealedLine 与 clamped）、editor.setCursor 管光标（回读 cursor 与 clamped），要操作的实例由 editor.openDocument / document.active / editor.info 交回 paneId。当年 LaneH 的四条证据一条都没被推翻（editor.revealLocation 至今是 fire-and-forget 事件：无 ack / 无落地确认 / 落地走 React setState 异步重渲染 / 订阅者只在 GUI 挂载时存在），变的只是观察件（见下一条），而观察件救不了「一步同时打开并定位」这条组合面：把它登记成工具等于造第二条没有核对通道的跳转。⇒ 按铁律 4 继续不登记，runSupplemental 的前置兜底对误调仍抛带判性理由的可见 NOT_WIRED，绝不返回 moved:true 一类的假成功。' },
  { scope: 'B10 批判性变更（LaneV 2026-11-06）：editor.openDocument 由 deferred 转为具名 edit 工具（不是抬成 wired 缺口计数——它没有对应的 rust/debug 真源缺口名，故不进 MCP_TOOL_GAP_MAP）', reason: '原判性（宿主无可诚实回报结果的打开通道）在 B3 批之后不再成立，理由逐条：① 观察件到位——editor-write-legs.ts 已证明 MCP 面能在执行时动态 import ui/editor-pane-registry 并按 paneId 反查 livePanes 的 ref 壳（ps10 纪律：登记簿仍是动态边，开机静态图零新增），于是「这条 path 有没有真上屏」从推断变成读得回来的事实；② 执行体没换——仍只发射宿主既有的 editor.revealLocation（App.tsx 通用导航落地点，与转到定义 / 问题面板 / 大纲同一条路），本批零新事件、零新宿主能力、没给事件加 ack；③ 回执形态——发射后有界轮询登记簿（窗缺省 3000ms、上限 10000ms、间隔 25ms，三个常量与依据写在 editor-open-legs.ts 模块头），只有「某实例 filePathRef 命中目标 + 上屏 model 就是那一份标签 model」才回 opened:true，并把 paneId / lineCount / language / modelUri / readOnly / derivedView / waitedMs / polls / intent 全部读回来；④ 读不到就显式失败并交代账目（等了多久、看到几个实例、各实例正显示什么、为什么判没打开），登记簿整张读不到或在发射前查到该事件零订阅者 ⇒ 不发射、直接 NOT_WIRED；⑤ Wave4 #4 里「routeOpenPath 不校验项目根域」这一条由 MCP 侧补上：入参只收项目根内相对路径，走与 fs.readFile 同一条 resolveWithinRoot，绝对路径 / 盘符 / 上跳当场 INVALID_ARGS，宿主事件永远拿不到域外落点（附带红利：目标锚在当前根内，routeOpenPath 的换项目分支构造上不可达）。打开文档不写盘、不改模型、不改光标：contentChanged:false 与 saved:false / persisted:false 恒定如实回报，落盘仍只经第四张表 approvedRoots × 内核 writablePaths 双闸与 exportFile 对话框。档位与 B3 那五枚同尺进 Rust EDIT_TOOLS_EXACT，端点级 read 会话直调逐枚 E_TIER_DENIED 带工具名 + Denied 审计 + 桥零调用。' },
  /* ---- B4 批（LaneS，2026-11-06）：启动器族逐条判性（27 枚已登记，其余一律留账不静默）---- */
  { scope: 'B4 批刻意永不登记：launcher_pick_archive / launcher_pick_source_root / launcher_pick_write_root', reason: '对话框即授权本身（铁律 6/7）：这三条命令的返回值就是授权动作（选中的绝对路径 + 当场写入第三张表的 approvals.json），把它做成模型可调用的工具等于让 AI 替人按下确认键，也等于开放任意目标路径参数。授权入口只有原生目录对话框一条路，JS 侧永不代拿落点决定权。' },
  { scope: 'B4 批刻意永不登记：launcher_trust_executable', reason: '可执行文件信任的授予必须是人的动作：宿主在同一命令内算 sha256 并弹原生确认框（approvedBy 恒为 native-dialog），登记成工具即让 AI 自授信任并绕过 launcher_start 校验链里的那一道闸，属新造权限而非新入口。' },
  { scope: 'B4 批刻意永不登记：launcher_instance_open_folder', reason: 'OS shell 面向人的动作（在资源管理器里打开一个目录），没有模型可消费的数据面，也不产生任何可回读读数；宿主 only 认枚举目标（instance/game/logs/backups/staging），不收子路径。' },
  { scope: 'B4 批刻意永不登记：launcher_log_export / launcher_save_export', reason: '两条导出都是 exportFile 同形的法定通道：原生保存对话框与写盘绑在同一个 Rust 命令内，落点由对话框当场选定。登记成 MCP 工具即把「人选落点」换成「模型给落点」，铁律 6 不允许，且不新增任何写盘通道。' },
  { scope: 'B4 批刻意不登记：launcher_runtime_*（宿主未落地）', reason: '真源不存在：Rust commands.rs 的 38 条 COMMAND_NAMES 里没有 launcher_runtime_* 任何一条，桥文件也明确不写（process.rs 的运行时解析因此 fail-closed）。按铁律 4「真源不存在 ⇒ 不登记」，绝不挂空实现或假装有运行时登记表。' },
  { scope: 'B4 批刻意不登记：market_device_token / market_publish / market_download / market_extract / market_fetch_text（market_* 全族）', reason: '铸凭据、不可逆外发发布、以及带安装副作用的网络取件，三类都不是「读一台机器的状态」；Rust validate_tool_name 对 market_ 前缀保持 fail-closed（TOOL_FAIL_CLOSED），本批零改动，盘点里继续按缺口逐条挂着。' },
  { scope: 'B4 批判性变更（相对批单）：launcher_content_plan / launcher_save_import / launcher_project_extract 不登记', reason: '三条的 archivePath 入参按宿主自己的注释是「用户在原生对话框里选中的输入件」，宿主的 validate_archive_argument 只做形态闸（绝对路径 / 存在 / 是文件 / 非 UNC / 无控制字符），没有「这台机器上哪些包已被人选过」这一层可复验的登记表；而产出该路径的 launcher_pick_archive 属对话框即授权、刻意不登记。两相叠加：登记这三条等于让模型自行指定任意本机文件让宿主读取并解包 ⇒ 新造了一条读侧的任意路径通道，与铁律 6「不得开放任意目标路径参数」相反。故本批把它们留在缺口清单，改由界面侧向导产出的 planId 驱动 launcher_content_apply / launcher_save_apply_import（planId 是一次性句柄，不是路径，过期即显式拒绝）。' },
  { scope: 'B4 批判性变更（相对批单）：launcher_instance_create 不登记', reason: '命令载荷是 {request, profile}，其中 profile 由 adapter 的 probe + buildProfile 编译（那是游戏知识，只能进 *-adapter / launcher-core，MCP 腿零游戏知识），且 request.sourceRoot 是 launcher_pick_source_root 对话框产出的绝对路径（即授权本身）。MCP 面既造不出诚实的 profile，也拿不到合法的 sourceRoot ⇒ 登记即造假或越权，留账不登记；实例的新建走界面，或经 launcher_instance_duplicate 复制既有实例。' },
  { scope: 'B4 批已登记但刻意收窄：launcher_instance_update 不收 executableRelativePath / args / env', reason: '宿主白名单允许这些字段，但「跑什么」属于人的决定（信任只能由原生确认框授予）：具名工具只收 name / notes / tags 三个描述性字段，其余字段在本面被显式拒绝（INVALID_ARGS 说明原因），宿主白名单仍是判据真源。这是收紧，不是放宽，也不影响界面侧既有能力。' },
];

/** 内置 resource（≥6 的硬要求；「当前文档与光标」是第一波后的加法，Wave4 余项⑤再加 `kojo://tasks`）。 */
export interface McpResourceSpec {
  readonly uri: string;
  readonly name: string;
  readonly description: string;
  readonly mimeType?: string;
}

export const MCP_RESOURCE_SPECS: readonly McpResourceSpec[] = [
  { uri: 'kojo://project/snapshot', name: '项目快照', description: '当前项目的一屏聚合快照', mimeType: 'application/json' },
  { uri: 'kojo://project/file-tree', name: '文件树', description: '项目根内文件树', mimeType: 'application/json' },
  { uri: 'kojo://project/diagnostics', name: '诊断', description: '当前诊断读数（投影为可读列表 + truncated 标记）', mimeType: 'application/json' },
  { uri: 'kojo://project/validation-failures', name: '校验失败规则', description: '校验 report.failedRules（投影为可读列表 + truncated 标记）', mimeType: 'application/json' },
  { uri: 'kojo://project/commands', name: '命令清单', description: '命令面板注册表清单（投影为可读列表 + truncated 标记）', mimeType: 'application/json' },
  { uri: 'kojo://project/plugins', name: '插件状态', description: '插件状态（inactive 必须可见，含 missing[]；投影 + truncated 标记）', mimeType: 'application/json' },
  { uri: 'kojo://project/events', name: '事件环形缓冲', description: '内核事件环形缓冲最近记录', mimeType: 'application/json' },
  { uri: 'kojo://project/active-document', name: '当前文档与光标', description: 'Active document text and cursor position（投影 + 截断上限 + truncated 标记）', mimeType: 'application/json' },
  // Wave4 余项⑤（LaneL）：长任务表（新条目，与上面 8 条并列，老条目语义零改动）。
  { uri: 'kojo://tasks', name: '长任务表', description: '本会话长任务清单：状态 / 进度账 / 取消位 / 有界终态投影 + notIncluded[] 缺席任务族逐条原因（轮询面，服务端不推送）', mimeType: 'application/json' },
];

/* ------------------------------------------------------------------ *
 * 6. resource 可读性：截断上限 + 显式 truncated 标记（fail loud，不静默）
 * ------------------------------------------------------------------ */

/** 单个 resource 文本的总上限（字符）；超限必须显式标注，绝不悄悄截掉。 */
export const RESOURCE_TEXT_LIMIT = 24_000;
/** 列表类 resource 的单次条数上限。 */
export const RESOURCE_ITEM_LIMIT = 200;
/** 活动文档正文上限（留出余量，避免投影 JSON 再触发外层截断）。 */
const DOCUMENT_TEXT_CAP = 8_000;

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}
function asFinite(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? (v as unknown[]) : [];
}

/**
 * 文本总闸：`text` 超过 `cap` 时**不静默截断**，而是返回一个结构化 JSON envelope，
 * 顶层带 `truncated:true` + `cap` + `originalLength` + `preview` + 处置 `hint`。
 * 模型读到 `truncated:true` 就知道要缩小范围 / 分页，而不是误把预览当全文。
 */
export function truncateResourceText(text: string, cap = RESOURCE_TEXT_LIMIT): { text: string; truncated: boolean } {
  const src = typeof text === 'string' ? text : String(text ?? '');
  if (src.length <= cap) return { text: src, truncated: false };
  const envelope = {
    truncated: true,
    cap,
    originalLength: src.length,
    preview: src.slice(0, cap),
    hint: RESOURCE_TRUNCATION_HINT,
  };
  return { text: JSON.stringify(envelope, null, 2), truncated: true };
}

/**
 * 截断时的「去哪拿完整」指针：resources 面按 MCP 协议只有 `uri` 入参、自身无法翻页，
 * 所以显式把客户端引到**带游标的工具面**（同数据源）。分页取舍写死在这一处，见本批回执。
 */
function pagingPointer(truncated: boolean, tool: string, unit = 'items'): Record<string, unknown> {
  return truncated
    ? { hasMore: true, pageableVia: 'tool', pageTool: tool, pageUnit: unit, pageHint: `This resource view is capped; call ${tool} with limit+cursor to enumerate all ${unit}.` }
    : { hasMore: false };
}

/** 当前文档内容与光标 → 可读投影（正文按上限截断并显式标记）。 */
export function slimActiveDocument(raw: unknown, cap = DOCUMENT_TEXT_CAP): Record<string, unknown> {
  const obj = isPlainObject(raw) ? raw : {};
  const text = asString(obj['text'], asString(obj['content']));
  const cursorRaw = obj['cursor'];
  const cursor = isPlainObject(cursorRaw)
    ? { line: asFinite(cursorRaw['line'], 1), column: asFinite(cursorRaw['column'], 1) }
    : { line: 1, column: 1, inferred: true };
  const truncated = text.length > cap;
  const warnings: string[] = [];
  if (!('text' in obj) && !('content' in obj)) warnings.push('源数据缺 text/content（显式标注，不静默）');
  if (!isPlainObject(cursorRaw)) warnings.push('源数据缺 cursor（回退 {line:1,column:1} 并标记 inferred）');
  return {
    path: asString(obj['path'], asString(obj['uri'])),
    language: asString(obj['language']),
    cursor,
    text: truncated ? text.slice(0, cap) : text,
    textLength: text.length,
    truncated,
    ...pagingPointer(truncated, 'document.active', 'characters'),
    ...(warnings.length ? { warnings } : {}),
  };
}

/** 命令清单 → 可读投影（条数上限 + truncated）。 */
export function slimCommandList(raw: unknown, cap = RESOURCE_ITEM_LIMIT): Record<string, unknown> {
  const items = Array.isArray(raw)
    ? asArray(raw)
    : isPlainObject(raw) && Array.isArray(raw['commands'])
      ? asArray(raw['commands'])
      : [];
  const truncated = items.length > cap;
  const commands = items.slice(0, cap).map((it) => {
    const o = isPlainObject(it) ? it : {};
    return {
      id: asString(o['id'], asString(o['name'])),
      title: asString(o['title'], asString(o['id'])),
      description: asString(o['description']),
      tier: asString(o['tier']),
    };
  });
  return { commands, total: items.length, truncated, ...pagingPointer(truncated, 'commands.list') };
}

/** 诊断列表 → 可读投影（条数上限 + truncated）。 */
export function slimDiagnosticList(raw: unknown, cap = RESOURCE_ITEM_LIMIT): Record<string, unknown> {
  const items = Array.isArray(raw)
    ? asArray(raw)
    : isPlainObject(raw) && Array.isArray(raw['items'])
      ? asArray(raw['items'])
      : isPlainObject(raw) && Array.isArray(raw['diagnostics'])
        ? asArray(raw['diagnostics'])
        : [];
  const truncated = items.length > cap;
  const diagnostics = items.slice(0, cap).map((it) => {
    const o = isPlainObject(it) ? it : {};
    return { message: asString(o['message']), line: asFinite(o['line'], 1), severity: asString(o['severity']), source: asString(o['source']) };
  });
  return { diagnostics, total: items.length, truncated, ...pagingPointer(truncated, 'problems.diagnostics') };
}

/** 插件状态 → 可读投影：inactive 必可见、每项含 missing[]；缺字段显式 warnings（不静默）。 */
export function slimPluginStatus(raw: unknown, cap = RESOURCE_ITEM_LIMIT): Record<string, unknown> {
  const obj = isPlainObject(raw) ? raw : {};
  const warnings: string[] = [];
  const takeArray = (key: string): unknown[] => {
    const v = obj[key];
    if (Array.isArray(v)) return asArray(v);
    warnings.push(v === undefined ? `源数据缺字段 ${key}（显式补空数组，不静默）` : `源数据字段 ${key} 不是数组（显式补空数组，不静默）`);
    return [];
  };
  const active = takeArray('active');
  const inactive = takeArray('inactive');
  const missing = takeArray('missing');
  const truncated = active.length > cap || inactive.length > cap || missing.length > cap;
  const inactiveSlim = inactive.slice(0, cap).map((it) => {
    const o = isPlainObject(it) ? it : { id: String(it) };
    const m = o['missing'];
    return { ...o, missing: Array.isArray(m) ? m : [] };
  });
  return {
    active: active.slice(0, cap),
    inactive: inactiveSlim,
    missing: missing.slice(0, cap),
    total: { active: active.length, inactive: inactive.length, missing: missing.length },
    truncated,
    ...(truncated
      ? {
          hasMore: true,
          pageableVia: 'none',
          pageNote:
            'No paginated tool exists for plugin status (this batch adds optional arguments only, no new tool names). Items beyond the cap are NOT enumerable from this surface — say so explicitly rather than assuming the list is complete.',
        }
      : { hasMore: false }),
    ...(warnings.length ? { warnings } : {}),
  };
}

/** 校验 report.failedRules → 可读投影（兼容 raw / raw.report / raw.failedRules / 直接数组）。 */
export function slimValidationFailures(raw: unknown, cap = RESOURCE_ITEM_LIMIT): Record<string, unknown> {
  const sources: unknown[] = [raw];
  if (isPlainObject(raw) && isPlainObject(raw['report'])) sources.push(raw['report']);
  let rules: unknown[] = [];
  let found = false;
  for (const s of sources) {
    if (isPlainObject(s) && Array.isArray(s['failedRules'])) {
      rules = asArray(s['failedRules']);
      found = true;
      break;
    }
  }
  if (!found && Array.isArray(raw)) {
    rules = asArray(raw);
    found = true;
  }
  const truncated = rules.length > cap;
  const failedRules = rules.slice(0, cap).map((it) => {
    const o = isPlainObject(it) ? it : { rule: String(it) };
    return { rule: asString(o['rule'], asString(o['id'])), message: asString(o['message']), severity: asString(o['severity']) };
  });
  return {
    failedRules,
    total: rules.length,
    truncated,
    ...pagingPointer(truncated, 'editor.selfCheck'),
    ...(found ? {} : { warnings: ['report.failedRules 缺席（显式标注，不静默）'] }),
  };
}

/** 按 uri 分派可读性投影；未登记 uri 原样返回（仍会过总闸截断）。 */
export function slimResourceData(uri: string, data: unknown): unknown {
  switch (uri) {
    case 'kojo://project/active-document':
      return slimActiveDocument(data);
    case 'kojo://project/commands':
      return slimCommandList(data);
    case 'kojo://project/plugins':
      return slimPluginStatus(data);
    case 'kojo://project/validation-failures':
      return slimValidationFailures(data);
    case 'kojo://project/diagnostics':
      return slimDiagnosticList(data);
    default:
      return data;
  }
}

/* ------------------------------------------------------------------ *
 * 6b. 分页游标核心（B1「分页游标批」，2026-11-06）
 *
 * 一句话定位：把「截断型」读数面变成「分页型」，让外部 AI **能完整枚举**。
 *
 * 游标形状 = `指纹:下标`（列举面下标＝条目序号，文本面下标＝字符偏移）：
 * - 每次取页都对**当前全量快照**算一个 FNV-1a 指纹（列举面按稳定 key、文本面按正文），
 *   并把它编进 `nextCursor`；
 * - 下一页带着该游标进来时先复算指纹：
 *   ① 指纹相同 ⇒ 快照没变，按下标切是**可自证的**（全页并集 == 全集，无重无漏）；
 *   ② 指纹不同 ⇒ 翻页期间被并发编辑 / 外部写盘改过，**绝不按旧下标盲切**（那正是漏条 /
 *     重复的成因）。此处选择「显式出声 + 从新快照头部整页重发」：返回 `changedDuringPaging:true`
 *     并给出新快照的第 0 页。客户端据此知道「本页不可与旧页拼接」，且无需重启会话就能继续；
 *     不做静默重排、不做假装连续。
 * - 游标形态不合法 ⇒ `INVALID_ARGS`（fail loud，不静默当成第一页）。
 *
 * 完整性账（每页必带）：`total` + `hasMore` + `nextCursor` + `offset` + `truncated`
 * （`truncated` 口径不变＝「本次没把全量都呈现」）；取不到全量的面（如引擎自身封顶的检索）
 * 显式给 `knownTotal:false`，不硬编一个假 total。
 *
 * 页大小闸仍是闸：`limit` 一律 clamp 到「该面今天已有的上限」，本批不抬高任何体积闸。
 * ------------------------------------------------------------------ */

/** 分页入参 `limit` 的通用下限（1 条一页也要能出，否则游标死锁）。 */
export const PAGE_LIMIT_MIN = 1;

/** FNV-1a 32 位滚动指纹（列举面按 key 序列、文本面按正文；8 位十六进制）。 */
export function pageFingerprint(parts: readonly string[]): string {
  let h = (0x811c9dc5 ^ parts.length) >>> 0;
  for (const part of parts) {
    for (let i = 0; i < part.length; i += 1) {
      h = (h ^ part.charCodeAt(i)) >>> 0;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    h = (h ^ 0x1f) >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** 游标 = `指纹:下标`（下标＝下一页的起点；文本面＝字符偏移）。 */
export function encodePageCursor(fingerprint: string, index: number): string {
  return `${fingerprint}:${index}`;
}

const CURSOR_RE = /^([0-9a-f]{8}):(\d{1,10})$/;

/** 解析游标；形态不合法（含非字符串）返回 null，由调用方决定出声口径。 */
export function decodePageCursor(cursor: unknown): { readonly fingerprint: string; readonly index: number } | null {
  if (typeof cursor !== 'string') return null;
  const m = CURSOR_RE.exec(cursor);
  if (!m) return null;
  const index = Number(m[2]);
  if (!Number.isFinite(index)) return null;
  return { fingerprint: m[1] as string, index };
}

/** 分页入参里 `limit` 可复用的旧名：序列真源已上移到 §5 的 `PAGE_SIZE_ARG_ALIASES`（导出，
 * 供各面 schema 声明与漂移护栏共用——声明与取值序列必须是同一份名单，否则严格化会拒掉旧别名）。 */

function clampPositiveInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : fallback;
  return Math.min(Math.max(min, n), max);
}

function pageSizeOf(args: Record<string, unknown>, defaultLimit: number, maxLimit: number): number {
  for (const alias of PAGE_SIZE_ARG_ALIASES) {
    const v = args[alias];
    if (typeof v === 'number' && Number.isFinite(v)) return clampPositiveInt(v, defaultLimit, PAGE_LIMIT_MIN, maxLimit);
  }
  return clampPositiveInt(undefined, defaultLimit, PAGE_LIMIT_MIN, maxLimit);
}

/** 游标给了但形状不对 ⇒ 显式报错（绝不静默退回第一页冒充连续）。导出给 app 侧手写分页腿复用。 */
export function assertCursorShape(args: Record<string, unknown>): void {
  const raw = args['cursor'];
  if (raw === undefined || raw === null) return;
  if (decodePageCursor(raw) === null) {
    throw new McpFailure(
      'INVALID_ARGS',
      `cursor 形状不合法（期望 \`指纹:下标\`，且必须是上一页 nextCursor 的原样回传）：${String(raw).slice(0, 64)}`,
    );
  }
}

/**
 * 取页参数（给「先要窗口再取数」的腿用，如检索：引擎的 `maxResults` 取决于 offset+limit）。
 * 游标优先于裸 `offset`；游标形状不合法显式报错，绝不静默当第一页。
 */
export function pageParamsFor(
  args: Record<string, unknown>,
  opts: { readonly defaultLimit: number; readonly maxLimit: number },
): { readonly limit: number; readonly offset: number; readonly hasCursor: boolean } {
  assertCursorShape(args);
  const limit = pageSizeOf(args, opts.defaultLimit, opts.maxLimit);
  const decoded = decodePageCursor(args['cursor']);
  if (decoded) return { limit, offset: Math.max(0, decoded.index), hasCursor: true };
  const raw = args['offset'];
  const offset = typeof raw === 'number' && Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0;
  return { limit, offset, hasCursor: false };
}

export interface PageEnvelope {
  readonly offset: number;
  readonly limit: number;
  readonly total: number;
  readonly truncated: boolean;
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
  readonly fingerprint: string;
  readonly changedDuringPaging?: true;
}

/**
 * 列举面分页：`items` 必须是**当前全量**（不是已截断的片段），`keyOf` 给每条的稳定 key。
 * 返回体自带完整性账；`changedDuringPaging` 出现时 `items` 是新快照的第 0 页。
 */
export function paginateByCursor<T>(
  items: readonly T[],
  keyOf: (item: T, index: number) => string,
  args: Record<string, unknown>,
  opts: { readonly defaultLimit: number; readonly maxLimit: number },
): { readonly page: readonly T[]; readonly offset: number; readonly limit: number; readonly total: number; readonly truncated: boolean; readonly hasMore: boolean; readonly nextCursor: string | null; readonly fingerprint: string; readonly changedDuringPaging?: true } {
  assertCursorShape(args);
  const limit = pageSizeOf(args, opts.defaultLimit, opts.maxLimit);
  const fingerprint = pageFingerprint(items.map((it, i) => keyOf(it, i)));
  const decoded = decodePageCursor(args['cursor']);
  let offset = 0;
  let changed: true | undefined;
  if (decoded) {
    if (decoded.fingerprint === fingerprint) {
      if (decoded.index > items.length) {
        throw new McpFailure(
          'INVALID_ARGS',
          `cursor 下标越界：${decoded.index} > 全集 ${items.length} 条。cursor 必须是上一页 nextCursor 的原样回传，` +
            '不得自行推算或改写；请省略 cursor 从第 0 页重翻。',
        );
      }
      offset = decoded.index;
    } else {
      changed = true;
      offset = 0;
    }
  }
  const page = items.slice(offset, offset + limit);
  const next = offset + page.length;
  const hasMore = next < items.length;
  const envelope: PageEnvelope = {
    offset,
    limit,
    total: items.length,
    truncated: page.length < items.length,
    hasMore,
    nextCursor: hasMore ? encodePageCursor(fingerprint, next) : null,
    fingerprint,
  };
  return {
    page,
    ...envelope,
    ...(changed === true ? { changedDuringPaging: true as const } : {}),
  };
}

/**
 * 文本面分页（`fs.readFile` / `document.active`）：游标下标＝字符偏移。
 * 单页字符上限 `maxLimit` 由调用方按**宿主不可信串闸**给（见 app 侧 `MCP_PAGE_TEXT_MAX`），
 * 保证 JS 报出去的账不会在 Rust 转发时被再切一刀（否则「逐页拼接==全文」会在边界上假）。
 */
export function paginateText(
  text: string,
  args: Record<string, unknown>,
  opts: { readonly defaultLimit: number; readonly maxLimit: number },
): { readonly page: string; readonly offset: number; readonly limit: number; readonly total: number; readonly truncated: boolean; readonly hasMore: boolean; readonly nextCursor: string | null; readonly fingerprint: string; readonly changedDuringPaging?: true } {
  assertCursorShape(args);
  const limit = pageSizeOf(args, opts.defaultLimit, opts.maxLimit);
  const fingerprint = pageFingerprint([text]);
  const decoded = decodePageCursor(args['cursor']);
  let offset = 0;
  let changed: true | undefined;
  if (decoded) {
    if (decoded.fingerprint === fingerprint) {
      if (decoded.index > text.length) {
        throw new McpFailure(
          'INVALID_ARGS',
          `cursor 下标越界：${decoded.index} > 正文 ${text.length} 字符。cursor 必须是上一页 nextCursor 的原样回传，` +
            '不得自行推算或改写；请省略 cursor 从第 0 页重翻。',
        );
      }
      offset = decoded.index;
    } else {
      changed = true;
      offset = 0;
    }
  } else if (args['offset'] !== undefined && args['offset'] !== null) {
    // 裸 `offset`（无游标）＝调用方自己指定窗口起点：没有快照指纹可比对，因此**不做连续性保证**，
    // 只做长度夹取；账目里 `cursor` 缺席如实体现（`hasMore`/`nextCursor` 仍自洽，从该偏移往下翻页）。
    const wanted = Math.floor(Number(args['offset']));
    offset = Number.isFinite(wanted) ? Math.min(Math.max(0, wanted), text.length) : 0;
  }
  const page = text.slice(offset, offset + limit);
  const next = offset + page.length;
  const hasMore = next < text.length;
  return {
    page,
    offset,
    limit,
    total: text.length,
    truncated: page.length < text.length,
    hasMore,
    nextCursor: hasMore ? encodePageCursor(fingerprint, next) : null,
    fingerprint,
    ...(changed === true ? { changedDuringPaging: true as const } : {}),
  };
}

/** 截断型 resource 文本的诚实提示：指向**真正存在**的带游标工具面。 */
export const RESOURCE_TRUNCATION_HINT =
  'Resource text exceeded the cap and was truncated. This resource surface is uri-only (MCP resources/read takes no arguments), so it cannot page itself: use the paginated tools instead — fs.readFile/document.active with offset+limit (or cursor) for document text, commands.list / fs.tree / io.listDir / problems.diagnostics / semantic.diagnostics / semantic.documentSymbols with limit+cursor for lists, and re-read with a narrower query. Do NOT assume the preview is the complete content.';

/** 分页游标批：文本面单页上限由宿主不可信串闸决定（见 app 侧 `MCP_PAGE_TEXT_MAX`）。 */
export const HOST_UNTRUSTED_STRING_GATE = 64 * 1024;

/* ------------------------------------------------------------------ *
 * 7. prompts：零游戏名词的领域工作流骨架 + mcp.prompt 槽消费逻辑
 *
 * 骨架只给「读优先 / 校验 / 复核」的工作流结构与具名槽位；任何游戏 / 领域知识
 * 都由 `mcp.prompt` 槽（`*-adapter` 贡献）以片段形式注入 `{{slot:xxx}}`。
 * 槽缺失时渲染成**显式可读占位**（fail loud），骨架绝不编造领域知识。
 * ------------------------------------------------------------------ */

export interface McpPromptSkeletonSpec {
  readonly name: string;
  readonly description: string;
  readonly arguments: readonly { name: string; required?: boolean }[];
  /** 工作流骨架文本：`{{arg}}` 为参数槽，`{{slot:xxx}}` 为 adapter 注入的领域知识槽。 */
  readonly template: string;
  /** 本骨架消费的 mcp.prompt 领域槽名。 */
  readonly slots: readonly string[];
}

export const MCP_PROMPT_SKELETON_SPECS: readonly McpPromptSkeletonSpec[] = [
  {
    name: 'workflow.triage-diagnostics',
    description:
      'Domain-agnostic workflow: inspect the active document, read diagnostics, choose the smallest fix, then re-validate. Domain-specific rules are injected through mcp.prompt slots by adapters, never hardcoded.',
    arguments: [{ name: 'focus', required: false }],
    slots: ['domain_context', 'domain_rules'],
    template: [
      'You assist inside a structured editor through a read-first tool surface.',
      'Goal: triage diagnostics for {{focus}}.',
      'Steps:',
      '1. Read resources (active document, diagnostics, validation failures) BEFORE proposing any edit.',
      '2. Inspect available quick fixes via read-only listings; never invent an action id.',
      '3. Propose the smallest edit for the highest-severity finding. Request explicit itemized approval for any destructive/privileged action.',
      '4. Re-read diagnostics afterwards and report what changed. If a result has truncated=true, narrow the query instead of assuming completeness.',
      'Domain context (mcp.prompt slot):',
      '{{slot:domain_context}}',
      'Domain rules (mcp.prompt slot):',
      '{{slot:domain_rules}}',
    ].join('\n'),
  },
  {
    name: 'workflow.author-review',
    description:
      'Domain-agnostic workflow: author/review a document, compare a diff, preview, and replay state to confirm the result. Domain knowledge comes only from mcp.prompt slots.',
    arguments: [{ name: 'target', required: false }],
    slots: ['domain_context', 'domain_vocabulary'],
    template: [
      'You assist inside a structured editor through a read-first tool surface.',
      'Goal: author and review {{target}}.',
      'Steps:',
      '1. Read the command list and active document to learn what the surface offers.',
      '2. Draft the change as a projection; use diff.compare (read-only) to see exactly what would change.',
      '3. Use preview.document and state.replay (read-only) to confirm the projection without mutating live state.',
      '4. Only then propose an edit inside authorized roots. Any domain wording must come from the injected slots, not from assumptions.',
      'Domain context (mcp.prompt slot):',
      '{{slot:domain_context}}',
      'Domain vocabulary (mcp.prompt slot):',
      '{{slot:domain_vocabulary}}',
    ].join('\n'),
  },
  {
    name: 'workflow.safe-refactor',
    description:
      'Domain-agnostic workflow: plan a refactor by reading structure first, apply only approved minimal edits, then re-read diagnostics and a diff to verify no unintended change.',
    arguments: [{ name: 'scope', required: false }],
    slots: ['domain_context'],
    template: [
      'You assist inside a structured editor through a read-first tool surface.',
      'Goal: plan a safe refactor of {{scope}}.',
      'Steps:',
      '1. Read document symbols and references (read-only) to map every affected site.',
      '2. Enumerate the smallest edits; classify each as read / edit / privileged. Never bundle a destructive action without explicit approval.',
      '3. After an edit, re-read diagnostics and diff.compare; a truncated result must be narrowed, not assumed complete.',
      '4. Report residual findings honestly (fail loud).',
      'Domain context (mcp.prompt slot):',
      '{{slot:domain_context}}',
    ].join('\n'),
  },
];

/** `mcp.prompt` 槽贡献的最小读取形状（宿主把 SlotMap['mcp.prompt'] 贡献投影成这一形状）。 */
export interface McpPromptSlotContributionLike {
  readonly name: string;
  render(args: Record<string, unknown>):
    | Promise<{ messages: readonly { readonly content: { readonly text: string } }[] }>
    | { messages: readonly { readonly content: { readonly text: string } }[] };
}

/**
 * 槽消费：把 `mcp.prompt` 槽贡献 render 出的文本收集成领域片段，供骨架按槽名注入。
 * 这是「游戏知识只能由 *-adapter 注入」的唯一入口——骨架自身不含任何领域事实。
 */
export async function collectPromptSlotFragments(
  contributions: readonly McpPromptSlotContributionLike[],
  args: Record<string, unknown> = {},
): Promise<McpPromptSlotFragment[]> {
  const out: McpPromptSlotFragment[] = [];
  for (const c of contributions ?? []) {
    const rendered = await c.render(args);
    const text = (rendered.messages ?? [])
      .map((m) => (m && typeof m.content?.text === 'string' ? m.content.text : ''))
      .filter(Boolean)
      .join('\n');
    out.push({ name: c.name, text, source: c.name });
  }
  return out;
}

/**
 * 渲染骨架：`{{arg}}` 用入参填，`{{slot:name}}` 用片段填。
 * 参数缺席 / 槽未注入 → **显式可读占位**（不静默、绝不编造领域知识）。
 */
export function renderSkeleton(
  spec: McpPromptSkeletonSpec,
  args: Record<string, unknown>,
  fragments: readonly McpPromptSlotFragment[] = [],
): { messages: { role: 'user'; content: { type: 'text'; text: string } }[] } {
  const byName = new Map(fragments.map((f) => [f.name, f.text]));
  const text = spec.template.replace(/\{\{([^}]+)\}\}/g, (_match: string, key: string): string => {
    const k = key.trim();
    if (k.startsWith('slot:')) {
      const slot = k.slice(5);
      const value = byName.get(slot);
      return value !== undefined && value !== ''
        ? value
        : `[领域槽未注入: ${slot}（adapter 未通过 mcp.prompt 提供；骨架不编造领域知识）]`;
    }
    const value = args[k];
    return value === undefined || value === null || value === ''
      ? `[未提供参数: ${k}]`
      : String(value);
  });
  return { messages: [{ role: 'user', content: { type: 'text', text } }] };
}

/** 把骨架 + 槽片段装配成可直接喂给 registry 的 `McpPrompt[]`。 */
export function createSkeletonPrompts(fragments: readonly McpPromptSlotFragment[] = []): McpPrompt[] {
  return MCP_PROMPT_SKELETON_SPECS.map((spec) => ({
    name: spec.name,
    description: spec.description,
    arguments: spec.arguments,
    render: async (args: Record<string, unknown>) => renderSkeleton(spec, args, fragments),
  }));
}

/* ------------------------------------------------------------------ *
 * 8. 装配 helper
 * ------------------------------------------------------------------ */

/**
 * 命令面板 id → 面向模型的 `tier`。**一律 `privileged`（fail-closed）**：
 *
 * - 命令面板注册的是「面向人的 UI 动作」（写盘 / 另存为 / 原生对话框 / 启动器 /
 *   编辑器写 / 光标与布局副作用），没有独立数据面；ADR-0013 决策 1 与盘点脚本的
 *   deferred 归因都把这一类归为「首期不默认暴露」。
 * - `isDangerousTool` 只认 `launcher_` / `export_file` / `remove_` 等**下划线**形状，
 *   认不出 `workbench.saveAll` / `launcher.openInstances` 这类点号 id；若沿用
 *   `commandToTool` 的缺省 `'edit'`，`tier=edit` 会话就能看见并执行这些动作，
 *   绕过「危险工具默认缺席、逐工具逐会话批准」。
 * - 因此宿主不替用户判断「哪条 UI 动作安全」，统一归 privileged：不进 `tools/list`，
 *   `tools/call` 须在 `scope.approvedTools` 里精确命中。命令作者自报的 `tier` 只许收紧、
 *   不许放宽（与 Rust 侧「annotations 不可信、tier 由宿主裁决」同口径）。
 * - 零游戏名词：只按 id 形状判据，不认领域语义；`declared` 的收紧分支为将来
 *   按显式白名单放开个别纯只读动作留扩展点，当前 inferred 已是最高档。
 *
 * 本函数供宿主（app 侧生产真源登记）调用；`commandToTool` 的缺省行为保持不变。
 */
const TIER_RANK: Readonly<Record<McpTier, number>> = { read: 0, edit: 1, privileged: 2 };

export function classifyCommandTier(id: string, declared?: McpTier): McpTier {
  const inferred: McpTier = 'privileged';
  if (isDangerousTool(id)) return inferred; // 冻结危险名单是显式红线，不接受任何放宽
  if (declared === undefined) return inferred;
  return TIER_RANK[declared] > TIER_RANK[inferred] ? declared : inferred;
}

/** 命令 → 工具：name=id、description=description??title、inputSchema=argsSchema??{}、tier 缺省 'edit'；危险名强制 privileged。 */
export function commandToTool(cmd: McpCommandSource): McpTool {
  const tier: McpTier = isDangerousTool(cmd.id) ? 'privileged' : (cmd.tier ?? 'edit');
  return {
    name: cmd.id,
    description: cmd.description ?? cmd.title,
    inputSchema: cmd.argsSchema ?? {},
    tier,
    run: async (args, scope) => {
      const result = await cmd.run(args, scope);
      // 命令面板动作是面向人的 UI 动作（开面板 / 弹对话框 / 改布局 / Monaco 交互输入框），
      // `CommandEntry.run` 返回 void ⇒ 没有 ack、没有落地确认。原样回 undefined 会让调用方
      // 把 fire-and-forget 当成「执行成功」，与铁律 4「内核不静默 / inactive 必须可见」相冲。
      // 因此 void 一律换成**诚实回执**；有真实返回值的命令原样透出，旧契约零改动。
      if (result !== undefined) return result;
      return {
        dispatched: true,
        confirmed: false,
        notice:
          '命令已派发但无可核验的落地确认（fire-and-forget，无 ack / 无状态读数）；' +
          '不可据此判定操作已生效，请用 project.info / document.active / problems.diagnostics 等只读真源复核。',
      };
    },
  };
}

function notWired(what: string): McpReaderFn {
  return () => {
    throw new McpFailure('NOT_WIRED', `能力「${what}」未接线：宿主未提供数据源（不静默、不伪造读数）`);
  };
}

function specToTool(spec: ToolSpec, run: McpReaderFn): McpTool {
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: spec.inputSchema,
    tier: spec.tier,
    ...(spec.annotations ? { annotations: spec.annotations } : {}),
    run: async (args, scope) => run(args, scope),
  };
}

function toText(data: unknown): string {
  return typeof data === 'string' ? data : JSON.stringify(data ?? null, null, 2);
}

function dedupeByName(tools: readonly McpTool[]): McpTool[] {
  const seen = new Set<string>();
  const out: McpTool[] = [];
  for (const t of tools) {
    if (seen.has(t.name)) continue;
    seen.add(t.name);
    out.push(t);
  }
  return out;
}

/** tier 授权判据：只读恒开；privileged 必须显式在 approvedTools；edit 需 edit/privileged 会话。 */
export function tierAllowed(tool: McpTool, scope: McpSessionScope): { allowed: boolean; reason?: string } {
  if (tool.tier === 'privileged') {
    return scope.approvedTools.includes(tool.name)
      ? { allowed: true }
      : { allowed: false, reason: `特权工具 ${tool.name} 未在本会话 approvedTools 中显式批准` };
  }
  if (tool.tier === 'edit' && scope.tier === 'read') {
    return { allowed: false, reason: `只读会话不可调用编辑工具 ${tool.name}` };
  }
  return { allowed: true };
}

/* ------------------------------------------------------------------ *
 * 9. registry 工厂
 * ------------------------------------------------------------------ */

export function createMcpCapabilityRegistry(deps: McpHostDeps): McpCapabilityRegistry {
  const semantic = deps.semantic ?? {};
  const kernelIo = deps.kernelIo ?? {};

  const semanticTools = SEMANTIC_TOOL_SPECS.map((spec) => {
    const method = spec.method as keyof McpSemanticReaders;
    return specToTool(spec, semantic[method] ?? notWired(spec.name));
  });
  const kernelTools = KERNEL_IO_TOOL_SPECS.map((spec) => {
    const method = spec.method as keyof McpKernelIo;
    return specToTool(spec, kernelIo[method] ?? notWired(spec.name));
  });
  const supplementalTools = SUPPLEMENTAL_TOOL_SPECS.map((spec) =>
    specToTool(
      spec,
      deps.runSupplemental
        ? (args, scope) => deps.runSupplemental!(spec.name, args, scope)
        : notWired(spec.name),
    ),
  );
  const commandTools = (deps.commands ?? []).map(commandToTool);
  // 命令来源优先（同 name 时命令登记覆盖内置规格），其后三路。
  const allTools = dedupeByName([...commandTools, ...semanticTools, ...kernelTools, ...supplementalTools]);
  const toolByName = new Map(allTools.map((t) => [t.name, t]));

  const builtinResources: readonly McpResource[] = MCP_RESOURCE_SPECS.map((spec) => ({
    uri: spec.uri,
    name: spec.name,
    description: spec.description,
    ...(spec.mimeType ? { mimeType: spec.mimeType } : {}),
    read: async (scope: McpSessionScope) => {
      if (!deps.readResourceData) {
        throw new McpFailure('RESOURCE_UNAVAILABLE', `resource ${spec.uri} 未提供数据源（不静默）`);
      }
      const data = await deps.readResourceData(spec.uri, scope);
      // 可读性投影（列表/正文带自己的 truncated 标记）→ 文本化 → 总闸截断（带显式 truncated）。
      const projected = slimResourceData(spec.uri, data);
      const { text } = truncateResourceText(toText(projected));
      return { contents: [{ uri: spec.uri, text }] };
    },
  }));
  const resources: McpResource[] = [...builtinResources];
  for (const extra of deps.resources ?? []) {
    const at = resources.findIndex((r) => r.uri === extra.uri);
    if (at >= 0) resources[at] = extra;
    else resources.push(extra);
  }
  const resourceByUri = new Map(resources.map((r) => [r.uri, r]));

  // 骨架仅在宿主显式提供 promptSlots（含空数组）时并入；缺省行为与第一波逐字一致。
  const skeletonPrompts = deps.promptSlots === undefined ? [] : createSkeletonPrompts(deps.promptSlots);
  const prompts: McpPrompt[] = [...skeletonPrompts, ...(deps.prompts ?? [])];
  const promptByName = new Map(prompts.map((p) => [p.name, p]));

  return {
    listTools(scope) {
      return allTools.filter((t) => tierAllowed(t, scope).allowed);
    },

    listResources() {
      return resources;
    },

    listPrompts() {
      return prompts;
    },

    async callTool(name, args, scope) {
      const tool = toolByName.get(name);
      if (!tool) throw new McpFailure('UNKNOWN_TOOL', `未知工具：${name}`);
      const gate = tierAllowed(tool, scope);
      if (!gate.allowed) throw new McpFailure('PERMISSION_DENIED', gate.reason ?? `越权调用 ${name}`);
      const input = args ?? {};
      const check = validateAgainstSchema(tool.inputSchema, input);
      if (!check.valid) {
        throw new McpFailure(
          'INVALID_ARGS',
          `工具 ${name} 入参不合法：${check.errors.join('；')}` +
            // 违规项被闸住时如实说明少报了几条（口径与其它「截断必带 truncated」的面一致）。
            (check.omittedErrors > 0 ? `；另有 ${check.omittedErrors} 条违规项未逐条列出（单次最多 ${SCHEMA_ERROR_CAP} 条）` : ''),
        );
      }
      try {
        return await tool.run(input, scope);
      } catch (err) {
        if (isMcpFailure(err)) throw err; // 结构化失败原样透出（NOT_WIRED 等）
        throw new McpFailure('TOOL_EXECUTION_FAILED', `工具 ${name} 执行失败：${err instanceof Error ? err.message : String(err)}`);
      }
    },

    async readResource(uri, scope) {
      const resource = resourceByUri.get(uri);
      if (!resource) throw new McpFailure('UNKNOWN_RESOURCE', `未知资源：${uri}`);
      try {
        return await resource.read(scope);
      } catch (err) {
        if (isMcpFailure(err)) throw err;
        throw new McpFailure('RESOURCE_UNAVAILABLE', `资源 ${uri} 读取失败：${err instanceof Error ? err.message : String(err)}`);
      }
    },

    async getPrompt(name, args, scope) {
      const prompt = promptByName.get(name);
      if (!prompt) throw new McpFailure('UNKNOWN_PROMPT', `未知提示：${name}`);
      const input = args ?? {};
      for (const a of prompt.arguments ?? []) {
        if (a.required && !(a.name in input)) {
          throw new McpFailure('MISSING_PROMPT_ARGUMENT', `提示 ${name} 缺必填参数：${a.name}`);
        }
      }
      try {
        return await prompt.render(input, scope);
      } catch (err) {
        if (isMcpFailure(err)) throw err;
        throw new McpFailure('PROMPT_RENDER_FAILED', `提示 ${name} 渲染失败：${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
