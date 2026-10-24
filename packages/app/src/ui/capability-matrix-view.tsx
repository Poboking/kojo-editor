/**
 * 设置页「语言能力」节（批次十 S15，2026-10-23）——一等语言能力矩阵的**只读可视化**。
 *
 * ## 数据只认一个真源
 *
 * 行、状态、豁免理由全部现读 `monaco/language-capabilities.ts` 的
 * {@link LANGUAGE_CAPABILITY_MATRIX}（以及它的 `{ exempt }` 文案）；本文件只补**作者面标签**
 * （能力名 / 四档叫法 / 两门语言名），**不另存一份能力清单或矩阵**。矩阵加一枚能力、
 * 或把某格从豁免改成已交付，这里下一轮渲染就跟着变——没有第二处需要同步。
 *
 * ## 为什么不做开关
 *
 * 能力事实的真源仍是各自 provider 的注册点；矩阵是那批注册点的清单与承诺，不是第二套
 * 开关（见 language-capabilities.ts 头注「谁消费这张表」）。所以本节只读：搜索、排序、
 * 折叠都只改**看法**，不改任何行为、不写任何偏好、不动文件。
 *
 * ## 样式
 *
 * 全内联、只用主题 token（`var(--fg-dim)` / `var(--border-subtle)` …），不动 `styles.css`
 * （冲突热点）——与 `kojo2-cutover-settings.tsx` 同一先例。
 */
import { useState, type CSSProperties, type ReactElement } from 'react';
import {
  ALL_LANGUAGE_CAPABILITIES,
  LANGUAGE_CAPABILITY_MATRIX,
  PARITY_LANGUAGE_IDS,
  isLanguageCapabilityExemption,
  LanguageCapability,
  type LanguageCapabilityMatrix,
  type LanguageCapabilityTier,
  type ParityLanguageId,
} from '../monaco/language-capabilities';
import { ERB_LANGUAGE_ID } from '../monaco/erb-language';
import { KOJO2_LANGUAGE_ID } from '@kojo/kojo-lang/constants';

/* ============================== 作者面标签（只此一份，别处不要抄） ============================== */

/**
 * 能力的人类叫法。顺序与 `LanguageCapability` 枚举无关；**键集由 typecheck 钉死**：
 * 枚举加一枚而这里不补，`Record<LanguageCapability, …>` 直接红——与矩阵同一条纪律。
 */
const CAPABILITY_LABELS: Readonly<Record<LanguageCapability, string>> = Object.freeze({
  [LanguageCapability.Folding]: '折叠',
  [LanguageCapability.Outline]: '大纲',
  [LanguageCapability.Format]: '整理格式',
  [LanguageCapability.Semantic]: '结构化着色',
  [LanguageCapability.Indent]: '缩进',
  [LanguageCapability.Brackets]: '括号配对',
  [LanguageCapability.References]: '查找引用',
  [LanguageCapability.Rename]: '改名',
  [LanguageCapability.Signature]: '签名提示',
  [LanguageCapability.Inlay]: '行内提示',
  [LanguageCapability.CodeLens]: '行上注解',
  [LanguageCapability.Implementation]: '跳实现',
  [LanguageCapability.Highlight]: '同符号高亮',
  [LanguageCapability.Selection]: '扩选',
  [LanguageCapability.CallHierarchy]: '调用层级',
  [LanguageCapability.Completion]: '补全',
  [LanguageCapability.Hover]: '悬停提示',
  [LanguageCapability.Definition]: '转定义',
  [LanguageCapability.Diagnostics]: '诊断',
  [LanguageCapability.Preview]: '预览',
});

/** 一门语言名（两门一等语言；作者面不出现语言 id） */
const LANGUAGE_LABELS: Readonly<Record<ParityLanguageId, string>> = Object.freeze({
  [ERB_LANGUAGE_ID]: 'ERB',
  [KOJO2_LANGUAGE_ID]: 'Kojo 2.0',
});

/** 四档状态的人话（三档已交付 + 一档豁免；语义见 language-capabilities.ts 头注） */
const TIER_LABELS: Readonly<Record<LanguageCapabilityTier | 'exempt', string>> = Object.freeze({
  builtin: '内建',
  shared: '共享',
  self: '专属',
  exempt: '未提供',
});

/** 每档的一句话解释（节头 hint 用；与矩阵头注同口径） */
const TIER_HINTS: readonly { tier: LanguageCapabilityTier | 'exempt'; text: string }[] = [
  { tier: 'builtin', text: '编辑器自带，语言包不注册' },
  { tier: 'shared', text: '同一份服务同时挂给声明了它的语言' },
  { tier: 'self', text: '该语言自己的模块提供' },
  { tier: 'exempt', text: '已知缺口，行下写明原因与下一步' },
];

/* ============================== 纯视图模型 ============================== */

export type CapabilityStatusTier = LanguageCapabilityTier | 'exempt';

