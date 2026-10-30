import type {
  EditorRenameEdit,
  EditorRenameRelated,
  EditorRenameResult,
  EditorRenameTarget,
  EditorRenameTargetResult,
  EditorSymbolLocation,
  ErbIndex,
  ErbReference,
} from '@kojo/plugin-api';
import {
  labelEntryAt,
  labelScopeAt,
  type ErbLabelEntry,
  type ErbLabelOccurrence,
  type ErbLabelScope,
} from './symbols';
import { referencesOf } from './references';
import { MODEL_TOKEN_CLASS } from '@kojo/plugin-api';

/**
 * ERB **改名判据**（LAU-4 导航腿，2026-10-30）——从宿主 `monaco/erb-rename.ts` 整块搬进
 * 解析器插件。宿主的 `erb-rename.ts` 从此只剩"model / 位置 → 请求"与"契约 → Monaco 形状"
 * 两段翻译，外加**落盘通道**（写允许域 / 双通道送达 / 写前备份：那是宿主事实，不是语言判据）。
 *
 * ## 两条改名腿（判据都在本文件，宿主不重算）
 *
 * 1. **函数名**（全项目、跨文件）：光标词归一化大写后 `ErbIndex.byName` 命中才算数；
 *    编辑集 = `referencesOf(index, 归一化名)` 全集（含 `definition`——改名必须连定义一起改），
 *    再并上宿主递来的**其它语言证据**（{@link EditorRenameRelated}，`.kojo` 源）；
 * 2. **`$` 标签**（单文件、函数局部）：{@link labelScopeAt} 给出本函数内的全部出现；
 *    `.kojo` 源里若有同名标签写法（`标签 <名>` / `跳到 <名>` / 裸 `$名` / `JUMP|GOTO 名`），
 *    下一次保存会被重新生成盖回 ⇒ 整次拒绝（判据 {@link kojoLabelMentions}）。
 *
 * ## 三态与全或无
 *
 * - `undefined` = 本包不认这个文件 / 语言（弃权，宿主问下一家）；
 * - 索引未建 / 反向索引缺席 ⇒ 拒绝（可见理由，**不猜**）：改名漏一处就是同名分叉；
 * - 其它语言证据 `unprovable` 非空 ⇒ 整次拒绝（只改 `.erb` 半边下次保存会被冲掉）；
 * - 拒绝时 `edits` 必为空（全或无；宿主那侧另有"已落盘后不再拒绝"的最后一道）。
 *
 * ## 分层纪律
 *
 * 纯函数、零 IO / 零 Monaco：索引与文本都从参数进。宿主 `monaco/erb-rename.ts` 只调本模块
 * 导出的两个供方函数（`provideRenameTarget` / `provideRename`），不再抄任何一条取词 / 归类 /
 * 标签判定（第二份判据迟早与这份漂移，表现是"输入框框住 A、改的却是 B"）。
 */

/* ============================== 词定位 ============================== */

/**
 * 标识字符集：Unicode 字母 / 数字 / 下划线。与反向索引的记号字符集同口径
 * （真语料 21% 的函数名含 CJK，ASCII 集会静默漏两成）。
 */
const IDENT_RE = /[\p{L}\p{N}_]/u;

function isIdentPart(ch: string | undefined): boolean {
  return ch !== undefined && IDENT_RE.test(ch);
}

/**
 * 光标列 → 所在词的 0 基半开区间 `[start, end)`（**纯函数**）。
 *
 * `col0` = Monaco 的 1 基列 - 1。词判定向两侧看一格：光标贴着词（词尾后一格、
 * 或词首上一格贴着词）都算在词上，与 Monaco `getWordAtPosition` 的行为一致；
 * 两侧都不是标识字符（空白 / 运算符 / 空行）⇒ `null`。越界列夹取到行尾。
 */
