/**
 * 命中列表「摊平 + 渲染窗口」判据（纯函数面：`panel-rows.ts`，零 React）。
 *
 * 钉三件事（2026-11-02 规模批 KW-9）：
 *   ① 摊平顺序与折叠语义和窗口化之前的渲染逐层 push 一致（含搜索时全展开）；
 *   ② 一次挂载的行数被 `NAV_WINDOW` 收口：初值封顶、按步长生长、终值 = total；
 *   ③ `mustInclude` 定位语义：点名的行在窗口外时窗口撑大到盖住它（照谓词窗 G1）。
 *
 * 规模钉不用计时断言（本仓纪律：`performance.now()` + 比较会把文件整份踢出功能池）。
 * 真盘参照读数（eraFL `D:/Game/erafl/ERB/口上`）：293 份 XML / 61,562 条口上 /
 * 单文件最大 2,445 条——合成夹具按 5,000 条造，远超真盘任何一档。
 */

import { describe, expect, it } from 'vitest';
import type { KojoXmlCommand, KojoXmlFile, KojoXmlIndex } from '@kojo/plugin-api';
import { buildPanelTree, filterPanelTree, type PanelTree } from '../src/panel-tree';
import {
  flattenPanelRows,
  navWindowSize,
  NAV_WINDOW,
  NAV_WINDOW_INITIAL,
  NAV_WINDOW_STEP,
  nextNavWindow,
  type PanelRow,
} from '../src/panel-rows';

/* ------------------------------ 测试基建 ------------------------------ */

function cmd(com: string, text: string, line: number, index: number): KojoXmlCommand {
  return {
    index,
    span: { start: { line, column: 3 }, end: { line: line + 2, column: 12 } },
    contentSpan: null,
    attrs: { com, name: `条目${com}` },
    text,
  };
}

function file(path: string, charaNo: number | null, commands: KojoXmlCommand[]): KojoXmlFile {
  return { path, format: 'data', encoding: 'utf-8', eol: 'crlf', charaNo, commands, diagnostics: [] };
}

/** 按契约形状折索引（排序口径与提供方一致：文件按路径、角色号升序） */
function makeIndex(files: KojoXmlFile[]): KojoXmlIndex {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const byChara = new Map<number, KojoXmlFile[]>();
  const byCom = new Map<string, number>();
  let commandCount = 0;
  for (const f of sorted) {
    if (f.charaNo !== null) {
      const bucket = byChara.get(f.charaNo);
      if (bucket) bucket.push(f);
      else byChara.set(f.charaNo, [f]);
    }
    for (const c of f.commands) {
      commandCount++;
      const key = c.attrs['com'] ?? '';
      byCom.set(key, (byCom.get(key) ?? 0) + 1);
    }
  }
  return {
    files: sorted,
    commandCount,
    byChara: new Map([...byChara.entries()].sort((a, b) => a[0] - b[0])),
    byCom,
    diagnostics: [],
    scannedAt: 1,
  };
}

/** 小夹具：2 个角色、3 份文件、每文件 2 条 */
function smallTree(): PanelTree {
  return buildPanelTree(
    makeIndex([
      file('root/1001_a/KOJO_K1001_COM.xml', 1001, [cmd('300', '「早」', 3, 0), cmd('1000', '「晚」', 8, 1)]),
      file('root/1001_a/KOJO_K1001_EVENT.xml', 1001, [cmd('30', '「嗯」', 2, 0), cmd('40', '「啊」', 5, 1)]),
      file('root/1002_b/KOJO_K1002_COM.xml', 1002, [cmd('300', '「台词」', 4, 0), cmd('310', '「再见」', 9, 1)]),
    ]),
    new Map<number, string>([
      [1001, '阿莉丝'],
      [1002, '贝拉'],
    ]),
  );
}

/** 规模夹具：1 个角色 × 1 份文件 × n 条口上（远超初值窗口） */
function bigTree(n: number): PanelTree {
  const commands = Array.from({ length: n }, (_, i) => cmd(String(i + 1), `台词 ${i + 1}`, i + 2, i));
  return buildPanelTree(makeIndex([file('root/1001_a/KOJO_K1001_COM.xml', 1001, commands)]), new Map());
}

const CLOSED = { searching: false, openCharas: new Set<string>(), openFiles: new Set<string>(), previewId: null };
const OPEN_ALL = {
  searching: false,
  openCharas: new Set(['chara:1001', 'chara:1002']),
  openFiles: new Set([
    'root/1001_a/KOJO_K1001_COM.xml',
    'root/1001_a/KOJO_K1001_EVENT.xml',
    'root/1002_b/KOJO_K1002_COM.xml',
  ]),
  previewId: null,
};

/* ------------------------------ 摊平语义 ------------------------------ */

