/**
 * 方言解析链的**宿主薄层**（LAU-D1b；`ARCH-language-unification.md` §5.3 / §5.4 / §8）。
 *
 * 判定语义**一行都不在这里**：解析、对账、归属全在 `@kojo/kojo-core` 的
 * `resolveDialectBinding`（LAU-D1a `875b05d3` 的契约）。本文件只回答三件事：
 *
 * 1. **输入从哪来**——识别链结论（`project.adapterId`）、工作区覆盖
 *    （`workspace.json` 的 `meta.dialect`，经 {@link loadWorkspaceDialectOverride} 现读）、
 *    文件内断言（`# 方言 <id>`，{@link readDialectAssertions}）与事实查询函数
 *    （组合根按 v1 `gameId` 取 2.0 `GameAdapter`，{@link installDialectFactsFor}）；
 * 2. **结果怎么投影**——状态栏一格（{@link dialectStatusForProject}）与
 *    `EditorDocumentIdentity.dialect` 那一格（{@link dialectContextOf}）；
 * 3. **消费者谁先问**——`documentRequestFields` 与 2.0 诊断链路。
 *
 * ## 为什么断言是逐行取样式读，而不走 CST
 *
 * `dialect_decl` 节点确实已进文法（LAU-SYNTAX `3a76d857`），但宿主**没有同步可用的 CST**：
 * tree-sitter 解析在 worker 里异步往返（`monaco/tree-sitter/*`），而本层要被同步语言服务
 * 请求（`documentRequestFields`）与 200ms 诊断节拍调用。为了一枚单行断言去等一次异步
 * parse，等于把每次悬停都排到解析队列后面。所以这里**只认文法烧进 token 的同一形状**
 * （`grammar.v2.js` 的 `decl()`：`#` + 水平空白 + `方言` + 空白或行尾 + 任意尾巴），
 * 不改文法 / wasm / 词表（LAU-D1b 的明令），每行拿到的第一个名字词就是那一行的断言值。
 *
 * **读出的是全部断言，不在这一层挑胜负**：文件里写两条互不相容的 `# 方言` 时，本层照读
 * 两条并原样下传，由 core 发 `core/dialect/mismatch`（"多个说法等于没有自证"）。
 * 早先"重复断言取首条"是**静默裁决**——同一份文件自证两次而两次不一样，屏上却像没这回事，
 * 那是铁律 4 明令要禁的形状；要"取首条"这种宽松口径，也必须先报冲突，不能说都不说。
 *
 * ## 没有默认方言（D12）
 *
 * 本文件不写任何方言常量、没有 `fallback` 分支：解析结果为空就是未绑定，状态栏如实说
 * 「未绑定」，事实类服务由 core 交空。覆盖只做**显式覆盖**，绝不按扩展名 / 路径猜。
 */
import {
  resolveDialectBinding,
  type DialectBindingResolution,
  type DialectId,
  type GameAdapter,
  type KojoDiagnostic,
} from '@kojo/kojo-core';
import { pathKey, type DialectContext, type WorkspaceService } from '@kojo/plugin-api';

/* ============================== 1. 文件内断言（纯函数） ============================== */

/** `# 方言 <名字>` 的断言读数（行号只给诊断定位用，1 基） */
export interface DialectAssertion {
  readonly dialect: DialectId;
  /** 断言所在行（1 基） */
  readonly line: number;
}

/**
 * 文法里 `decl('方言')` 烧出的 token 形状：`#[水平空白]+方言(?:[水平空白][^\n]*)?`。
 * 水平空白 = 空格 / Tab / 全角空格（`grammar.v2.js:62` 的 `W`，逐字同源）。
 *
 * 只认**行首**（允许前导水平空白）：断言是行级自证，写在行中间的不是它。
 * `#方言`（缺空白）与 `# 方言erafl`（词后粘字）由文法判 ERROR，本层同样不认——
 * 语法不比规范松，这里也不比文法松。
 */
const ASSERTION_PATTERN = /^[ \t\u3000]*#[ \t\u3000]+方言(?:[ \t\u3000]+([^\r\n]*))?[ \t\u3000]*$/;

/**
 * 从文件文本读出**全部**方言断言（按行序）；没有 / 形状不完整 ⇒ 空数组。
 *
 * 文法允许词后带任意尾巴（与 `# 视` 同构），断言值取**第一个名字词**：
 * `# 方言 erafl` 与 `# 方言 erafl 说明` 都读 `erafl`，尾巴不参与归属。
 *
 * **重复断言不再"取首条了事"**（铁律 4「内核不静默」）：全部交给 core
 * （`resolveDialectBinding({ fileAssertions })`）对账——都指向同一方言 ⇒ 与一条等价；
 * 指向不同方言 ⇒ `core/dialect/mismatch`（error）且**谁也不算自证**。本层只负责读全，
 * 不做"谁赢"的裁决（裁决在 core，判定面只有一处）。
 */