export function wordAtColumn(lineText: string, col0: number): { start: number; end: number } | null {
  if (!Number.isFinite(col0) || col0 < 0) return null;
  const at = Math.min(Math.trunc(col0), lineText.length);
  // 先看光标左侧字符（词尾后一格的情形），再看光标处字符（词首上的情形）
  const anchor = isIdentPart(lineText[at - 1]) ? at - 1 : isIdentPart(lineText[at]) ? at : -1;
  if (anchor < 0) return null;
  let start = anchor;
  while (start > 0 && isIdentPart(lineText[start - 1])) start--;
  let end = anchor + 1;
  while (end < lineText.length && isIdentPart(lineText[end])) end++;
  return { start, end };
}

/** 名字判定的产物：命中（原词区间 + 归一化名）或拒绝（给作者看的理由） */
export type RenameNameTarget =
  | { readonly kind: 'hit'; readonly startColumn: number; readonly endColumn: number; readonly normalizedName: string }
  | { readonly kind: 'reject'; readonly reason: string };

/**
 * 光标处词 → 是否可重命名（**纯函数**；`column` = 1 基列，`hasName` = 索引里有没有这个名字）。
 *
 * 命中 = 词归一化大写后 `byName` 有它；未命中（`$` 标签、`#DIM` 局部名、裸词）与
 * 无词都 reject，理由区分两种，作者一眼知道为什么 F2 不动。
 */
export function resolveRenameName(
  lineText: string,
  column: number,
  hasName: (normalizedName: string) => boolean,
): RenameNameTarget {
  const col0 = Math.min(Math.max(0, column - 1), lineText.length);
  const word = wordAtColumn(lineText, col0);
  if (!word) return { kind: 'reject', reason: '光标处没有可重命名的名字' };
  const raw = lineText.slice(word.start, word.end);
  const normalizedName = raw.toUpperCase();
  if (!hasName(normalizedName)) {
    return {
      kind: 'reject',
      reason: `「${raw}」不在 ERB 函数索引内，不能重命名（$ 标签与 #DIM 局部名不在射程）`,
    };
  }
  return {
    kind: 'hit',
    startColumn: word.start + 1,
    endColumn: word.end + 1,
    normalizedName,
  };
}

/* ============================== `$` 标签改名判据 ============================== */

/** 标签名允许的字符（与解析器同一枚 Unicode 集：字母 / 数字 / 下划线；单源在契约层） */
const LABEL_NAME_RE = new RegExp(`^${MODEL_TOKEN_CLASS}+$`, 'u');
/** 纯数字不认（`GOTO 123` 与行号目标有歧义） */
const LABEL_NAME_DIGITS = /^\p{N}+$/u;

/**
 * 标签改名的新名字判定（**纯函数**；`null` = 可用，字符串 = 给作者看的拒绝理由）。
 * 同函数标签重名按大小写不敏感比较（标签名不区分大小写）。
 */
export function labelRenameRejection(
  scope: Pick<ErbLabelScope, 'name' | 'normalizedName' | 'siblingNames'>,
  newName: string,
): string | null {
  if (!LABEL_NAME_RE.test(newName)) return `标签名只能用字母、数字、下划线（「${newName}」含其它字符）`;
  if (LABEL_NAME_DIGITS.test(newName)) return `标签名不能是纯数字（「${newName}」会与行号跳转混淆）`;
  const upper = newName.toUpperCase();
  if (upper === scope.normalizedName) return null; // 只改大小写是合法改名
  const clash = scope.siblingNames.find((name) => name.toUpperCase() === upper);
  return clash === undefined ? null : `本函数里已有标签「${clash}」，不能改成「${newName}」（标签名不区分大小写）`;
}

/** 光标是否落在作用域中的某一处（含词尾后一格） */
function occurrenceAt(
  scope: ErbLabelScope,
  line: number,
  column: number,
): ErbLabelOccurrence | undefined {
  return scope.occurrences.find(
    (occurrence) => occurrence.line === line && column >= occurrence.column && column <= occurrence.endColumn,
  );
}

