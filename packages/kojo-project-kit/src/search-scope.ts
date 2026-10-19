/**
 * 检索范围提供方（C3 领域限定检索批）——**"这个角色的文件在哪"这条判据住本文件**。
 *
 * 宿主全文检索只认两样泛型事实：`label`（原样画进下拉）与 `roots`（原样当检索根交给
 * 原生检索命令）。它既不知道有"角色"这个概念，也不需要知道——所以这里给出的
 * `roots` 收窄对宿主而言与"用户少选了几个目录"没有区别。
 *
 * ## 判据为什么是「目录前缀」而不是「文件名」
 *
 * `CharaInfo.kojoDir`（契约字段，适配器在 `loadProject` 里按 CHARA 编号 + 目录名/文件名
 * 双路绑定好的**绝对路径**）就是"这个角色的口上文件住哪"的唯一权威答案。于是
 * - 判定 = 一次目录收窄，**扫描代价在 Rust 侧真的变小**（少扫就是少扫），不是"全扫一遍再挑"；
 * - 不需要把 `M_KOJO_K(\d+)` 那条正则抄第二份（抄进宿主尤其糟：那是全仓最不该有游戏知识的一层）；
 * - 角色名单不在这里重算：唯一真源是 `project.charaIndex`，本文件只做**投影**。
 *
 * ## 为什么首批只到角色级（家族级为什么现在不做）
 *
 * 「家族」在 `FamilyIndexRule.match(fnName, filePath?)` 里是**按函数名**判的，与目录无关：
 * 一个角色的一个家族本来就摊在**若干文件**里，而**一个文件里也住着多个家族**。于是家族级
 * 有两条路，都不像角色级那样"一次目录收窄就正好等于语义"：
 *
 * 1. 把该家族涉及的文件列成 `roots`（契约形状容得下：文件根只产出它自己）——
 *    但扫到的是**整份文件**，读数会含同文件里的别的家族：范围**偏大**；
 * 2. 扫完再按"命中行所在函数属于哪个家族"过滤结果——范围**正好**，代价是把判定
 *    做到**每一次检索的每一个命中**上，还要为"结果 → 函数 → 家族"新建第二份索引缓存
 *    与第二套跳过计数。
 *
 * 两条都不付：**没有真实消费方之前，家族级只是多出来的两套口径**。首批只做角色级
 * （目录收窄 = 语义正好，且扫得更少是实测的），家族级留在这里可加、契约不需要改。
 *
 * 无 `kojoDir` 的角色**不产候选**（没有目录可限定；文件树那侧本来也看不见它）。
 */

import type { CharaInfo, SearchScopeOption } from '@kojo/plugin-api';
import { basename } from '@kojo/plugin-api';

/**
 * 范围 id 的命名空间前缀。id 用**编号**（作者改显示名不换身份），
 * 宿主侧再按 `pluginId` 叠一层命名空间（多个提供方共存时不串线）。
 */
const CHARA_ID_PREFIX = 'chara:';

/** 有口上目录的角色条目（`kojoDir` 已在 loadProject 里绑成绝对路径） */
type CharaWithDir = CharaInfo & { kojoDir: string };

/** 角色条目 → 一条"只看这个角色"的检索范围候选 */
function charaScopeOption(info: CharaWithDir): SearchScopeOption {
  return {
    id: `${CHARA_ID_PREFIX}${info.no}`,
    // 标签与部署向导 / 新建向导同一口径（`#编号 名字`）——同一个事实在别的面里已经这么写了，
    // 这里再造一种写法就是第三份词表。
    label: `#${info.no} ${info.name}`,
    // 悬浮提示给目录原名（作者在游戏目录里看到的就是这个形态）
    detail: basename(info.kojoDir),
    roots: [info.kojoDir],
  };
}

/** 判据只有一条：有口上目录 ⇒ 该目录就是这个角色的全部检索范围 */
function hasKojoDir(info: CharaInfo): info is CharaWithDir {
  return typeof info.kojoDir === 'string' && info.kojoDir !== '';
}

/**
 * 角色清单 → 检索范围候选（纯函数、零 IO）。
 *
 * 排序按编号升序：与导航树、文件树同一顺序，作者在下拉里能按已知次序找，
 * 不必先适应第三种排序。
 */
export function charaSearchScopeOptions(charas: Iterable<CharaInfo>): SearchScopeOption[] {
  return [...charas]
    .filter(hasKojoDir)
    .sort((a, b) => a.no - b.no)
    .map(charaScopeOption);
}