export function readDialectAssertions(source: string): readonly DialectAssertion[] {
  if (typeof source !== 'string' || source.length === 0) return [];
  const lines = source.split(/\r?\n/);
  const found: DialectAssertion[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = ASSERTION_PATTERN.exec(lines[index]!);
    if (match === null) continue;
    const raw = match[1];
    if (raw === undefined) continue; // `# 方言` 裸写：断言没有值，等于没有自证（继续看下一行）
    const value = raw.trim().split(/[ \t\u3000]+/)[0] ?? '';
    if (value.length === 0) continue;
    found.push({ dialect: value, line: index + 1 });
  }
  return found;
}

/**
 * 从文件文本读出**第一条**方言断言；没有 / 形状不完整 ⇒ `null`。
 *
 * 只给"这一份文件自证了什么"的只读展示面用（状态栏 / 悬停里引用一行）；解析链一律走
 * {@link readDialectAssertions} 全量下传——多条冲突由 core 报错，别在这一层又判一次。
 */
export function readDialectAssertion(source: string): DialectAssertion | null {
  return readDialectAssertions(source)[0] ?? null;
}

/* ============================== 2. 宿主输入源 ============================== */

/** 方言 id → 2.0 事实（`GameAdapter`）；交 `null` = 该方言没有 2.0 面 */
export type DialectFactsFor = (dialect: DialectId) => GameAdapter | null | undefined;

let factsFor: DialectFactsFor | null = null;

/** 一份文档解析需要的最小项目投影（`GameProject | null` 天然可传） */
export interface DialectProjectLike {
  readonly adapterId?: string | null;
  readonly rootDir?: string | null;
}

/** 工作区覆盖的内存表：键 = `pathKey(rootDir)`（Windows 大小写 / 分隔符同一把尺） */
const workspaceOverrides = new Map<string, DialectId>();
/** 状态栏 / 请求构造都订阅这张表：覆盖是异步读出来的，屏上必须跟着它变 */
let revision = 0;
const listeners = new Set<() => void>();

function bump(): void {
  revision += 1;
  for (const listener of [...listeners]) listener();
}

