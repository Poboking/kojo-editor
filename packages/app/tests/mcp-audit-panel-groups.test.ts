// @vitest-environment happy-dom
/**
 * T3 判据：审计面板「会话分组 + 原因列 + 错误码文案表」。
 *
 * 先红后绿，钉住四件事：
 *   A1 按 `sessionId` 分组，无 `sessionId` 的旧条目落具名组，**一条不丢**；
 *   A2 组内按 `ts` 升序（输入打乱也照样时间线）；
 *   A3/A4 `note` 上屏：已知原因码走人话，未知码原样显示（不空白、不吞）；
 *   A5 全仓 `E_*` 码覆盖闸（模板前缀 `E_QUICKFIX_` 不是完整码，抽取规则须排除）；
 *   A6 三枚原因码全覆盖且文案两两不同；
 *   A7 文案卫生（非空 / 无 TODO / 无长十六进制 / 无盘符 / 无 127.0.0.1:）；
 *   A8 `formatAuditEntry` 逐字不变（文本导出面红线，另建一条，不改原文件）。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { act, createElement as h, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';

import {
  AuditPanel,
  UNLABELED_SESSION_LABEL,
  formatAuditEntry,
  groupAuditEntries,
  type AuditEntryView,
} from '../src/mcp/audit-panel';
import {
  MCP_ERROR_COPY,
  MCP_REASON_COPY,
  copyForError,
  copyForReason,
} from '../src/mcp/mcp-error-copy';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* ------------------------------- 渲染脚手架 ------------------------------- */

const mountedRoots: Array<{
  root: ReturnType<typeof createRoot>;
  container: HTMLDivElement;
}> = [];

afterEach(async () => {
  for (const { root, container } of mountedRoots.splice(0)) {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  }
  document.body.innerHTML = '';
});