/**
 * `.kojo` 源里是否有同名标签的**可证明引用面**（**纯函数**）。
 *
 * 只认行首写法（与糖线词法同形）：
 * - `标签 <名>`（⇄ `$名`）；
 * - `跳到 <名>`（可带 `$` / `*` 前缀，⇄ `GOTO`）；
 * - 原生直通行 `$名` 与 `JUMP/GOTO/TRYJUMP/TRYGOTO <名>`（`.kojo` 允许整行透传引擎原文）。
 *
 * 命中 ⇔ 只改 `.erb` 会被下一次保存 `.kojo` 重新生成的产物盖回去 ⇒ 调用方整批拒绝。
 * 名字按大小写不敏感比较；行尾 `;` 注释先剥掉。
 */
export function kojoLabelMentions(text: string, normalizedName: string): boolean {
  const want = normalizedName.toUpperCase();
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const code = raw.replace(/;.*$/, '').trim();
    if (code.length === 0) continue;
    const sugar = /^(?:标签|跳到)\s+(\S+)/.exec(code);
    const rawLabel = sugar === null ? /^\$(\S+)/.exec(code) : null;
    const rawJump = sugar === null && rawLabel === null ? /^(?:JUMP|GOTO|TRYJUMP|TRYGOTO)\s+(\S+)/i.exec(code) : null;
    const name = (sugar ?? rawLabel ?? rawJump)?.[1]?.replace(/^[$*]/, '');
    if (name !== undefined && name.toUpperCase() === want) return true;
  }
  return false;
}

/* ============================== 求值（resolveRenameLocation 那一步） ============================== */

/**
 * 改名求值的三态（与契约 {@link EditorRenameTargetResult} 一一对应）：
 * `hit` = 可改名；`reject` = 认这个位置但不改；`none` = 本包不答（索引未建 / 不是方言）。
 */
export type ErbRenameResolution =
  | { readonly kind: 'hit'; readonly target: EditorRenameTarget }
  | { readonly kind: 'reject'; readonly reason: string }
  | { readonly kind: 'none' };

/**
 * 光标处 → 可改名的原词（**纯函数**）：`$` 标签腿优先，其次函数名腿。
 *
 * 标签腿先走是因为标签是**文件局部**事实、不依赖项目索引——索引未建时标签照样可改
 * （与宿主旧实现逐字同序）。标签入口但作用域不成立（`$` 定义名字形不整 / 跳转目标
 * 找不到同名标签）⇒ 拒绝，**绝不落函数名腿**（`GOTO ALPHA` 不是调用 ALPHA）。
 */
export function resolveErbRenameAt(
  index: ErbIndex | null,
  path: string,
  text: string,
  line: number,
  column: number,
): ErbRenameResolution {
  if (!Number.isFinite(line) || !Number.isFinite(column) || line < 1) return { kind: 'none' };
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const lineText = lines[Math.trunc(line) - 1] ?? '';
  // ---- 标签腿 ----
  const scope = labelScopeAt(text, path, Math.trunc(line), Math.trunc(column));
  const labelHit = scope === null ? undefined : occurrenceAt(scope, Math.trunc(line), Math.trunc(column));
  if (scope !== null && labelHit !== undefined) {
    return {
      kind: 'hit',
      target: {
        line: labelHit.line,
        startColumn: labelHit.column,
        endColumn: labelHit.endColumn,
        text: lineText.slice(labelHit.column - 1, labelHit.endColumn - 1),
        scope: 'label',
      },
    };
  }
  const entry: ErbLabelEntry | null = labelEntryAt(lineText, Math.trunc(column));
  if (entry !== null) {
    return {
      kind: 'reject',
      reason:
        entry === 'jump'
          ? '跳转目标在当前函数里找不到同名 `$` 标签，不按函数名重命名（不猜）'
          : '这不是可重命名的 `$` 标签名（标签名只能是字母、数字、下划线）',
    };
  }
  // ---- 函数名腿 ----
  if (index === null) return { kind: 'none' };
  const target = resolveRenameName(lineText, Math.trunc(column), (name) => index.byName.has(name));
  if (target.kind === 'reject') return { kind: 'reject', reason: target.reason };
  return {
    kind: 'hit',
    target: {
      line: Math.trunc(line),
      startColumn: target.startColumn,
      endColumn: target.endColumn,
      text: lineText.slice(target.startColumn - 1, target.endColumn - 1),
      scope: 'symbol',
    },
  };
}

