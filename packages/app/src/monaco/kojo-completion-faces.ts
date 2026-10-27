import type * as Monaco from './entry';
import type { KojoFaceTable } from '@kojo/plugin-api';
import { TIMING_ARG_TOKENS, TIMING_NAMED_PARAMS, argTokenCnLabel, type TimingNamedParamSpec } from '@kojo/kojo-vocab/keywords';
import { lineRange } from './completion-range';
import {
  col0Of,
  timingHeadParts,
  type KojoNameField,
} from './kojo-completion-position';

/**
 * 语法糖（`.kojo`）补全 · **时机块头**——沿用单一 `kojo-face` source：
 * - **KC-2 分野**：行首 `时机 <分野>：` 在 `<分野>` 位置弹分野候选；
 * - **KC-2b 命名参数**：分野令牌之后、块头 `：` 之前，弹**命名参数键**候选
 *   （`成否:` / `类型:` / `参数:`），并在键之后弹该键的**取值**候选。
 *
 * 分野清单 / 命名参数键表的**唯一真源** = adapter 的 `KojoFaceTable.faces` +
 * `kojo-sugar` 的 `TIMING_NAMED_PARAMS`——本模块**不硬编码任何游戏分野名，也不硬编码中文键名**
 * （游戏知识只进 adapter；命名参数是跨游戏语言层，属 kojo-sugar；架构铁律 3）。
 *
 * 取值来源（**只取契约/语言层公开面，不猜**）：
 * - `成否:`：adapter 成否位协议的 `KojoFaceTable.successFlag.values`（公开面 ⇒ 给候选；
 *   未公开 ⇒ 该键此处零候选）；
 * - `类型:`：该分野模板的 `KojoFaceTemplate.segments`（键 = 段的候选取值）；
 * - `参数:`：语言层闭集 `ARG` / `ARG:<数字>`（`TIMING_ARG_TOKENS`；多值拼接不做）。
 *
 * 纯函数：只读模型、不产生编辑、不写盘、不发事件；位置不符 / 表缺省一律 `[]`、绝不抛。
 * Monaco 绑定（provider 注册）刻意不在此处——编排层负责把本函数接进补全基座。
 */

/** 命名参数键的尾冒号（全角 / 半角均可） */
const TRAILING_COLON_RE = /[：:]$/;
/** 令牌切分用空白 */
const WHITESPACE_RE = /\s/;
/** CJK 判定（含扩展 A / 假名）；用于 `类型:` 段取值的 CJK-primary 过滤 */
const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/;

/**
 * 命名参数**键名集**（含隐藏英文别名）：某枚冒号"紧邻其前（空白切分）的令牌"落在此集内
 * ⇒ **键冒号**（命名参数尾符、取值位分界）。
 *
 * 与 `kojo-completion-instructions.ts` 的 `NAMED_PARAM_KEYS`（编号槽判据）同款派生、同一真源
 * = `kojo-sugar` 的 `TIMING_NAMED_PARAMS`。那边未导出该集、且本批禁改该文件 ⇒ 此处再派生
 * 一份——两个派生都只从键表来（键表改则两处同改），无第二真源。
 */
const NAMED_PARAM_KEYS: ReadonlySet<string> = new Set(
  TIMING_NAMED_PARAMS.flatMap((p) => (p.alias === undefined ? [p.name] : [p.name, p.alias])),
);

/** 命名参数**键**候选的 detail（宿主 UI 文案；键名一律取自 kojo-sugar 键表，非硬编码） */
const KEY_DETAIL = '时机命名参数';

/** 分野令牌之后的尾段令牌（按空白切分；尾冒号标记命名参数键） */
interface TailToken {
  /** 行内绝对起始下标 */
  readonly start: number;
  /** 行内绝对结束下标（不含） */
  readonly end: number;
  readonly text: string;
  /** 令牌以全/半角冒号收尾（= 命名参数**键**，而非值） */
  readonly colon: boolean;
}

function tokenizeTail(line: string, from: number): TailToken[] {
  const out: TailToken[] = [];
  let i = from;
  while (i < line.length) {
    if (WHITESPACE_RE.test(line[i]!)) {
      i += 1;
      continue;
    }
    const start = i;
    while (i < line.length && !WHITESPACE_RE.test(line[i]!)) i += 1;
    const text = line.slice(start, i);
    out.push({ start, end: i, text, colon: TRAILING_COLON_RE.test(text) });
  }
  return out;
}

