/**
 * 口上 XML 的**事件三格**投影（LAU-D3；`ARCH-language-unification.md` §5.4 第 3 行）。
 *
 * eraFL 的叙事正文是声明式数据：`<command com="300" name="会話" kojoPlace="TOP">`。
 * 这三格分别回答「哪条命令」「叫什么」「出现在哪」——方言体检要拿它们对事件目录，
 * 就必须先把它们从**行文本**里投影成带坐标的挂点（1 基行、1 基 UTF-16 码元列、尾列半开，
 * 与 Monaco / core / plugin-api 同一条坐标口径）。
 *
 * ## 为什么复用 `attrsOnLine` 而不新写扫描器
 *
 * 属性词法（引号、单引号、值内空白）在 `@kojo/kojo-lang/xml-attrs` 已经有一份**被补全/悬停/
 * 诊断三条腿共用**的实现（B5b C 类第三车从宿主 `kojo-xml-providers.ts` 搬进包，宿主那边改成
 * re-export、三个消费点一字未动）。再写一份正则 = 同一份 XML 有两种切法，"补全认得出的值、
 * 诊断认不出"就只是时间问题。所以本模块只做**选哪些属性算事件格**，词法一律调用那一枚。
 *
 * ## 凭什么元素算口上条目
 *
 * - `<command>`：现行格式，一格 `com` + `name` + `kojoPlace`；
 * - `<event>`：eraFL 的事件口上（`<event eventId="300" name="同行に誘う">`，真盘 7 处），
 *   第一格叫 `eventId`；
 * - `<kojo>`：旧格式的正文壳，位置写在它自己的 `place` 上（不是 `kojoPlace`）。
 *
 * 不认识的元素 / 拼错的标签（`<command_>`）一律不进表——拼写问题由解析器报
 * `kojo-xml.tag.command-misspelled`，本模块不替它猜。
 *
 * ## 为什么住插件不住宿主（B5b C 类第三车）
 *
 * 本模块与 `./kojo-xml-dialect` 是同一条判据链的两段（投影 → 诊断），宿主只剩 marker 装配，
 * 于是跟着方言体检那一车一起离开 `packages/app/src/monaco/**`。零 Monaco、零 React、零 IO。
 */
import { attrsOnLine } from '@kojo/kojo-lang/xml-attrs';

/** 事件三格：命令 / 名字 / 位置 */
export type KojoXmlEventCell = 'command' | 'name' | 'place';

/** 一处事件格（值区间 = 引号内文本，1 基、尾列半开） */
export interface KojoXmlEventSite {
  /** 这一格回答什么 */
  readonly cell: KojoXmlEventCell;
  /** 属性值（原样，未 trim） */
  readonly value: string;
  /** 属性名（原样；诊断文案要说清是哪一格） */
  readonly attribute: string;
  /** 所在元素（`command` / `event` / `kojo`） */
  readonly element: 'command' | 'event' | 'kojo';
  /** 1 基行 */
  readonly line: number;
  /** 值起始列（1 基） */
  readonly startColumn: number;
  /** 值结束列（1 基、半开） */
  readonly endColumn: number;
}

/** 元素 → 三格对应的属性名（`null` = 这个元素没有这一格） */
const CELL_ATTRIBUTES: Readonly<Record<string, Partial<Record<KojoXmlEventCell, readonly string[]>>>> = {
  command: { command: ['com'], name: ['name'], place: ['kojoPlace', 'place'] },
  event: { command: ['eventId'], name: ['name'] },
  kojo: { place: ['place'] },
};

/** 行首（或任意位置）的一个开标签（排除结束/声明/注释/CDATA） */
const OPEN_TAG_RE = /<(?![!?/])([A-Za-z_][\w.:-]*)(?=[\s>/])/g;

/** 该行所有的口上元素起始位置（0 基下标 → 元素名） */
function elementStarts(line: string): Array<{ index: number; element: 'command' | 'event' | 'kojo' }> {
  const out: Array<{ index: number; element: 'command' | 'event' | 'kojo' }> = [];
  OPEN_TAG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = OPEN_TAG_RE.exec(line)) !== null) {
    const name = match[1]!;
    if (name === 'command' || name === 'event' || name === 'kojo') {
      out.push({ index: match.index, element: name });
    }
  }
  return out;
}

/**
 * 整份文本 → 事件格列表（按行、按属性出现序；同一属性只取一次）。
 *
 * 纯函数、零 IO：测试与编辑器走同一条判据。属性区间由 `attrsOnLine` 给，
 * 本函数只做"属于哪个元素 / 是哪一格"的归属。
 */
export function kojoXmlEventSitesOf(lines: readonly string[]): KojoXmlEventSite[] {
  if (!Array.isArray(lines) || lines.length === 0) return [];
  const out: KojoXmlEventSite[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.indexOf('<') < 0) continue;
    const starts = elementStarts(line);
    if (starts.length === 0) continue;
    const attrs = attrsOnLine(line);
    if (attrs.length === 0) continue;
    for (const start of starts) {
      // 只取这个开标签之后、下一个开标签之前的属性（一行多标签时不串台）
      const next = starts.find((item) => item.index > start.index);
      const endIndex = next === undefined ? line.length : next.index;
      const cells = CELL_ATTRIBUTES[start.element];
      if (cells === undefined) continue;
      for (const cell of ['command', 'name', 'place'] as const) {
        const names = cells[cell];
        if (names === undefined) continue;
        for (const attr of attrs) {
          if (attr.nameStart <= start.index || attr.nameStart >= endIndex) continue;
          if (!names.includes(attr.name)) continue;
          out.push({
            cell,
            value: attr.value,
            attribute: attr.name,
            element: start.element,
            line: index + 1,
            startColumn: attr.valueStart + 1,
            endColumn: attr.valueEnd + 1,
          });
          break;
        }
      }
    }
  }
  return out;
}
