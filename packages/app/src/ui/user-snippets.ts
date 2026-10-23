import { errorText } from '@kojo/plugin-api';

/**
 * 用户自定义代码片段（S10，对标 VS Code User Snippets）。
 *
 * ## 存在哪、为什么不可能写进游戏目录
 *
 * 片段落在 kernel 全局存储域：`{appDataDir}/store/_global/user-snippets-v1.json`。
 * 这是应用自己的**常驻可写根**（与工作区同一类落点），不受项目开闭 / 写授权周期影响；
 * 本模块的**唯一**入口是一个 `get/set` 存储端口，**不接受任何目标路径参数**——
 * 没有路径就没有"写到别处"的口子，铁律 5 / 6 在这里是结构性的，不是靠调用方自觉。
 *
 * ## 与 Monaco 的分工
 *
 * 本模块只管"存什么"（片段表 + 存储往返 + 校验），**零 Monaco 依赖**；
 * 片段正文原样保存（可含 `$1` / `${1:name}` / `${1|甲,乙|}` 等 tab-stop 语法），
 * 真正的占位符跳转由 Monaco 的 snippet 插入规则处理（见 `monaco/user-snippet-completion.ts`）。
 * 这里刻意**不**转义 / 不改写正文：片段语法是作者的原文，任何"顺手清洗"都会悄悄改掉作者写的 `$`。
 *
 * ## 不静默（铁律 4）
 *
 * - 盘上的 JSON 坏了（kernel `entry()` 报 corrupt）/ 结构不对 / 版本不认 ⇒
 *   `loadUserSnippets` 返回带 `error` 的结果（**片段为空 + 一句人话**），绝不假装"从没写过"；
 * - 单条不合法 / 前缀重复 ⇒ 跳过并计入 `error`（跳过几条、为什么，都写在那一句里）；
 * - 新增 / 修改时非法前缀、重名、空正文 ⇒ 抛 `UserSnippetError`（带 `problem` 判别码），
 *   调用方必须上屏；写盘前同样复验，坏数据进不了盘。
 *
 * 有 `error` 时 `createUserSnippetStore` 的写操作一律拒绝（fail-closed）：从空列表起写会把
 * 盘上那份坏文件悄悄覆盖掉。作者修好或删掉文件后重开编辑器即可恢复；要显式重来，
 * 调 `saveUserSnippets(kv, [])` 覆盖（那一笔是作者动作，不是本模块的兜底）。
 */

/** 全局存储键（落点：`{appDataDir}/store/_global/user-snippets-v1.json`） */
export const USER_SNIPPETS_KEY = 'user-snippets-v1';

/** 本版支持的语言分组（与 Monaco 语言 id 逐字相等） */
export const USER_SNIPPET_LANGUAGES = ['erb', 'kojo2'] as const;

export type UserSnippetLanguage = (typeof USER_SNIPPET_LANGUAGES)[number];

/** 一条用户片段（存储形状 = 对外形状，零转换） */
export interface UserSnippet {
  readonly language: UserSnippetLanguage;
  /** 触发前缀：同语言内唯一（大小写不敏感判重） */
  readonly prefix: string;
  /** 显示名（候选的 detail） */
  readonly name: string;
  /** 片段正文：原样保存，`$1` / `${1:name}` 由 Monaco snippet 展开 */
  readonly body: string;
  /** 可选备注（候选 documentation 的第二行） */
  readonly description?: string;
}

/** 新增片段的入参：`language` 收宽成 string，校验后才收窄（避免调用方绕过类型检查） */
export interface UserSnippetInput {
  readonly language: string;
  readonly prefix: string;
  readonly name: string;
  readonly body: string;
  readonly description?: string;
}

/** 修改时的定位键（语言不可改：换语言 = 删一条 + 加一条，语义更清楚） */
export interface UserSnippetTarget {
  readonly language: string;
  readonly prefix: string;
}

/** 修改时可换的字段（未给 = 保留原值） */
export interface UserSnippetPatch {
  readonly prefix?: string;
  readonly name?: string;
  readonly body?: string;
  readonly description?: string;
}

/** 校验失败的判别码（调用方据此决定怎么上屏；`corrupt-store` 只来自写操作的前置读） */
export type UserSnippetProblem =
  | 'bad-shape'
  | 'invalid-language'
  | 'invalid-prefix'
  | 'empty-name'
  | 'empty-body'
  | 'duplicate-prefix'
  | 'not-found'
  | 'corrupt-store';

