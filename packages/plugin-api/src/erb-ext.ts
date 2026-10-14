/**
 * 「ERB 方言扩展名」的**单一真源**（FT-2 收口，2026-10-14）。
 *
 * ## 为什么要有这个文件
 *
 * 这条口径原本有**四份副本、分处三个包**：
 * - `erb-parser/src/plugin.ts` 的 `ERB_EXT`（索引 walk + 结构闸门 + 💡 修复动作）；
 * - `ui-sugar-lift/src/index.ts` 的 `isErbFile`（是否投影糖写法）；
 * - `app/src/ui/lift-preview.ts` 的 `isErbLike`（编辑器只读门 + 糖视图可用性）；
 * - `app/src/ui/FileTree.tsx` 的 `erbExt`（"附加文件，不在口上索引内"标记）
 *   与 `app/src/ui/drag-drop.ts` 的 `OPENABLE_EXT`（拖入白名单 + 覆盖提示文案）。
 *
 * 四份靠注释里一句"与 ERB_EXT 同口径"人肉对齐。副本一漂移，症状就是
 * **「索引里有、面上开不了」或反过来**——与刚被 E16 批收口的 `isIdentPart` 双副本同类。
 * 现在谓词只此一处、清单只此一份，全部消费方指回来。
 *
 * ## 引擎侧依据（硬事实，不是某个游戏的约定）
 *
 * Emuera 预载目录时**只按这五种扩展名收文件**：
 * `.csv` `.erb` `.erh` `.erd` `.als`（`Runtime/Utils/Preload.cs` 的预载白名单，
 * 大小写不敏感）。也就是说 **`.ERH` 是引擎认可的脚本文件**，而编辑器此前打不开它、
 * 不进索引、没有高亮。`.erm` 是同族 era 引擎的正文字体（基线语料 0 份，口径必须覆盖，
 * 否则换盘就漏）。
 *
 * ## 分层纪律（为什么住契约层）
 *
 * `erb` / `erm` / `erh` / `erd` 是**引擎级**词汇：审计 A 的黑名单是游戏名
 * （eratw/eraK/…）、`M_KOJO` 前缀、`個人口上` 路径、`sav`——都不在此。
 * **具体游戏的目录约定**（哪个目录算口上根、哪个面名是标配）一律不得写进这里，
 * 那是 `eratw-adapter` 的领域。
 *
 * ## 形态口径（判"文件名那一层"）
 *
 * 判定 = `extname(basename(path))` 落在清单内（大小写不敏感），因此：
 * - `.ERH` / `.erh` 同等；`K36.ERH`、`M_KOJO_K11_TR.ERH` 多点名取**最后一段**；
 * - 整名以点开头的 `.erb`（点文件）判**否**——与 `drag-drop` / `paths.extname` 既有口径一致；
 * - 无扩展名判否；目录段叫 `dir.ERB` 而文件叫 `说明.txt` 判否（旧副本对整条路径做
 *   尾正则时，`C:\x\y.erb` 这类**目录**路径会被误判为方言文件——本谓词只看文件名，
 *   调用方不得把目录路径喂进来判定，目录剔除归 `stat.isDirectory` 那一层管）。
 */

import { extname } from './paths';

/** 方言扩展名（小写、含点）——清单元素的联合类型，拼错的值过不了类型 */
export type ErbDialectExtension = '.erb' | '.erm' | '.erh';

/**
 * 正文类：函数定义（`@`）住在这里，口上结构的全部意义所在。
 * `.erm` 是同族引擎的正文字体，基线语料 0 份但口径必须含。
 */
export const ERB_BODY_EXTENSIONS: readonly ErbDialectExtension[] = ['.erb', '.erm'];

/**
 * 声明类（`#DIM` / `#DIMS` / `#DEFINE` 容器）：引擎同样预载，
 * 实测基线语料口上根内 31 份、975 行、**0 个函数定义**（⇒ 进索引只加文件数、不动函数树）。
 *
 * 为什么必须与正文类**分开可辨**：索引 membership 决定"哪些文件值得体检"，
 * 而声明文件的合法形态就是"整份只有 `#` 指令、一条语句都没有"——
 * 按正文形态判它，就会成串假阳性。判据要落在"声明文件"这个形态上，不是"跳过某个扩展名"。
 */
export const ERB_DECLARATION_EXTENSIONS: readonly ErbDialectExtension[] = ['.erh'];

/** 引擎认可的方言全集 = 正文 + 声明。**这是消费方唯一该读的清单**。 */
export const ERB_DIALECT_EXTENSIONS: readonly ErbDialectExtension[] = [
  ...ERB_BODY_EXTENSIONS,
  ...ERB_DECLARATION_EXTENSIONS,
];

/**
 * **留位未接线**：引擎预载白名单里还剩 `.erd`（`Preload.cs` 与 `.erh` 并列）。
 *
 * 基线盘实测仅 1 份（`ERB\カラム機能\COLUMNDIV@2.ERD`），且在索引根之外 ⇒ 本批不接：
 * 不进索引、不高亮、不开放拖入（接线动作 = 把它并入 {@link ERB_DECLARATION_EXTENSIONS}
 * 后原样重跑本批的语料自证，读数目自然跟上；没有第二份盘可证之前不做没根据的工作）。
 *
 * 下面那条"清单元素互不重叠"的断言会钉住它此刻**没有**被接线。
 */
export const ERB_ENGINE_RESERVED_EXTENSIONS: readonly string[] = ['.erd'];

/** 文件名/路径是否属于 ERB 方言（正文或声明；大小写不敏感） */
export function isErbDialectPath(path: string): boolean {
  return (ERB_DIALECT_EXTENSIONS as readonly string[]).includes(extname(path).toLowerCase());
}

/** 是否是**正文**方言文件（`.erb` / `.erm`） */
export function isErbBodyPath(path: string): boolean {
  return (ERB_BODY_EXTENSIONS as readonly string[]).includes(extname(path).toLowerCase());
}

/** 是否是**声明**文件（`.erh`）——"整份只有 `#DIM`/`#DIMS`/`#DEFINE`、0 函数"的合法形态 */
export function isErbDeclarationPath(path: string): boolean {
  return (ERB_DECLARATION_EXTENSIONS as readonly string[]).includes(extname(path).toLowerCase());
}

/**
 * Monaco 的 `extensions` 入参：同一份清单展开成「原样 + 全大写」两种写法。
 *
 * 为什么要两种：Monaco 的语言注册按字面量匹配扩展名（既有注册本就写着 `['.ERB', '.erb']`），
 * 只给小写会让盘上的 `X.ERB` / `X.ERH` 落到别的语言。**清单仍然只有一份**，
 * 大小写形态是这里现算的派生物，不是第二处手抄。
 */
export function erbMonacoExtensions(exts: readonly string[] = ERB_DIALECT_EXTENSIONS): string[] {
  const out: string[] = [];
  for (const e of exts) {
    out.push(e, e.toUpperCase());
  }
  return out;
}
