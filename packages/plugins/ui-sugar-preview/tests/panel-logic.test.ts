/**
 * S4-UI 批验收：糖预览面板纯逻辑（`panel-logic.ts`）。
 *
 * 覆盖用户验收项里的四件事：
 * - **逐行映射**（糖源码行 → 产物行区间；缺失源行防御性补空，不静默错位）；
 * - **诊断行**（severity / 定位；文件级诊断 `line = null` 且不可跳转）；
 * - **全角空格告警**（规范 §8：`U+3000` 行标记 + 计数）；
 * - **可达性折叠**（三档计数 + 着色类别 + 人读标签，混合态不隐藏）。
 *
 * 另加：概要 / 行数统计 / 降级文案闭集 / `.kojo` 判定。
 *
 * 本文件是**测试**，按解耦审计规则 C 豁免可直接 import 其它插件包
 * （这里用 kojo-sugar 的真实转译器当输入源，免得"面板逻辑只对假对象成立"）。
 */

import { describe, expect, it } from 'vitest';
import type {
  ArchiveMeta,
  PreviewReachability,
  SnapshotArchiveEntry,
  SnapshotScanResult,
  SugarDiagnostic,
  SugarPreviewArchive,
  SugarPreviewLine,
  SugarPreviewMessageBlock,
  SugarPreviewResult,
  SugarSourceMapEntry,
  SugarTranspileResult,
} from '@kojo/plugin-api';
import { createSugarPreviewService, createSugarTranspileService } from '@kojo/plugin-kojo-sugar';
import { createEratwFaceTable } from '@kojo/plugin-eratw-adapter';
import {
  DIAG_WINDOW_INITIAL,
  DIAG_WINDOW_STEP,
  FULLWIDTH_SPACE,
  ROW_WINDOW_INITIAL,
  ROW_WINDOW_STEP,
  ZERO_REACH,
  archiveStatus,
  blockLabel,
  buildArchiveOptions,
  buildDiagnosticRows,
  buildPreviewRows,
  canJump,
  countLines,
  createLiveTextPool,
  degradeText,
  diagWindowSize,
  foldReachability,
  formatSize,
  fullwidthSpaceLines,
  generatedLabel,
  hasBlocks,
  isKojoFile,
  nextDiagWindow,
  nextRowWindow,
  reachabilityClass,
  reachabilityLabel,
  rowWindowSize,
  summarize,
  type DiagnosticRow,
  type PreviewDegrade,
} from '../src/panel-logic';

/* ============================== 输入构造 ============================== */

const mkTranspile = (
  erb = '',
  sourceMap: SugarSourceMapEntry[] = [],
  diagnostics: SugarDiagnostic[] = [],
): SugarTranspileResult => ({ erb, sourceMap, diagnostics });

const mkBlock = (
  fromLine: number,
  toLine: number,
  reachability: PreviewReachability,
  text = '产物文本',
): SugarPreviewMessageBlock => ({ fromLine, toLine, text, branches: [], reachability });

const mkLine = (
  sourceLine: number,
  sourceText: string,
  generatedLines: number[] = [],
  messageBlocks: SugarPreviewMessageBlock[] = [],
): SugarPreviewLine => ({ sourceLine, sourceText, generatedLines, messageBlocks });

const mkResult = (
  lines: SugarPreviewLine[],
  opts: { transpile?: SugarTranspileResult; structuralLines?: number[] } = {},
): SugarPreviewResult => ({
  transpile: opts.transpile ?? mkTranspile(),
  lines,
  structuralLines: opts.structuralLines ?? [],
  archive: null,
});

const diag = (
  code: string,
  severity: 'error' | 'warning' | 'info',
  message: string,
  loc: { line: number; column: number } | null,
): SugarDiagnostic => ({ code: code as SugarDiagnostic['code'], severity, message, loc });

/* ============================== 一、全角空格 ============================== */

describe('S4-UI / 全角空格（规范 §8）', () => {
  it('常量就是 U+3000', () => {
    expect(FULLWIDTH_SPACE).toBe('\u3000');
    expect(FULLWIDTH_SPACE.codePointAt(0)).toBe(0x3000);
  });

  it('检出含全角空格的行（1 基升序）', () => {
    const src = ['甲。', '乙\u3000丙。', '丁。', '\u3000'].join('\n');
    expect(fullwidthSpaceLines(src)).toEqual([2, 4]);
  });

  it('无全角空格 → 空数组（不误报半角空格 / 全角标点）', () => {
    expect(fullwidthSpaceLines('甲。乙，丙！')).toEqual([]);
    expect(fullwidthSpaceLines('')).toEqual([]);
  });
});

