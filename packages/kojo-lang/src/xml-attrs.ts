/**
 * XML 开标签的**属性词法**唯一实现（B5b C 类第三车：从宿主 `monaco/kojo-xml-providers.ts` 逐字搬来，
 * 判据、正则、列口径一字未改）。
 *
 * ## 为什么住包不住宿主
 *
 * 这枚词法此前被宿主的补全 / 悬停 / 诊断三条腿共用；`@kojo/plugin-ui-kojo-xml` 的
 * **事件三格投影**（`kojo-xml-event-sites.ts`）也吃它——那条腿的判据从宿主搬进插件之后，
 * 插件读不到 `packages/app/src/**`，词法留在宿主就等于逼插件各抄一份正则
 * （"补全认得出的值、诊断认不出"正是那份头注要防的事）。
 *
 * 搬进来后两侧引同一枚：
 * - 宿主 `monaco/kojo-xml-providers.ts` 改成 `export { attrsOnLine } from '@kojo/kojo-lang/xml-attrs'`，
 *   它那三个消费点与单测的 import 路径一字未动；
 * - 插件走 `@kojo/kojo-lang/xml-attrs`（叶子，不碰桶）。
 *
 * 本叶子零依赖（不引 core、不引契约层）、零 IO、纯函数。
 *
 * ## 坐标口径
 *
 * 行内 **0 基 UTF-16 码元列**，`valueStart` / `valueEnd` 指向**引号内**的文本（不含引号）。
 * 要 1 基（Monaco / core / plugin-api 那条口径）的调用方自己 +1 —— 事件三格投影就是这么做的。
 */

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
