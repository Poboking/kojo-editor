/**
 * eraAV 的角色级检索范围（槽 `search.scope` 贡献）——**本作的口上没有目录，所以范围给文件**。
 *
 * ## 为什么这里必须自己算一份，而不用 `kojo-project-kit` 的 `charaSearchScopeOptions`
 *
 * kit 那份投影的**唯一判据是 `CharaInfo.kojoDir`**（`packages/kojo-project-kit/src/search-scope.ts:47-57`）。
 * 而 eraAV **一律不设** `kojoDir`：契约语义是「该角色在口上域下的目录」，本作口上是
 * `ERB/Lines/` 下的 17 份扁平散文件（`EVENT_K{nn}_{角色名}.ERB`），把公共父目录塞进去会让
 * `ownerNoOfPath` 的最长根裁决塌成「整棵函数树归某一个任意角色」
 * （`packages/plugins/ui-kojo-navigator/src/tree.ts:149-158`；判据出处 `docs/PITFALLS.md` 229）。
 * 于是 kit 在本作**恒返回空数组**——不是漏实现，是那条路本身不许走。
 *
 * ## 契约给的合法通道：`roots` 容得下**单个文件**
 *
 * `SearchScopeOption.roots`「目录与单个文件皆可 … 文件根只产出它自己」
 * （`packages/plugin-api/src/slots.ts:1438-1444`）。本批逐环节复验过：
 * - 收窄侧 `narrowRoots` 会把"落在检索根之下"的文件根原样推进去（`packages/app/src/ui/search-scope.ts:191-220`）；
 * - 判据侧 `pathInScope` 在 `root === path` 时成立（`isPathUnder` 相等即真，`packages/plugin-api/src/paths.ts:123-136`）；
 * - 落盘侧 Rust 对每个根走一次 `WalkDir::new(root)`，文件根在深度 0 产出它自己
 *   （`packages/app/src-tauri/src/lib.rs:2849-2879`）。
 * ⇒ 「一个角色的检索范围 = 它那一份口上文件」在本作既成立又最小，无需第二套机制。
 *
 * ## 纯函数纪律
 *
 * `provide` 不读盘（契约 `SearchScopeContribution` 明写，`slots.ts:1454-1456`）：
 * 「哪个号对应哪份文件」是 `loadProject` 已经算好的事实，由适配器以闭包递进来
 * （见 `plugin.ts` 的 `kojoScan`）。**没有口上文件的角色不产候选**（实测 120 个角色里
 * 只有 17 个有文件 ⇒ 103 个不出现），与 kit 的「无 `kojoDir` 不产候选」同判据。
 */

import type { CharaInfo, SearchScopeOption } from '@kojo/plugin-api';
import { basename } from '@kojo/plugin-api';
import type { EraavKojoFileEntry } from './kojo-scan';

/**
 * 检索范围 id 前缀：与 kit 同用 `chara:` 同用编号（「作者改显示名不换身份」），
 * 宿主再按 `pluginId` 叠一层命名空间，两家的 id 相同也不串线。
 */
const CHARA_ID_PREFIX = 'chara:';

/**
 * 角色表 × 口上文件清单 ⇒ 检索范围候选（纯函数、零 IO）。
 *
 * 排序按编号升序（与 kit、导航树、文件树同一顺序）。标签口径与 kit 逐字一致
 * （`#编号 名字`，`packages/kojo-project-kit/src/search-scope.ts:47-57`）——同一个事实
 * 不在两个地方写两种写法；`名字`取 `charaIndex` 的 `名前`（汉化盘＝中文），
 * 只有 CSV 缺席时才退回文件名段。悬浮提示给文件原名（作者在游戏目录里看到的就是它）。
 */
export function eraavSearchScopeOptions(
  charas: Iterable<CharaInfo>,
  kojoFiles: readonly EraavKojoFileEntry[],
): SearchScopeOption[] {
  const nameByNo = new Map<number, string>();
  for (const info of charas) nameByNo.set(info.no, info.name);
  return [...kojoFiles]
    .sort((a, b) => a.no - b.no)
    .map((entry) => ({
      id: `${CHARA_ID_PREFIX}${entry.no}`,
      label: `#${entry.no} ${nameByNo.get(entry.no) ?? entry.label}`,
      detail: basename(entry.path),
      roots: [entry.path],
    }));
}
