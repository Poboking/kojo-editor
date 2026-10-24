/**
 * 设置页「语言能力」节的纯视图模型（批次十 S15）。
 *
 * 钉三件事：
 * 1. 行/状态/豁免理由**只来自** `monaco/language-capabilities.ts`（换一份矩阵，视图跟着变，
 *    证明这里没有第二份清单）；
 * 2. 搜索与排序只是看法，不改矩阵、不改入参；
 * 3. 组件 SSR 形状：两门语言 + 每项能力 + 豁免理由都在，且带搜索框与折叠按钮。
 */
import { describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  buildCapabilityMatrixRows,
  capabilityMatrixSummary,
  filterCapabilityRows,
  sortCapabilityRows,
  CapabilityMatrixSection,
} from '../src/ui/capability-matrix-view';
import {
  ALL_LANGUAGE_CAPABILITIES,
  LANGUAGE_CAPABILITY_MATRIX,
  PARITY_LANGUAGE_IDS,
  LanguageCapability,
  isLanguageCapabilityExemption,
  type LanguageCapabilityMatrix,
} from '../src/monaco/language-capabilities';
import { ERB_LANGUAGE_ID } from '../src/monaco/erb-language';
import { KOJO2_LANGUAGE_ID } from '@kojo/kojo-lang';

/* ============================== 行构建 ============================== */

describe('buildCapabilityMatrixRows', () => {
  it('行数 = 能力全集，顺序 = 枚举声明序', () => {
    const rows = buildCapabilityMatrixRows();
    expect(rows.map((r) => r.capability)).toEqual(ALL_LANGUAGE_CAPABILITIES);
  });

  it('每格状态与矩阵逐项一致（含豁免理由原文）', () => {
    const rows = buildCapabilityMatrixRows();
    for (const row of rows) {
      for (const languageId of PARITY_LANGUAGE_IDS) {
        const status = LANGUAGE_CAPABILITY_MATRIX[languageId][row.capability];
        const view = row.statuses[languageId];
        if (isLanguageCapabilityExemption(status)) {
          expect(view).toMatchObject({
            tier: 'exempt',
            available: false,
            label: '未提供',
            exemption: status.exempt,
          });
        } else {
          expect(view).toMatchObject({ tier: status, available: true, exemption: null });
          expect(view.label).not.toBe('');
        }
      }
    }
  });

  it('hasExemption 只看两门语言里有没有缺口', () => {
    const rows = buildCapabilityMatrixRows();
    const exempt = rows.filter((r) => r.hasExemption).map((r) => r.capability);
    expect(exempt).toEqual([LanguageCapability.Implementation, LanguageCapability.CallHierarchy]);
  });

  it('换一份矩阵立刻反映（没有第二份硬编码清单）', () => {
    const custom: LanguageCapabilityMatrix = {
      ...LANGUAGE_CAPABILITY_MATRIX,
      [KOJO2_LANGUAGE_ID]: {
        ...LANGUAGE_CAPABILITY_MATRIX[KOJO2_LANGUAGE_ID],
        [LanguageCapability.Completion]: { exempt: '自定义理由：等接线后改 self' },
      },
    };
    const row = buildCapabilityMatrixRows(custom).find(
      (r) => r.capability === LanguageCapability.Completion,
    );
    expect(row?.statuses[KOJO2_LANGUAGE_ID].exemption).toBe('自定义理由：等接线后改 self');
    expect(row?.hasExemption).toBe(true);
    // 入参矩阵本身没被改
    expect(LANGUAGE_CAPABILITY_MATRIX[KOJO2_LANGUAGE_ID][LanguageCapability.Completion]).toBe('self');
  });
});

/* ============================== 搜索 ============================== */

