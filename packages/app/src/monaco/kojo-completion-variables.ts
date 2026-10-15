import type * as Monaco from './entry';
import type { VariableSchema } from '@kojo/plugin-api';
import { ENGINE_VARIABLE_FAMILIES } from '@kojo/plugin-kojo-sugar';

/**
 * KC-1 · `.kojo` 插值里的**变量 / 属性补全**（`{她的<前缀>}` / `{你的<前缀>}` /
 * `{角色<数字>的<前缀>}`；规范 `docs/SYNTAX-SUGAR-SURFACE-SPEC.md` §3.8）。
 *
 * 名字来源 = `VariableSchema.names(family)`（KC-1 新增的**可选**枚举能力）；族并集的口径
 * = `kojo-sugar` 的 `makeLookup.resolveFamily` **搜索的那张族清单**（`ENGINE_VARIABLE_FAMILIES`），
 * 即"只补降糖器认得的名字"——否则会产出随后就报 `unknown-identifier` 的候选。
 * 分层口径同 `resolveFamily`（ALS-R1）：**主表优先、追加名表补漏**。
 *
 * 纯逻辑 + 薄 Monaco 翻译（与 `kojo-hover.ts` 同纪律）：位置不符 / 字典缺省 / 无枚举能力
 * ⇒ 返回 `[]`，**绝不猜、绝不抛**。
 */

/** 名字字符集（正向定义，排除全角标点/运算符等分隔符；含中日文、全角拉丁、全角数字） */
const NAME_CHAR_RE =
  /[0-9A-Za-z_\u00c0-\u024f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff10-\uff19\uff21-\uff3a\uff41-\uff5a\uff66-\uff9f]/;

function isNameChar(ch: string): boolean {
  return NAME_CHAR_RE.test(ch);
}

/** 一次补全的"名字段"位置（0 基区间 + 光标前已输入前缀） */
interface NameContext {
  /** 名字段起点（0 基，含）——替换范围左界 */
  readonly start: number;
  /** 名字段终点（0 基，不含）——替换范围右界 */
  readonly end: number;
  /** 光标前已输入的名字前缀（用于过滤 / 排序） */
  readonly prefix: string;
}

/** 代词 / 角色前缀长度（`她的` / `你的` / `角色<数字>的`；无 ⇒ 0） */
function pronounPrefixLength(interpContent: string): number {
  if (interpContent.startsWith('她的') || interpContent.startsWith('你的')) return 2;
  const m = /^角色\d+的/.exec(interpContent);
  return m === null ? 0 : m[0].length;
}

/**
 * 解析光标处的"名字补全位置"（**纯函数**；`column` = Monaco 的 1 基列）。
 *
 * 返回 `null` = 该处不是可补全的名字位置（**不猜**：插值外 / 代词前缀内 / 数字开头
 * / 前缀半成品一律不认）。
 */
function parseNameContext(lineText: string, column: number): NameContext | null {
  if (!Number.isFinite(column) || column < 1) return null;
  const col0 = Math.min(column - 1, lineText.length);

  // 1) 光标须在 `{ … }` 插值内：向左找 `{`，途中遇 `}` 即视为已在插值外。
  let open = -1;
  for (let i = col0 - 1; i >= 0; i--) {
    const ch = lineText[i]!;
    if (ch === '}') return null;
    if (ch === '{') {
      open = i;
      break;
    }
  }
  if (open < 0) return null;

  const content = lineText.slice(open + 1);
  const prefixLen = pronounPrefixLength(content);
  // 光标落在代词 / 角色前缀里（`{她|的`、`{角色1|2的`）→ 不是名字位置。
  if (col0 < open + 1 + prefixLen) return null;
  // 裸名位置：`{她` / `{你` / `{角色` 是前缀半成品，不当名字补全。
  if (prefixLen === 0 && /^(她|你|角色)/.test(content)) return null;

  const start = open + 1 + prefixLen;
  const prefix = lineText.slice(start, col0);
  if (prefix.length > 0 && ![...prefix].every(isNameChar)) return null;

  let end = col0;
  while (end < lineText.length && isNameChar(lineText[end]!)) end++;
  // 名字段不得以数字起（`{12` / `{12的` 是编号，不是名字）。
  if (end > start && /[0-9]/.test(lineText[start]!)) return null;

  return { start, end, prefix };
}

/**
 * 产出 `{ … }` 插值里变量 / 属性名的补全候选（**纯函数**，供补全基座调用）。
 *
 * 行为：仅当光标位于 `{ … }` 内且内容形如 `(她|你|角色<数字>)的<前缀>`（或裸名位置）
 * 时产出候选；名字来自 `schema.names(...)` 枚举（遍历相关族取并集），`kind` = Variable，
 * `insertText` = 名字，`detail` = `族:编号`，`description` 有则进 `documentation`；
 * 排序受控（**前缀精确匹配优先**），替换范围**只覆盖名字那一段**。位置不符 / `schema`
 * 缺省 / 实现未提供 `names` ⇒ 返回 `[]`，不抛。
 */
export function variableCompletionItems(
  monaco: typeof Monaco,
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
  schema: VariableSchema | undefined,
): Monaco.languages.CompletionItem[] {
  const names = schema?.names;
  if (names === undefined) return [];
  const context = parseNameContext(model.getLineContent(position.lineNumber), position.column);
  if (context === null) return [];

  const range: Monaco.IRange = {
    startLineNumber: position.lineNumber,
    endLineNumber: position.lineNumber,
    startColumn: context.start + 1,
    endColumn: context.end + 1,
  };
  const items: Monaco.languages.CompletionItem[] = [];
  const seen = new Set<string>();
  // 两轮（与 `resolveFamily` 的 ALS-R1 分层同口径）：主表优先，追加名表只在主表未中时补漏。
  for (const tier of ['primary', 'append'] as const) {
    for (const family of ENGINE_VARIABLE_FAMILIES) {
      for (const info of names(family) ?? []) {
        if ((info.source ?? 'primary') !== tier) continue;
        const name = info.name;
        if (name.length === 0 || seen.has(name)) continue;
        if (context.prefix.length > 0 && !name.startsWith(context.prefix)) continue;
        seen.add(name);
        const index: number | string | undefined = info.index ?? info.resolvedIndex;
        const exact = context.prefix.length > 0 && name === context.prefix;
        items.push({
          label: name,
          kind: monaco.languages.CompletionItemKind.Variable,
          insertText: name,
          detail: index === undefined ? family : `${family}:${index}`,
          range,
          sortText: `${exact ? '0' : '1'}_${name}`,
          ...(info.description !== undefined && info.description.length > 0
            ? { documentation: info.description }
            : {}),
        });
      }
    }
  }
  return items;
}
