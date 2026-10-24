/**
 * 口上 XML 手写扫描解析器。
 *
 * 为什么手写而不用 XML 库：仓库没有 XML 依赖（本批也不许加），而口上 XML 的要求
 * 恰好是"扫描式"的强项——
 * 1. **不抛异常**：语料是玩家/作者手改的，坏一份不能让整次索引挂掉；
 * 2. **要坐标**：编辑器的跳转、高亮、诊断都要回指原文（1 基行列），
 *    通用库给的是对象树，不给"这个文本在原文第几行第几列"；
 * 3. **要容错**：未闭合、少引号、拼错的标签名都要"能读多少读多少"，
 *    而不是像严格解析器那样第一处错误就放弃。
 *
 * 结构判据（eraFL 语料实测）：
 * - 现行格式 `<data>` 根 → 若干 `<command ...>` → `<contents>正文</contents>`；
 * - 旧格式 `<kojodef>` 根 → `<command com="300" name="会話">` → `<kojo ...>正文</kojo>`；
 * - 其余元素（`<event>` / `<preset>` / `<parts>` / `<color>` / `<li>` / `<save>` …）
 *   一律当"不认识"跳过，**不报诊断**——它们在同目录的其它 xml 里是合法内容，
 *   报错只会把作者淹在噪声里。只有"结构性可证明的问题"才出声。
 */

import type {
  KojoXmlCommand,
  KojoXmlDiagnostic,
  KojoXmlEncoding,
  KojoXmlFile,
  KojoXmlFormat,
  KojoXmlPosition,
  KojoXmlSpan,
  KojoXmlSeverity,
} from '@kojo/plugin-api';

/** `parseKojoXmlText` 的入参（`text` 已解码、不含 BOM） */
export interface ParseKojoXmlInput {
  readonly path: string;
  readonly text: string;
  readonly encoding: KojoXmlEncoding;
  readonly charaNo: number | null;
}

/** 诊断码（点分命名空间；面板按前缀分组） */
export const KOJO_XML_DIAG = {
  /** 声明的 encoding 与字节实际编码不符（9 份 UTF-16 声明 utf-8 就落这条） */
  encodingMismatch: 'kojo-xml.encoding.mismatch',
  /** 根元素不是 data / kojodef */
  rootUnknown: 'kojo-xml.root.unknown',
  /** 文件里一个元素都没有 */
  rootMissing: 'kojo-xml.root.missing',
  /** 到文件末尾仍未闭合 */
  unclosedTag: 'kojo-xml.syntax.unclosed-tag',
  /** 结束标签没有对应的开始标签 */
  unexpectedEndTag: 'kojo-xml.syntax.unexpected-end-tag',
  /** 标签本身没写完（缺 `>`） */
  unterminatedTag: 'kojo-xml.syntax.unterminated-tag',
  /** 属性值没加引号 */
  unquotedAttribute: 'kojo-xml.syntax.unquoted-attribute',
  /** 属性只有名字没有值 */
  valuelessAttribute: 'kojo-xml.syntax.valueless-attribute',
  /** 引号没闭合 */
  unterminatedAttribute: 'kojo-xml.syntax.unterminated-attribute',
  /** 注释没闭合 */
  unclosedComment: 'kojo-xml.syntax.unclosed-comment',
  /** 拼错的 command（如 `<command_>`）：引擎不认，整条口上会静默消失 */
  misspelledCommand: 'kojo-xml.tag.command-misspelled',
} as const;

const CH_TAB = 9;
const CH_LF = 10;
const CH_CR = 13;
const CH_SPACE = 32;
const CH_BANG = 33;
const CH_DQUOTE = 34;
const CH_HASH = 35;
const CH_AMP = 38;
const CH_SQUOTE = 39;
const CH_DASH = 45;
const CH_DOT = 46;
const CH_SLASH = 47;
const CH_0 = 48;
const CH_9 = 57;
const CH_COLON = 58;
const CH_EQ = 61;
const CH_GT = 62;
const CH_QMARK = 63;
const CH_A = 65;
const CH_Z = 90;
const CH_UNDERSCORE = 95;
const CH_a = 97;
const CH_z = 122;