/* ============================== 编辑集（provideRenameEdits 那一步） ============================== */

/** 一份文件的编辑组（宿主按 `resourcePath` 分组送达；组序 = 索引的出现序） */
function editOf(
  reference: { readonly filePath: string; readonly line: number; readonly column: number; readonly endColumn: number; readonly kind?: ErbReference['kind'] },
  requestPath: string,
  newName: string,
): EditorRenameEdit {
  return {
    line: reference.line,
    startColumn: reference.column,
    endColumn: reference.endColumn,
    newText: newName,
    ...(reference.filePath === requestPath ? {} : { resourcePath: reference.filePath }),
    ...(reference.kind === undefined ? {} : { occurrenceKind: reference.kind }),
  };
}

/**
 * 其它语言证据 → 编辑（`endColumn` 由"这一串就是这个名字"派生：`column + 名字长度`，
 * 与反向索引同一条派生纪律；契约位置不带 `endColumn`）。
 */
function relatedEdits(
  locations: readonly EditorSymbolLocation[] | undefined,
  requestPath: string,
  normalizedName: string,
  newName: string,
): EditorRenameEdit[] {
  const out: EditorRenameEdit[] = [];
  for (const location of locations ?? []) {
    if (!Number.isFinite(location.line) || location.line < 1) continue;
    const column = location.column ?? location.span?.columnStart ?? 1;
    if (!Number.isFinite(column) || column < 1) continue;
    const endColumn = location.span?.columnEnd ?? column + normalizedName.length;
    out.push({
      line: location.line,
      startColumn: column,
      endColumn,
      newText: newName,
      ...(location.filePath === requestPath ? {} : { resourcePath: location.filePath }),
      // 跨语言腿的出现点是别家供方**证明过**的引用：不标 `mention`（那会让宿主按
      // "散文跳过"再判一次，把真引用漏掉）。分类只对 ERB 词法面的 `mention` 有意义。
    });
  }
  return out;
}

/**
 * 一次改名的完整判据（**纯函数**）：成功 = 编辑集 + 原名；失败 = 空编辑 + 可读理由。
 *
 * 顺序即语义（与宿主旧实现逐字同序）：
 * 1. 标签腿先走（文件局部，不依赖索引）；
 * 2. 其它语言证据 `unprovable` 非空 ⇒ 整次拒绝（跨语言腿判据缺席）；
 * 3. 函数名腿：索引 / 反向索引缺席 ⇒ 拒绝；引用集为空 ⇒ 拒绝；
 * 4. 编辑集 = 本语言引用全集 + 其它语言证据（同一份全或无）。
 */