/** 令牌 → 命名参数键 spec：剥去尾冒号后按 规范名 / 隐藏别名 查键表；非键 ⇒ `undefined` */
function namedParamOf(text: string): TimingNamedParamSpec | undefined {
  const key = text.replace(TRAILING_COLON_RE, '');
  return TIMING_NAMED_PARAMS.find((p) => p.name === key || p.alias === key);
}

/** 尾段令牌的**编辑面右界**：块冒号收尾的令牌不含那枚冒号（结构符，替换不许吃掉） */
function tokenEditEnd(token: TailToken): number {
  if (!token.colon) return token.end;
  return NAMED_PARAM_KEYS.has(token.text.slice(0, -1)) ? token.end : token.end - 1;
}

/** 紧邻 `at` 之前（空白切分）的令牌文本：自 `at` 向左吃到空白为止（下界 = 分野段终） */
function tokenTextBefore(line: string, at: number, lowerBound: number): string {
  let start = at;
  while (start > lowerBound && !WHITESPACE_RE.test(line[start - 1]!)) start--;
  return line.slice(start, at);
}

/**
 * `faceStart` 之后全部**块冒号**的下标（0 基）。块冒号 = **非键冒号**且**收束自己的令牌**
 * （其后是空白或行尾）——即块头收尾那一枚。
 *
 * 键冒号判据 = 紧邻其前（空白切分）的令牌 ∈ {@link NAMED_PARAM_KEYS}。"收束自己的令牌"这一半
 * 是对"非键即块"钝口径的**必要收窄**：值令牌可以内嵌冒号（v1.6 的 `实参:2` / `实参$:2`）——
 * 钝口径会把它误当收尾冒号，把 `参数: 实参:2` 这类顶格写值的位置整片掐死（旧代码不掐：旧口径
 * 只认全角 `：`）。解析器（`lexer.parseTimingHead`）对同一行只把**行尾**那枚冒号剥作终止符、
 * 内嵌冒号一律归值——本判据与它同向。
 */
function blockColonIndices(line: string, faceStart: number): number[] {
  const out: number[] = [];
  for (let i = faceStart; i < line.length; i++) {
    const ch = line[i]!;
    if (ch !== '：' && ch !== ':') continue;
    if (NAMED_PARAM_KEYS.has(tokenTextBefore(line, i, faceStart))) continue; // 键冒号
    const next = line[i + 1];
    if (next !== undefined && !WHITESPACE_RE.test(next)) continue; // 值令牌内嵌冒号（`实参:2`）
    out.push(i);
  }
  return out;
}

/**
 * 块头在光标处是否**已收口**：存在块冒号且下标 < `col0`。收口语义**以光标列为界**——块冒号
 * 在光标之后 ⇒ 作者仍在头内编辑，候选照给。原实现（整行 `includes('：')`）把"行里出现过
 * 收尾冒号"与"光标已在收尾冒号之后"混作一件：⑦ 缺陷的编辑位（`时机 指令 310 成否: 游戏判定：`
 * 光标在行中）被整行口径误杀。
 */
function blockHeadClosed(line: string, faceStart: number, col0: number): boolean {
  return blockColonIndices(line, faceStart).some((i) => i < col0);
}

/**
 * 时机块头的**分野名槽**（`column` = Monaco 的 1 基列；纯函数）。
 *
 * 段界取自 `kojo-completion-position` 的 {@link timingHeadParts}（**同一份**锚 + 同一份终止符，
 * 与编号槽判据不再各扫一遍）。命中条件：光标在分野段内（含段右界，即"刚写完名字"）且块头在
 * **光标处**尚未收口（收尾冒号在光标之后不算收口——作者仍在头内编辑）。位置不符 ⇒ `null`（不猜）。
 *
 * 消费方两路：KC-2 候选（下面的 `faceCandidates`）与「上下文主动触发」
 * （`suggest-context-trigger.ts` 用它判"光标是否刚落到分野位"）。
 */
