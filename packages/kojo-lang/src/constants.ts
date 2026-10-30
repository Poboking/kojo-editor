/**
 * Kojo 2.0 的**零依赖身份叶子**（K2-CUTOVER-THEME）：语言 id 与源扩展名两枚字符串。
 *
 * 为什么单开一层：这两枚此前住在 `kojo2-language.ts`，而那个模块一加载就拖上
 * `kojo2-enter → kojo2-lexicon → @kojo/plugin-kojo-sugar`（~900 KB 词表 + 表达式表；
 * 那条指针壳 `kojo2-enter.ts` 已在 B3d 删除）。
 * 但真正的消费方要的只是两个字符串——
 * - `ui/kojo2-cutover.ts`（路由层，刻意零 Monaco、零 DOM，见其头注）要用扩展名；
 * - `ui/kojo2-model-language.ts`（重挂层）要用语言 id 与"这是不是 2.0 文件"的判据。
 *
 * 为两枚字符串把整条词表链拽进路由层，是 PS-10 断链批一直在拆的那种"判据住在重模块里"。
 * 所以把**字面源**下沉到本文件（零 import，连 type import 都不需要），由
 * `kojo2-language.ts` 按同一对象 re-export：既有 import 点（`languages.ts` /
 * `ui/kojo2-open.ts` / 测试）读到的值一字不变，`kojo-extension-single-source.test.ts`
 * 另有一条"全仓 `.kojo2` 字面量只此一处"的守门（本文件即唯一豁免）。
 *
 * 换扩展名 / 换 id 时**只改这里**：语言注册、路由判据、model 语言重挂三处自动跟上。
 */

/** Monaco 语言 id（也是 `ITextModel.getLanguageId()` 的返回值） */
export const KOJO2_LANGUAGE_ID = 'kojo2';

/** 2.0 源扩展名（含点、小写；匹配一律对最后一段扩展名做小写归一） */
export const KOJO2_SOURCE_EXTENSION = '.kojo2';

/** 2.0 行注释起头（ERB-PARITY G9）：`language-config` 与宿主 descriptor 同读这一枚 */
export const KOJO2_LINE_COMMENT = '//';