/* ============================== 二、诊断行 ============================== */

describe('S4-UI / 诊断行（buildDiagnosticRows / canJump）', () => {
  it('severity / 消息 / 定位原样带出', () => {
    const rows = buildDiagnosticRows([
      diag('expr-missing-else', 'error', '表达式「如果」必须含「否则」分支', { line: 7, column: 5 }),
    ]);
    expect(rows[0]).toMatchObject({
      severity: 'error',
      code: 'expr-missing-else',
      message: '表达式「如果」必须含「否则」分支',
      line: 7,
      column: 5,
    });
    expect(canJump(rows[0]!)).toBe(true);
  });

  it('文件级诊断（loc=null）→ line/column 为 null 且**不可跳转**', () => {
    const rows = buildDiagnosticRows([diag('alias-dup', 'warning', '别名重复定义', null)]);
    expect(rows[0]!.line).toBeNull();
    expect(rows[0]!.column).toBeNull();
    expect(canJump(rows[0]!)).toBe(false);
  });

  it('同码同位置的多条诊断 key 不互相顶掉（含序号）', () => {
    const rows = buildDiagnosticRows([
      diag('x', 'warning', 'a', { line: 1, column: 1 }),
      diag('x', 'warning', 'b', { line: 1, column: 1 }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.key).not.toBe(rows[1]!.key);
  });

  it('缺省 / 空数组 → 空列表', () => {
    expect(buildDiagnosticRows([])).toEqual([]);
    expect(buildDiagnosticRows(undefined)).toEqual([]);
  });

  it('三种 severity 都保留（info 不被吞）', () => {
    const rows = buildDiagnosticRows([
      diag('a', 'error', 'e', null),
      diag('b', 'warning', 'w', null),
      diag('c', 'info', 'i', null),
    ]);
    expect(rows.map((r: DiagnosticRow) => r.severity)).toEqual(['error', 'warning', 'info']);
  });
});

/* ============================== 三、可达性折叠 ============================== */

describe('S4-UI / 可达性折叠（计数 / 着色 / 标签）', () => {
  it('计数三档（混合态不丢失）', () => {
    const c = foldReachability([
      mkBlock(1, 1, 'reachable'),
      mkBlock(2, 2, 'reachable'),
      mkBlock(3, 3, 'unknown'),
      mkBlock(4, 4, 'unreachable'),
    ]);
    expect(c).toEqual({ reachable: 2, unknown: 1, unreachable: 1 });
  });

  it('着色优先级：含不可达 → bad；否则含未知 → warn；否则全可达 → ok；无块 → none', () => {
    expect(reachabilityClass({ reachable: 0, unreachable: 0, unknown: 0 })).toBe('none');
    expect(reachabilityClass({ reachable: 2, unreachable: 0, unknown: 0 })).toBe('ok');
    expect(reachabilityClass({ reachable: 2, unreachable: 0, unknown: 1 })).toBe('warn');
    expect(reachabilityClass({ reachable: 2, unreachable: 1, unknown: 1 })).toBe('bad');
  });

  it('hasBlocks：无块为 false（据此不画徽章）', () => {
    expect(hasBlocks({ reachable: 0, unreachable: 0, unknown: 0 })).toBe(false);
    expect(hasBlocks({ reachable: 1, unreachable: 0, unknown: 0 })).toBe(true);
  });

  it('标签：单一态用单词，混合态显式列出计数', () => {
    expect(reachabilityLabel({ reachable: 0, unreachable: 0, unknown: 0 })).toBe('');
    expect(reachabilityLabel({ reachable: 3, unreachable: 0, unknown: 0 })).toBe('可达');
    expect(reachabilityLabel({ reachable: 0, unreachable: 2, unknown: 0 })).toBe('不可达');
    expect(reachabilityLabel({ reachable: 0, unreachable: 0, unknown: 1 })).toBe('未知');
    expect(reachabilityLabel({ reachable: 1, unreachable: 1, unknown: 1 })).toBe('可达 1 / 未知 1 / 不可达 1');
  });

  it('单块标签闭集覆盖三档（都有中文）', () => {
    const all: PreviewReachability[] = ['reachable', 'unreachable', 'unknown'];
    for (const r of all) {
      expect(blockLabel(r)).toMatch(/[\u4e00-\u9fa5]/);
    }
  });
});

/* ============================== 四、产物行区间标签 ============================== */

describe('S4-UI / 产物行区间标签（generatedLabel）', () => {
  it('空数组 → `—`（纯糖语法行）', () => {
    expect(generatedLabel([])).toBe('—');
  });

  it('单行 → `L12`', () => {
    expect(generatedLabel([12])).toBe('L12');
  });

  it('连续区间 → `L12–L14`', () => {
    expect(generatedLabel([12, 13, 14])).toBe('L12–L14');
  });

  it('非连续 → 列出首尾并标注行数（不假装连续）', () => {
    const label = generatedLabel([12, 15]);
    expect(label).toContain('L12');
    expect(label).toContain('L15');
    expect(label).toContain('2 行');
  });
});

/* ============================== 五、逐行映射 ============================== */

describe('S4-UI / 逐行映射（buildPreviewRows）', () => {
  const SRC = ['角色: 1', '时机 初见：', '    「甲。」', '', '    \u3000乙。'].join('\n');

  it('行数 = 源文件行数；逐行带源文本与空行标记', () => {
    const rows = buildPreviewRows(mkResult([]), SRC);
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.sourceLine)).toEqual([1, 2, 3, 4, 5]);
    expect(rows[3]!.blank).toBe(true);
    expect(rows[2]!.blank).toBe(false);
  });

  it('产物行来自数据层映射；缺失的源行**防御性补空**（不静默错位）', () => {
    const rows = buildPreviewRows(
      mkResult([
        mkLine(1, '角色: 1', [1, 2]),
        // 故意缺源行 2 / 4：面板应补空而不是把后面的行顶上
        mkLine(3, '    「甲。」', [7]),
      ]),
      SRC,
    );
    expect(rows[0]!.generatedLines).toEqual([1, 2]);
    expect(rows[1]!.generatedLines).toEqual([]);
    expect(rows[1]!.generatedLabel).toBe('—');
    expect(rows[2]!.generatedLines).toEqual([7]);
    expect(rows[3]!.generatedLines).toEqual([]);
  });

  it('全角空格标记挂在行上（保存告警的行内指示）', () => {
    const rows = buildPreviewRows(mkResult([]), SRC);
    expect(rows[4]!.hasFullwidthSpace).toBe(true);
    expect(rows[0]!.hasFullwidthSpace).toBe(false);
  });

  it('可达性按行折叠（消息块 → 计数 → 着色）', () => {
    const rows = buildPreviewRows(
      mkResult([mkLine(3, '    「甲。」', [7], [mkBlock(7, 7, 'unreachable'), mkBlock(8, 8, 'reachable')])]),
      SRC,
    );
    expect(rows[2]!.reach).toEqual({ reachable: 1, unreachable: 1, unknown: 0 });
    expect(rows[2]!.reachClass).toBe('bad');
    expect(rows[2]!.reachLabel).toBe('可达 1 / 不可达 1');
    // 无块的行 → 无色（none）
    expect(rows[0]!.reachClass).toBe('none');
  });

  it('null 结果 → 仍按源文本建行（面板在读盘前也不空白）', () => {
    const rows = buildPreviewRows(null, SRC);
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.generatedLines.length === 0)).toBe(true);
  });

  it('稳定键为源行号（React key）', () => {
    const rows = buildPreviewRows(mkResult([]), SRC);
    expect(rows.map((r) => r.key)).toEqual(['L1', 'L2', 'L3', 'L4', 'L5']);
  });
});

