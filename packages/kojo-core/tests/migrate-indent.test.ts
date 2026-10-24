/**
 * 迁移引擎 · v1 `indent-mismatch` 成因定位（K2-MIGRATE-INDENT-DETAIL）。
 *
 * 红→绿基线（改前）：
 * - v1 只会给一句 `indent-mismatch`；真实语料那 2 份 `.kojo` 的 blocked 读数是
 *   `v1-compile-failed`，没有行号/成因；
 * - 真实语料载入器把带 BOM 的原文直接喂 v1 前端（首行 `;` 注释因 BOM 前缀落成顶层正文），
 *   伪失配无法自动修复。
 * 本文件钉住：成因可区分、detail 透出、BOM 唯一解修复后不再是 blocked。
 */
import { describe, expect, it } from 'vitest';

import {
  diagnoseV1IndentMismatch,
  migrateKojoSourceSemantic,
  repairV1Source,
} from '../src/index.js';
import { runMigrationDifferential } from '../../kojo-conformance/src/migration.js';
import { runCorpusMigration } from '../../kojo-conformance/src/corpus.js';

const BOM = '\uFEFF';

/** 真实语料里那两份 `.kojo` 的共同形状：BOM + 首行 `;` 注释 + 头部声明 */
const REAL_SHAPE_BOM = `${BOM}; 博丽 灵梦（1） · 用户测试\n角色: 1\n口上: 用户测试\n\n时机 日常 310：\n    「……」\n`;

describe('diagnoseV1IndentMismatch · 成因可区分', () => {
  it('首行 BOM → 首行 BOM 成因 + 机械可解', () => {
    const finding = diagnoseV1IndentMismatch(REAL_SHAPE_BOM, 1);
    expect(finding?.cause).toBe('bom-first-line');
    expect(finding?.repairable).toBe(true);
    expect(finding?.detail).toContain('indent-mismatch: 首行 BOM @第 1 行');
  });

  it('行首 tab 与空格混用 → tab/space 混用（不自动修）', () => {
    const source = '角色: 1\n口上: t\n\n时机 日常 310：\n\t    「混用」\n';
    const finding = diagnoseV1IndentMismatch(source, 5);
    expect(finding?.cause).toBe('tab-space-mixed');
    expect(finding?.repairable).toBe(false);
    expect(finding?.detail).toContain('tab/space 混用 @第 5 行');
  });

  it('跨层 tab/space 不一致 → tab/space 混用', () => {
    const source = '角色: 1\n口上: t\n\n时机 日常 310：\n    如果 a：\n\t\t乙\n';
    const finding = diagnoseV1IndentMismatch(source, 6);
    expect(finding?.cause).toBe('tab-space-mixed');
    expect(finding?.detail).toContain('父块头第 5 行用空格，本行用 tab');
  });

  it('块缩进跳级 → indent-jump（不自动修）', () => {
    const source = '角色: 1\n口上: t\n\n时机 日常 310：\n        「跳级」\n';
    const finding = diagnoseV1IndentMismatch(source, 5);
    expect(finding?.cause).toBe('indent-jump');
    expect(finding?.detail).toContain('块缩进跳级 @第 5 行');
    expect(finding?.repairable).toBe(false);
  });

  it('首个缩进行前面不是块头 → 孤儿正文', () => {
    const source = '角色: 1\n口上: t\n\n    「孤儿」\n';
    const finding = diagnoseV1IndentMismatch(source, 4);
    expect(finding?.cause).toBe('orphan-body');
    expect(finding?.detail).toContain('孤儿正文 @第 4 行');
  });

  it('顶层外部行（2.0 专有行 / `# 版本`）→ top-level-foreign-line', () => {
    expect(diagnoseV1IndentMismatch('# 机 指令 310\n', 1)?.cause).toBe('top-level-foreign-line');
    expect(diagnoseV1IndentMismatch('角色: 1\n# 版本 1.0\n', 2)?.cause).toBe('top-level-foreign-line');
  });

  it('行号越界 / 正常行 → null（不硬编成因）', () => {
    expect(diagnoseV1IndentMismatch('角色: 1\n', 9)).toBeNull();
    expect(diagnoseV1IndentMismatch('; 注释\n', 1)).toBeNull();
  });
});

