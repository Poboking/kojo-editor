/**
 * eratohoK 口上约定规则集（`GameAdapter.conventions`）——**本作唯一一条「改了就哑」的
 * 结构性陷阱**，规则由真盘路由推出（`D:/game/eratohoK`，2026-10-25）。
 *
 * ## 引擎事实（规则的前提）
 *
 * `ERB/口上/_KOJO_SYSTEM.ERB` 的主路由一律按**目标角色号**拼函数名（114 条 CALLFORM）：
 * ```
 * TRYCALLFORM KOJO_TRAIN_START_K{LOCAL:5}
 * TRYCALLFORM KOJO_TRAIN_START_%KOJO_STATE(1)%_K{LOCAL:5}
 * TRYCALLFORM KOJO_TRAIN_START_K{LOCAL:5}_{CFLAG:(LOCAL:5):2999}
 * TRYCALLFORM KOJO_COM_K{LOCAL:5}          （指令面同理，另有 BEFORE/AFTER/TARGET/PLAYER 变体）
 * TRYCALLFORM KOJO_EVENT_K{LOCAL:5}(ARG:1)
 * ```
 * 也就是说：**函数名里的 `K{n}` 才是引擎会去找的地址，文件放在哪个目录完全不参与路由**。
 * 于是作者常见失误会「保存成功、游戏里永远不出声」：
 *
 * **文件在 22 号目录，函数名却写 K8**：路由为 22 号拼的是 `…_K22_…`，这条永远不触发。
 * 真盘实测 **1 处**：`22 紫口上/KOJO_C_K22.ERB:40 @KOJO_COM_AFTER_C_K8`
 * （K8 是「パチュリー」的角色号，疑似复制粘贴后漏改）。
 *
 * ## 为什么只有一条规则
 *
 * 另外两条候选都在真盘上被证伪，**故意不写**（宁可少报，不做噪声机）：
 * - 「口上目录里的文件没有任何带角色号的函数」→ 688 份里 **4 份**命中，全部是合法形态：
 *   `09 咲夜口上/KOJO_FUNCTION_K9_K10.ERB`（9/10 号共用的 `KOJO_ASK` / `KOJO_HAIR_NAME`
 *   助手）与 `1205 ランダムキャラ軍師/KOJO_B..D_K1205.ERB`（随机角色目录里的 `_KXXX`
 *   模板）⇒ 报了就是假阳性。
 * - 「每日事件缺 `_RATE` / `_DECISION`」→ 310 个家族里 36 组「缺件」几乎全是
 *   `_DERIVATION_*_DISABLE` / `_NAME` 这类**有意为之的变体**，不是缺陷。
 *
 * ## 为什么 `scope: 'file'`
 *
 * 判定只吃「这个文件自己的函数名 + 它所在目录名」，不依赖任何别处的事实 ⇒
 * 引擎可以逐文件增量重算（改一个 ERB 只重跑那一个）。
 *
 * ## 口径：宁可漏报不可误报
 *
 * - 只认**口上域的直接子目录与一层子目录**（`{编号} {名称}/[DAILY/]文件.ERB`）；
 *   更深的作者自建结构不猜。
 * - 只对能解析出**具体角色号**的函数比目录号；`_KXXX` 模板占位、无号助手函数跳过。
 * - 读不到索引里的函数表 = 这个文件没可审内容 ⇒ 不产问题（「没读到」由引擎的
 *   `failedRules` 负责，本规则不抛错）。
 */

import type {
  ConventionCheckContext,
  ConventionIssue,
  ConventionRule,
  ErbFile,
} from '@kojo/plugin-api';
import { join } from '@kojo/plugin-api';
import { ERATOHOK } from './constants';
import { parseKojoDirName } from './chara-csv';
import { parseKojoFamily } from './family-index';

const RULE_MISMATCH = 'eratohok.kojo.chara-mismatch';

/** 文件是否住在口上域的编号目录里（一层或 `DAILY/` 一层）；是则返回编号，否则 null */
function kojoDirNoOf(filePath: string, kojoRoot: string): number | null {
  const normalized = filePath.replace(/\\/g, '/');
  const root = kojoRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!normalized.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return null;
  const rel = normalized.slice(root.length + 1);
  const segments = rel.split('/');
  // `{编号} {名称}/文件.ERB` 或 `{编号} {名称}/DAILY/文件.ERB`；更深的自建子目录不猜归属
  if (segments.length !== 2 && segments.length !== 3) return null;
  return parseKojoDirName(segments[0] ?? '')?.no ?? null;
}

function createCharaMismatchRule(): ConventionRule {
  return {
    id: RULE_MISMATCH,
    description:
      '函数名的 K{角色号} 与所在口上目录的编号不一致（引擎按 K{目标} 拼名，这条永远不会在该角色身上触发）',
    severity: 'warning',
    scope: 'file',
    source:
      'ERB/口上/_KOJO_SYSTEM.ERB 主路由（TRYCALLFORM …_K{LOCAL:5}）+ 真盘实测 1 处'
      + '（22 紫口上/KOJO_C_K22.ERB:40 写 K8）',
    checkFile(ctx: ConventionCheckContext, file: ErbFile): ConventionIssue[] {
      const kojoRoot = join(ctx.project.rootDir, ...ERATOHOK.paths.kojoRoot);
      const dirNo = kojoDirNoOf(file.path, kojoRoot);
      if (dirNo === null) return [];

      const issues: ConventionIssue[] = [];
      for (const fn of file.functions ?? []) {
        const match = parseKojoFamily(fn.normalizedName ?? fn.name, fn.filePath);
        if (match === null) continue;
        const actual = match.characterNo;
        if (actual === null || actual === dirNo) continue;
        issues.push({
          ruleId: RULE_MISMATCH,
          severity: 'warning',
          message:
            `函数「${fn.name}」锚定 K${actual}，但文件住在 ${dirNo} 号的口上目录。` +
            `引擎为 ${dirNo} 号角色拼的是 KOJO…_K${dirNo}_…（或 _K${dirNo}），` +
            `这条永远不会在 ${dirNo} 号身上触发。` +
            `若它本是 ${actual} 号的口上，请把文件移到对应目录；若是有意共享，请改成 _KXXX 模板形。`,
          filePath: file.path,
          line: fn.startLine,
          characterNo: dirNo,
          ...(match.family.length > 0 ? { family: match.family } : {}),
          key: `${RULE_MISMATCH}|${file.path}|${fn.startLine}|${fn.name}`,
        });
      }
      return issues;
    },
  };
}

/**
 * 构造 eratohoK 约定规则集（供 `GameAdapter.conventions` 使用）。
 * 唯一规则是纯索引判定、零读盘 ⇒ 装配时一次成型，不需要 getter。
 */
export function createTohokConventions(): readonly ConventionRule[] {
  return [createCharaMismatchRule()];
}