export function planErbRename(
  index: ErbIndex | null,
  requestPath: string,
  text: string,
  line: number,
  column: number,
  newName: string,
  related?: EditorRenameRelated,
): EditorRenameResult {
  const reject = (rejectReason: string): EditorRenameResult => ({
    kind: 'rename',
    edits: [],
    rejectReason,
  });
  const resolution = resolveErbRenameAt(index, requestPath, text, line, column);
  if (resolution.kind === 'none') return reject('ERB 函数索引未建，暂不可重命名');
  if (resolution.kind === 'reject') return reject(resolution.reason);

  const target = resolution.target;
  const normalizedName = target.text.toUpperCase();

  // ---- 标签腿：单文件、函数局部、全或无 ----
  if (target.scope === 'label') {
    // 宿主看不见 `.kojo` 源（枚举抛错）⇒ 无从证明有没有同名标签写法 ⇒ 整次拒绝（不静默只改半边）
    const unprovable = related?.unprovable ?? [];
    if (unprovable.length > 0) {
      return reject(
        `无法检查 .kojo 源里的同名标签（${unprovable.join('、')}）——为免只改一半，整次重命名取消`,
      );
    }
    const scope = labelScopeAt(text, requestPath, line, column);
    if (scope === null) return reject('当前位点的 `$` 标签作用域已变化，请重按 F2 重试');
    const rejection = labelRenameRejection(scope, newName);
    if (rejection !== null) return reject(rejection);
    // `.kojo` 源里的同名标签写法 ⇒ 只改 `.erb` 会被下一次保存盖回去
    const sources = related?.sources ?? [];
    let kojoHits = 0;
    for (const source of sources) {
      if (kojoLabelMentions(source.text, scope.normalizedName)) kojoHits++;
    }
    if (kojoHits > 0) {
      return reject(
        `${kojoHits} 份 .kojo 源里也写着标签「${scope.name}」。保存 .kojo 时会按同名重新生成 .erb，` +
          '只改这一处会留下两份不一致的标签，故整次重命名取消。请先在 .kojo 源里改名。',
      );
    }
    return {
      kind: 'rename',
      edits: scope.occurrences.map((occurrence) => ({
        line: occurrence.line,
        startColumn: occurrence.column,
        endColumn: occurrence.endColumn,
        newText: newName,
      })),
      oldName: scope.name,
    };
  }

  // ---- 函数腿：判据缺席 ⇒ 整次拒绝 ----
  const unprovable = related?.unprovable ?? [];
  if (unprovable.length > 0) {
    return reject(
      `${normalizedName} 的改名需要连带 .kojo 源，但 ${unprovable.length} 项 .kojo 侧判据缺席：` +
        unprovable.join('、') +
        '。无法证明这些记号是否指向本函数——' +
        '只改 .erb 会被下一次保存 .kojo 冲掉，故整次重命名取消（不静默改一半）。' +
        '请先在对应 .kojo 源内改名，或由宿主接入 ui.editor.languageService 的引用判读',
    );
  }
  if (index === null) return reject('ERB 函数索引未建，暂不可重命名');
  if (index.references === undefined) {
    return reject('反向引用索引缺席，无法全项目收集引用（不猜，不部分改）');
  }
  const refs = referencesOf(index, normalizedName);
  if (refs.length === 0) {
    return reject('反向引用索引缺席，无法全项目收集引用（不猜，不部分改）');
  }
  const edits: EditorRenameEdit[] = refs.map((ref) => editOf(ref, requestPath, newName));
  edits.push(...relatedEdits(related?.occurrences, requestPath, normalizedName, newName));
  return { kind: 'rename', edits, oldName: target.text };
}

/* ============================== 槽供方（两枚成员） ============================== */

/**
 * `renameTarget` 供方：只认方言文件；非方言 / 索引未建 ⇒ `undefined`（弃权）。
 * 拒绝理由原样交回（宿主填 Monaco `rejectReason`）。
 */
export function provideRenameTarget(
  index: ErbIndex | null,
  request: {
    readonly path: string;
    readonly text: string;
    readonly line: number;
    readonly column: number;
  },
  isDialect: (path: string) => boolean,
): EditorRenameTargetResult | undefined {
  if (!isDialect(request.path)) return undefined;
  const resolution = resolveErbRenameAt(index, request.path, request.text, request.line, request.column);
  if (resolution.kind === 'none') return undefined;
  if (resolution.kind === 'reject') return { kind: 'renameTarget', rejectReason: resolution.reason };
  return { kind: 'renameTarget', target: resolution.target };
}

/** `rename` 供方：只认方言文件；编辑集或拒绝理由二选一（契约全或无）。 */
export function provideRename(
  index: ErbIndex | null,
  request: {
    readonly path: string;
    readonly text: string;
    readonly line: number;
    readonly column: number;
    readonly newName: string;
    readonly related?: EditorRenameRelated;
  },
  isDialect: (path: string) => boolean,
): EditorRenameResult | undefined {
  if (!isDialect(request.path)) return undefined;
  return planErbRename(
    index,
    request.path,
    request.text,
    request.line,
    request.column,
    request.newName,
    request.related,
  );
}