/**
 * ERB 语言面的**最小常量叶子**（`@kojo/erb-lang/constants`）。
 *
 * ## 为什么语言 id 要在这里有第二处
 *
 * 判据整块住在本包之后，**供方是插件**（`@kojo/plugin-erb-lang`），而插件看不见宿主
 * （`packages/app/src/**` 不在它的可 import 面里，audit 也不许）。插件认"这份请求是不是
 * ERB 的活"必须有一个**不依赖宿主**的 id 清单——所以它落在这里，由宿主的接线测试
 * （`packages/app/tests/erb-highlight-selection.test.ts`）与宿主的 `ERB_LANGUAGE_ID`
 * 对拍：宿主换 id 而这里不换，那条用例当场红。
 *
 * ## 两个 id 都是真的
 *
 * - `'kojo-erb'`：宿主 `monaco/erb-language.ts` 的 `ERB_LANGUAGE_ID`，`.erb` / `.erm` /
 *   `.erh` 打开时的 model 语言 id（`ITextModel.getLanguageId()` 原样递进请求）；
 * - `'erb'`：短形式。`@kojo/plugin-inline-completion-local` 的 `ERB_LANGUAGE_IDS` 已经
 *   同时认这两个（同一门语言的两种写法），tree-sitter 侧的注入子语言也叫 `erb`。
 *   宿主今天不会用它当 Monaco 语言 id，但**请求是数据**——认它不花代价，漏它的代价是
 *   "某个派生 model 上这两条腿静默哑掉"。
 *
 * 顺序即优先级（仅供报告阅读；`includes` 判据与顺序无关）。
 */
export const ERB_LANGUAGE_IDS: readonly string[] = Object.freeze(['kojo-erb', 'erb']);
