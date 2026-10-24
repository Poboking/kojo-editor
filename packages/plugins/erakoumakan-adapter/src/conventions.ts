/**
 * era紅魔館 口上约定规则集（`GameAdapter.conventions`）——**本作两条「改了就哑」的
 * 结构性陷阱**，规则全部由真盘路由推出（`D:/Game/eraKoumakan`，2026-10-25）。
 *
 * ## 引擎事实（规则的前提）
 *
 * `ERB/EVENT_KOJO.ERB` 的主路由一律按**目标角色号**拼函数名：
 * ```
 * FUNC KOJO%RESULTS%_MESSAGE_COM_K{対象}_{SELECTCOM}
 * FUNC KOJO_MESSAGE_COUNTER_K{対象}_{TCVAR:20}
 * FUNC KOJO_EVENT_K{対象}_{ARG}
 * FUNC KOJO_K{対象}
 * ```
 * 也就是说：**函数名里的 `K{n}` 才是引擎会去找的地址，文件放在哪个目录完全不参与
 * 路由**。于是两类作者常见失误会「保存成功、游戏里永远不出声」：
 *
 * 1. **文件在 6_フラン，函数名却写 K7**：路由为 6 号拼的是 `…_K6_…`，这条永远不触发。
 *    真盘实测 **1 处**：`6_フラン/対あなた口上.ERB:766 @KOJO_MESSAGE_COM_K7_463_1`
 *    （K7 是「子悪魔」的角色号，疑似复制粘贴后漏改）。
 * 2. **文件里没有任何带角色号的口上函数**：整份文件不会被任何路由命中。
 *    真盘实测 **0 份**（`U_汎用` 无编号目录不参与本规则——`_KU_` 泛用口上是合法形态）。
 *
 * ## 为什么两条都用 `scope: 'file'`
 *
 * 判定只吃「这个文件自己的函数名 + 它所在目录名」，不依赖任何别处的事实 ⇒
 * 引擎可以逐文件增量重算（改一个 ERB 只重跑那一个）。这也是为什么没有像 eraFL
 * 那样建全树扫描缓存：不需要。
 *
 * ## 口径：宁可漏报不可误报
 *
 * - 只认**口上域的直接子目录**（`ERB/口上/{编号}_{名称}/`）；根层公共文件、`U_汎用`、
 *   更深的子目录一律不管（深层文件可能是作者自建的组织结构，不猜）。
 * - 只对 `parseKojoFamily` 能解析出**具体角色号**的函数比目录号；`_KU_` 泛用形、
 *   `KW` 见せつけ形（角色号仍在）按解析结果比。
 * - 读不到索引里的函数表 = 这个文件没可审内容 ⇒ 不产问题（不把「没读到」伪装成
 *   「没问题」这一点由引擎的 `failedRules` 负责，本规则不抛错）。
 */

import type {
  ConventionCheckContext,
  ConventionIssue,
  ConventionRule,
  ErbFile,
} from '@kojo/plugin-api';
import { join } from '@kojo/plugin-api';
import { ERAKOUMAKAN } from './constants';
import { parseKojoDirName } from './chara-csv';
import { parseKojoFamily } from './family-index';

const RULE_MISMATCH = 'erakoumakan.kojo.chara-mismatch';
const RULE_ORPHAN = 'erakoumakan.kojo.orphan-file';

/** 文件是否住在口上域**直接子目录**里的编号目录下；是则返回编号，否则 null */
function kojoDirNoOf(filePath: string, kojoRoot: string): number | null {
  const normalized = filePath.replace(/\\/g, '/');
  const root = kojoRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!normalized.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return null;
  const rel = normalized.slice(root.length + 1);
  const segments = rel.split('/');
  // 只认 `{编号}_{名称}/文件.ERB` 一层；更深的自建子目录不猜归属
  if (segments.length !== 2) return null;
  return parseKojoDirName(segments[0] ?? '')?.no ?? null;
}

/* ------------------- 规则 1：函数名 K{n} 与所在目录不符 ------------------- */

function createCharaMismatchRule(): ConventionRule {
  return {
    id: RULE_MISMATCH,
    description:
      '函数名的 K{角色号} 与所在口上目录的编号不一致（引擎按 K{目标} 拼名，这条永远不会在该角色身上触发）',
    severity: 'warning',
    scope: 'file',
    source:
      'ERB/EVENT_KOJO.ERB 主路由（FUNC …_K{対象}_…）+ 真盘实测 1 处（6_フラン/対あなた口上.ERB:766 写 K7）',
    checkFile(ctx: ConventionCheckContext, file: ErbFile): ConventionIssue[] {
      const kojoRoot = join(ctx.project.rootDir, ...ERAKOUMAKAN.paths.kojoRoot);
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
            `函数「${fn.name}」锚定 K${actual}，但文件住在 ${dirNo}_… 的口上目录。` +
            `引擎为主角 ${dirNo} 号拼的是 KOJO…_K${dirNo}_…，这条永远不会在 ${dirNo} 号身上触发。` +
            `若它本是 ${actual} 号的口上，请把文件移到对应目录；若是有意共享，请改成 _KU_ 泛用形。`,
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

/* ------------------- 规则 2：整份文件没有可路由的口上函数 ------------------- */

function createOrphanFileRule(): ConventionRule {
  return {
    id: RULE_ORPHAN,
    description:
      '口上目录里的 ERB 没有任何带角色号的 KOJO 函数（引擎路由找不到它，整份文件不会生效）',
    severity: 'warning',
    scope: 'file',
    source:
      'ERB/EVENT_KOJO.ERB 主路由（所有口上都按 KOJO…_K{対象}_… 拼名）+ 真盘实测 0 份',
    checkFile(ctx: ConventionCheckContext, file: ErbFile): ConventionIssue[] {
      const kojoRoot = join(ctx.project.rootDir, ...ERAKOUMAKAN.paths.kojoRoot);
      if (kojoDirNoOf(file.path, kojoRoot) === null) return [];
      const functions = file.functions ?? [];
      if (functions.length === 0) return [];
      const firstLine = functions[0]!.startLine;
      const recognized = functions.some(
        (fn) => parseKojoFamily(fn.normalizedName ?? fn.name, fn.filePath) !== null,
      );
      if (recognized) return [];
      return [
        {
          ruleId: RULE_ORPHAN,
          severity: 'warning',
          message:
            `「${file.path}」里的 ${functions.length} 个函数都不是 KOJO…_K{n} / NTR_KOJO…_K{n} / ` +
            `SexHara…_K{n} / WC…_K{n} 形态。引擎按目标角色号拼函数名，整份文件不会被任何路由命中。` +
            `若这是作者自建的辅助函数文件，可忽略本提示并把它移出口上目录。`,
          filePath: file.path,
          line: firstLine,
          key: `${RULE_ORPHAN}|${file.path}`,
        },
      ];
    },
  };
}

/**
 * 构造 era紅魔館 约定规则集（供 `GameAdapter.conventions` 使用）。
 * 两条规则都是纯索引判定、零读盘 ⇒ 装配时一次成型，不需要 getter。
 */
export function createKoumakanConventions(): readonly ConventionRule[] {
  return [createCharaMismatchRule(), createOrphanFileRule()];
}