export class UserSnippetError extends Error {
  readonly problem: UserSnippetProblem;

  constructor(problem: UserSnippetProblem, message: string) {
    super(message);
    this.name = 'UserSnippetError';
    this.problem = problem;
  }
}

/** 读取结果：`error !== null` 时 `snippets` 仍可用（能救回多少给多少），但写操作被拒 */
export interface UserSnippetLoadResult {
  readonly snippets: readonly UserSnippet[];
  /** 盘上那份的可见问题（null = 一切正常） */
  readonly error: string | null;
}

/**
 * kernel `ScopedStorageImpl.entry()` 的同形端口（可选）。
 * 有它才分得清 `missing`（首启，合法的"从没写过"）与 `corrupt`（盘上站着一份坏 JSON）；
 * kernel 的 `get()` 把后者投影成 `undefined`，只有它会让"坏文件"看起来像首启。
 */
export type UserSnippetEntryState =
  | { readonly state: 'missing' }
  | { readonly state: 'corrupt'; readonly detail: string }
  | { readonly state: 'ok'; readonly value: unknown };

/**
 * 本模块需要的存储端口（`kernel.storage.global()` 结构上直接满足）。
 * 语义照 kernel：`get` 缺键 = `undefined`；读不动则抛错（读不动 ≠ 不存在）。
 */
export interface UserSnippetKv {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  /** 可选：显式三态读（kernel 有；测试替身可省略） */
  entry?(key: string): Promise<UserSnippetEntryState>;
}

/** 盘上文档的版本（结构一旦改变就抬版本，旧版直接报"不受支持"，不猜） */
const DOC_VERSION = 1;

/** 前缀允许的字符：中文 / 字母 / 数字 / 下划线 / 点 / 连字符；必须以文字、数字或下划线开头 */
const PREFIX_RE = /^[\p{L}\p{N}_][\p{L}\p{N}_.-]*$/u;

/** 判重键：同语言 + 前缀折叠大小写（`FOO` 与 `foo` 在作者眼里是同一个前缀） */
function prefixKey(language: string, prefix: string): string {
  return `${language}\u0000${prefix.toLowerCase()}`;
}

function describeValue(raw: unknown): string {
  if (raw === null) return 'null';
  if (Array.isArray(raw)) return '数组';
  return typeof raw;
}

/**
 * 校验并归一（trim 前缀 / 名字 / 备注；正文**原样**保留）。
 * 任何不合法都抛 `UserSnippetError`——绝不"修一修就算了"。
 */
export function normalizeUserSnippet(input: UserSnippetInput): UserSnippet {
  if (!(USER_SNIPPET_LANGUAGES as readonly string[]).includes(input.language)) {
    throw new UserSnippetError(
      'invalid-language',
      `片段语言只能是 ${USER_SNIPPET_LANGUAGES.join(' / ')}：「${input.language}」不是其中之一。`,
    );
  }
  const prefix = input.prefix.trim();
  if (!PREFIX_RE.test(prefix)) {
    throw new UserSnippetError(
      'invalid-prefix',
      `片段前缀不能用空串或带空格，只能用中文、字母、数字、下划线、点或连字符，且必须以文字、数字或下划线开头：「${input.prefix}」。`,
    );
  }
  const name = input.name.trim();
  if (name === '') {
    throw new UserSnippetError('empty-name', '片段名字不能为空（候选里要显示它）。');
  }
  if (input.body.trim() === '') {
    throw new UserSnippetError('empty-body', `片段「${prefix}」的正文不能为空。`);
  }
  const description = input.description?.trim();
  return {
    language: input.language as UserSnippetLanguage,
    prefix,
    name,
    body: input.body,
    ...(description !== undefined && description !== '' ? { description } : {}),
  };
}

/** 盘上的单条 → 入参（字段缺失 / 类型不对抛 `bad-shape`，不猜默认值） */
function inputOfStored(raw: unknown): UserSnippetInput {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new UserSnippetError('bad-shape', `条目应是对象，实际是 ${describeValue(raw)}`);
  }
  const r = raw as Record<string, unknown>;
  if (
    typeof r.language !== 'string' ||
    typeof r.prefix !== 'string' ||
    typeof r.name !== 'string' ||
    typeof r.body !== 'string'
  ) {
    throw new UserSnippetError('bad-shape', '条目缺少 language / prefix / name / body 字符串字段');
  }
  if (r.description !== undefined && typeof r.description !== 'string') {
    throw new UserSnippetError('bad-shape', '条目的 description 不是字符串');
  }
  return {
    language: r.language,
    prefix: r.prefix,
    name: r.name,
    body: r.body,
    ...(typeof r.description === 'string' ? { description: r.description } : {}),
  };
}

