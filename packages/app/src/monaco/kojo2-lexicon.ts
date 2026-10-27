/**
 * 宿主侧的 **2.0 词表出口**（SDK B4：词表单源已搬进 `@kojo/kojo-lang/lexicon`）。
 *
 * 本文件只剩一行 re-export，**正文删掉是因为它不能再有正文**：词表是语言面，供方
 * （`@kojo/plugin-kojo-lang`）与宿主都要读同一批词形，而插件读不到宿主模块。宿主留一份
 * 就是第二份判据——`kojo2-language-lexicon.test.ts` 的"零抄本"闸从此扫的是包里的真身
 * （`KOJO2_SOURCES` 已指到 `packages/kojo-lang/src/`）。
 *
 * 既有 import 点（`kojo2-indent.ts` / `kojo2-format.ts` / `kojo2-completion.ts` / 各测试）
 * 一字未改：这一行的作用就是把它们原样接到真源，读到的数组是**同一枚对象**。
 */
export * from '@kojo/kojo-lang/lexicon';
