/**
 * 注释里的可点击链接（批次十 S12）：ERB / kojo2 注释中的 URL 与相对路径 → Monaco DocumentLink。
 *
 * ## 边界（为什么这样切）
 *
 * - **只认注释**：行注释只认**行首**（首个非空白字符）的注释起头，且**逐语言各一套**
 *   （{@link LinkLanguage}）：
 *   - ERB：`;`（Emuera 唯一的行注释；`#` 是预处理指令 `#DIM` / `#FUNCTION`，**不是注释**）；
 *   - kojo2：整行 `//`（§4.13；`#` 是声明锚，`;` 只允许出现在 `@原生` 里）。
 *   旧口径把 `#` / `;` / `//` 一律当注释起头（三语并集）⇒ `.kojo2` 的声明行
 *   `# 常量 图 字符串 = "data/立绘.csv"` 会在字符串上长出可点链接。
 *   块注释 `/* … *\/` 两门语言都照旧识别（既有行为，本批不动），扫描会跳过引号内文本。
 * - **URL 只认 http(s)**：`DocumentLink.url` 直接交给 Monaco 的 opener（新窗口打开），
 *   不走宿主外链白名单之外的自造通道；其余 `foo://` 一律不当 URL。
 * - **相对路径必须命中磁盘**：按「model 所在目录」→「项目根」两处解析，探针由宿主注入且
 *   **只读**（只有 `existsPath`，没有写盘入口）。没有命中的候选不产出链接——宁可不标，
 *   也不给作者一个点开才发现不存在的假链接。
 * - **点击复用既有定位命令**：`command:` 链接指向 `kojo-code-lens.ts` 的 `CODE_LENS_COMMAND`
 *   （内部落 `editor.revealLocation`，与转到定义同一条开文件/定位通道），不新造第二套跳转。
 *
 * ## 识别口径
 *
 * 路径候选支持正斜杠 / 反斜杠 / 中文文件名 / 空格（有目录分隔符时裸写也能吃到空格；
 * 纯文件名带空格用引号、反引号或 `「」` / `『』` 包住）。候选是否成链最终由存在性探针裁决，
 * 所以 `example.com`、`v1.2.3`、`50/100` 这类注释噪音即使被词法扫到，也不会出现在链接里。
 */

import type * as Monaco from './entry';
import { ERB_LANGUAGE_ID } from './erb-language';
import { CODE_LENS_COMMAND } from './kojo-code-lens';
import { KOJO2_LANGUAGE_ID } from '@kojo/kojo-lang/constants';

/** 注释文本中的一段链接候选（offsets 为整篇文本下标，end 不含） */
export interface LinkCandidate {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly kind: 'url' | 'path';
}

/** 相对路径解析所需的两个根（都可为空；为空的那一路直接跳过） */
export interface DocumentLinkContext {
  readonly modelPath?: string | null;
  readonly projectRoot?: string | null;
}

/** 只读存在性探针：宿主拿内核 io 的 stat / 报告包一层；**禁止**在这里写盘 */
export type PathExistsProbe = (path: string) => boolean | Promise<boolean>;

/** 链接落地所需的文件定位（行号缺省 1，链接只负责把文件打开） */
export interface DocumentLinkTarget {
  readonly filePath: string;
  readonly line?: number;
  readonly column?: number;
}

/**
 * 点击落点复用的**既有**定位命令 id。
 *
 * 这里不新注册命令：`installDocumentLinks` 只提供供给器，点击经 Monaco 的 command opener
 * 调起 `kojo-code-lens.ts` 那条已注册的 `CODE_LENS_COMMAND`（其内部走 `editor.revealLocation`）。
 * 接线层若要换通道，可通过 {@link DocumentLinksHost.openCommandId} 覆盖。
 */
export const DOCUMENT_LINK_OPEN_COMMAND = CODE_LENS_COMMAND;