/* ============================== 六、概要 / 行数 ============================== */

describe('S4-UI / 概要（summarize）与行数（countLines）', () => {
  it('countLines：末尾换行不额外计一行；空文本为 0', () => {
    expect(countLines('')).toBe(0);
    expect(countLines('a')).toBe(1);
    expect(countLines('a\nb')).toBe(2);
    expect(countLines('a\nb\n')).toBe(2);
  });

  it('概要：源行 / 产物行 / 诊断 / 映射 / 结构行 / 消息块 / 全角空格', () => {
    const SRC = ['角色: 1', '时机 初见：', '    「甲。」', '    \u3000乙。'].join('\n');
    const res = mkResult(
      [
        mkLine(1, '角色: 1', [1]),
        mkLine(2, '时机 初见：', []) ,
        mkLine(3, '    「甲。」', [7, 8], [mkBlock(7, 7, 'unreachable')]),
        mkLine(4, '    \u3000乙。', [9], [mkBlock(9, 9, 'reachable'), mkBlock(10, 10, 'unknown')]),
      ],
      {
        transpile: mkTranspile('a\nb\nc\n', [], [
          diag('e1', 'error', '错', null),
          diag('w1', 'warning', '警', { line: 3, column: 1 }),
        ]),
        structuralLines: [2, 4],
      },
    );
    const s = summarize(res, SRC);
    expect(s.sourceLines).toBe(4);
    expect(s.generatedLines).toBe(3);
    expect(s.diagnostics).toBe(2);
    expect(s.errors).toBe(1);
    expect(s.warnings).toBe(1);
    expect(s.mappedLines).toBe(3); // L1 / L3 / L4 有产物映射，L2 无
    expect(s.structuralLines).toBe(2);
    expect(s.blocks).toBe(3);
    expect(s.unreachableBlocks).toBe(1);
    expect(s.unknownBlocks).toBe(1);
    expect(s.fullwidthLines).toBe(1);
  });

  it('null 结果 → 产物侧计数为 0（但源行数照算）', () => {
    const s = summarize(null, 'a\nb\n');
    expect(s.sourceLines).toBe(2);
    expect(s.generatedLines).toBe(0);
    expect(s.diagnostics).toBe(0);
    expect(s.mappedLines).toBe(0);
  });
});