async function mount(el: ReactElement): Promise<{
  text: () => string;
  find: (sel: string) => Element | null;
  findAll: (sel: string) => Element[];
}> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mountedRoots.push({ root, container });
  await act(async () => {
    root.render(el);
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  return {
    text: () => container.textContent ?? '',
    find: (sel) => container.querySelector(sel),
    findAll: (sel) => [...container.querySelectorAll(sel)],
  };
}

const entry = (over: Partial<AuditEntryView> & { ts: string }): AuditEntryView => ({
  clientId: 'c1',
  tool: 'read_file',
  argsDigest: '{}',
  outcome: 'ok',
  ...over,
});

/* --------------------------------- A1/A2 --------------------------------- */

describe('A1 会话分组：按 sessionId 归组，无 sessionId 落具名组，一条不丢', () => {
  const entries: AuditEntryView[] = [
    entry({ ts: 't1', sessionId: 'sess-a', tool: 'read_file' }),
    entry({ ts: 't2', sessionId: 'sess-a', tool: 'write_file' }),
    entry({ ts: 't3', sessionId: 'sess-a', tool: 'fileTree.remove' }),
    entry({ ts: 't4', tool: 'export_file' }),
    entry({ ts: 't5', tool: 'launcher_start' }),
  ];

  it('三条同会话 + 两条无会话 ⇒ 两组，Σ 组内条目 === 输入条目数', () => {
    const groups = groupAuditEntries(entries);
    expect(groups).toHaveLength(2);
    expect(groups.reduce((n, g) => n + g.rows.length, 0)).toBe(entries.length);
    const sessionGroup = groups.find((g) => g.sessionId === 'sess-a');
    expect(sessionGroup?.rows.map((r) => r.ts)).toEqual(['t1', 't2', 't3']);
    const loose = groups.find((g) => g.sessionId === undefined);
    expect(loose, '无 sessionId 的条目必须落进具名分组，不许丢弃').toBeDefined();
    expect(loose!.label).toBe(UNLABELED_SESSION_LABEL);
    expect(loose!.rows.map((r) => r.ts)).toEqual(['t4', 't5']);
  });

  it('组头带 clientId 与条目数（多客户端去重列出）', () => {
    const groups = groupAuditEntries([
      entry({ ts: 't1', sessionId: 's', clientId: 'c1' }),
      entry({ ts: 't2', sessionId: 's', clientId: 'c2' }),
      entry({ ts: 't3', sessionId: 's', clientId: 'c1' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.clientIds.sort()).toEqual(['c1', 'c2']);
    expect(groups[0]!.rows).toHaveLength(3);
  });

  it('屏上：两组标题都在，行数一条不少（组头不是 li，行数断言不漂）', async () => {
    const hz = await mount(h(AuditPanel, { entries }));
    expect(hz.findAll('[data-testid="mcp-audit-group"]')).toHaveLength(2);
    expect(hz.text()).toContain('sess-a');
    expect(hz.text()).toContain(UNLABELED_SESSION_LABEL);
    expect(hz.findAll('[data-testid="mcp-audit-rows"] li')).toHaveLength(entries.length);
  });
});

describe('A2 组内时间线：输入打乱，组内仍按 ts 升序', () => {
  it('打乱顺序 ⇒ 组内 ts 升序', () => {
    const groups = groupAuditEntries([
      entry({ ts: '2026-11-06T10:00:03.000Z', sessionId: 's' }),
      entry({ ts: '2026-11-06T10:00:01.000Z', sessionId: 's' }),
      entry({ ts: '2026-11-06T10:00:02.000Z', sessionId: 's' }),
      entry({ ts: '2026-11-06T10:00:05.000Z' }),
      entry({ ts: '2026-11-06T10:00:04.000Z' }),
    ]);
    const session = groups.find((g) => g.sessionId === 's')!;
    expect(session.rows.map((r) => r.ts)).toEqual([
      '2026-11-06T10:00:01.000Z',
      '2026-11-06T10:00:02.000Z',
      '2026-11-06T10:00:03.000Z',
    ]);
    const loose = groups.find((g) => g.sessionId === undefined)!;
    expect(loose.rows.map((r) => r.ts)).toEqual([
      '2026-11-06T10:00:04.000Z',
      '2026-11-06T10:00:05.000Z',
    ]);
  });
});

/* --------------------------------- A3/A4 --------------------------------- */

describe('A3 原因列上屏：已知原因码渲染人话，不把裸机器码当唯一内容', () => {
  it('note=privileged_not_approved ⇒ 屏上出现文案表 human，且不再只剩机器码', async () => {
    const hz = await mount(
      h(AuditPanel, {
        entries: [
          entry({
            ts: '2026-11-06T10:00:00.000Z',
            tool: 'fileTree.remove',
            outcome: 'denied',
            note: 'privileged_not_approved',
          }),
        ],
      }),
    );
    const copy = MCP_REASON_COPY['privileged_not_approved']!;
    expect(copy, 'privileged_not_approved 必须有文案').toBeDefined();
    expect(hz.text()).toContain(copy.human);
    expect(hz.text(), '屏上不该只剩机器码').not.toContain('privileged_not_approved');
  });
});

describe('A4 未知原因码：原样显示，不空白不吞', () => {
  it("note='brand_new_reason' ⇒ 屏上原样出现 brand_new_reason", async () => {
    const hz = await mount(
      h(AuditPanel, {
        entries: [
          entry({
            ts: '2026-11-06T10:00:00.000Z',
            tool: 'read_file',
            outcome: 'filtered',
            note: 'brand_new_reason',
          }),
        ],
      }),
    );
    expect(hz.text()).toContain('brand_new_reason');
    expect(copyForReason('brand_new_reason')).toBeUndefined();
  });
});

/* ---------------------------------- A5 ---------------------------------- */

/** vitest 以仓库根为 cwd 启动（`node node_modules/vitest/vitest.mjs run …`）。 */
const REPO_ROOT = process.cwd();

function listFiles(dir: string, ext: readonly string[]): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && ext.some((e) => d.name.endsWith(e)))
    .map((d) => join(dir, d.name));
}

const QUOTED_LITERAL = /"([^"\n]*)"|'([^'\n]*)'|`([^`\n]*)`/g;

/**
 * 只收**完整字符串字面量**里的 `E_*` 码：
 *   · 模板插值不影响同一字面量里的完整码（`[E_X] …${v}` 仍算完整），照收；
 *   · 以 `_` 结尾的是**前缀**（注释里的 `E_QUICKFIX_*`、模板里的 `E_QUICKFIX_${kind}`），
 *     跳过——宁可不收，也不许为凑数造假键。
 */
function extractCodes(src: string): string[] {
  const out = new Set<string>();
  for (const m of src.matchAll(QUOTED_LITERAL)) {
    const literal = m[1] ?? m[2] ?? m[3] ?? '';
    for (const t of literal.matchAll(/\bE_[A-Z0-9_]+\b/g)) {
      if (t[0].endsWith('_')) continue;
      out.add(t[0]);
    }
  }
  return [...out];
}

function scanCodes(): string[] {
  const files = [
    ...listFiles(join(REPO_ROOT, 'packages/app/src-tauri/src/mcp'), ['.rs']),
    ...listFiles(join(REPO_ROOT, 'packages/mcp-host/src'), ['.ts']),
    ...listFiles(join(REPO_ROOT, 'packages/app/src/mcp'), ['.ts', '.tsx']),
  ];
  expect(files.length).toBeGreaterThan(10);
  const codes = new Set<string>();
  for (const f of files) {
    for (const code of extractCodes(readFileSync(f, 'utf8'))) codes.add(code);
  }
  return [...codes].sort();
}