/**
 * 解析盘上的值：能救的条目保留，救不了的跳过并**合并成一句可见的 error**。
 * 单条坏不连累整份文件（作者可能只是手改错了一行）；`v` 不对 / 不是对象才整份拒绝。
 */
export function parseUserSnippetDocument(raw: unknown): UserSnippetLoadResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {
      snippets: [],
      error: `用户代码片段文件的结构不对：期望 { v: ${DOC_VERSION}, snippets: [...] }，实际是 ${describeValue(raw)}。`,
    };
  }
  const doc = raw as { v?: unknown; snippets?: unknown };
  if (doc.v !== DOC_VERSION) {
    return {
      snippets: [],
      error: `用户代码片段文件的版本不受支持（读到 v=${String(doc.v)}，本版只认 v=${DOC_VERSION}）。`,
    };
  }
  if (!Array.isArray(doc.snippets)) {
    return {
      snippets: [],
      error: `用户代码片段文件的 snippets 不是数组（实际是 ${describeValue(doc.snippets)}）。`,
    };
  }
  const snippets: UserSnippet[] = [];
  const seen = new Set<string>();
  const skipped: string[] = [];
  let skippedCount = 0;
  doc.snippets.forEach((item, index) => {
    try {
      const snippet = normalizeUserSnippet(inputOfStored(item));
      const key = prefixKey(snippet.language, snippet.prefix);
      if (seen.has(key)) {
        skippedCount += 1;
        if (skipped.length < 3) skipped.push(`第 ${index + 1} 条：同语言里前缀「${snippet.prefix}」重复`);
        return;
      }
      seen.add(key);
      snippets.push(snippet);
    } catch (err: unknown) {
      skippedCount += 1;
      if (skipped.length < 3) skipped.push(`第 ${index + 1} 条：${errorText(err)}`);
    }
  });
  if (skippedCount === 0) return { snippets, error: null };
  const tail = skippedCount > skipped.length ? `…（共 ${skippedCount} 条）` : '';
  return { snippets, error: `跳过 ${skippedCount} 条不合法的片段：${skipped.join('；')}${tail}。` };
}

/** 读盘（坏 JSON / 读不动都变成可见 error，绝不静默成"空表"） */
export async function loadUserSnippets(kv: UserSnippetKv): Promise<UserSnippetLoadResult> {
  try {
    if (typeof kv.entry === 'function') {
      const state = await kv.entry(USER_SNIPPETS_KEY);
      if (state.state === 'missing') return { snippets: [], error: null };
      if (state.state === 'corrupt') {
        return {
          snippets: [],
          error: `用户代码片段文件损坏（${state.detail}）：这次没有加载任何片段；修好或删掉 ${USER_SNIPPETS_KEY} 后重开编辑器。`,
        };
      }
      return parseUserSnippetDocument(state.value);
    }
    const raw = await kv.get(USER_SNIPPETS_KEY);
    if (raw === undefined) return { snippets: [], error: null };
    return parseUserSnippetDocument(raw);
  } catch (err: unknown) {
    return { snippets: [], error: `用户代码片段读取失败：${errorText(err)}。` };
  }
}

/**
 * 写盘（先逐条复验 + 判重）：坏数据不落盘。
 * 存储键 / 落点由 kernel 存储域决定，本函数**不接收路径**。
 */
export async function saveUserSnippets(kv: UserSnippetKv, snippets: readonly UserSnippetInput[]): Promise<void> {
  const normalized: UserSnippet[] = [];
  const seen = new Set<string>();
  for (const item of snippets) {
    const snippet = normalizeUserSnippet(item);
    const key = prefixKey(snippet.language, snippet.prefix);
    if (seen.has(key)) {
      throw new UserSnippetError(
        'duplicate-prefix',
        `片段前缀「${snippet.prefix}」在「${snippet.language}」语言里出现了两次。`,
      );
    }
    seen.add(key);
    normalized.push(snippet);
  }
  await kv.set(USER_SNIPPETS_KEY, { v: DOC_VERSION, snippets: normalized });
}