export function timingFaceSlot(line: string, column: number): KojoNameField | null {
  const parts = timingHeadParts(line);
  if (parts === null) return null;
  const col0 = col0Of(line, column);
  if (col0 === null || col0 < parts.faceStart || col0 > parts.faceEnd) return null;
  if (blockHeadClosed(line, parts.faceStart, col0)) return null;
  return { start: parts.faceStart, end: parts.faceEnd, prefix: line.slice(parts.faceStart, col0) };
}

/**
 * 命名参数**取值位探针**（CTX-SUGGEST 主动触发消费；`column` = Monaco 的 1 基列）。
 *
 * 语义 = "光标处是可补的命名参数取值位置"（与候选源的取值路径同一枚判据）：
 * - **刚敲完键冒号**：光标紧贴该键令牌的尾冒号（`成否：|` / `成否:|`）；
 * - **值令牌内且前一完整令牌是键冒号**：`成否: 游戏|判定：`（行尾块冒号在光标之后不算收口）。
 * 块头在光标处已收口 / 分野段内 / 非时机行 ⇒ `false`。
 *
 * NB（接线）：`suggest-context-trigger` 的探针契约是"非 `null` 即命中"，本函数按定死签名回
 * `boolean`——消费方纳入 `KOJO_NAME_SLOTS` 时要折一道（`probe(...) ? true : null`，或直接判 truthy）。
 */
export function timingNamedParamValueSlot(line: string, column: number): boolean {
  const col0 = col0Of(line, column);
  if (col0 === null) return false;
  const parts = timingHeadParts(line);
  if (parts === null) return false;
  if (col0 <= parts.faceEnd) return false;
  if (blockHeadClosed(line, parts.faceStart, col0)) return false;

  const tail = tokenizeTail(line, parts.faceEnd);
  const active = tail.find((t) => t.start < col0 && col0 <= t.end);
  const committed = tail.filter((t) => t !== active && t.end <= col0);
  // (a) 刚敲完键冒号：活动令牌是键令牌且光标恰在其尾冒号之后。
  if (
    active !== undefined &&
    active.colon &&
    col0 === active.end &&
    namedParamOf(active.text) !== undefined
  ) {
    return true;
  }
  // (b) 值令牌内（或空插入点）且前一完整令牌是键冒号。
  const last = committed[committed.length - 1];
  return last !== undefined && last.colon && namedParamOf(last.text) !== undefined;
}

/**
 * 计算行首 `时机 <分野> [编号] [命名参数]` 处该给的一轮候选。行为：
 * - 光标处在**分野名令牌内** ⇒ 分野候选（`Object.keys(faceTable.faces)`，按已输入前缀过滤，
 *   `kind` = `EnumMember`）；
 * - 光标在**分野令牌之后**（且块头未在光标处收口）：
 *   - 前一完整令牌是 `键:`，或光标紧贴**键冒号**尾 ⇒ 给该键的**取值**候选（`kind` = `EnumMember`）；
 *   - 否则 ⇒ 给**键**候选（`TIMING_NAMED_PARAMS` 规范名，`kind` = `Property`）；
 * - **块冒号在光标之前**（块头已收口）→ `[]`；块冒号在光标之后（头内编辑位）候选照给；
 *   缺 `faceTable` → `[]`。
 */
export function faceCompletionItems(
  monaco: typeof Monaco,
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
  faceTable: KojoFaceTable | undefined,
): Monaco.languages.CompletionItem[] {
  if (!faceTable || !model || !position) return [];
  if (!Number.isFinite(position.lineNumber) || position.lineNumber < 1) return [];
  if (!Number.isFinite(position.column) || position.column < 1) return [];

  const line = model.getLineContent(position.lineNumber);
  const parts = timingHeadParts(line);
  if (parts === null) return [];

  const faceStart = parts.faceStart;
  const faceEnd = parts.faceEnd;
  const col0 = position.column - 1;
  if (col0 < faceStart) return [];

  // 块头在光标处已收口（存在块冒号且下标 < col0）⇒ 本模块零候选（交回其它补全面）；
  // 块冒号在光标之后 ⇒ 作者仍在头内编辑，候选照给（⑦ 缺陷的编辑位）。
  if (blockHeadClosed(line, faceStart, col0)) return [];

  // 位置 1：光标仍在分野名令牌内 ⇒ 分野候选（KC-2 原行为，逐字保留）。
  if (col0 <= faceEnd) {
    return faceCandidates(monaco, line, faceStart, faceEnd, col0, position, faceTable);
  }

  // 位置 2 / 3：分野令牌之后、块头 `：` 之前 ⇒ 命名参数键 / 取值候选（KC-2b）。
  return timingNamedParamCandidates(monaco, line, faceStart, faceEnd, col0, position, faceTable);
}