/* ============================== 七、降级 / 文件判定 ============================== */

describe('S4-UI / 降级文案与文件判定', () => {
  it('每个降级状态都有非空中文提示（闭集覆盖）', () => {
    const all: PreviewDegrade[] = [
      'no-project',
      'no-file',
      'not-kojo',
      'reading',
      'previewing',
      'read-error',
      'preview-error',
    ];
    for (const d of all) {
      expect(degradeText(d).length).toBeGreaterThan(0);
      expect(degradeText(d)).toMatch(/[\u4e00-\u9fa5]/);
    }
  });

  it('isKojoFile：大小写不敏感；非 .kojo / 空值 → false', () => {
    expect(isKojoFile('/p/x.kojo')).toBe(true);
    expect(isKojoFile('/p/x.KOJO')).toBe(true);
    expect(isKojoFile('/p/x.erb')).toBe(false);
    expect(isKojoFile('')).toBe(false);
    expect(isKojoFile(null)).toBe(false);
    expect(isKojoFile(undefined)).toBe(false);
  });
});

/* ============================== 八、真实转译器输入 ============================== */

describe('S4-UI / 真实 sugar.preview 结果可直接建行（形状对得上）', () => {
  const SRC = ['角色: 1', '时机 初见：', '    「你好。」', '    她笑了。 续', ''].join('\n');

  it('行数 = 源文件行数；面板映射与数据层逐行一致', async () => {
    const transpileSvc = createSugarTranspileService({ faceTable: createEratwFaceTable() });
    const previewSvc = createSugarPreviewService({
      transpile: (s, o) => transpileSvc.transpile(s, o),
    });
    const res = await previewSvc.preview({ source: SRC });
    expect(res.lines).toHaveLength(countLines(SRC));

    const rows = buildPreviewRows(res, SRC);
    expect(rows).toHaveLength(countLines(SRC));
    // 面板没有自己编造映射：逐行与数据层同源
    for (let i = 0; i < res.lines.length; i++) {
      expect(rows[i]!.generatedLines).toEqual(res.lines[i]!.generatedLines);
      expect(rows[i]!.sourceText).toBe(res.lines[i]!.sourceText);
    }
    // 至少有一条糖行映射到了产物行（否则这份输入对预览毫无意义）
    expect(rows.some((r) => r.generatedLines.length > 0)).toBe(true);
    // 概要的诊断计数与契约一致
    expect(summarize(res, SRC).diagnostics).toBe(res.transpile.diagnostics.length);
  });
});

