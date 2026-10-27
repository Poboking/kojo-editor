/**
 * `ui.monaco.language` 的**供方**（SDK B4）：把 `@kojo/kojo-lang` 的 2.0 语言面交出去。
 *
 * ## 这一枚文件为什么只有"装配"没有"内容"
 *
 * 判据全在语言面库（词表 / Monarch / 语言配置 / 三套主题声明），本文件只做一件事：
 * 把它们**按契约字段名归到一格**里。写第二份正则、抄第二个色值，就是本批次要消灭的东西。
 *
 * ```
 * @kojo/kojo-lang/monarch          → surface.monarch
 * @kojo/kojo-lang/language-config  → surface.configuration
 * @kojo/kojo-lang/monaco-theme     → surface.themes（三套，注册序 = 数组序）
 * ```
 *
 * ## 类型标注本身就是闸
 *
 * 整枚对象显式标注成契约的 {@link MonacoLanguageSurface}：包里的数据一旦与契约差一格
 * （多一个键 / `indentAction` 写了枚举数字 / 主题少一侧部件色名），**编译期就红**，
 * 不用等运行期那条 warn。这就是"供方侧静态对拍"，另一半（运行期按形状丢弃）在宿主的
 * `monaco-language-surface.ts`。
 *
 * ## `wordPattern` 为什么不在这里
 *
 * 词边界是全编辑器一条线（双击选词 / 补全触发字符共用宿主那份 CJK 标点单源），
 * 不是 2.0 独有的语言事实。供方刻意不写这一格，宿主落点会补它自己的——
 * 口径见契约头注与 `tests/monaco-language-surface.test.ts`。
 *
 * ## 数据是**稳定引用**
 *
 * 契约要求同一枚对象（宿主按引用判重复注册），所以这里是 `const` 而不是 getter；
 * 包内那四张表本身也是模块级单例。
 */
import type { MonacoLanguageSurface } from '@kojo/plugin-api';
import { KOJO2_LANGUAGE_ID } from '@kojo/kojo-lang/constants';
import { KOJO2_MONARCH } from '@kojo/kojo-lang/monarch';
import { KOJO2_LANGUAGE_CONFIGURATION } from '@kojo/kojo-lang/language-config';
import { KOJO2_THEME_SURFACES } from '@kojo/kojo-lang/monaco-theme';

/** kojo2 的完整语言面（词法 + 配置 + 三套主题声明）。 */
export const KOJO2_MONACO_LANGUAGE_SURFACE: MonacoLanguageSurface = {
  languageId: KOJO2_LANGUAGE_ID,
  monarch: KOJO2_MONARCH,
  configuration: KOJO2_LANGUAGE_CONFIGURATION,
  themes: KOJO2_THEME_SURFACES,
};
