/**
 * eraFL 2.0 演出面（游戏事实 —— 只住本包）。
 *
 * 权威依据：设计稿 §4.8（`(心形)`）、§8.2（`@着色`）、§8.3（`@颜绘`）、§7.5（`选项`）。
 * core 只认"声明了哪些演出面"，具体引擎指令名一律查本表。
 *
 * **逐面按真盘读数裁决，不按 eraTW 的形态照抄**（交接文档入口 B 裁决表原假设
 * "大面积声明不支持"被读数部分修正）：
 *
 * | 面 | 裁决 | 真盘依据（2026-10-24 `D:/Game/erafl`） |
 * | --- | --- | --- |
 * | 心形 | **null** | 语料零心形打印函数（"心形" 5 处命中全是台词文本内容，不是指令） |
 * | 着色 | **声明** | `SETCOLOR` 1,932 处 / `RESETCOLOR` 841 处 / hex 实参形 245 处 |
 * | 颜绘 | **null** | `PRINT_FACE` 0 处；eraFL 的立绘/表情在 XML 属性（`kojoPlace`/`priority`/`emotion`，见 `preview/conditions.ts` 白名单） |
 * | 选项 | **null** | `PRINTBUTTON`/`INPUTS` 全树 806 处但**口上域只有 2 处**（其余全在系统菜单域）；2.0 `选项` 面向口上作者 ⇒ 不声明，用了报 unsupported（fail-visible） |
 */
import type { AdapterPresentation } from '@kojo/kojo-core';

/**
 * `@着色 0xRRGGBB` → `SETCOLOR` … `RESETCOLOR`（配对由 core 自动补，作者不手写）。
 *
 * `hexPrefix: '0x'`：hex 实参形实测 245 处（`SETCOLOR 0x…`）。语料里另有**命名色**
 * 两种形——`COLOR("银色")`（游戏侧函数，定义在 `ERB/SYSTEM/FUNCTION/_FUNCTION_DESIGN.ERB:18`）
 * 与 `カラー_ライトブルー` 一类常量——它们是**函数调用/常量引用，不是颜色字面量**，
 * 所以不进 `hexPrefix` 的管辖（本字段只描述字面量前缀）。
 */
const COLOR = Object.freeze({
  setColor: 'SETCOLOR',
  resetColor: 'RESETCOLOR',
  hexPrefix: '0x',
});

/**
 * eraFL 演出面：只有 `color` 一面有语料支撑；其余三面 null。
 *
 * null = "当前 adapter 不支持"（§10.10：core 在使用时报该面的 unsupported 错误）——
 * 对 eraFL 这是**如实声明**：心形/颜绘的演出确实在 XML 属性侧（入口 E 的战场），
 * 选项确实不在口上域用法里。补全数据（`faceTemplates` / `hintNames`）跟着能力面走：
 * 能力没声明就不给候选。
 */
export const ERAFL_PRESENTATION: AdapterPresentation = Object.freeze({
  heart: null,
  color: COLOR,
  face: null,
  options: null,
});