/** 宿主接线面（组长在 `editor-global-providers.ts` 装配，本模块不碰注册面） */
export interface DocumentLinksHost {
  /** 只读存在性探测；抛错按「不存在」处理，绝不让编辑器呈现链崩溃 */
  readonly existsPath: PathExistsProbe;
  /** 当前项目根（可空；语料未开时相对路径只剩 model 目录这一路） */
  readonly projectRoot?: () => string | null | undefined;
  /** model → 磁盘路径；缺省读 `model.uri.fsPath`，非 file scheme 直接不产出链接 */
  readonly filePathOf?: (model: Monaco.editor.ITextModel) => string | null | undefined;
  /** 覆盖点击命令 id（缺省 {@link DOCUMENT_LINK_OPEN_COMMAND}） */
  readonly openCommandId?: string;
}

interface TextSpan {
  readonly start: number;
  readonly end: number;
}

interface UrlSpan {
  readonly start: number;
  readonly end: number;
}

/** 路径探针命中结果：matchedLength 是原始候选里真正被确认的前缀长度（用于收窄下划线） */
export interface ResolvedPath {
  readonly path: string;
  readonly matchedLength: number;
}

const KNOWN_EXTENSIONS = new Set([
  'erb',
  'kojo',
  'kojo2',
  'txt',
  'md',
  'json',
  'csv',
  'ini',
  'xml',
  'html',
  'htm',
  'rb',
  'py',
  'js',
  'jsx',
  'ts',
  'tsx',
  'css',
  'scss',
  'yaml',
  'yml',
  'toml',
  'log',
  'dat',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
  'wav',
  'ogg',
  'mp3',
  'zip',
  'pdf',
  'docx',
  'xlsx',
  'sh',
  'bat',
  'ps1',
]);

