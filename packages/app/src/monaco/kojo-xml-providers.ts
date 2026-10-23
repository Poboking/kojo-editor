/**
 * 口上 XML 的编辑器增强面（悬停 / 补全 / 大纲 / 折叠）。
 *
 * 归属：本文件是**宿主 Monaco 层**，只许出现语言级词汇（XML / 属性 / 元素），
 * 不许出现任何具体游戏的属性枚举或 `com` 编号——那些由 adapter 经 `kojo.xml`
 * 服务以 `KojoXmlSchema` 交过来（见 `plugin-api/kojo-xml.ts` 的注）。
 *
 * 接线：`xml-language.ts` 的 descriptor 在 `register()` 里调用本函数；规格来源由
 * 宿主在项目打开后 `setKojoXmlSchemaSource(...)` 注入（未注入 = 只有静态语法面，
 * 补全只剩"通用属性骨架"，不猜游戏取值）。
 */
import type * as Monaco from './entry';
import type { KojoXmlAttributeSpec, KojoXmlSchema } from '@kojo/plugin-api';

/** 规格来源（宿主注入；抛错按"没有规格"处理，绝不把异常抛进编辑器） */
export type KojoXmlSchemaSource = () => KojoXmlSchema | null;

let schemaSource: KojoXmlSchemaSource | null = null;

/** 注入规格来源（`null` = 撤回；换项目时宿主应重设或撤回） */
export function setKojoXmlSchemaSource(source: KojoXmlSchemaSource | null): void {
  schemaSource = source;
}

/** 当前规格（取不到 / 抛错 = null） */
export function currentKojoXmlSchema(): KojoXmlSchema | null {
  try {
    return schemaSource === null ? null : schemaSource();
  } catch {
    return null;
  }
}

/* ------------------------------ 文本工具 ------------------------------ */

/** 一行里所有属性（名字 + 值 + 值区间），不解析嵌套结构——够悬停与补全用 */
export interface XmlAttrOnLine {
  readonly name: string;
  readonly value: string;
  /** 值在行内的起止列（0 基，不含引号） */
  readonly valueStart: number;
  readonly valueEnd: number;
  /** 属性名在行内的起止列（0 基） */
  readonly nameStart: number;
  readonly nameEnd: number;
}

const ATTR_RE = /([A-Za-z_][\w.:-]*)\s*=\s*("[^"]*"|'[^']*')/g;

export function attrsOnLine(line: string): XmlAttrOnLine[] {
  const out: XmlAttrOnLine[] = [];
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(line)) !== null) {
    const nameStart = m.index;
    const raw = m[2]!;
    const valueStart = m.index + m[0].length - raw.length + 1;
    out.push({
      name: m[1]!,
      value: raw.slice(1, -1),
      nameStart,
      nameEnd: nameStart + m[1]!.length,
      valueStart,
      valueEnd: valueStart + raw.length - 2,
    });
  }
  return out;
}

/** 该行是否是开始标签（且不是自闭合 / 结束标签） */
export function openTagNameOf(line: string): string | null {
  const m = /<([A-Za-z_][\w.:-]*)(?:\s[^>]*)?>/.exec(line);
  if (!m) return null;
  if (/\/>\s*$/.test(line)) return null;
  return m[1]!;
}

/** 该行是否是结束标签，返回标签名 */
export function closeTagNameOf(line: string): string | null {
  const m = /<\/\s*([A-Za-z_][\w.:-]*)\s*>/.exec(line);
  return m ? m[1]! : null;
}

/* ------------------------------ 折叠 ------------------------------ */

/** 纯函数：按标签配对算折叠区间（1 基行；`end` = 结束标签所在行） */
export function computeXmlFoldingRanges(lines: readonly string[]): Array<{ start: number; end: number }> {
  const stack: Array<{ name: string; line: number }> = [];
  const out: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNo = i + 1;
    const close = closeTagNameOf(line);
    if (close) {
      // 找到最近的同名开标签（中间那些没闭合的不动：折叠只是视图，不替作者修结构）
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k]!.name !== close) continue;
        const open = stack[k]!;
        if (lineNo > open.line) out.push({ start: open.line, end: lineNo });
        stack.length = k;
        break;
      }
      continue;
    }
    const open = openTagNameOf(line);
    if (open) stack.push({ name: open, line: lineNo });
  }
  return out;
}

/* ------------------------------ 大纲 ------------------------------ */

export interface XmlCommandSymbol {
  readonly label: string;
  readonly detail: string;
  readonly line: number;
}

/** 纯函数：把每个 `<command>` 投影成一条大纲符号（行 = 1 基） */
export function computeXmlCommandSymbols(lines: readonly string[]): XmlCommandSymbol[] {
  const out: XmlCommandSymbol[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!/<command[\s>]/.test(line)) continue;
    const attrs = attrsOnLine(line);
    const get = (n: string): string | undefined => attrs.find((a) => a.name === n)?.value;
    const com = get('com') ?? '';
    const name = get('name') ?? '';
    const place = get('kojoPlace') ?? get('place') ?? '';
    const priority = get('priority') ?? '';
    const label = [com, name].filter((s) => s.length > 0).join(' · ') || '<command>';
    const detail = [place, priority ? `优先级 ${priority}` : ''].filter((s) => s.length > 0).join(' / ');
    out.push({ label, detail, line: i + 1 });
  }
  return out;
}