/** 分野候选（KC-2）：行首 `时机 <分野>` 处枚举 `faceTable.faces`。 */
function faceCandidates(
  monaco: typeof Monaco,
  line: string,
  faceStart: number,
  faceEnd: number,
  col0: number,
  position: Monaco.Position,
  faceTable: KojoFaceTable,
): Monaco.languages.CompletionItem[] {
  const prefix = line.slice(faceStart, col0);
  const range = lineRange(position, faceStart, faceEnd);
  const kind = monaco.languages.CompletionItemKind.EnumMember;

  const out: Monaco.languages.CompletionItem[] = [];
  Object.keys(faceTable.faces).forEach((face, idx) => {
    if (prefix.length > 0 && !face.startsWith(prefix)) return;
    const tpl = faceTable.faces[face];
    const item: Monaco.languages.CompletionItem = {
      label: face,
      kind,
      insertText: face,
      filterText: face,
      range,
      sortText: `${String(idx).padStart(3, '0')}_${face}`,
    };
    if (tpl && tpl.template) {
      item.detail = tpl.template;
      const doc = [`**${face}** · 函数名模板 \`${tpl.template}\``];
      const slot = tpl.template.includes('{i}')
        ? (tpl.slotSemantics?.index ?? faceTable.slotSemantics?.index)
        : undefined;
      if (slot !== undefined) {
        doc.push(`编号含义：${slot.label}${slot.detail !== undefined ? `（${slot.detail}）` : ''}`);
      }
      if (tpl.success?.template) doc.push(`成否模板 \`${tpl.success.template}\``);
      if (tpl.messageCheck?.template) doc.push(`MESSAGECHECK 模板 \`${tpl.messageCheck.template}\``);
      item.documentation = { value: doc.join('\n\n') };
    }
    out.push(item);
  });
  return out;
}

/** 命名参数键 / 取值候选（KC-2b）：分野令牌之后的块头尾段。 */
function timingNamedParamCandidates(
  monaco: typeof Monaco,
  line: string,
  faceStart: number,
  faceEnd: number,
  col0: number,
  position: Monaco.Position,
  faceTable: KojoFaceTable,
): Monaco.languages.CompletionItem[] {
  const tail = tokenizeTail(line, faceEnd);
  const active = tail.find((t) => t.start < col0 && col0 <= t.end);
  const committed = tail.filter((t) => t !== active && t.end <= col0);
  const last = committed[committed.length - 1];

  // 光标紧贴**键冒号**尾（`成否：|` / `成否:|`）⇒ 该键的取值位置（空前缀、空替换区间）。
  // 非键冒号收尾的令牌（如 `参数: 实参:|` 的内嵌冒号）**落到下面老路径**：值区归属由前一枚
  // 完整键令牌决定，既有行为逐字保留。
  if (active !== undefined && active.colon && col0 === active.end) {
    const spec = namedParamOf(active.text);
    if (spec !== undefined) {
      return valueCandidates(monaco, line, faceStart, faceEnd, undefined, col0, position, faceTable, spec);
    }
  }

  // 前一完整令牌是 `键:`（带尾冒号）⇒ 光标处于它的**取值**位置。
  if (last !== undefined && last.colon) {
    const spec = namedParamOf(last.text);
    if (!spec) return [];
    return valueCandidates(monaco, line, faceStart, faceEnd, active, col0, position, faceTable, spec);
  }

  // 否则为**键**位置（含编号位 / 新令牌位；前缀不符则自然零候选）。
  return keyCandidates(monaco, active, col0, position);
}

/**
 * 命名参数**键**候选：取 `TIMING_NAMED_PARAMS` 的规范名（隐藏英文别名不进列表——规范 §4.1）。
 * 前缀过滤与替换区间同分野候选口径；`insertText = "<键>: "` 便于接着写取值。
 */