function assertUniquePrefix(list: readonly UserSnippet[], snippet: UserSnippet, exceptIndex: number): void {
  const key = prefixKey(snippet.language, snippet.prefix);
  const hit = list.findIndex((s, i) => i !== exceptIndex && prefixKey(s.language, s.prefix) === key);
  if (hit >= 0) {
    throw new UserSnippetError(
      'duplicate-prefix',
      `「${snippet.language}」语言里已经有前缀「${snippet.prefix}」的片段：「${list[hit]!.name}」。`,
    );
  }
}

/** 新增一条（不改入参；重名抛错） */
export function addUserSnippet(list: readonly UserSnippet[], input: UserSnippetInput): readonly UserSnippet[] {
  const snippet = normalizeUserSnippet(input);
  assertUniquePrefix(list, snippet, -1);
  return [...list, snippet];
}

function indexOfSnippet(list: readonly UserSnippet[], target: UserSnippetTarget): number {
  const language = target.language;
  const prefix = target.prefix.trim().toLowerCase();
  return list.findIndex((s) => s.language === language && s.prefix.toLowerCase() === prefix);
}

/** 改一条（定位命中后整条复验；找不到 / 改出重名都抛错） */
export function updateUserSnippet(
  list: readonly UserSnippet[],
  target: UserSnippetTarget,
  patch: UserSnippetPatch,
): readonly UserSnippet[] {
  const index = indexOfSnippet(list, target);
  if (index < 0) {
    throw new UserSnippetError(
      'not-found',
      `找不到「${target.language}」语言里前缀「${target.prefix}」的片段。`,
    );
  }
  const current = list[index]!;
  const next = normalizeUserSnippet({
    language: current.language,
    prefix: patch.prefix ?? current.prefix,
    name: patch.name ?? current.name,
    body: patch.body ?? current.body,
    description: patch.description ?? current.description,
  });
  assertUniquePrefix(list, next, index);
  return list.map((s, i) => (i === index ? next : s));
}

/** 删一条（找不到抛错，让调用方知道这条点击没生效） */
export function removeUserSnippet(list: readonly UserSnippet[], target: UserSnippetTarget): readonly UserSnippet[] {
  const index = indexOfSnippet(list, target);
  if (index < 0) {
    throw new UserSnippetError(
      'not-found',
      `找不到「${target.language}」语言里前缀「${target.prefix}」的片段。`,
    );
  }
  return list.filter((_, i) => i !== index);
}

/** 按语言过滤（未知语言 id = 空表，不猜语言别名） */
export function snippetsForLanguage(list: readonly UserSnippet[], languageId: string): readonly UserSnippet[] {
  return list.filter((s) => s.language === languageId);
}

/** 带持久化的 CRUD 门面（每次操作都从盘上现读 → 改 → 写回；不缓存第二份真源） */
export interface UserSnippetStore {
  /** 读盘（坏文件也返回结果，不抛） */
  load(): Promise<UserSnippetLoadResult>;
  add(input: UserSnippetInput): Promise<readonly UserSnippet[]>;
  update(target: UserSnippetTarget, patch: UserSnippetPatch): Promise<readonly UserSnippet[]>;
  remove(target: UserSnippetTarget): Promise<readonly UserSnippet[]>;
}

export function createUserSnippetStore(kv: UserSnippetKv): UserSnippetStore {
  const current = async (): Promise<readonly UserSnippet[]> => {
    const result = await loadUserSnippets(kv);
    if (result.error !== null) {
      // fail-closed：从空表起写会把盘上那份坏文件悄悄覆盖掉（没读到 ≠ 没写过）
      throw new UserSnippetError('corrupt-store', `${result.error}（修好或删掉后重开编辑器再改片段。）`);
    }
    return result.snippets;
  };

  return {
    load: () => loadUserSnippets(kv),
    async add(input) {
      const next = addUserSnippet(await current(), input);
      await saveUserSnippets(kv, next);
      return next;
    },
    async update(target, patch) {
      const next = updateUserSnippet(await current(), target, patch);
      await saveUserSnippets(kv, next);
      return next;
    },
    async remove(target) {
      const next = removeUserSnippet(await current(), target);
      await saveUserSnippets(kv, next);
      return next;
    },
  };
}