/** 一门语言在一项能力上的呈现状态 */
export interface CapabilityStatusView {
  readonly tier: CapabilityStatusTier;
  readonly available: boolean;
  readonly label: string;
  /** 仅 `{ exempt }` 档有值：矩阵里那句人话理由 */
  readonly exemption: string | null;
}

/** 一行 = 一项能力 × 两门语言 */
export interface CapabilityMatrixRow {
  readonly capability: LanguageCapability;
  readonly label: string;
  readonly statuses: Readonly<Record<ParityLanguageId, CapabilityStatusView>>;
  /** 任一语言标了豁免 ⇒ 这一行是「有缺口」 */
  readonly hasExemption: boolean;
}

/** 排序口径：清单顺序（枚举声明序，稳定）/ 缺口优先（有豁免的行提到前面，其余保持原序） */
export type CapabilitySort = 'order' | 'exempt-first';

/** 节头读数 */
export interface CapabilityMatrixSummary {
  readonly total: number;
  /** 有至少一门语言缺一项能力的行数 */
  readonly exemptRows: number;
  /** 豁免格数（行 × 语言逐格数） */
  readonly exemptCells: number;
  /** 每门语言已交付的面数 */
  readonly delivered: Readonly<Record<ParityLanguageId, number>>;
}

/**
 * 把矩阵摊成展示行。
 *
 * 缺省读模块导出的 {@link LANGUAGE_CAPABILITY_MATRIX}；形参只给测试与将来的筛选视图用。
 * 不缓存、不复制：调用方每次渲染现调，矩阵变了这里就变。
 */
export function buildCapabilityMatrixRows(
  matrix: LanguageCapabilityMatrix = LANGUAGE_CAPABILITY_MATRIX,
): readonly CapabilityMatrixRow[] {
  return ALL_LANGUAGE_CAPABILITIES.map((capability) => {
    const statuses = {} as Record<ParityLanguageId, CapabilityStatusView>;
    for (const languageId of PARITY_LANGUAGE_IDS) {
      const status = matrix[languageId][capability];
      statuses[languageId] = isLanguageCapabilityExemption(status)
        ? { tier: 'exempt', available: false, label: TIER_LABELS.exempt, exemption: status.exempt }
        : { tier: status, available: true, label: TIER_LABELS[status], exemption: null };
    }
    return {
      capability,
      label: CAPABILITY_LABELS[capability],
      statuses,
      hasExemption: PARITY_LANGUAGE_IDS.some((languageId) => !statuses[languageId].available),
    };
  });
}

/**
 * 搜索：大小写不敏感的子串匹配，命中能力名 / 能力 id / 语言名 / 档位叫法 / 豁免理由。
 *
 * 空查询（含全空白）返回原数组本体——不复制，调用方按只读数组用。
 * 「缺口」「豁免」两个词单独兜住：免得作者为了找缺口还要读懂「未提供」这个叫法。
 */
export function filterCapabilityRows(
  rows: readonly CapabilityMatrixRow[],
  query: string,
): readonly CapabilityMatrixRow[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return rows;
  return rows.filter((row) => {
    const parts: string[] = [row.label, row.capability];
    for (const languageId of PARITY_LANGUAGE_IDS) {
      const status = row.statuses[languageId];
      parts.push(LANGUAGE_LABELS[languageId], status.label);
      if (status.exemption !== null) parts.push(status.exemption, '缺口', '豁免');
    }
    return parts.join('\n').toLowerCase().includes(needle);
  });
}

/** 排序：返回新数组（不改入参）；`order` 原样返回，`exempt-first` 稳定地把缺口行提前 */
export function sortCapabilityRows(
  rows: readonly CapabilityMatrixRow[],
  sort: CapabilitySort,
): readonly CapabilityMatrixRow[] {
  if (sort === 'order') return rows;
  return [...rows].sort((a, b) => Number(b.hasExemption) - Number(a.hasExemption));
}

/** 节头读数：总项数、缺口行 / 格、每门语言已交付面数 */
export function capabilityMatrixSummary(
  rows: readonly CapabilityMatrixRow[],
): CapabilityMatrixSummary {
  const delivered = {} as Record<ParityLanguageId, number>;
  let exemptCells = 0;
  for (const languageId of PARITY_LANGUAGE_IDS) {
    let count = 0;
    for (const row of rows) {
      if (row.statuses[languageId].available) count += 1;
      else exemptCells += 1;
    }
    delivered[languageId] = count;
  }
  return {
    total: rows.length,
    exemptRows: rows.filter((row) => row.hasExemption).length,
    exemptCells,
    delivered,
  };
}

/* ============================== 组件（全内联样式） ============================== */

/** 三列栅格：能力名 + 两门语言各一格；豁免理由占满整行（长句可折） */
const ROW_STYLE: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) minmax(72px, auto) minmax(72px, auto)',
  columnGap: 'var(--space-3)',
  rowGap: 'var(--space-1)',
  alignItems: 'center',
  padding: 'var(--space-1) var(--space-3)',
  borderTop: '1px solid var(--border-subtle)',
  fontSize: 'var(--fs-2)',
  lineHeight: 1.5,
};

