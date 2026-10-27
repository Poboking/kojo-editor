import { shortPath } from '@kojo/plugin-api';
import type { SearchMatch, SearchProgress, SearchResult } from '../bridge/search';
import type { ReplaceOutcome } from './search-store';
import { quickOpenSourceExtensions } from './commands';

/**
 * 全文检索面板的**纯逻辑**（无 React、无 IPC）：扩展名过滤的双向换算、命中行预览切分、
 * 结果摘要与扁平化。抽出来的理由与 `problem-store.ts` / `notice-queue.ts` 同一做法——
 * 这是数据判据，不是渲染细节；只有独立成模块才钉得住（渲染层在 node 环境跑不了）。
 */

/**
 * 默认检索的**契约源侧**扩展名：从 `quickOpenSourceExtensions()` 派生——那正是
 * `Ctrl+P` 与项目扫描用的同一份来源（`ERB_DIALECT_EXTENSIONS + KOJO_V1_SOURCE_EXTENSIONS`
 * + 开关放行时的 2.0 追加项）。
 *
 * **为什么不手写清单**（WS-10 默认真相面批）：从前这里抄了一份
 * `erb, erh, erd, kojo, txt, csv, als`——`.erm` 与 `.kojo1` 漏在门外、尚未接线的
 * `.erd` 却混了进来，于是出现「`Ctrl+P` 找得到、全文搜索搜不到」的分叉。
 * 同一族文件的两份清单必然漂移（本仓反复记的「双真源必然漂移」形状，这里是第三条腿）。
 * 派生 ⇒ 分叉在结构上不可能；漂移判据由 `search-query.test.ts` 的
 * 「搜索默认面与 Ctrl+P 同源」用例钉住（谁再手写一份就红）。
 */
function stripLeadingDot(ext: string): string {
  return ext.toLowerCase().replace(/^\.+/, '');
}

/**
 * 契约之外的**通用文本族**（一处显式清单，可覆盖）：表格/纯文本不在方言契约里，
 * 但口上作者确实要搜它们。这是本文件唯一允许存在的字面量清单。
 */
export const SEARCH_EXTRA_EXTENSIONS: readonly string[] = ['txt', 'csv', 'als'];

/** 派生 + 追加 = 搜索默认面（每次现算，与 `quickOpenSourceExtensions()` 逐字同步） */
export function defaultSearchExtensions(): string[] {
  return [...quickOpenSourceExtensions().map(stripLeadingDot), ...SEARCH_EXTRA_EXTENSIONS];
}

/**
 * 默认检索扩展名（模块加载时按当前开关算一次的快照；要**现算**的口径请调
 * `defaultSearchExtensions()`）。导出名保留是为了既有消费方（面板指纹、语料测试）零改动。
 */
export const DEFAULT_SEARCH_EXTENSIONS: readonly string[] = defaultSearchExtensions();

/** 过滤框的初始文本（与 `DEFAULT_SEARCH_EXTENSIONS` 同源，不各写一份） */
export const DEFAULT_EXTENSION_TEXT = DEFAULT_SEARCH_EXTENSIONS.join(', ');

/**
 * 过滤框文本 → 扩展名列表：逗号（半/全角）、分号、空白都当分隔符；
 * 去前导点、转小写、去重、排序（排序让"同一份输入"恒产出同一个请求，判据可钉）。
 */
export function parseExtensions(text: string): string[] {
  const seen = new Set<string>();
  for (const raw of text.split(/[,，;；\s]+/)) {
    const ext = raw.trim().toLowerCase().replace(/^\.+/, '');
    if (ext !== '') seen.add(ext);
  }
  return [...seen].sort();
}

/** 列表 → 过滤框文本（回填用；与 `parseExtensions` 往返一致） */
export function formatExtensions(list: readonly string[]): string {
  return list.join(', ');
}

/* ------------------------------ 排除模式（WS-10） ------------------------------ */