function isNameStart(c: number): boolean {
  return (
    (c >= CH_A && c <= CH_Z) ||
    (c >= CH_a && c <= CH_z) ||
    c === CH_UNDERSCORE ||
    c === CH_COLON ||
    c > 127 // 非 ASCII 也可能是合法的 XML 名字（语料里没有，但不该被当成正文）
  );
}

function isNameChar(c: number): boolean {
  return isNameStart(c) || (c >= CH_0 && c <= CH_9) || c === CH_DASH || c === CH_DOT;
}

function isSpace(c: number): boolean {
  return c === CH_SPACE || c === CH_TAB || c === CH_LF || c === CH_CR;
}

/** XML 预定义实体；`&#…;` 数值实体另行处理 */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
};

/**
 * 解实体。属性值与正文共用同一条判据（属性里的 `eval="{TSTR:… == &quot;商談&quot;}"`
 * 必须解回真引号，否则编辑器把表达式原样显示成一堆 `&quot;`）。
 *
 * 认不出来的 `&…;` 原样保留：语料里没有自定义实体，而把未知实体吞掉会让
 * 作者看不见自己写错的地方。
 */
export function decodeKojoXmlEntities(raw: string): string {
  if (!raw.includes('&')) return raw; // 绝大多数正文没有实体，省一次整串正则
  return raw.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.charCodeAt(0) === CH_AMP - 3 /* '#' = 35 */) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = hex ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      // 越界码点不猜（XML 本身也不允许），原样留着让作者看见
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}

/**
 * 行首下标表。换行判据与 Monaco 一致：`\r\n` / `\r` / `\n` 各算一次换行，
 * 于是 CRLF 里的 `\n` 落在**上一行的行尾**（列 = 行长 + 1），下一字符才是新行首。
 * 这样"行列 → 下标"与"下标 → 行列"互为逆运算，span 切出来的子串才逐字等于原文。
 */
function buildLineStarts(text: string): number[] {
  const starts: number[] = [0];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === CH_CR) {
      if (text.charCodeAt(i + 1) === CH_LF) i++;
      starts.push(i + 1);
    } else if (c === CH_LF) {
      starts.push(i + 1);
    }
  }
  return starts;
}

function positionAt(lineStarts: readonly number[], index: number): KojoXmlPosition {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid]! <= index) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: index - lineStarts[lo]! + 1 };
}

/** 一帧 = 一个尚未闭合的元素 */
interface Frame {
  readonly name: string;
  /** 开始标签 `<` 的下标 */
  readonly start: number;
  readonly attrs: Record<string, string>;
  /** 开始标签 `>` 之后的下标（正文起点） */
  readonly contentStart: number;
  /** 子元素回填的正文区间 */
  readonly collected: ContentRange[];
}

interface ContentRange {
  readonly kind: 'contents' | 'kojo';
  readonly start: number;
  readonly end: number;
  readonly attrs?: Record<string, string>;
}

/** XML 声明里的 encoding 值（认不出 = null） */
function readDeclaredEncoding(piText: string): string | null {
  const m = /\bencoding\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(piText);
  if (!m) return null;
  return (m[1] ?? m[2] ?? '').trim() || null;
}

/** 编码族（声明写 utf-16 而字节是 utf-16le 不算不符） */
function encodingFamily(name: string): 'utf-8' | 'utf-16' | 'other' {
  const n = name.toLowerCase().replace(/[_\s]/g, '-');
  if (n === 'utf-8' || n === 'utf8') return 'utf-8';
  if (n === 'utf-16' || n === 'utf16' || n === 'utf-16le' || n === 'utf-16be') return 'utf-16';
  return 'other';
}

/**
 * 解析一份口上 XML。**任何输入都不抛异常**（包括空串、二进制乱码、半截文件）。
 */
