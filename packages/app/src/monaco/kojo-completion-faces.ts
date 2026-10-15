import type * as Monaco from './entry';
import type { KojoFaceTable } from '@kojo/plugin-api';
import { TIMING_ARG_TOKENS, TIMING_NAMED_PARAMS, argTokenCnLabel, type TimingNamedParamSpec } from '@kojo/plugin-kojo-sugar';

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

/** 行首 `时机 ` 前缀（允许行首空白；`时机` 后至少一个空白） */
const TIMING_PREFIX_RE = /^[ \t]*时机[ \t]+/;
/** 分野名令牌的终止符：空白 / 全角冒号 / 半角冒号 */
const FACE_TOKEN_END_RE = /[\s：:]/;
/** 块头终结的全角冒号——`该名之后`已出现即分野段收尾，不再补全 */
const BLOCK_COLON = '：';
/** 命名参数键的尾冒号（全角 / 半角均可） */
const TRAILING_COLON_RE = /[：:]$/;
/** 令牌切分用空白 */
const WHITESPACE_RE = /\s/;
/** CJK 判定（含扩展 A / 假名）；用于 `类型:` 段取值的 CJK-primary 过滤 */
const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/;

/** 命名参数**键**候选的 detail（宿主 UI 文案；键名一律取自 kojo-sugar 键表，非硬编码） */
const KEY_DETAIL = '时机命名参数';

/** 行内替换区间（覆盖光标处那段令牌 / 空插入点） */
function lineRange(position: Monaco.Position, startIdx: number, endIdx: number): Monaco.IRange {
  return {
    startLineNumber: position.lineNumber,
    endLineNumber: position.lineNumber,
    startColumn: startIdx + 1,
    endColumn: endIdx + 1,
  };
}

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

/**
 * 计算行首 `时机 <分野> [编号] [命名参数]` 处该给的一轮候选。行为：
 * - 光标处在**分野名令牌内** ⇒ 分野候选（`Object.keys(faceTable.faces)`，按已输入前缀过滤，
 *   `kind` = `EnumMember`）；
 * - 光标在**分野令牌之后、块头 `：` 之前**：
 *   - 前一完整令牌是 `键:` ⇒ 命中该键后给**取值**候选（`kind` = `EnumMember`）；
 *   - 否则 ⇒ 给**键**候选（`TIMING_NAMED_PARAMS` 规范名，`kind` = `Property`）；
 * - 该名之后一旦出现全角 `：`（块头已收尾）→ `[]`；缺 `faceTable` → `[]`。
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
  const head = TIMING_PREFIX_RE.exec(line);
  if (!head) return [];

  const faceStart = head[0]!.length;
  const col0 = position.column - 1;
  if (col0 < faceStart) return [];

  // 分野名令牌 = `时机 ` 之后的第一个空白 / 冒号之前的整段
  let faceEnd = faceStart;
  while (faceEnd < line.length && !FACE_TOKEN_END_RE.test(line[faceEnd]!)) faceEnd++;

  // 块头已收尾：分野段之后出现块头终结的全角 `：` ⇒ 本模块零候选（交回其它补全面）。
  if (line.slice(faceStart).includes(BLOCK_COLON)) return [];

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

  // 前一完整令牌是 `键:`（带尾冒号）⇒ 光标处于它的**取值**位置。
  if (last !== undefined && last.colon) {
    const keyToken = last.text.replace(TRAILING_COLON_RE, '');
    const spec = TIMING_NAMED_PARAMS.find((p) => p.name === keyToken || p.alias === keyToken);
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
  const range = lineRange(position, active ? active.start : col0, active ? active.end : col0);
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