describe('filterCapabilityRows', () => {
  const rows = buildCapabilityMatrixRows();

  it('空查询（含全空白）返回原数组本体', () => {
    expect(filterCapabilityRows(rows, '')).toBe(rows);
    expect(filterCapabilityRows(rows, '   ')).toBe(rows);
  });

  it('按中文能力名命中', () => {
    expect(filterCapabilityRows(rows, '折叠').map((r) => r.capability)).toEqual([
      LanguageCapability.Folding,
    ]);
  });

  it('按能力 id 命中且大小写不敏感', () => {
    expect(filterCapabilityRows(rows, 'CALL').map((r) => r.capability)).toEqual([
      LanguageCapability.CallHierarchy,
    ]);
  });

  it('按豁免理由原文命中', () => {
    expect(filterCapabilityRows(rows, 'monaco 0.57').map((r) => r.capability)).toEqual([
      LanguageCapability.CallHierarchy,
    ]);
  });

  it('「缺口 / 豁免」兜住未提供档', () => {
    expect(filterCapabilityRows(rows, '缺口').map((r) => r.capability)).toEqual([
      LanguageCapability.Implementation,
      LanguageCapability.CallHierarchy,
    ]);
  });

  it('按档位叫法命中', () => {
    expect(filterCapabilityRows(rows, '内建').map((r) => r.capability)).toEqual([
      LanguageCapability.Indent,
      LanguageCapability.Brackets,
      LanguageCapability.Preview,
    ]);
  });

  it('无匹配返回空数组', () => {
    expect(filterCapabilityRows(rows, '不存在的词')).toEqual([]);
  });
});

/* ============================== 排序与摘要 ============================== */

describe('sortCapabilityRows', () => {
  const rows = buildCapabilityMatrixRows();

  it('清单顺序原样返回', () => {
    expect(sortCapabilityRows(rows, 'order')).toBe(rows);
  });

  it('缺口优先：有缺口的行按原声明序提前，其余保持原序，且不改入参', () => {
    const sorted = sortCapabilityRows(rows, 'exempt-first');
    expect(sorted.slice(0, 2).map((r) => r.capability)).toEqual([
      LanguageCapability.Implementation,
      LanguageCapability.CallHierarchy,
    ]);
    const rest = sorted.slice(2).map((r) => r.capability);
    expect(rest).toEqual(
      ALL_LANGUAGE_CAPABILITIES.filter(
        (c) => c !== LanguageCapability.Implementation && c !== LanguageCapability.CallHierarchy,
      ),
    );
    expect(rows.map((r) => r.capability)).toEqual(ALL_LANGUAGE_CAPABILITIES);
  });
});

describe('capabilityMatrixSummary', () => {
  it('总数 / 缺口行 / 缺口格 / 每门语言已交付面数', () => {
    const summary = capabilityMatrixSummary(buildCapabilityMatrixRows());
    expect(summary.total).toBe(ALL_LANGUAGE_CAPABILITIES.length);
    expect(summary.exemptRows).toBe(2);
    expect(summary.exemptCells).toBe(3);
    expect(summary.delivered[ERB_LANGUAGE_ID]).toBe(ALL_LANGUAGE_CAPABILITIES.length - 1);
    expect(summary.delivered[KOJO2_LANGUAGE_ID]).toBe(ALL_LANGUAGE_CAPABILITIES.length - 2);
  });
});

/* ============================== 组件 SSR ============================== */

describe('CapabilityMatrixSection', () => {
  const html = renderToStaticMarkup(h(CapabilityMatrixSection));

  it('两门语言与搜索 / 折叠入口都在', () => {
    expect(html).toContain('语言能力');
    expect(html).toContain('ERB');
    expect(html).toContain('Kojo 2.0');
    expect(html).toContain('aria-label="搜索语言能力"');
    expect(html).toContain('折叠清单');
    expect(html).toContain('缺口优先');
  });

  it('每项能力各一行', () => {
    expect(html.match(/data-capability="/g)?.length).toBe(ALL_LANGUAGE_CAPABILITIES.length);
    expect(html).toContain('调用层级');
    expect(html).toContain('整理格式');
  });

  it('豁免理由铺开在行下，未提供档可见', () => {
    expect(html).toContain('Monaco 0.57');
    expect(html).toContain('未提供');
    expect(html).toContain('2.0 里&quot;跳实现&quot;与&quot;转定义&quot;是同一件事');
  });
});