export function parseKojoXmlText(input: ParseKojoXmlInput): KojoXmlFile {
  const text = input.text;
  const n = text.length;
  const lineStarts = buildLineStarts(text);

  const span = (start: number, end: number): KojoXmlSpan => ({
    start: positionAt(lineStarts, Math.max(0, Math.min(start, n))),
    end: positionAt(lineStarts, Math.max(0, Math.min(end, n))),
  });

  const diagnostics: KojoXmlDiagnostic[] = [];
  const report = (
    severity: KojoXmlSeverity,
    code: string,
    message: string,
    start: number,
    end: number,
    data?: Record<string, string>,
  ): void => {
    const diagnostic: KojoXmlDiagnostic = {
      path: input.path,
      severity,
      code,
      message,
      span: span(start, end),
    };
    diagnostics.push(data ? { ...diagnostic, data } : diagnostic);
  };

  const commands: KojoXmlCommand[] = [];
  const stack: Frame[] = [];
  let rootName: string | null = null;
  let rootStart = 0;
  let rootOpenEnd = 0;
  let declaredEncoding: string | null = null;
  let declStart = -1;
  let declEnd = -1;

  const emitCommand = (frame: Frame, elementEnd: number): void => {
    const contents = frame.collected.filter((r) => r.kind === 'contents');
    // 旧格式的正文在 <kojo> 里；两种都有的文件以 <contents> 为准（现行格式优先）
    const used = contents.length > 0 ? contents : frame.collected.filter((r) => r.kind === 'kojo');
    const attrs: Record<string, string> = { ...frame.attrs };
    // 旧格式的判据属性（place / isFall / priority…）挂在 <kojo> 上：
    // 合并进 attrs 才能让消费方用同一套键读两种格式（同名时以子元素为准，它是更具体的那一层）
    for (const range of used) {
      if (range.attrs) Object.assign(attrs, range.attrs);
    }
    const contentText = used
      .map((r) => decodeKojoXmlEntities(text.slice(r.start, r.end)))
      .join('');
    const contentSpan =
      used.length > 0
        ? span(used[0]!.start, used[used.length - 1]!.end)
        : null;
    commands.push({
      index: commands.length,
      span: span(frame.start, elementEnd),
      contentSpan,
      attrs,
      text: contentText,
    });
  };

  /**
   * 收束一帧。`elementEnd` = 含结束标签的末尾，`contentEnd` = 结束标签的起点。
   *
   * `parent` **必须显式传**：调用点都是"先出栈再收束"，若在这里读
   * `stack[length-2]`，取到的是祖父层（`data`），正文就会被挂到根上、`<command>`
   * 收不到任何正文——表现为"能解析出条目但台词全空"。
   */
  const finishFrame = (
    frame: Frame,
    elementEnd: number,
    contentEnd: number,
    parent: Frame | null,
  ): void => {
    if (frame.name === 'contents' || frame.name === 'kojo') {
      if (parent && (parent.name === 'command' || parent.name === 'kojo')) {
        parent.collected.push({
          kind: frame.name,
          start: frame.contentStart,
          end: contentEnd,
          attrs: frame.attrs,
        });
      }
      return;
    }
    if (frame.name === 'command') emitCommand(frame, elementEnd);
  };

  let i = 0;
  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt < 0) break;
    i = lt;
    const c1 = text.charCodeAt(i + 1);

    // <!-- 注释 -->：整段跳过。语料里有 1029 处注释，其中不少是"注释掉的口上"，
    // 若不跳过就会把它们算成真条目。
    if (c1 === CH_BANG) {
      if (text.startsWith('<!--', i)) {
        const close = text.indexOf('-->', i + 4);
        if (close < 0) {
          report('error', KOJO_XML_DIAG.unclosedComment, '注释没有闭合（缺 `-->`）', i, Math.min(n, i + 4));
          break;
        }
        i = close + 3;
        continue;
      }
      if (text.startsWith('<![CDATA[', i)) {
        const close = text.indexOf(']]>', i + 9);
        if (close < 0) {
          report('error', KOJO_XML_DIAG.unclosedComment, 'CDATA 段没有闭合（缺 `]]>`）', i, Math.min(n, i + 9));
          break;
        }
        i = close + 3;
        continue;
      }
      // DOCTYPE 等其它声明：整段跳
      const gt = text.indexOf('>', i + 2);
      if (gt < 0) break;
      i = gt + 1;
      continue;
    }

    // <?xml … ?>：只关心 encoding 声明
    if (c1 === 63 /* '?' */) {
      const close = text.indexOf('?>', i + 2);
      if (close < 0) break;
      if (declStart < 0) {
        declStart = i;
        declEnd = close + 2;
        declaredEncoding = readDeclaredEncoding(text.slice(i, close));
      }
      i = close + 2;
      continue;
    }

    // </name>
    if (c1 === CH_SLASH) {
      let j = i + 2;
      const nameStart = j;
      while (j < n && isNameChar(text.charCodeAt(j))) j++;
      const endName = text.slice(nameStart, j);
      const gt = text.indexOf('>', j);
      if (gt < 0) {
        report(
          'error',
          KOJO_XML_DIAG.unterminatedTag,
          `结束标签 </${endName}> 没有闭合的 \`>\``,
          i,
          n,
        );
        break;
      }
      const tagEnd = gt + 1;
      if (!endName) {
        report('error', KOJO_XML_DIAG.unterminatedTag, '结束标签缺少元素名（`</>`）', i, tagEnd);
        i = tagEnd;
        continue;
      }
      let match = -1;
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k]!.name === endName) {
          match = k;
          break;
        }
      }
      if (match < 0) {
        report(
          'error',
          KOJO_XML_DIAG.unexpectedEndTag,
          `结束标签 </${endName}> 没有对应的开始标签`,
          i,
          tagEnd,
        );
        i = tagEnd;
        continue;
      }
      // 中间那些没闭合的帧：报到它们自己的开始标签上（比报到这里更好定位）
      while (stack.length - 1 > match) {
        const orphan = stack[stack.length - 1]!;
        report(
          'error',
          KOJO_XML_DIAG.unclosedTag,
          `标签 <${orphan.name}> 未闭合（被 </${endName}> 提前收束）`,
          orphan.start,
          orphan.contentStart,
        );
        finishFrame(orphan, i, i, stack[stack.length - 2] ?? null);
        stack.pop();
      }
      const frame = stack.pop()!;
      finishFrame(frame, tagEnd, i, stack[stack.length - 1] ?? null);
      i = tagEnd;
      continue;
    }

    // 正文里的裸 `<`（如「<3」）：当文本，不报错也不当标签
    if (!isNameStart(c1)) {
      i += 1;
      continue;
    }

    // <name attr="…" …>
    const tagStart = i;
    let j = i + 1;
    const nameStart = j;
    while (j < n && isNameChar(text.charCodeAt(j))) j++;
    const name = text.slice(nameStart, j);
    const attrs: Record<string, string> = {};
    let selfClosing = false;
    let tagClosed = false;

    while (j < n) {
      while (j < n && isSpace(text.charCodeAt(j))) j++;
      if (j >= n) break;
      const c = text.charCodeAt(j);
      if (c === CH_GT) {
        j += 1;
        tagClosed = true;
        break;
      }
      if (c === CH_SLASH) {
        if (text.charCodeAt(j + 1) === CH_GT) {
          j += 2;
          selfClosing = true;
          tagClosed = true;
          break;
        }
        j += 1; // 多余的斜杠：跳过，不改变结构判据
        continue;
      }
      const attrNameStart = j;
      while (j < n) {
        const ac = text.charCodeAt(j);
        if (isSpace(ac) || ac === CH_EQ || ac === CH_GT || ac === CH_SLASH) break;
        j++;
      }
      const attrName = text.slice(attrNameStart, j);
      while (j < n && isSpace(text.charCodeAt(j))) j++;
      if (text.charCodeAt(j) !== CH_EQ) {
        if (attrName) {
          // 只有名字没有值：XML 非法，但值按空串收下，后面的属性照读
          report(
            'error',
            KOJO_XML_DIAG.valuelessAttribute,
            `属性 \`${attrName}\` 没有取值`,
            attrNameStart,
            j,
          );
          attrs[attrName] = '';
        }
        continue;
      }
      j += 1; // '='
      while (j < n && isSpace(text.charCodeAt(j))) j++;
      const quote = text.charCodeAt(j);
      if (quote === CH_DQUOTE || quote === CH_SQUOTE) {
        const valueStart = j + 1;
        const valueEnd = text.indexOf(String.fromCharCode(quote), valueStart);
        if (valueEnd < 0) {
          report(
            'error',
            KOJO_XML_DIAG.unterminatedAttribute,
            `属性 \`${attrName}\` 的引号没有闭合`,
            attrNameStart,
            n,
          );
          attrs[attrName] = decodeKojoXmlEntities(text.slice(valueStart));
          j = n;
          break;
        }
        attrs[attrName] = decodeKojoXmlEntities(text.slice(valueStart, valueEnd));
        j = valueEnd + 1;
        continue;
      }
      // 没加引号：读到空白 / '>' 为止，照样收下值（"能解析多少给多少"）
      const valueStart = j;
      while (j < n) {
        const vc = text.charCodeAt(j);
        if (isSpace(vc) || vc === CH_GT || vc === CH_SLASH) break;
        j++;
      }
      report(
        'error',
        KOJO_XML_DIAG.unquotedAttribute,
        `属性 \`${attrName}\` 的值没有加引号`,
        attrNameStart,
        j,
      );
      attrs[attrName] = decodeKojoXmlEntities(text.slice(valueStart, j));
    }

    if (!tagClosed) {
      report(
        'error',
        KOJO_XML_DIAG.unterminatedTag,
        `开始标签 <${name}> 没有闭合的 \`>\``,
        tagStart,
        n,
      );
      break;
    }

    if (stack.length === 0 && rootName === null) {
      rootName = name;
      rootStart = tagStart;
      rootOpenEnd = j;
    } else if (stack.length === 1 && name !== 'command' && name.startsWith('command')) {
      // `<command_>` 这类拼写：XML 本身合法，引擎却按未知元素跳过 ⇒ 整条口上静默消失。
      // 这是语料里真实存在的写法（2003_NPC_メスガキアマゾネス/KOJO_K2003_COM.xml 28 处）。
      report(
        'warning',
        KOJO_XML_DIAG.misspelledCommand,
        `标签 <${name}> 疑似 \`<command>\` 的拼写错误，引擎会把它当未知元素跳过`,
        tagStart,
        j,
        { tag: name },
      );
    }

    const frame: Frame = {
      name,
      start: tagStart,
      attrs,
      contentStart: j,
      collected: [],
    };
    if (selfClosing) {
      finishFrame(frame, j, j, stack[stack.length - 1] ?? null);
    } else {
      stack.push(frame);
    }
    i = j;
  }

  // 文件结束仍在栈上的：逐个报未闭合，但内容照样收（半截文件也能出东西）
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    report(
      'error',
      KOJO_XML_DIAG.unclosedTag,
      `标签 <${frame.name}> 未闭合（到文件末尾仍未收束）`,
      frame.start,
      frame.contentStart,
    );
    finishFrame(frame, n, n, stack[stack.length - 2] ?? null);
    stack.pop();
  }

  // 根元素
  let format: KojoXmlFormat = 'unknown';
  if (rootName === 'data') format = 'data';
  else if (rootName === 'kojodef') format = 'kojodef';
  if (rootName === null) {
    report('error', KOJO_XML_DIAG.rootMissing, '文件里没有任何元素，不是口上 XML', 0, 0);
  } else if (format === 'unknown') {
    report(
      'error',
      KOJO_XML_DIAG.rootUnknown,
      `根元素 <${rootName}> 不是口上格式（期望 <data> 或 <kojodef>）`,
      rootStart,
      rootOpenEnd,
      { root: rootName },
    );
  }

  // 编码：BOM 是事实、声明是文本，冲突时必须让作者知道"你写的那行没生效"
  if (declaredEncoding) {
    const declaredFamily = encodingFamily(declaredEncoding);
    const actualFamily = input.encoding === 'utf-16le' || input.encoding === 'utf-16be' ? 'utf-16' : 'utf-8';
    if (declaredFamily !== actualFamily) {
      report(
        'warning',
        KOJO_XML_DIAG.encodingMismatch,
        `声明 encoding="${declaredEncoding}"，实际字节是 ${input.encoding}（以 BOM 为准）`,
        declStart >= 0 ? declStart : 0,
        declEnd >= 0 ? declEnd : 0,
        { declared: declaredEncoding, actual: input.encoding },
      );
    }
  }

  diagnostics.sort((a, b) => {
    if (a.span.start.line !== b.span.start.line) return a.span.start.line - b.span.start.line;
    if (a.span.start.column !== b.span.start.column) return a.span.start.column - b.span.start.column;
    return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
  });

  return {
    path: input.path,
    format,
    encoding: input.encoding,
    // 契约只有 crlf / lf 两档：混排时按"有 CRLF 就是 CRLF"报（写回时保 CRLF 更安全）
    eol: text.includes('\r\n') ? 'crlf' : 'lf',
    charaNo: input.charaNo,
    commands,
    diagnostics,
  };
}
