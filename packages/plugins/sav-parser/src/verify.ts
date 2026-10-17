/**
 * 注入回读验证（纯函数；游戏无关）。
 *
 * 写盘后强制重新解析落盘文件，断言每个覆盖值真实落盘：
 * - 标量：值相等；
 * - 数组：逐条 CellPatch 按全维度下标比对（新插入与替换两种情形同表）。
 *
 * 任何不匹配都进 mismatches（调用方显式抛错并提示备份位置——验证失败
 * 视为致命错误，绝不静默返回"成功"）。
 */

import type {
  ArchiveArrayVariable,
  ArchiveCellPatch,
  ArchiveOverrides,
  ArchiveVariable,
  SnapshotArchive,
} from '@kojo/plugin-api';
import { compareContent } from '@kojo/plugin-api';

export interface VerifyReport {
  /** 核对过的覆盖条目数（标量 1 条 / 单元补丁逐条计） */
  checked: number;
  /** 不匹配描述（空数组 = 全部通过） */
  mismatches: string[];
}

function indexKey(index: readonly number[]): string {
  return index.join(',');
}

function findVar(vars: readonly ArchiveVariable[] | undefined, key: string): ArchiveVariable | undefined {
  return vars?.find((v) => v.key === key);
}

function checkScalar(
  where: string,
  key: string,
  expected: number | string,
  actual: ArchiveVariable | undefined,
  mismatches: string[],
  checked: { n: number },
): void {
  checked.n++;
  if (!actual) {
    mismatches.push(`${where}.${key}: 变量未找到（落盘文件中不存在）`);
    return;
  }
  if (actual.type === 'int' || actual.type === 'str' || actual.type === 'xml') {
    if (actual.value !== expected) {
      mismatches.push(`${where}.${key}: 期望 ${String(expected)}，落盘 ${String(actual.value)}`);
    }
    return;
  }
  mismatches.push(`${where}.${key}: 覆盖为标量但落盘变量类型为 ${actual.type}`);
}

function checkPatches(
  where: string,
  key: string,
  patches: readonly ArchiveCellPatch[],
  actual: ArchiveVariable | undefined,
  mismatches: string[],
  checked: { n: number },
): void {
  if (!actual) {
    checked.n += patches.length;
    mismatches.push(`${where}.${key}: 变量未找到（落盘文件中不存在）`);
    return;
  }
  const isArr = 'cells' in actual && 'saveLen' in actual;
  if (!isArr) {
    checked.n += patches.length;
    mismatches.push(`${where}.${key}: 覆盖为单元补丁但落盘变量类型为 ${actual.type}（非数组）`);
    return;
  }
  const arr = actual as ArchiveArrayVariable;
  const byIndex = new Map<string, ArchiveCellPatch>(arr.cells.map((c) => [indexKey(c.index), { index: c.index, value: c.value }]));
  for (const p of patches) {
    checked.n++;
    const hit = byIndex.get(indexKey(p.index));
    if (!hit) {
      mismatches.push(`${where}.${key}[${p.index.join(',')}]: 单元未落盘`);
    } else if (hit.value !== p.value) {
      mismatches.push(`${where}.${key}[${p.index.join(',')}]: 期望 ${String(p.value)}，落盘 ${String(hit.value)}`);
    }
  }
}

/**
 * 回读**字节态**断言（W17）：写出的字节与重读的字节必须逐字节相同。
 *
 * 与文件历史的行级比对共用 `@kojo/plugin-api` 的 `compareContent`——字节态和行态
 * 从同一次比对派生，不在两个消费方各写一条 if 链。值级断言（`verifyOverrides`）
 * 管"值确实落了盘"，本函数管"落盘的确实是刚写的那份字节"：两者缺一不可，
 * 例如写入被截断/回填旧档时，值可能碰巧对上，字节已经不对。
 */
export function verifyReadbackBytes(expected: Uint8Array, actual: Uint8Array): VerifyReport {
  const eq = compareContent({ bytes: expected }, { bytes: actual });
  if (eq.bytesEqual === true) return { checked: 1, mismatches: [] };
  const at = eq.firstByteDiff;
  return {
    checked: 1,
    mismatches: [
      `回读字节与写入字节不同（写入 ${expected.length}B，落盘 ${actual.length}B` +
        (at === null ? '）' : `，首个差异在偏移 ${at}）`),
    ],
  };
}

/**
 * 对照覆盖集验证重解析结果。返回报告（mismatches 非空 = 验证失败）。
 */
export function verifyOverrides(archive: SnapshotArchive, overrides: ArchiveOverrides): VerifyReport {
  const mismatches: string[] = [];
  const checked = { n: 0 };

  // 顶层 / 主变量区 / 全局区 / EM 区（与 serializePayload 的覆盖作用域同构：
  // vars 覆盖集对各变量区按 key 生效，key 冲突时按流序首个命中）
  for (const [key, value] of overrides.vars ?? []) {
    const hit =
      findVar(archive.vars, key) ??
      findVar(archive.globalVars, key) ??
      findVar(archive.emVars, key);
    if (typeof value === 'number' || typeof value === 'string') {
      checkScalar('vars', key, value, hit, mismatches, checked);
    } else {
      checkPatches('vars', key, value, hit, mismatches, checked);
    }
  }

  // 角色块（按块 index 定位）
  const blocks = new Map((archive.chars ?? []).map((b) => [b.index, b]));
  for (const [charIndex, varMap] of overrides.chars ?? []) {
    const block = blocks.get(charIndex);
    for (const [key, value] of varMap) {
      const where = `chars[${charIndex}]`;
      const hit = block ? findVar(block.vars, key) : undefined;
      if (typeof value === 'number' || typeof value === 'string') {
        checkScalar(where, key, value, hit, mismatches, checked);
      } else {
        checkPatches(where, key, value, hit, mismatches, checked);
      }
    }
  }

  return { checked: checked.n, mismatches };
}