describe('flattenPanelRows：顺序与折叠语义（与窗口化前的逐层 push 一致）', () => {
  it('全折叠：一行一个角色，顺序 = 树的组序', () => {
    const rows = flattenPanelRows(smallTree(), CLOSED);
    expect(rows.map((r) => r.kind)).toEqual(['chara', 'chara']);
    expect((rows[0] as Extract<PanelRow, { kind: 'chara' }>).chara.label).toBe('阿莉丝');
  });

  it('展开角色出文件行、展开文件出条目行，顺序严格 角色→文件→条目 深度优先', () => {
    const rows = flattenPanelRows(smallTree(), OPEN_ALL);
    expect(rows.length).toBe(2 + 3 + 6);
    expect(rows.map((r) => r.kind)).toEqual([
      'chara', 'file', 'command', 'command', 'file', 'command', 'command', 'chara', 'file', 'command', 'command',
    ]);
  });

  it('key 沿用原渲染的 React key：chara.id / file.id / command.id', () => {
    const rows = flattenPanelRows(smallTree(), OPEN_ALL);
    expect(rows[0]!.key).toBe('chara:1001');
    expect(rows[1]!.key).toBe('root/1001_a/KOJO_K1001_COM.xml');
    expect(rows[2]!.key).toBe('root/1001_a/KOJO_K1001_COM.xml:3:3:0');
  });

  it('previewId 命中时在条目行后插一行 preview（key = 条目 key + ":preview"）', () => {
    const rows = flattenPanelRows(smallTree(), { ...OPEN_ALL, previewId: 'root/1001_a/KOJO_K1001_COM.xml:3:3:0' });
    expect(rows.length).toBe(2 + 3 + 6 + 1);
    expect(rows[3]!.kind).toBe('preview');
    expect(rows[3]!.key).toBe('root/1001_a/KOJO_K1001_COM.xml:3:3:0:preview');
  });

  it('搜索态 = 全展开（既有语义不动）：open 集合为空也把文件与条目全摊出来', () => {
    const filtered = filterPanelTree(smallTree(), '台词');
    const rows = flattenPanelRows(filtered, { ...CLOSED, searching: true });
    expect(rows.some((r) => r.kind === 'command')).toBe(true);
    expect(rows.every((r) => r.kind !== 'chara' && r.kind !== 'file' || r.open === true)).toBe(true);
  });

  it('空树 / null 树给空数组（空态文案由渲染层保留）', () => {
    expect(flattenPanelRows(null, CLOSED)).toEqual([]);
    expect(flattenPanelRows(filterPanelTree(smallTree(), '不存在的词'), CLOSED)).toEqual([]);
  });
});

/* ------------------------------ 窗口收口 ------------------------------ */

describe('NAV_WINDOW：一次挂载的行数收口（规模钉，无计时断言）', () => {
  it('档位常量：初值 120 / 步长 240（1:2 节奏，同谓词窗档位）', () => {
    expect(NAV_WINDOW).toEqual({ initial: 120, step: 240 });
    expect(NAV_WINDOW_INITIAL).toBe(120);
    expect(NAV_WINDOW_STEP).toBe(240);
  });

  it('5,000 条全展开：首帧实际建的行数 = 初值 120（≤ 初值 + 步长的上界判据从这起步）', () => {
    const rows = flattenPanelRows(bigTree(5_000), { searching: true, openCharas: new Set(), openFiles: new Set(), previewId: null });
    expect(rows.length).toBe(1 + 1 + 5_000);
    const win = navWindowSize(rows.length, undefined);
    expect(win).toBe(NAV_WINDOW_INITIAL);
    expect(rows.slice(0, win).length).toBeLessThanOrEqual(NAV_WINDOW_INITIAL + NAV_WINDOW_STEP);
  });

  it('再翻一层能长：nextNavWindow 首步到 初值+步长，单步增量 = 步长，终值 = total', () => {
    const total = 5_002;
    let cur: number | undefined;
    const seen: number[] = [];
    for (let i = 0; i < 100; i++) {
      cur = nextNavWindow(cur, total);
      seen.push(cur);
      if (cur === total) break;
    }
    expect(seen[0]).toBe(NAV_WINDOW_INITIAL + NAV_WINDOW_STEP);
    expect(seen[1]).toBe(NAV_WINDOW_INITIAL + 2 * NAV_WINDOW_STEP);
    expect(seen[seen.length - 1]).toBe(total);
    // 单调不减、增量有界（≤ 步长）
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]! - seen[i - 1]!).toBeGreaterThan(0);
      expect(seen[i]! - seen[i - 1]!).toBeLessThanOrEqual(NAV_WINDOW_STEP);
    }
  });

  it('小列表（≤ 初值）零哨兵：窗口 = total，与窗口化前的常见路径同构', () => {
    const rows = flattenPanelRows(smallTree(), OPEN_ALL);
    expect(navWindowSize(rows.length, undefined)).toBe(rows.length);
  });

  it('窗口不越界：limit 大于 total 时按 total 钉住', () => {
    const rows = flattenPanelRows(smallTree(), OPEN_ALL);
    expect(navWindowSize(rows.length, 10_000)).toBe(rows.length);
  });
});

/* ------------------------------ mustInclude 定位 ------------------------------ */

describe('navWindowSize 的 mustInclude：点名的行一定落在窗口内（照谓词窗 G1）', () => {
  it('位点在初始窗口外 → 窗口撑大到盖住它（不是"跳过去但看不见"）', () => {
    expect(navWindowSize(5_000, undefined, 250)).toBe(250);
  });

  it('位点在当前窗口内 → 窗口不动', () => {
    expect(navWindowSize(5_000, 300, 100)).toBe(300);
  });

  it('位点也受 total 钉住：不造出比列表更长的窗口', () => {
    expect(navWindowSize(200, undefined, 250)).toBe(200);
  });

  it('mustInclude 缺省 / 0 = 无覆盖点，回到普通窗口口径', () => {
    expect(navWindowSize(5_000, undefined)).toBe(NAV_WINDOW_INITIAL);
    expect(navWindowSize(5_000, undefined, 0)).toBe(NAV_WINDOW_INITIAL);
  });

  it('端到端：点名第 2,445 行（真盘单文件最大条数量级），窗口切片里真有它', () => {
    const rows = flattenPanelRows(bigTree(3_000), { searching: true, openCharas: new Set(), openFiles: new Set(), previewId: null });
    const locate = 2_445;
    expect(navWindowSize(rows.length, undefined) >= locate).toBe(false); // 初值窗口盖不住——正是要撑大的那档
    const win = navWindowSize(rows.length, undefined, locate);
    expect(win).toBe(locate);
    expect(rows.slice(0, win)[locate - 1]!.kind).toBe('command');
  });
});