function keyCandidates(
  monaco: typeof Monaco,
  active: TailToken | undefined,
  col0: number,
  position: Monaco.Position,
): Monaco.languages.CompletionItem[] {
  const prefix = active ? active.text.slice(0, col0 - active.start) : '';
  const range = lineRange(position, active ? active.start : col0, active ? active.end : col0);
  const kind = monaco.languages.CompletionItemKind.Property;

  const out: Monaco.languages.CompletionItem[] = [];
  TIMING_NAMED_PARAMS.forEach((spec, idx) => {
    if (prefix.length > 0 && !spec.name.startsWith(prefix)) return;
    out.push({
      label: spec.name,
      kind,
      insertText: `${spec.name}: `,
      filterText: spec.name,
      detail: KEY_DETAIL,
      range,
      sortText: `${String(idx).padStart(2, '0')}_${spec.name}`,
    });
  });
  return out;
}

/**
 * 命名参数**取值**候选：按键的 `valueSource` 派生（`kind` = `EnumMember`，与分野名同档）。
 * 取值集为空（如分野无该段 / 成否位协议未公开）⇒ 零候选（**不猜**）。
 */
function valueCandidates(
  monaco: typeof Monaco,
  line: string,
  faceStart: number,
  faceEnd: number,
  active: TailToken | undefined,
  col0: number,
  position: Monaco.Position,
  faceTable: KojoFaceTable,
  spec: TimingNamedParamSpec,
): Monaco.languages.CompletionItem[] {
  const values = valueSetOf(line, faceStart, faceEnd, faceTable, spec);
  if (values.length === 0) return [];

  const prefix = active ? active.text.slice(0, col0 - active.start) : '';
  // 替换区间止于令牌的**编辑面右界**：块冒号收尾的值令牌不含那枚冒号（结构符不许被吃掉）。
  const range = lineRange(position, active ? active.start : col0, active ? tokenEditEnd(active) : col0);
  const kind = monaco.languages.CompletionItemKind.EnumMember;

  const out: Monaco.languages.CompletionItem[] = [];
  values.forEach((value, idx) => {
    if (prefix.length > 0 && !value.startsWith(prefix)) return;
    out.push({
      label: value,
      kind,
      insertText: value,
      filterText: value,
      detail: `${spec.name} 取值`,
      range,
      sortText: `${String(idx).padStart(2, '0')}_${value}`,
    });
  });
  return out;
}

/**
 * 某键在当前分野下的取值集合（只取公开面；缺则空集；含 CJK 时隐藏纯 ASCII 别名）。
 */
function valueSetOf(
  line: string,
  faceStart: number,
  faceEnd: number,
  faceTable: KojoFaceTable,
  spec: TimingNamedParamSpec,
): readonly string[] {
  // `参数:` 的候选由语言层闭集**派生中文主形**（`实参` / `实参:1` / `实参$`），
  // 编辑器侧零硬编码（单一真源 = kojo-sugar 的 `TIMING_ARG_TOKENS` + `argTokenCnLabel`）。
  if (spec.valueSource === 'args') return TIMING_ARG_TOKENS.map((t) => argTokenCnLabel(t));
  if (spec.valueSource === 'successFlag') {
    const values = faceTable.successFlag?.values;
    return values ? Object.keys(values) : [];
  }
  // `valueSource === 'segment'`：该分野模板里 `${段名}` 段的候选取值。
  const segName = spec.segmentName;
  if (segName === undefined) return [];
  const tpl = faceTable.faces[line.slice(faceStart, faceEnd)];
  const seg = tpl?.segments?.[segName];
  if (!seg) return [];
  const keys = Object.keys(seg);
  // CJK-primary（规范 §4.1 中英不对等展示）：段表里一旦有中文键，纯 ASCII 键视作
  // 隐藏兼容别名（如 `类型:` 的引擎令牌 `COM` / `SCOM`），不进补全面板；无中文键 → 原样。
  const hasCjk = keys.some((k) => CJK_RE.test(k));
  return hasCjk ? keys.filter((k) => CJK_RE.test(k)) : keys;
}
