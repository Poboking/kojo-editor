/**
 * `@kojo/kojo-vocab` —— 语言层共用词表与纯函数（LAU-3b 解耦批）。
 *
 * 住在这一包里的东西的共同点：**ERB 与 kojo1/kojo2 都要用，且不属于任何一门语言的
 * 转译器**。kojo1（`@kojo/plugin-kojo-sugar`）封存、乃至删除之后，这些事实仍必须
 * 为 ERB 补全、kojo2 词法与宿主格式化服务。
 *
 * **消费方请按子路径引**，别引桶：
 * - 词表：`keywords`（中文主形 / 运算符 / 时机表）、`system-functions`（中文函数名）、
 *   `statement-functions`、`engine-globals`、`engine`（引擎变量族 + `makeLookup`）；
 * - 词法/排版：`identifier-chars`、`blank-charset`、`sugar-ident`、`lexer`、`formatter`；
 * - 编辑行为：`enter`（回车层级正则族）、`types`（共享类型）；
 * - 语言面判据：`native-hover`（中文 → 原生形态悬停反查，NAT-HOV 批自宿主搬入）、
 *   `native-marks`（`.kojo1` 糖区原生标记位与替换区间，同批）、
 *   `signature`（v1 面签名帮助判据，LAU-DUALLEG 车 5 自宿主搬入：宿主答 kojo1、
 *   插件供方 `@kojo/plugin-erb-lang` 答 ERB，同一把尺子）。
 *
 * 桶**故意不 re-export**：`lexer` / `formatter` 与几枚叶子之间有同名导出（历史原因），
 * 且把 200 KB 的排版链塞进任何只取一枚词表的调用方都是浪费——子路径是唯一入口。
 */
export {};