const HEADER_STYLE: CSSProperties = {
  ...ROW_STYLE,
  borderTop: 'none',
  color: 'var(--fg-dim)',
  fontSize: 'var(--fs-1)',
};

const CHIP_BASE: CSSProperties = {
  justifySelf: 'start',
  padding: '0 8px',
  borderRadius: '999px',
  border: '1px solid var(--border)',
  color: 'var(--fg-dim)',
  fontSize: 'var(--fs-1)',
  lineHeight: 1.7,
  whiteSpace: 'nowrap',
};

const CHIP_EXEMPT: CSSProperties = {
  ...CHIP_BASE,
  color: 'var(--warning)',
  borderColor: 'var(--warning)',
};

/**
 * 「语言能力」节本体。
 *
 * 三个本地状态都只改看法：`query`（搜索）、`sort`（排序）、`collapsed`（折叠清单）。
 * 没有偏好写入、没有副作用——打开/关掉设置页不改变任何行为。
 */
export function CapabilityMatrixSection(): ReactElement {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<CapabilitySort>('order');
  const [collapsed, setCollapsed] = useState(false);

  /* 每轮现读模块导出：矩阵是唯一真源，这里不留副本（见文件头「数据只认一个真源」） */
  const allRows = buildCapabilityMatrixRows();
  const visibleRows = sortCapabilityRows(filterCapabilityRows(allRows, query), sort);
  const summary = capabilityMatrixSummary(allRows);
  const filtering = query.trim() !== '';

  return (
    <div className="settings-group" data-settings-key="language.capabilities">
      <div role="heading" aria-level={4} className="settings-group-title">语言能力</div>

      <div className="settings-row static has-field">
        <input
          className="settings-text"
          type="search"
          value={query}
          placeholder="搜能力名或豁免原因…"
          aria-label="搜索语言能力"
          onChange={(e) => setQuery(e.target.value)}
        />
        <span>
          一等语言对照
          <span className="settings-hint">
            ERB 与 Kojo 2.0 同级：这张表逐项列出两门语言承诺的语言面。
            {TIER_HINTS.map((h) => `「${TIER_LABELS[h.tier]}」${h.text}`).join('；')}。
            只读读数：能力的有无由各自的注册点决定，这里不能开关，也不改动文件。
          </span>
        </span>
      </div>

      <div className="settings-row static">
        <span className="theme-segment" role="radiogroup" aria-label="能力排序">
          {([
            { value: 'order', label: '清单顺序' },
            { value: 'exempt-first', label: '缺口优先' },
          ] as const).map((choice) => (
            <button
              key={choice.value}
              type="button"
              role="radio"
              aria-checked={sort === choice.value}
              className={`theme-seg-btn${sort === choice.value ? ' on' : ''}`}
              onClick={() => setSort(choice.value)}
            >
              {choice.label}
            </button>
          ))}
        </span>
        <button
          type="button"
          className="ghost small"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((v) => !v)}
        >
          {collapsed ? '展开清单' : '折叠清单'}
        </button>
        <span>
          查看方式
          <span className="settings-hint">
            共 {summary.total} 项；有缺口 {summary.exemptRows} 项。{filtering ? `当前命中 ${visibleRows.length} 项。` : ''}
          </span>
        </span>
      </div>

      {collapsed ? null : (
        <div>
          <div style={HEADER_STYLE} aria-hidden="true">
            <span>能力</span>
            {PARITY_LANGUAGE_IDS.map((languageId) => (
              <span key={languageId}>
                {LANGUAGE_LABELS[languageId]} · {summary.delivered[languageId]}/{summary.total}
              </span>
            ))}
          </div>

          {visibleRows.length === 0 ? (
            <div className="settings-hint" role="status" style={{ padding: 'var(--space-2) var(--space-3)' }}>
              没有匹配的能力；换个词，或清空搜索看全部 {summary.total} 项。
            </div>
          ) : (
            visibleRows.map((row) => {
              const exemptions = PARITY_LANGUAGE_IDS.flatMap((languageId) => {
                const status = row.statuses[languageId];
                return status.exemption === null
                  ? []
                  : [{ languageId, reason: status.exemption }];
              });
              return (
                <div key={row.capability} style={ROW_STYLE} data-capability={row.capability}>
                  <span>{row.label}</span>
                  {PARITY_LANGUAGE_IDS.map((languageId) => {
                    const status = row.statuses[languageId];
                    return (
                      <span
                        key={languageId}
                        style={status.available ? CHIP_BASE : CHIP_EXEMPT}
                        aria-label={`${LANGUAGE_LABELS[languageId]}：${status.label}`}
                      >
                        {status.label}
                      </span>
                    );
                  })}
                  {exemptions.map(({ languageId, reason }) => (
                    <span
                      key={`${row.capability}-${languageId}`}
                      className="settings-hint"
                      style={{ gridColumn: '1 / -1' }}
                    >
                      <strong style={{ color: 'var(--fg)' }}>{LANGUAGE_LABELS[languageId]}</strong>
                      {'：'}
                      {reason}
                    </span>
                  ))}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