/* ------------------------------ 注册 ------------------------------ */

let registered = false;

/** 挂上口上 XML 的增强面（幂等） */
export function registerKojoXmlProviders(monaco: typeof Monaco): void {
  if (registered) return;
  registered = true;

  monaco.languages.registerFoldingRangeProvider(KOJO_XML_ID, {
    provideFoldingRanges(model) {
      const lines: string[] = [];
      for (let i = 1; i <= model.getLineCount(); i++) lines.push(model.getLineContent(i));
      return computeXmlFoldingRanges(lines).map((r) => ({ start: r.start, end: r.end, kind: undefined }));
    },
  });

  monaco.languages.registerDocumentSymbolProvider(KOJO_XML_ID, {
    provideDocumentSymbols(model) {
      const lines: string[] = [];
      for (let i = 1; i <= model.getLineCount(); i++) lines.push(model.getLineContent(i));
      return computeXmlCommandSymbols(lines).map((sym) => ({
        name: sym.label,
        detail: sym.detail,
        kind: 12 /* SymbolKind.Function */,
        tags: [],
        range: new monaco.Range(sym.line, 1, sym.line, model.getLineMaxColumn(sym.line)),
        selectionRange: new monaco.Range(sym.line, 1, sym.line, model.getLineMaxColumn(sym.line)),
      }));
    },
  });

  monaco.languages.registerHoverProvider(KOJO_XML_ID, {
    provideHover(model, position) {
      const schema = currentKojoXmlSchema();
      if (!schema) return null;
      const line = model.getLineContent(position.lineNumber);
      const col = position.column - 1;
      for (const attr of attrsOnLine(line)) {
        if (col >= attr.nameStart && col <= attr.valueEnd) {
          const spec = schema.attributes.find((a) => a.name === attr.name);
          if (!spec) {
            return {
              contents: [
                { value: `**${attr.name}**` },
                { value: '这个属性不在当前游戏的规格表里：引擎可能忽略它（拼写检查见诊断）。' },
              ],
            };
          }
          return { contents: hoverContentsOf(spec) };
        }
      }
      return null;
    },
  });

  monaco.languages.registerCompletionItemProvider(KOJO_XML_ID, {
    triggerCharacters: ['<', ' ', '"'],
    provideCompletionItems(model, position) {
      const schema = currentKojoXmlSchema();
      // 没有规格就什么都不补：猜属性名比不补更糟（作者会以为那是游戏支持的写法）
      if (!schema) return { suggestions: [] };
      const line = model.getLineContent(position.lineNumber);
      const before = line.slice(0, position.column - 1);
      // 只在标签内部给补全（`<` 之后、`>` 之前）
      const lt = before.lastIndexOf('<');
      const gt = before.lastIndexOf('>');
      if (lt < 0 || gt > lt) return { suggestions: [] };

      const used = new Set(attrsOnLine(line).map((a) => a.name));
      const word = model.getWordUntilPosition(position);
      const range = new monaco.Range(
        position.lineNumber,
        word.startColumn,
        position.lineNumber,
        word.endColumn,
      );

      // 值位置（光标在引号内）：给枚举值
      const inValue = attrsOnLine(line).find(
        (a) => position.column - 1 > a.valueStart && position.column - 1 <= a.valueEnd + 1,
      );
      if (inValue) {
        const spec = schema.attributes.find((a) => a.name === inValue.name);
        const values = spec?.values ?? [];
        return {
          suggestions: values.map((v) => ({
            label: v,
            kind: 12 /* Value */,
            insertText: v,
            range,
          })),
        };
      }

      const suggestions = schema.attributes
        .filter((a) => a.on !== 'kojo' && !used.has(a.name))
        .map((a) => ({
          label: a.name,
          kind: 5 /* Field */,
          detail: a.values ? a.values.slice(0, 4).join(' | ') : (a.doc.length > 40 ? `${a.doc.slice(0, 40)}…` : a.doc),
          documentation: { value: a.doc },
          insertText: a.values && a.values.length > 0 ? `${a.name}="\${1|${a.values.join(',')}|}"` : `${a.name}="$1"`,
          insertTextRules: 4 /* InsertAsSnippet */,
          range,
        }));

      // `com` 的数字补全：单独一组（数量大，用 detail 区分）
      const comSpec = schema.attributes.find((a) => a.name === 'com');
      if (comSpec && !used.has('com')) {
        for (const cmd of schema.commands.slice(0, 400)) {
          suggestions.push({
            label: `com="${cmd.code}"`,
            kind: 12 /* Value */,
            detail: cmd.label,
            documentation: { value: `命令 ${cmd.code}：${cmd.label}` },
            insertText: `com="${cmd.code}"`,
            insertTextRules: 4 /* InsertAsSnippet */,
            range,
          });
        }
      }

      return { suggestions };
    },
  });
}

function hoverContentsOf(spec: KojoXmlAttributeSpec): Monaco.IMarkdownString[] {
  const parts: Monaco.IMarkdownString[] = [{ value: `**${spec.name}**${spec.required ? '（必填）' : ''}` }];
  parts.push({ value: spec.doc });
  if (spec.values && spec.values.length > 0) {
    parts.push({ value: `取值：${spec.values.map((v) => `\`${v}\``).join(' / ')}` });
  }
  return parts;
}

/** 本模块只服务这一门语言 */
const KOJO_XML_ID = 'kojo-xml';
