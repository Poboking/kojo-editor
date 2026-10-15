import { formatText, type FormatDialect, type FormatEdit } from '@kojo/plugin-kojo-sugar';

/**
 * 保存时格式化（E2）——**纯函数**：内存文本进，(新文本 + edits) 出。
 * 零 React、零 Monaco、零 IO，所以整条判断能在 node 里钉死。
 *
 * ## 同一真源
 *
 * 这里调的就是 `Shift+Alt+F` 那一份 `formatText`（`@kojo/plugin-kojo-sugar/formatter`）。
 * 不复制规则、不"保存专用简化版"——两套规则迟早分叉，分叉的结果是同一个文件
 * 手动格式化与自动格式化给出不同字节，那比没有格式化更糟。
 *
 * ## 与全角空格保存告警的关系（本批的真陷阱）
 *
 * 告警的真源是 `planSave` 对**它拿到的那份文本**跑 `fullwidthSpaceLines`。所以顺序
 * 决定了行为，而顺序只有一条：**先格式化，再走既有保存链路**（备份 / 原子写 /
 * 保编码 / 产物落盘一条都不绕开）。
 * - 格式化把缩进位与注释里的 `U+3000` 折成半角 ⇒ 这些行不再进 `fullwidthSpaceLines`
 *   ⇒ **不弹**（不是把选择吞掉，是它们已经不成立了）；
 * - 台词正文里的 `U+3000` 格式化**故意不动**（那是打印给玩家的排版）⇒ 仍然弹，
 *   且只弹一次：用户选「替换为半角并保存」后重存，格式化第二轮零改动 ⇒ 不再弹；
 *   选「仍然保存」则带 `acknowledgeFullwidthSpace` 重存 ⇒ 也不再弹。
 * 本模块**绝不**自己置 `acknowledgeFullwidthSpace`：那是作者的判断，不是软件的。
 * - 偏好关着 ⇒ 返回原文与空 edits，保存链路逐字按既有行为走（三选弹窗照旧）。
 */

/** 一次"保存前整理"的结果 */
export interface FormatOnSaveResult {
  /** 落盘该用的文本（未开启或未改动时 === 传入文本） */
  readonly text: string;
  /** 本次实际改动（供宿主一次性落进 model ⇒ 一个撤销步） */
  readonly edits: readonly FormatEdit[];
  /** 是否真的改写了（`false` = model 不用动） */
  readonly changed: boolean;
}

const UNCHANGED = (text: string): FormatOnSaveResult => ({ text, edits: [], changed: false });

/** 规则本体（可注入替身；缺省 = `Shift+Alt+F` 用的那一份，不是"保存专用简化版"） */
export type FormatRunner = (text: string, dialect: FormatDialect) => { text: string; edits: FormatEdit[] };

/**
 * 开启时跑同一份格式化；**任何异常都不许挡住保存**：整理失败就按原文保存，
 * 并把原因 warn 出去（"内核不静默"——功能退化要看得见，但丢作者的稿子不行）。
 */
export function applyFormatOnSave(
  text: string,
  dialect: FormatDialect | null,
  enabled: boolean,
  format: FormatRunner = formatText,
): FormatOnSaveResult {
  if (!enabled || dialect === null) return UNCHANGED(text);
  let result: { text: string; edits: FormatEdit[] };
  try {
    result = format(text, dialect);
  } catch (e: unknown) {
    console.warn(`[format-on-save] 整理失败，按原文保存：${e instanceof Error ? e.message : String(e)}`);
    return UNCHANGED(text);
  }
  if (result.edits.length === 0) return UNCHANGED(text);
  return { text: result.text, edits: result.edits, changed: true };
}