/**
 * 「排除」框文本 → gitignore-lite 模式清单（**纯函数**，顺序敏感）。
 *
 * 分隔符与「类型」/glob 框同款（逗号半/全角、分号、空白）——两个框的打字习惯不该有两套。
 * 但与 glob 框刻意不同的一点：**不排序、原样保序**。gitignore-lite 语义是
 * "后写的规则赢"（`!` 取反就靠这个），排序会改写规则先后 = 改写语义。
 * 同一份输入恒产出同一份请求，判据仍然钉得住。
 *
 * 规则（与 Rust 侧 `compile_exclude_rules` 逐字对齐，跨语言对拍用例见 cargo 测试）：
 * - `**` 跨目录、`*`/`?` 不跨目录；
 * - 不含 `/` 的模式按**文件名**匹配任意深度（`*.tmp` 挡 `a/b/c.tmp`）；
 * - 前导 `/` 剥掉（钉在检索根上的相对写法）；反斜杠归一成 `/`；
 * - 前导 `!` = 取反（把先前挡下的放回来）；
 * - **大小写敏感**（与 include glob 同口径：显式路径模式显式匹配）。
 */
export function parseExcludePatterns(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/[,，;；\s]+/)) {
    const token = raw.trim().replace(/\\/g, '/');
    if (token === '' || token === '!') continue;
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

/* ------------------------------ 「在此文件夹中搜索」的范围标签 ------------------------------ */

/**
 * 目录路径 → 范围标签（**纯函数**）：取末段目录名；盘符根 / 单段路径原样返回。
 * 面板上「范围：<label>」只显示这一小截，全路径进悬停。宿主不理解路径的领域含义，
 * 只做字形切割。
 */
export function folderScopeLabel(dir: string): string {
  const trimmed = dir.replace(/[\\/]+$/, '');
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (cut < 0) return trimmed;
  const last = trimmed.slice(cut + 1);
  return last === '' ? trimmed : last;
}

/**
 * glob 文件过滤（P2-15 体验差距批）：**扩展名过滤管不了的那一半**。
 *
 * `parseExtensions` 的口径是"第几段后缀"，作者真正想问的却常常是按位置的形态：
 * 「`src` 下的 erb」「任意深度的 `*.kojo`」「`**`/`x/*.erb`」。这些写不成扩展名，
 * 于是只能全项目搜完在结果里人肉找——面板因此补一个 glob 框。
 * （注释里 `**` 与 `/` 刻意分写：块注释中 `*` 紧跟 `/` 会提前终止注释）
 *
 * ## 分隔符与 `parseExtensions` 同款
 * 逗号（半/全角）、分号、空白一律当分隔符：两个框的打字习惯不该有两套。
 *
 * ## glob 与扩展名是**且**的关系（两者都满足才扫）
 * 扩展名管"什么类型的文件"、glob 管"什么位置的路径"，是两个独立维度；
 * 写成"或"会让「类型=erb + glob=*.kojo」这种自相矛盾的条件悄悄扫全项目。
 * 后端（Rust `collect_files`）按且实现，前端只负责把两类词分开喂过去。
 *
 * ## 为什么不并入 `parseExtensions`
 * 老函数的签名与行为被既有测试钉死（`search-query.test.ts` 零改动通过），
 * 且它的产物语义是"后缀清单"；glob 的产物语义是"路径模式"，混在一个返回值里
 * 两边都得先分辨自己拿到的是哪一种。故新开一个函数，产出 `{ extensions, globs }`。
 */
export interface FileFilterParts {
  /** 扩展名（小写、不含点；与 `parseExtensions` 逐字同口径） */
  readonly extensions: string[];
  /** glob 形态（原样保留大小写：glob 是**路径模式**，不是后缀词表） */
  readonly globs: string[];
}

/** 一个词算 glob 形态当且仅当含通配符或路径分隔符（`*` `?` `/` `\`） */
function isGlobToken(token: string): boolean {
  return /[*?/\\]/.test(token);
}

/**
 * 过滤框文本 → `{ extensions, globs }`（**纯函数**）：两类词分开、各自归一。
 *
 * - 扩展名段：去前导点、转小写、去重、排序（与 `parseExtensions` 逐字同口径）；
 * - glob 段：反斜杠归一成 `/`（Windows 写法与 glob 惯例统一）、去重、排序
 *   （同一份输入恒产出同一个请求，判据可钉）；**不折小写**——大小写敏感的
 *   理由见 Rust 侧 `glob_to_regex` 的注释（显式路径模式显式匹配）。
 */
export function parseFileFilter(text: string): FileFilterParts {
  const exts = new Set<string>();
  const globs = new Set<string>();
  for (const raw of text.split(/[,，;；\s]+/)) {
    const token = raw.trim();
    if (token === '') continue;
    if (isGlobToken(token)) globs.add(token.replace(/\\/g, '/'));
    else exts.add(token.toLowerCase().replace(/^\.+/, ''));
  }
  return { extensions: [...exts].sort(), globs: [...globs].sort() };
}

/* ------------------------------ glob 过滤框的当前文本 ------------------------------ */

/**
 * glob 过滤框的当前文本（**模块级**，与 `extensionText` 住 `search-store` 同理由：
 * 侧栏切走会卸载面板，过滤条件必须活得比面板久）。
 *
 * 这是 `search-store.runSearch` 发请求时读的**唯一真源**：请求装配时
 * `parseFileFilter(getGlobFilterText()).globs` → `request.options.globs`
 * （**只在非空时带键**：空 globs 的请求体与接线前逐字一致）。
 * 本模块只持有文本与解析判据；请求怎么装配归 search-store。
 */
let globFilterText = '';

export function getGlobFilterText(): string {
  return globFilterText;
}

export function setGlobFilterText(text: string): void {
  globFilterText = text;
}

/* ------------------------------ 替换偏好：保留大小写 ------------------------------ */

/**
 * 「替换时保留大小写」偏好（P2-15）：零 React 纯逻辑，可单测。
 * 存法照 `format-pref.ts` 先例——localStorage + 面板里一个开关，**不新造第二套偏好机制**。
 *
 * ## 默认**开**（与常见编辑器一致）
 * VSCode / JetBrains 的替换保留大小写默认都是开的：作者写全小写替换词、
 * 命中处是全大写时，没有这个开关就会把 `CALL FOO` 改成 `CALL bar`——脚本域里
 * 大写常常是有含义的（常量、宏、另一个记号），悄悄改小写比不改更糟。
 * 本仓「新功能默认关」的既定口径在这里让位给领域理由，且这个开关**看得见、关得掉**
 * （`SearchFilterBar` 里的「保留大小写」），不存在"悄悄改了我的文本"。
 *
 * ## 真源只有一份：localStorage，替换动作每次现读
 * 与 `format-pref.ts` 同一条读取路径：开关只写值 + 持有渲染用的镜像，
 * 执行器（`search-replace-exec.ts`）在每次替换动作前现读一次。于是"刚翻的开关"与
 * "执行器闭包里的旧值"不可能不一致。
 */
const CASE_PRESERVE_PREF_KEY = 'kojo.ui.search.preserveReplaceCase.v1';

/** 缺省 = 开（见模块头「默认开」的领域理由） */
export const CASE_PRESERVE_DEFAULT = true;

/** localStorage 访问器（node 测试环境无 window；隐私模式可能抛错——都不该影响替换） */
function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** 读偏好（只有明确存过 `off` 才算关；读不到 / 抛错一律回默认，绝不抛到替换链路） */
export function loadCasePreservePref(): boolean {
  const s = storage();
  if (!s) return CASE_PRESERVE_DEFAULT;
  try {
    return s.getItem(CASE_PRESERVE_PREF_KEY) !== 'off';
  } catch {
    return CASE_PRESERVE_DEFAULT;
  }
}

/** 写偏好（写不进去不算错：只影响下次替换，不影响本次） */
export function saveCasePreservePref(on: boolean): void {
  const s = storage();
  if (!s) return;
  try {
    if (on) s.removeItem(CASE_PRESERVE_PREF_KEY);
    else s.setItem(CASE_PRESERVE_PREF_KEY, 'off');
  } catch {
    /* 隐私模式 / 配额满：静默降级为"本次会话按默认开" */
  }
}

/** 查询是否可发（全空白不发：发给后端只会拿一条"检索词为空"回来） */
export function isValidSearchQuery(query: string): boolean {
  return query.trim() !== '';
}

/* ------------------------------ 最近检索（W7-E） ------------------------------ */

/**
 * 「最近检索」保留的条数上限。
 *
 * 20 条的理由：检索框窄、历史是**翻**出来的不是列出来的，再多按 ↑ 也翻不动；
 * 20 ≈ 一次会话里真正会回头再用的查询数，同时把一条 localStorage 值压在几百字节。
 */
export const SEARCH_HISTORY_LIMIT = 20;

/**
 * 把一条查询并入历史（**纯函数**，存储编解码不在这里）：最新在前、去重、上限截断。
 *
 * - 全空白不入史（不是有效检索，`isValidSearchQuery` 同一判据）；
 * - 去重 = 同一条只留最新的位置（再搜一次旧词，它回到队首而不是多一条）；
 * - 已在队首且未越限 ⇒ **原引用返回**：调用方据此跳过写盘与多余的状态替换。
 */
export function pushSearchHistory(
  history: readonly string[],
  query: string,
  limit: number = SEARCH_HISTORY_LIMIT,
): readonly string[] {
  if (!isValidSearchQuery(query)) return history;
  if (limit <= 0) return [];
  if (history[0] === query && history.length <= limit) return history;
  return [query, ...history.filter((q) => q !== query)].slice(0, limit);
}

/**
 * 存储里的原始值 → 清洗后的历史（**纯函数**）：只认非空字符串、同一判据滤掉空白、
 * 去重保序、截到上限。手改坏的 JSON 元素（数字 / null / 对象）一律丢弃，
 * 不猜、不 stringify——历史是只读回放，坏一条不该废掉整份。
 */
export function normalizeSearchHistory(
  list: readonly unknown[],
  limit: number = SEARCH_HISTORY_LIMIT,
): string[] {
  const out: string[] = [];
  if (limit <= 0) return out;
  for (const item of list) {
    if (typeof item !== 'string' || !isValidSearchQuery(item)) continue;
    if (out.includes(item)) continue;
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

/** 短路径（口径真源 = `plugin-api/paths.shortPath`，与问题面板、四块插件面板同一条）：
 *  取末两段——检索结果面板窄，末两段是唯一的区分点。名字保留检索层的叫法，实现不再抄第二份。 */
export function shortSearchPath(path: string): string {
  return shortPath(path);
}

/**
 * 命中行预览 → 三段（命中前 / 命中 / 命中后）。
 * 偏移越界一律夹回串内：Rust 侧算得再准，也不该让一个坏载荷把界面炸掉。
 */
export function previewParts(m: SearchMatch): { head: string; hit: string; tail: string } {
  const len = m.preview.length;
  const start = Math.max(0, Math.min(m.start, len));
  const end = Math.max(start, Math.min(m.end, len));
  return {
    head: m.preview.slice(0, start),
    hit: m.preview.slice(start, end),
    tail: m.preview.slice(end),
  };
}

/** 结果行的位置标签（`行:列`，与问题面板的 `路径:行` 同族但更细一档） */
export function matchLocationLabel(m: SearchMatch): string {
  return `${m.line}:${m.column}`;
}

/**
 * 扁平行与虚拟列表几何搬到了**叶子模块** `search-rows.ts`（PERF 搜索批）：
 * 本文件在开机图里（`search-store` 静态引它），而那份几何只有懒加载的检索面板用得上。
 * 这里只留一条 **type** 再导出，既有调用方的 import 路径不用改，也不给开机图添边。
 */
export type { SearchRow } from './search-rows';

/**
 * 结果摘要（停止态与完成态分开说——"停下来的结果"不该看起来像"搜完了"）。
 *
 * 260px 侧栏里一行只放得下三个读数（视觉批十四实测：完整句会折成两行，连同两条边角
 * 说明一共四行 11px 的墙）⇒ 上屏用**紧凑档**，完整句（含扫描文件数）走

 * `searchSummaryDetail` 挂悬停。
 */
export function searchSummaryText(r: SearchResult): string {
  const prefix = r.cancelled ? '已停止：' : '';
  const seconds = (r.elapsedMs / 1000).toFixed(1);
  return `${prefix}${r.totalMatches} 条 · ${r.files.length} 文件 · ${seconds}s`;
}

/** 摘要的完整句（悬停详情）：扫描面那一段只在 tooltip 里出现 */
export function searchSummaryDetail(r: SearchResult): string {
  const prefix = r.cancelled ? '已停止：' : '';
  const seconds = (r.elapsedMs / 1000).toFixed(1);
  return `${prefix}${r.totalMatches} 条结果 · ${r.files.length} 个文件 · 扫描 ${r.filesScanned} 个文件 · ${seconds}s`;
}

/**
 * 结果里的「第 X 项 / 共 Y 项」（与 VSCode 查找控件的 `{0} of {1}` 同语义）。
 *
 * `cursor` 是 0 基游标，`-1` = 还没导航——此时把第 1 项当作**下一站**上屏：
 * 面板出结果时不自动跳第一处（全项目检索不抢编辑器焦点），但作者按回车就该知道
 * 会落在哪里；这与行导航"焦点不在列表时 ↓ 进第一行"是同一把尺子。
 * 越界一律夹回总数：游标是显示量，坏载荷不许把读数撑出范围（同 `previewParts`）。
 */
export function searchMatchCounterText(cursor: number, total: number): string | null {
  if (!Number.isFinite(total) || total <= 0) return null;
  const count = Math.max(1, Math.trunc(total));
  const index = Number.isFinite(cursor) ? Math.max(0, Math.trunc(cursor)) : 0;
  return `第 ${Math.min(index + 1, count)} 项 / 共 ${count} 项`;
}

/** 需要显式说明的边角（截断 / 各类跳过）；无则 null */
export function searchNoticeText(r: SearchResult): string | null {
  const notes: string[] = [];
  if (r.truncated) notes.push('结果已达上限，未列全');
  if (r.skipped.binary > 0) notes.push(`跳过 ${r.skipped.binary} 个二进制文件`);
  if (r.skipped.tooLarge > 0) notes.push(`跳过 ${r.skipped.tooLarge} 个超大文件`);
  if (r.skipped.unreadable > 0) notes.push(`${r.skipped.unreadable} 个文件读取失败`);
  if (r.skipped.filtered > 0) notes.push(`${r.skipped.filtered} 个文件被类型过滤挡下`);
  // 排除模式挡下的条数（WS-10）：老载荷没这个键 ⇒ 按 0 处理，不装出一条读数
  const excluded = r.skipped.excluded ?? 0;
  if (excluded > 0) notes.push(`${excluded} 个文件被排除模式挡下`);
  return notes.length > 0 ? notes.join(' · ') : null;
}

/** 检索中的进度文案（总数为 0 时只报已扫描数，不假装知道总量） */
export function searchProgressText(p: SearchProgress): string {
  return p.totalFiles > 0
    ? `检索中… 已扫描 ${p.filesScanned}/${p.totalFiles} 个文件 · 命中 ${p.matchCount}`
    : `检索中… 已扫描 ${p.filesScanned} 个文件 · 命中 ${p.matchCount}`;
}

/**
 * 替换汇总文案（R7 搜索替换批）。逐文件跳过的只读文件、文本已变化而跳过的命中、
 * 写失败的文件——每一类都要上屏（铁律 4：不静默），作者替换完第一眼就该知道
 * 「改了什么、有什么没改成」。
 */
export function replaceSummaryText(o: ReplaceOutcome): string {
  if (o.applied === 0 && o.stale === 0 && o.readOnlyFiles === 0 && o.errors.length === 0) {
    return '没有需要替换的命中（文本可能已是新值）';
  }
  const parts: string[] = [];
  if (o.applied > 0) {
    parts.push(o.filesChanged > 1 ? `已替换 ${o.applied} 处（${o.filesChanged} 个文件）` : `已替换 ${o.applied} 处`);
  }
  if (o.stale > 0) parts.push(`${o.stale} 处文本已变化，跳过`);
  if (o.readOnlyFiles > 0) parts.push(`${o.readOnlyFiles} 个文件只读未改`);
  if (o.errors.length > 0) parts.push(...o.errors.slice(0, 3));
  if (o.errors.length > 3) parts.push(`另有 ${o.errors.length - 3} 个文件写入失败`);
  return parts.join(' · ');
}