describe('A5 覆盖闸：源码里每一枚完整 E_* 码都必须是文案表的键', () => {
  it('全部 E_* 码覆盖，且不靠假键凑数', () => {
    const codes = scanCodes();
    expect(codes.length, '抽取规则失效（扫不出码）').toBeGreaterThanOrEqual(40);
    expect(codes).not.toContain('E_QUICKFIX_');
    const missing = codes.filter((code) => MCP_ERROR_COPY[code] === undefined);
    expect(missing, `这些码没有人类可读文案：${missing.join(', ')}`).toEqual([]);
  });

  it('copyForError：已知码返回文案，未知码返回 undefined', () => {
    expect(copyForError('E_TOOL_NOT_APPROVED')?.human).toBeTruthy();
    expect(copyForError('E_DOES_NOT_EXIST')).toBeUndefined();
  });
});

/* ---------------------------------- A6 ---------------------------------- */

describe('A6 三枚原因码全覆盖，文案两两可区分', () => {
  it('market_fail_closed / privileged_not_approved / tier_filtered 都在表里且 human 各不相同', () => {
    const reasons = ['market_fail_closed', 'privileged_not_approved', 'tier_filtered'];
    for (const r of reasons) {
      expect(MCP_REASON_COPY[r], `缺原因码文案：${r}`).toBeDefined();
      expect(MCP_REASON_COPY[r]!.human.length).toBeGreaterThan(0);
    }
    const humans = reasons.map((r) => MCP_REASON_COPY[r]!.human);
    expect(new Set(humans).size).toBe(3);
  });
});

/* ---------------------------------- A7 ---------------------------------- */

describe('A7 文案卫生：非空 / 无 TODO / 无长十六进制 / 无盘符 / 无 127.0.0.1:', () => {
  it('两张表全部 human 与 hint 通过卫生检查', () => {
    const tables: Array<[string, Record<string, { human: string; hint?: string }>]> = [
      ['MCP_ERROR_COPY', MCP_ERROR_COPY],
      ['MCP_REASON_COPY', MCP_REASON_COPY],
    ];
    for (const [name, table] of tables) {
      for (const [key, copy] of Object.entries(table)) {
        expect(copy.human.trim(), `${name}.${key}.human 为空`).not.toBe('');
        expect(copy.human, `${name}.${key}.human 含 TODO`).not.toMatch(/TODO/i);
        expect(copy.human, `${name}.${key}.human 含长十六进制`).not.toMatch(/\b[0-9a-f]{32,}\b/i);
        expect(copy.human, `${name}.${key}.human 含盘符路径`).not.toMatch(/[A-Za-z]:[\\/]/);
        expect(copy.human, `${name}.${key}.human 含 127.0.0.1:`).not.toContain('127.0.0.1:');
        expect(copy.human, `${name}.${key}.human 重复机器码`).not.toContain(key);
        if (copy.hint !== undefined) {
          expect(copy.hint.trim(), `${name}.${key}.hint 为空串`).not.toBe('');
          expect(copy.hint, `${name}.${key}.hint 含 TODO`).not.toMatch(/TODO/i);
          expect(copy.hint, `${name}.${key}.hint 含 127.0.0.1:`).not.toContain('127.0.0.1:');
          expect(copy.hint, `${name}.${key}.hint 含盘符路径`).not.toMatch(/[A-Za-z]:[\\/]/);
        }
      }
    }
  });
});

/* ---------------------------------- A8 ---------------------------------- */

describe('A8 红线：formatAuditEntry 文本导出逐字不变', () => {
  it('含 note 的 denied 条目', () => {
    expect(
      formatAuditEntry({
        ts: 't3',
        clientId: 'c1',
        tool: 'fileTree.remove',
        argsDigest: 'path:str(9)',
        outcome: 'denied',
        note: '特权工具未批准',
      }),
    ).toBe('t3 c1 fileTree.remove [denied] path:str(9)（特权工具未批准）');
  });

  it('含 sessionId / elapsedMs / landedPath 的全字段条目', () => {
    expect(
      formatAuditEntry({
        ts: '2026-11-06T10:00:00.000Z',
        clientId: 'c1',
        tool: 'fileTree.remove',
        argsDigest: 'relPath:str(9)',
        outcome: 'denied',
        landedPath: 'docs/a.txt',
        note: '特权工具未批准',
        sessionId: 'sess-7',
        elapsedMs: 12,
      }),
    ).toBe(
      '2026-11-06T10:00:00.000Z c1 fileTree.remove [denied] relPath:str(9) <sess-7> 12ms → docs/a.txt（特权工具未批准）',
    );
  });

  it('缺项条目不多写空格', () => {
    expect(
      formatAuditEntry({
        ts: 't1',
        clientId: 'c1',
        tool: 'read_file',
        argsDigest: '{}',
        outcome: 'ok',
      }),
    ).toBe('t1 c1 read_file [ok] {}');
  });
});