describe('repairV1Source · 只做机械唯一解', () => {
  it('剥掉首行 BOM，并留下修复记录', () => {
    const repaired = repairV1Source(REAL_SHAPE_BOM);
    expect(repaired.code.startsWith(BOM)).toBe(false);
    expect(repaired.repairs).toHaveLength(1);
    expect(repaired.repairs[0]?.cause).toBe('bom-first-line');
    expect(diagnoseV1IndentMismatch(repaired.code, 1)).toBeNull();
  });

  it('没有 BOM → 逐字原样，不产生修复记录', () => {
    const source = '角色: 1\n口上: t\n';
    const repaired = repairV1Source(source);
    expect(repaired.code).toBe(source);
    expect(repaired.repairs).toEqual([]);
  });

  it('不替作者决定外部行 / 跳级 / 混用（有歧义一律维持 blocked）', () => {
    const foreign = '# 机 指令 310\n';
    const jump = '时机 日常 310：\n        「跳级」\n';
    expect(repairV1Source(foreign).code).toBe(foreign);
    expect(repairV1Source(jump).code).toBe(jump);
  });
});

describe('differential · blockedDetail 透出（additive）', () => {
  const run = (source: string) =>
    runMigrationDifferential({
      cases: [{ id: 'bom', source }],
      compileV1: (input) =>
        input.startsWith(BOM)
          ? {
              ok: false,
              text: '',
              diagnostics: [
                { code: 'indent-mismatch', severity: 'error', message: '这一行不在任何「时机」块内', line: 1 },
              ],
            }
          : { ok: true, text: 'ERB\n' },
      compile2: () => ({ ok: true, text: 'ERB\n' }),
      migrate: () => ({ ok: true, code: '', unsupported: [] }),
    }).cases[0]!;

  it('改前：blocked + v1-compile-failed，detail 给出首行 BOM 行号', () => {
    const report = run(REAL_SHAPE_BOM);
    expect(report.status).toBe('blocked');
    expect(report.blockedReason).toBe('v1-compile-failed');
    expect(report.blockedDetail).toContain('indent-mismatch: 首行 BOM @第 1 行');
  });

  it('修复后：不再是 blocked（旧消费方仍拿 status / 原 code）', () => {
    const report = run(repairV1Source(REAL_SHAPE_BOM).code);
    expect(report.status).not.toBe('blocked');
    expect(report.blockedReason).toBeNull();
    expect(report.blockedDetail).toBeNull();
  });

  it('迁移器接手修复后的源：真实形状可迁移', () => {
    const result = migrateKojoSourceSemantic(repairV1Source(REAL_SHAPE_BOM).code, {
      eventNames: ['日常'],
    });
    expect(result.ok).toBe(true);
  });
});

describe('真实语料载入 · BOM 机械修复（corpus 入口）', () => {
  it('BOM 源喂给 v1 前已被剥除，BOM 事实仍进读数', () => {
    const files: Record<string, string> = { '/corpus/bom.kojo': REAL_SHAPE_BOM };
    const seen: string[] = [];
    const result = runCorpusMigration({
      root: '/corpus',
      io: {
        listFiles: (dir) => (dir === '/corpus' ? ['bom.kojo'] : []),
        readText: (target) => files[target] ?? '',
      },
      sha256: () => '0'.repeat(64),
      compileV1: (input) => {
        seen.push(input);
        return input.startsWith(BOM)
          ? {
              ok: false,
              text: '',
              diagnostics: [
                { code: 'indent-mismatch', severity: 'error', message: '这一行不在任何「时机」块内', line: 1 },
              ],
            }
          : { ok: true, text: 'ERB\n' };
      },
      compile2: () => ({ ok: true, text: 'ERB\n' }),
      migrate: () => ({ ok: true, code: '', unsupported: [] }),
    });

    // 红→绿：载入器若原样把 BOM 喂给 v1（改前），这里会是 [BOM...] + blocked
    expect(seen.every((source) => !source.startsWith(BOM))).toBe(true);
    expect(result.cases[0]?.bom).toBe(true);
    expect(result.cases[0]?.status).not.toBe('blocked');
    expect(result.cases[0]?.readings.v1.ok).toBe(true);
  });
});
