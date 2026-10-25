/**
 * eraSQC 口上约定规则集（`GameAdapter.conventions`）——本作最典型的「改了就哑」陷阱。
 *
 * ## 引擎事实
 *
 * `ERB/EVENT_K/EVENT_K.ERB` 的主路由一律按**目标角色号**拼函数名：
 * ```
 * TRYCALLFORM KOJO_MESSAGE_COM_{NO:TARGET}_{CFLAG:209}
 * TRYCALLFORM SELF_KOJO_K{NO:TARGET}_{CFLAG:209}, ARGS
 * TRYCALLFORM COUNTER_KOJO_{NO:TARGET}_{CFLAG:209}, ARGS
 * ```
 * 函数名里的角色号才是引擎会去找的地址；**文件叫什么名字不参与路由**。
 * 于是复制 `EVENT_K07.ERB` 改成 8 号角色时若漏改函数名，保存成功、游戏里
 * 8 号永远不会出声。
 *
 * ## 判据
 *
 * - 只审口上域根下的 `EVENT_K{no}[_尾段].ERB` / `DEVENT_K{no}[_尾段].ERB`；
 * - 只对 `parseKojoFamily` 能解析出**具体角色号**的函数比对；
 * - 无编号的路由本体（`KOJO_MESSAGE_COM` 等）与辅助函数不产生问题。
 *
 * `scope: 'file'`：判定只吃本文件的名字与函数名，不依赖别处事实 ⇒ 可逐文件增量重算。
 * 真盘 111 份口上文件实测 **0 处**错位（规则是给作者改文件后的守卫，不是历史欠账）。
 */
import type {
  ConventionCheckContext,
  ConventionIssue,
  ConventionRule,
  ErbFile,
} from '@kojo/plugin-api';
import { join } from '@kojo/plugin-api';
import { ERASQC } from './constants';
import { parseKojoFileName } from './chara-csv';
import { parseKojoFamily } from './family-index';

export const RULE_CHARA_MISMATCH = 'erasqc.kojo.chara-mismatch';

/** 文件名里的角色号（不符合口上文件形态返回 null，不猜） */
function fileCharaNoOf(filePath: string): number | null {
  const base = filePath.replace(/\\/g, '/').split('/').pop() ?? '';
  return parseKojoFileName(base, ERASQC.kojoFilePattern)?.no ?? null;
}

function createCharaMismatchRule(): ConventionRule {
  return {
    id: RULE_CHARA_MISMATCH,
    description:
      '函数名的角色号与所在口上文件名的编号不一致（引擎按目标角色号拼名，这条永远不会在该角色身上触发）',
    severity: 'warning',
    scope: 'file',
    source:
      'ERB/EVENT_K/EVENT_K.ERB 主路由（TRYCALLFORM …_{NO:TARGET}_{CFLAG:209}）+ 真盘实测 0 处',
    checkFile(ctx: ConventionCheckContext, file: ErbFile): ConventionIssue[] {
      const kojoRoot = join(ctx.project.rootDir, ...ERASQC.paths.kojoRoot);
      const normalized = file.path.replace(/\\/g, '/');
      const root = kojoRoot.replace(/\\/g, '/').replace(/\/+$/, '');
      if (!normalized.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return [];

      const fileNo = fileCharaNoOf(file.path);
      if (fileNo === null) return [];

      const issues: ConventionIssue[] = [];
      for (const fn of file.functions ?? []) {
        const match = parseKojoFamily(fn.normalizedName ?? fn.name, fn.filePath);
        if (match === null || match.characterNo === null) continue;
        if (match.characterNo === fileNo) continue;
        issues.push({
          ruleId: RULE_CHARA_MISMATCH,
          severity: 'warning',
          message:
            `函数「${fn.name}」锚定角色 ${match.characterNo}，但文件属于 ${fileNo} 号。` +
            `引擎为 ${fileNo} 号拼的是 …_{NO:TARGET}_{CFLAG:209} 一类函数名，这条永远不会在 ${fileNo} 号身上触发。` +
            `若它本是 ${match.characterNo} 号的口上，请把这段移回对应文件；` +
            `若是有意共享，请改成引擎实际会调用的函数名。`,
          filePath: file.path,
          line: fn.startLine,
          characterNo: fileNo,
          key: `${RULE_CHARA_MISMATCH}|${file.path}|${fn.startLine}|${fn.name}`,
        });
      }
      return issues;
    },
  };
}

/** 构造 eraSQC 约定规则集（供 `GameAdapter.conventions` 使用）。 */
export function createErasqcConventions(): readonly ConventionRule[] {
  return [createCharaMismatchRule()];
}