/** 订阅方言宿主表（事实登记 / 工作区覆盖）的变化；返回退订函数 */
export function subscribeDialectStore(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 当前修订号（`useSyncExternalStore` 的快照；值本身不参与渲染） */
export function dialectStoreRevision(): number {
  return revision;
}

/**
 * 登记事实查询函数（组合根在启动时调一次）。
 *
 * 生产实现是 `(dialect) => kojo2AdapterForProject({ adapterId: dialect })`——与语言服务
 * 同一个 2.0 登记簿、同一把键。**不在这里 import 组合根**：本文件要能在 node 池里单测，
 * 拖进 `bootstrap.ts` 就会把 worker / Tauri 桥一起拉进来。
 */
export function installDialectFactsFor(fn: DialectFactsFor | null): void {
  factsFor = fn;
  bump();
}

/** 宿主登记的事实查询；没登记 ⇒ `null`（未绑定，不猜） */
export function dialectFactsFor(dialect: DialectId): GameAdapter | null {
  if (factsFor === null) return null;
  try {
    return factsFor(dialect) ?? null;
  } catch {
    // 查询函数自己抛错 = 这一格没有事实；不把渲染链带下水（失败可见由未绑定承担）
    return null;
  }
}

/** 写 / 清一个项目的工作区覆盖（`null` = 清掉） */
export function setWorkspaceDialectOverride(rootDir: string, dialect: DialectId | null): void {
  if (typeof rootDir !== 'string' || rootDir.length === 0) return;
  const key = pathKey(rootDir);
  const value = typeof dialect === 'string' && dialect.trim().length > 0 ? dialect.trim() : null;
  const previous = workspaceOverrides.get(key) ?? null;
  if (previous === value) return;
  if (value === null) workspaceOverrides.delete(key);
  else workspaceOverrides.set(key, value);
  bump();
}

/** 读一个项目的工作区覆盖（没有 ⇒ `null`） */
export function workspaceDialectOverride(rootDir: string | null | undefined): DialectId | null {
  if (typeof rootDir !== 'string' || rootDir.length === 0) return null;
  return workspaceOverrides.get(pathKey(rootDir)) ?? null;
}

/**
 * 从工作区清单读出**当前工程**的显式覆盖（`workspace.json` 的 `meta.dialect`）。
 *
 * 关联口径：工作区项目的目录**就是**当前工程根（`workspaces.projectDir(id)` 与
 * `project.rootDir` 同键）。工作区服务不可用（浏览器开发壳没有平台数据目录）/
 * 没有对应项目 / `meta.dialect` 不是非空字符串 ⇒ 清空覆盖并返回 `null`——
 * 退到识别链结论，不另找一处"默认方言"。
 *
 * 这是**读**：不开新写通道，也不往游戏目录写任何清单。
 */
export async function loadWorkspaceDialectOverride(
  workspaces: Pick<WorkspaceService, 'list' | 'projectDir'>,
  rootDir: string,
): Promise<DialectId | null> {
  if (typeof rootDir !== 'string' || rootDir.length === 0) return null;
  let projects: Awaited<ReturnType<WorkspaceService['list']>>;
  try {
    projects = await workspaces.list();
  } catch {
    // 工作区服务不可用 = 这一趟没有覆盖（识别链结论仍照常工作）
    setWorkspaceDialectOverride(rootDir, null);
    return null;
  }
  const target = pathKey(rootDir);
  let raw: unknown = null;
  for (const project of projects) {
    if (pathKey(workspaces.projectDir(project.id)) !== target) continue;
    raw = project.meta?.['dialect'];
    break;
  }
  const dialect = typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null;
  setWorkspaceDialectOverride(rootDir, dialect);
  return dialect;
}

/* ============================== 3. 解析（薄包装，语义全在 core） ============================== */

/** 一份文档 / 一次请求的解析输入 */
export interface ResolveDocumentDialectInput {
  readonly project: DialectProjectLike | null;
  /** 文件正文（取 `# 方言` 断言）；缺省 = 没有断言 */
  readonly source?: string | null;
  /** 文件绝对路径（只为载体归属换算相对路径；缺省 = 不做归属） */
  readonly filePath?: string | null;
  /** 内容版本（与正文配套时断言读数按 `(路径, 版本)` 缓存；缺省 = 不缓存） */
  readonly version?: number | null;
  /** 覆盖写入口（测试 / 将来的显式入口）；缺省 = 读宿主表 */
  readonly workspaceOverride?: DialectId | null;
  /** 事实查询函数；缺省 = 宿主登记的那一枚 */
  readonly factsFor?: DialectFactsFor;
}

/**
 * 断言读数的**小缓存**：语言服务每次请求都要拿身份（悬停 / 补全 / 面包屑一敲键就是
 * 十来发），逐行扫全文 6,000 行 × N 发没有收益。键 = `(路径, 版本)`——正文没变答案就不会变；
 * 有界（只留最近 {@link ASSERTION_CACHE_LIMIT} 份），换文件不会无限长。
 */
const ASSERTION_CACHE_LIMIT = 32;
const assertionCache = new Map<string, readonly DialectAssertion[]>();

function cachedAssertions(
  path: string | null | undefined,
  version: number | null | undefined,
  source: string,
): readonly DialectAssertion[] {
  if (typeof path !== 'string' || path.length === 0 || typeof version !== 'number') {
    return readDialectAssertions(source);
  }
  const key = `${pathKey(path)}\u0000${version}`;
  const hit = assertionCache.get(key);
  if (hit !== undefined) return hit;
  const value = readDialectAssertions(source);
  if (assertionCache.size >= ASSERTION_CACHE_LIMIT) {
    const oldest = assertionCache.keys().next();
    if (!oldest.done) assertionCache.delete(oldest.value);
  }
  assertionCache.set(key, value);
  return value;
}

/** 路径归一：反斜杠 → 正斜杠，剥尾部斜杠（大小写不动） */
function slash(path: string): string {
  const normalized = path.replaceAll('\\', '/');
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
}

/**
 * 把绝对路径换算成**相对工程根**的 posix 路径（`carriers[].glob` 的口径）。
 * 不在工程根下 / 没有根 ⇒ `null`（不做归属，`binding.carrier = null`）。
 * 前缀比较折叠大小写（Windows 盘符与目录名不保证同一写法），归一仍走 `pathKey` 之外的
 * 逐字符比较——`pathKey` 会额外折叠别的差异，这里只需要"同一棵树"。
 */
function relativeToProjectRoot(
  rootDir: string | null | undefined,
  filePath: string | null | undefined,
): string | null {
  if (typeof rootDir !== 'string' || rootDir.length === 0) return null;
  if (typeof filePath !== 'string' || filePath.length === 0) return null;
  const root = slash(rootDir);
  const file = slash(filePath);
  if (file.length <= root.length) return null;
  if (file.slice(0, root.length).toLowerCase() !== root.toLowerCase()) return null;
  if (file[root.length] !== '/') return null;
  return file.slice(root.length + 1);
}

/**
 * 解析一份文档的方言绑定（`resolveDialectBinding` 的宿主入口）。
 *
 * 判定顺序与诊断码逐字由 core 决定（覆盖 > 识别链；断言只自证；无 id / 无事实 ⇒
 * `core/dialect/unbound`；错事实 ⇒ `core/dialect/response-mismatch`）。本函数只负责
 * 把四类输入凑齐，并给 `filePath` 换算成相对工程根。
 */
export function resolveDocumentDialect(
  input: ResolveDocumentDialectInput,
): DialectBindingResolution {
  const project = input.project;
  const source = typeof input.source === 'string' ? input.source : '';
  const assertions = cachedAssertions(input.filePath, input.version, source);
  const rootDir = project?.rootDir ?? null;
  const override =
    input.workspaceOverride !== undefined
      ? input.workspaceOverride
      : workspaceDialectOverride(rootDir);
  return resolveDialectBinding({
    detectedDialect: project?.adapterId ?? null,
    workspaceOverride: override,
    fileAssertion: assertions[0]?.dialect ?? null,
    fileAssertions: assertions.map((entry) => entry.dialect),
    factsFor: input.factsFor ?? dialectFactsFor,
    filePath: relativeToProjectRoot(rootDir, input.filePath),
  });
}

/* ============================== 4. 结果投影 ============================== */

/**
 * 解析结果 → `EditorDocumentIdentity.dialect?` 那一格（additive；`null` = 未绑定，键都不出现）。
 *
 * 只做投影：`dialect` / `factsVersion` / `carrier` 全部来自 core 的绑定，**不另算**。
 * `binding === null`（未绑定 / 响应错配）⇒ `null`：供方按"无事实"降级，绝不回落到默认方言。
 */
export function dialectContextOf(resolution: DialectBindingResolution): DialectContext | null {
  const binding = resolution.binding;
  if (binding === null) return null;
  return Object.freeze({
    dialect: binding.dialect,
    factsVersion: binding.factsVersion,
    carrier: binding.carrier ?? null,
  });
}

/** 状态栏一格的读数 */
export interface DialectStatus {
  /** 主文案（中文前缀 + id / 未绑定）；id 必须原样出现，方便作者与评审对上号 */
  readonly label: string;
  /** 悬停说明（含事实版本与冲突原因，不把诊断藏起来） */
  readonly title: string;
  readonly tone: 'bound' | 'mismatch' | 'unbound';
}

function diagnosticsTitle(diagnostics: readonly KojoDiagnostic[]): string {
  return diagnostics.map((diagnostic) => diagnostic.message).join('\n');
}

/**
 * 项目级方言读数（状态栏那一格）：**不读文件断言**——状态栏答"这个工程绑到哪个方言"，
 * 文件断言只影响那一份文件的诊断（断言与解析不一致时由 `core/dialect/mismatch` 说话）。
 *
 * `project === null` / 识别链与覆盖都没有 ⇒ 未绑定；有 id 但没有 2.0 事实面也 ⇒ 未绑定
 * （state bar 不替它编一个方言名）。覆盖与识别链不一致 ⇒ `kind` 是 `mismatch`，
 * 文案仍按覆盖给 id（core 的"以覆盖为准"）。
 */
export function dialectStatusForProject(project: DialectProjectLike | null): DialectStatus {
  const resolution = resolveDocumentDialect({ project });
  const binding = resolution.binding;
  if (binding === null) {
    const detail = diagnosticsTitle(resolution.diagnostics);
    return {
      label: '方言 未绑定',
      title: detail.length > 0 ? detail : '未绑定方言：事实类服务按无事实降级（不回落到任何默认方言）。',
      tone: 'unbound',
    };
  }
  const conflicts = resolution.diagnostics.filter(
    (diagnostic) => diagnostic.code === 'core/dialect/mismatch',
  );
  if (conflicts.length > 0) {
    return {
      label: `方言 ${binding.dialect}（冲突）`,
      title: [diagnosticsTitle(conflicts), `事实版本 ${binding.factsVersion}`].join('\n'),
      tone: 'mismatch',
    };
  }
  return {
    label: `方言 ${binding.dialect}`,
    title: `当前工程绑定的方言：${binding.dialect}（事实版本 ${binding.factsVersion}）`,
    tone: 'bound',
  };
}