/* ============================== 九、存档选择与可达性门控 ============================== */

describe('S4-UI / 存档选择（buildArchiveOptions / formatSize）', () => {
  const meta = {} as ArchiveMeta;
  const entry = (
    fileName: string,
    size: number,
    over: Partial<SnapshotArchiveEntry> = {},
  ): SnapshotArchiveEntry => ({ path: `/save/${fileName}`, fileName, size, mtimeMs: 1, meta, ...over });
  const scanOf = (entries: SnapshotArchiveEntry[]): SnapshotScanResult => ({
    dir: '/save',
    entries,
    scannedAt: 0,
    durationMs: 1,
  });

  it('只列浅解析成功的档（meta=null / error 的一律不列）', () => {
    const opts = buildArchiveOptions(
      scanOf([
        entry('a.sav', 1024),
        entry('bad1.sav', 1024, { meta: null }),
        entry('bad2.sav', 1024, { error: '解析失败' }),
      ]),
    );
    expect(opts.map((o) => o.fileName)).toEqual(['a.sav']);
  });

  it('标签 = 文件名 + 人读大小', () => {
    const opts = buildArchiveOptions(scanOf([entry('save01.sav', 2048)]));
    expect(opts[0]!.label).toBe('save01.sav（2.0 KB）');
    expect(opts[0]!.path).toBe('/save/save01.sav');
  });

  it('无扫描结果 / 空结果 → 空列表（下拉禁用）', () => {
    expect(buildArchiveOptions(null)).toEqual([]);
    expect(buildArchiveOptions(scanOf([]))).toEqual([]);
  });

  it('formatSize：B / KB / MB 三档', () => {
    expect(formatSize(512)).toBe('512 B');
    expect(formatSize(2048)).toBe('2.0 KB');
    expect(formatSize(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});

describe('S4-UI / 存档接入状态（archiveStatus）', () => {
  const archive = (no: number, name: string | null): SugarPreviewArchive => ({
    archivePath: '/save/a.sav',
    characterNo: no,
    characterName: name,
    functions: [],
  });

  it('未接入 → connected=false + 短标签 `未接` + 提示非空', () => {
    const st = archiveStatus(null);
    expect(st.connected).toBe(false);
    expect(st.who).toBe('未接');
    expect(st.hint.length).toBeGreaterThan(0);
  });

  it('已接入 → connected=true + 角色名与编号；提示为空', () => {
    const st = archiveStatus({ ...mkResult([]), archive: archive(12, '露米娅') });
    expect(st.connected).toBe(true);
    expect(st.who).toContain('露米娅');
    expect(st.who).toContain('#12');
    expect(st.hint).toBe('');
  });

  it('角色名不可读 → 只显示编号（不写 `null`）', () => {
    const st = archiveStatus({ ...mkResult([]), archive: archive(7, null) });
    expect(st.who).toBe('#7');
  });
});

describe('S4-UI / 可达性门控（未接入存档时不报可达）', () => {
  const SRC = ['角色: 1', '时机 初见：', '    「甲。」'].join('\n');
  const res = mkResult([
    mkLine(3, '    「甲。」', [7], [mkBlock(7, 7, 'unreachable'), mkBlock(8, 8, 'reachable')]),
  ]);

  it('withReachability=true：按块折叠（不可达 → bad）', () => {
    const rows = buildPreviewRows(res, SRC, true);
    expect(rows[2]!.reach.unreachable).toBe(1);
    expect(rows[2]!.reachClass).toBe('bad');
  });

  it('withReachability=false：一律无色（不可判定 ≠ 可达）', () => {
    const rows = buildPreviewRows(res, SRC, false);
    expect(rows[2]!.reach).toEqual(ZERO_REACH);
    expect(rows[2]!.reachClass).toBe('none');
    expect(rows[2]!.reachLabel).toBe('');
  });

  it('概要计数同步门控：未接入时 blocks / unreachable / unknown 全 0', () => {
    expect(summarize(res, SRC, true).blocks).toBe(2);
    expect(summarize(res, SRC, true).unreachableBlocks).toBe(1);
    expect(summarize(res, SRC, false).blocks).toBe(0);
    expect(summarize(res, SRC, false).unreachableBlocks).toBe(0);
    expect(summarize(res, SRC, false).unknownBlocks).toBe(0);
  });
});

describe('C2 / 缓冲真相池（live-first / disk-fallback 的选择判据）', () => {
  it('未收到广播 → textFor 为 null（调用方退回读盘兜底）', () => {
    const pool = createLiveTextPool();
    expect(pool.textFor('/proj/x.kojo')).toBeNull();
  });

  it('收到广播 → 以广播为准（读盘不再是真源）', () => {
    const pool = createLiveTextPool();
    pool.apply('/proj/x.kojo', '未保存的编辑');
    expect(pool.textFor('/proj/x.kojo')).toBe('未保存的编辑');
  });

  it('同一 path 新广播覆盖旧（拿最新一条当权威）', () => {
    const pool = createLiveTextPool();
    pool.apply('/proj/x.kojo', 'v1');
    pool.apply('/proj/x.kojo', 'v2');
    expect(pool.textFor('/proj/x.kojo')).toBe('v2');
  });

  it('path 不匹配不误用：别的文件的广播不喂给当前文件', () => {
    const pool = createLiveTextPool();
    pool.apply('/proj/other.kojo', 'other');
    expect(pool.textFor('/proj/x.kojo')).toBeNull();
  });

  it('path 判等走 pathKey 归一（Windows 分隔符/大小写不同也命中同一文件）', () => {
    const pool = createLiveTextPool();
    pool.apply('C:\\Proj\\X.kojo', 't');
    expect(pool.textFor('c:/proj/x.kojo')).toBe('t');
  });

  it('空文本也是真相（清空全文的编辑必须如实下发，不与"没收到"混淆）', () => {
    const pool = createLiveTextPool();
    pool.apply('/proj/x.kojo', '');
    expect(pool.textFor('/proj/x.kojo')).toBe('');
  });

  it('null / undefined 路径安全取空（换文件瞬时无活动文件的窗口期）', () => {
    const pool = createLiveTextPool();
    expect(pool.textFor(null)).toBeNull();
    expect(pool.textFor(undefined)).toBeNull();
  });
});
describe('渲染窗口（触底增窗）', () => {
  it('初窗 ≤ INITIAL；小列表整体可见（逐行映射 / 诊断各一口径）', () => {
    expect(rowWindowSize(10_000, undefined)).toBe(ROW_WINDOW_INITIAL);
    expect(rowWindowSize(30, undefined)).toBe(30);
    expect(diagWindowSize(10_000, undefined)).toBe(DIAG_WINDOW_INITIAL);
    expect(diagWindowSize(5, undefined)).toBe(5);
  });

  it('每步 +STEP、单调不减、终值钉在 total（两个列表口径一致）', () => {
    const walk = (next: (cur: number | undefined, total: number) => number, step: number): number => {
      let cur: number | undefined = undefined;
      let prev: number | undefined = undefined;
      for (let i = 0; i < 500 && cur !== 10_000; i++) {
        cur = next(cur, 10_000);
        // 步长上界只从第二个窗口起算（首窗 = INITIAL + STEP，下方已单独钉住）
        if (prev !== undefined) {
          expect(cur).toBeGreaterThanOrEqual(prev);
          expect(cur - prev).toBeLessThanOrEqual(step);
        }
        prev = cur;
      }
      return cur!;
    };
    expect(nextRowWindow(undefined, 10_000)).toBe(ROW_WINDOW_INITIAL + ROW_WINDOW_STEP);
    expect(nextDiagWindow(undefined, 10_000)).toBe(DIAG_WINDOW_INITIAL + DIAG_WINDOW_STEP);
    expect(walk(nextRowWindow, ROW_WINDOW_STEP)).toBe(10_000);
    expect(walk(nextDiagWindow, DIAG_WINDOW_STEP)).toBe(10_000);
  });

  it('已有窗口（limit）优先于 INITIAL，但被 total 钉住', () => {
    expect(rowWindowSize(10_000, ROW_WINDOW_INITIAL + ROW_WINDOW_STEP)).toBe(ROW_WINDOW_INITIAL + ROW_WINDOW_STEP);
    expect(rowWindowSize(100, 999)).toBe(100);
    expect(diagWindowSize(100, 999)).toBe(100);
  });
});