const URL_RE = /https?:\/\/[^\s<>"'`「」『』，。；：！？、]+/gi;
const QUOTED_RE = /"([^"\r\n]*)"|'([^'\r\n]*)'|`([^`\r\n]*)`|「([^」\r\n]*)」|『([^』\r\n]*)』/g;
const BARE_PATH_RE =
  /(?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|[^\s\\/'"`「」『』，。；：！？、]+[\\/])[^'"`「」『』，。；：！？、]*?\.[A-Za-z0-9]{1,8}(?=$|[\s，。；：！？、,;!?:)）\]】」』》])/g;
const EXPLICIT_PATH_RE = /(?:[A-Za-z]:[\\/]|\.{1,2}[\\/])[^\s'"`「」『』，。；：！？、,;!?]+/g;
const PLAIN_FILE_RE = /[^\s\\/'"`「」『』，。；：！？、,;!?]+\.[A-Za-z0-9]{1,8}/g;

/**
 * 文档语言：链接识别按语言各给一套**行注释起头**（两门语言的注释语法不同，不能取并集）。
 *
 * - `'erb'`：`;` 行注释；`#` 是预处理指令（`#DIM` / `#FUNCTION` …），`//` 不是注释；
 * - `'kojo2'`：整行 `//` 注释；`#` 是声明锚（`# 常量 …`），`;` 只在 `@原生` 里。
 */
export type LinkLanguage = 'erb' | 'kojo2';

/** 行首注释起头判据（**逐语言**；位置 = 首个非空白字符的下标） */
function isLineCommentStart(text: string, index: number, language: LinkLanguage): boolean {
  const ch = text[index];
  if (language === 'kojo2') return ch === '/' && text[index + 1] === '/';
  return ch === ';';
}

/**
 * 扫出整篇文本里的注释区间（块注释可跨行；行注释只认行首、且按 {@link LinkLanguage} 分口径）。
 *
 * 状态机只有三件事：行首判注释、跳过引号、块注释吃到 `*\/`。引号串里的 `/*` 不算注释起点；
 * 未闭合的块注释一路吃到文末（与 Monarch 的"坏输入照常上色"同取向）。
 */
export function scanCommentSpans(text: string, language: LinkLanguage): TextSpan[] {
  const spans: TextSpan[] = [];
  const len = text.length;
  let i = 0;
  let atLineStart = true;
  while (i < len) {
    const ch = text[i]!;
    if (ch === '\n' || ch === '\r') {
      atLineStart = true;
      i++;
      continue;
    }
    if (atLineStart) {
      let j = i;
      while (j < len && (text[j] === ' ' || text[j] === '\t')) j++;
      if (j < len) {
        const end = lineEndOffset(text, j);
        if (isLineCommentStart(text, j, language)) {
          spans.push({ start: j, end });
          i = end;
          atLineStart = false;
          continue;
        }
      }
      atLineStart = false;
      i = j;
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = skipQuoted(text, i);
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      const end = close < 0 ? len : close;
      if (end > i + 2) spans.push({ start: i + 2, end });
      i = close < 0 ? len : close + 2;
      atLineStart = i > 0 && (text[i - 1] === '\n' || text[i - 1] === '\r');
      continue;
    }
    i++;
  }
  return spans;
}

function lineEndOffset(text: string, from: number): number {
  const nl = text.indexOf('\n', from);
  let end = nl < 0 ? text.length : nl;
  if (end > from && text[end - 1] === '\r') end--;
  return end;
}

function skipQuoted(text: string, start: number): number {
  const quote = text[start]!;
  const len = text.length;
  let i = start + 1;
  while (i < len) {
    const ch = text[i]!;
    if (ch === '\n' || ch === '\r') break;
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === quote) return i + 1;
    i++;
  }
  return i;
}

/**
 * 提取整篇文本里的 URL / 相对路径候选（只看注释区间；注释起头按 `language` 分口径）。
 *
 * 返回的 offsets 可直接喂给 `model.getPositionAt` 换 Monaco range；URL 候选永远优先于
 * 与它重叠的路径候选（`https://…/x.erb` 只出一个 URL 链接，不会被拆成路径）。
 */
export function extractLinkCandidates(text: string, language: LinkLanguage): LinkCandidate[] {
  const collected: LinkCandidate[] = [];
  for (const span of scanCommentSpans(text, language)) {
    let lineStart = span.start;
    while (lineStart < span.end) {
      const nl = text.indexOf('\n', lineStart);
      const lineEnd = nl < 0 || nl > span.end ? span.end : nl;
      if (lineEnd > lineStart) {
        collected.push(...extractLineCandidates(text.slice(lineStart, lineEnd), lineStart));
      }
      if (lineEnd >= span.end) break;
      lineStart = lineEnd + 1;
    }
  }
  return dedupeCandidates(collected);
}

function extractLineCandidates(line: string, offset: number): LinkCandidate[] {
  const found: LinkCandidate[] = [];
  const urls: UrlSpan[] = [];
  URL_RE.lastIndex = 0;
  for (let m = URL_RE.exec(line); m !== null; m = URL_RE.exec(line)) {
    const raw = m[0]!;
    const trimmed = trimUrlEnd(raw);
    if (!trimmed) continue;
    const start = m.index;
    const end = start + trimmed.length;
    urls.push({ start, end });
    found.push({ start: offset + start, end: offset + end, text: trimmed, kind: 'url' });
    if (m[0]!.length === 0) URL_RE.lastIndex++;
  }

  QUOTED_RE.lastIndex = 0;
  for (let m = QUOTED_RE.exec(line); m !== null; m = QUOTED_RE.exec(line)) {
    const inner = m[0]!.slice(1, -1);
    const leading = inner.length - inner.trimStart().length;
    const text = inner.trim();
    if (!text || !looksLikePathText(text)) continue;
    const start = m.index + 1 + leading;
    found.push({ start: offset + start, end: offset + start + text.length, text, kind: 'path' });
  }

  for (const re of [BARE_PATH_RE, EXPLICIT_PATH_RE]) {
    re.lastIndex = 0;
    for (let m = re.exec(line); m !== null; m = re.exec(line)) {
      const text = trimPathEnd(m[0]!);
      if (!text || !looksLikePathText(text)) continue;
      if (insideAny(m.index, m.index + text.length, urls)) continue;
      found.push({ start: offset + m.index, end: offset + m.index + text.length, text, kind: 'path' });
      if (m[0]!.length === 0) re.lastIndex++;
    }
  }

  PLAIN_FILE_RE.lastIndex = 0;
  for (let m = PLAIN_FILE_RE.exec(line); m !== null; m = PLAIN_FILE_RE.exec(line)) {
    const text = trimPathEnd(m[0]!);
    if (!text || !hasKnownExtension(text)) continue;
    const before = m.index === 0 ? '' : line[m.index - 1]!;
    if (before && !/[\s（(【\[「『]/.test(before)) continue;
    if (insideAny(m.index, m.index + text.length, urls)) continue;
    found.push({ start: offset + m.index, end: offset + m.index + text.length, text, kind: 'path' });
    if (m[0]!.length === 0) PLAIN_FILE_RE.lastIndex++;
  }

  return found;
}

function dedupeCandidates(candidates: LinkCandidate[]): LinkCandidate[] {
  const urls = candidates
    .filter((c) => c.kind === 'url')
    .sort((a, b) => a.start - b.start || b.end - a.end);
  const paths = candidates
    .filter((c) => c.kind === 'path')
    .sort((a, b) => a.start - b.start || b.end - a.end);
  const out: LinkCandidate[] = [...urls];
  for (const candidate of paths) {
    if (insideAny(candidate.start, candidate.end, urls)) continue;
    if (out.some((chosen) => overlaps(candidate, chosen))) continue;
    out.push(candidate);
  }
  return out.sort((a, b) => a.start - b.start);
}

function overlaps(a: LinkCandidate | UrlSpan, b: LinkCandidate | UrlSpan): boolean {
  return a.start < b.end && b.start < a.end;
}

function insideAny(start: number, end: number, spans: readonly UrlSpan[]): boolean {
  return spans.some((span) => start < span.end && span.start < end);
}

/** URL 末尾的句读不属于链接（成对的括号保留，孤立的右括号剥掉） */
function trimUrlEnd(raw: string): string {
  let end = raw.length;
  while (end > 0 && /[.,;:!?，。；：！？、…"'`]/.test(raw[end - 1]!)) end--;
  const pairs: ReadonlyArray<readonly [string, string]> = [
    ['(', ')'],
    ['[', ']'],
    ['{', '}'],
  ];
  let changed = true;
  while (changed && end > 0) {
    changed = false;
    const last = raw[end - 1]!;
    for (const [open, close] of pairs) {
      if (last === close && countChar(raw.slice(0, end), open) < countChar(raw.slice(0, end), close)) {
        end--;
        changed = true;
        break;
      }
    }
  }
  return raw.slice(0, end);
}

function countChar(text: string, ch: string): number {
  let count = 0;
  for (const item of text) if (item === ch) count++;
  return count;
}

function trimPathEnd(raw: string): string {
  let end = raw.length;
  while (end > 0 && /[\s.,;:!?，。；：！？、…"'`]/.test(raw[end - 1]!)) end--;
  return raw.slice(0, end);
}

function looksLikePathText(raw: string): boolean {
  const text = raw.trim();
  if (!text) return false;
  if (/^https?:\/\//i.test(text)) return false;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(text)) return false;
  if (/^mailto:/i.test(text)) return false;
  if (/[<>"`]/.test(text)) return false;
  if (isAbsolutePath(text)) return true;
  if (/[\\/]/.test(text)) return true;
  if (/^\.{1,2}(?:[\\/]|$)/.test(text)) return true;
  return hasKnownExtension(text);
}

function hasKnownExtension(raw: string): boolean {
  const text = raw.trim();
  const dot = text.lastIndexOf('.');
  if (dot <= 0 || dot === text.length - 1) return false;
  return KNOWN_EXTENSIONS.has(text.slice(dot + 1).toLowerCase());
}

/**
 * 相对路径 → 绝对候选（model 目录优先、项目根兜底；绝对路径原样归一化）。
 *
 * 两处根解析是**并列**的：口上作者既可能写相对当前文件的 `../COMMON.ERB`，也可能写
 * 相对项目根的 `common/COMMON.ERB`；哪个先命中由探针说了算。
 */
export function resolvePathCandidates(rawPath: string, context: DocumentLinkContext): string[] {
  const raw = rawPath.trim();
  if (!raw) return [];
  if (isAbsolutePath(raw)) return [normalizePath(raw)];
  const bases: string[] = [];
  if (context.modelPath) {
    const dir = dirname(context.modelPath);
    if (dir) bases.push(dir);
  }
  if (context.projectRoot) bases.push(context.projectRoot);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const base of bases) {
    const joined = joinPath(base, raw);
    if (!joined) continue;
    const key = pathKey(joined);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(joined);
  }
  return out;
}

/**
 * 候选路径的存在性裁决（只读）。
 *
 * 带空格的候选会从最长前缀开始逐段回退：`./data/我的 文件.ERB 参见` 里整段不存在时，
 * 截到 `./data/我的 文件.ERB` 再探——这样裸写空格路径与行尾说明文字可以共存。
 * 探针抛错一律按不存在处理（呈现面不把宿主 IO 故障扩散成编辑器崩溃）。
 */
export async function resolveExistingPath(
  rawPath: string,
  context: DocumentLinkContext,
  existsPath: PathExistsProbe,
): Promise<ResolvedPath | null> {
  for (const variant of pathVariants(rawPath)) {
    for (const candidate of resolvePathCandidates(variant, context)) {
      let hit = false;
      try {
        hit = await existsPath(candidate);
      } catch {
        hit = false;
      }
      if (hit) return { path: candidate, matchedLength: variant.length };
    }
  }
  return null;
}

function pathVariants(rawPath: string): string[] {
  const base = trimPathEnd(rawPath.trim());
  if (!base) return [];
  const out = [base];
  let current = base;
  while (true) {
    const space = Math.max(current.lastIndexOf(' '), current.lastIndexOf('\t'));
    if (space <= 0) break;
    const next = trimPathEnd(current.slice(0, space).trimEnd());
    if (!next || next === current) break;
    out.push(next);
    current = next;
  }
  return out;
}

/** 生成 Monaco command 链接（`command:<id>?<encodeURIComponent(JSON args)>`） */
export function documentLinkCommandUrl(
  target: DocumentLinkTarget,
  commandId: string = DOCUMENT_LINK_OPEN_COMMAND,
): string {
  const payload = {
    filePath: target.filePath,
    line: Number.isFinite(target.line) ? Math.max(1, Math.trunc(target.line!)) : 1,
    ...(Number.isFinite(target.column) ? { column: Math.max(1, Math.trunc(target.column!)) } : {}),
  };
  return `command:${commandId}?${encodeURIComponent(JSON.stringify([payload]))}`;
}

/**
 * 接线：为 ERB 与 kojo2 注册 DocumentLink 供给器。
 *
 * 宿主只提供「这篇 model 在哪、项目根在哪、这个路径存不存在、点击用哪条命令」；
 * 识别 / 解析 / 去噪全在本模块完成。
 */
export function installDocumentLinks(
  monaco: typeof Monaco,
  host: DocumentLinksHost,
): Monaco.IDisposable {
  const commandId = host.openCommandId ?? DOCUMENT_LINK_OPEN_COMMAND;
  // Monaco 0.57 的独立版公开 API 叫 `registerLinkProvider` / `LinkProvider`（旧名
  // DocumentLinkProvider），语义仍是注释里的可点击链接。
  const provider: Monaco.languages.LinkProvider = {
    async provideLinks(model, token) {
      const text = model.getValue();
      const language = linkLanguageOf(model);
      const context: DocumentLinkContext = {
        modelPath: modelPathOf(model, host),
        projectRoot: safeProjectRoot(host),
      };
      const links: Monaco.languages.ILink[] = [];
      for (const candidate of extractLinkCandidates(text, language)) {
        if (token.isCancellationRequested) break;
        if (candidate.kind === 'url') {
          links.push({
            range: rangeOf(model, candidate.start, candidate.end),
            url: candidate.text,
            tooltip: candidate.text,
          });
          continue;
        }
        const resolved = await resolveExistingPath(candidate.text, context, host.existsPath);
        if (!resolved) continue;
        const end = Math.min(candidate.end, candidate.start + resolved.matchedLength);
        links.push({
          range: rangeOf(model, candidate.start, end),
          url: documentLinkCommandUrl({ filePath: resolved.path, line: 1 }, commandId),
          tooltip: `打开 ${resolved.path}`,
        });
      }
      return { links };
    },
  };
  return monaco.languages.registerLinkProvider([ERB_LANGUAGE_ID, KOJO2_LANGUAGE_ID], provider);
}

/**
 * model 的语言 → 链接语言口径（行注释起头各一套）。
 *
 * 缺 `getLanguageId` 的桩 model / 取值抛错 ⇒ 按 ERB（`;`）处理：ERB 是这两门里
 * **更严格**的一套（`#` 与 `//` 都不是注释），坏输入只会少标、不会多说。
 */
function linkLanguageOf(model: Monaco.editor.ITextModel): LinkLanguage {
  try {
    const read = (model as { getLanguageId?: () => string }).getLanguageId;
    const id = typeof read === 'function' ? read.call(model) : '';
    return id === KOJO2_LANGUAGE_ID ? 'kojo2' : 'erb';
  } catch {
    return 'erb';
  }
}

function modelPathOf(model: Monaco.editor.ITextModel, host: DocumentLinksHost): string | null {
  try {
    const provided = host.filePathOf?.(model);
    if (typeof provided === 'string' && provided.length > 0) return provided;
  } catch {
    // 宿主路径解析抛错时退回 model.uri；绝不让供给器整体失败
  }
  const uri = model.uri;
  if (!uri) return null;
  if (uri.scheme && uri.scheme !== 'file') return null;
  if (typeof uri.fsPath === 'string' && uri.fsPath.length > 0) return uri.fsPath;
  return typeof uri.path === 'string' && uri.path.length > 0 ? uri.path : null;
}

function safeProjectRoot(host: DocumentLinksHost): string | null {
  try {
    const root = host.projectRoot?.();
    return typeof root === 'string' && root.length > 0 ? root : null;
  } catch {
    return null;
  }
}

function rangeOf(model: Monaco.editor.ITextModel, start: number, end: number): Monaco.IRange {
  const a = model.getPositionAt(start);
  const b = model.getPositionAt(end);
  return {
    startLineNumber: a.lineNumber,
    startColumn: a.column,
    endLineNumber: b.lineNumber,
    endColumn: b.column,
  };
}

// ---- 路径字符串纯函数（渲染进程无 node:path，按两种分隔符自判风格） ----

function sepOf(path: string): string {
  return path.includes('\\') || /^[A-Za-z]:/.test(path) ? '\\' : '/';
}

function isAbsolutePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || /^[\\/]{1,2}/.test(path);
}

function dirname(path: string): string {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  if (index < 0) return '';
  if (index === 0) return path.slice(0, 1);
  if (index === 2 && /^[A-Za-z]:/.test(path)) return path.slice(0, 3);
  return path.slice(0, index);
}

function joinPath(base: string, relative: string): string {
  const sep = sepOf(base);
  const rel = relative.replace(/[\\/]/g, sep);
  const trimmed = base.replace(/[\\/]+$/, '');
  const head = trimmed.length > 0 ? trimmed : sep;
  return normalizePath(head.endsWith(sep) ? head + rel : head + sep + rel);
}

function normalizePath(path: string): string {
  const sep = sepOf(path);
  let text = path.replace(/[\\/]/g, sep);
  const drive = /^[A-Za-z]:/.test(text) ? text.slice(0, 2) : '';
  if (drive) text = text.slice(2);
  let leading = '';
  if (text.startsWith(sep)) {
    leading = text.startsWith(sep + sep) ? sep + sep : sep;
    text = text.slice(leading.length);
  }
  const parts: string[] = [];
  for (const part of text.split(sep)) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop();
      else if (!leading && !drive) parts.push('..');
      continue;
    }
    parts.push(part);
  }
  return drive + leading + parts.join(sep);
}

function pathKey(path: string): string {
  const normalized = normalizePath(path);
  return sepOf(normalized) === '\\' ? normalized.toLowerCase() : normalized;
}
