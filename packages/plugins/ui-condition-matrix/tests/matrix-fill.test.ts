/**
 * 口上包作用域 + 填格生成（零 React）。
 *
 * 合成数据只有「角色目录 / 包目录 / 状态键 / 面」这些通用形状，不带任何真游戏名词；
 * 分野表也用最小 stub 钉住「反查关键字」的判据。
 */

import { describe, expect, it } from 'vitest';
import type { FamilyMatch, KojoFaceTable, StateDependency, WorkspaceProject } from '@kojo/plugin-api';
import type { CharacterEntry, ConditionMatrix, FaceFunction } from '../src/matrix-logic';
import { buildMatrix } from '../src/matrix-logic';
import {
  EXTERNAL_PACK_KEY,
  ROOT_PACK_KEY,
  authorPackKeyOf,
  collectAuthorPacks,
  coveragePercent,
  filterEntryByPack,
  gapCellsOfRows,
  matchWorkspacePacks,
  relativeSegments,
  storyLineRows,
} from '../src/matrix-scope';
import {
  buildFillPlan,
  dominantFamily,
  dominantSelectorOfEntry,
  pickMergeTarget,
  resolveFaceTiming,
  sampleCondition,
  substituteFamily,
  type FillPack,
} from '../src/matrix-fill';

/* ------------------------------ 合成数据 ------------------------------ */

function match(face: string, slot: string, family = '', overrides: Partial<FamilyMatch> = {}): FamilyMatch {
  return {
    kind: 'ok',
    prefix: 'M_KOJO',
    family,
    characterNo: 1,
    selector: 0,
    face,
    sub: '',
    isMessageCheck: false,
    slot,
    isPlaceholder: false,
    ...overrides,
  };
}

function fn(name: string, filePath: string, face: string, slot: string, startLine: number, family = ''): FaceFunction {
  return {
    name,
    normalizedName: name.toUpperCase(),
    filePath,
    startLine,
    face,
    match: match(face, slot, family),
  };
}

const CHARA_DIR = 'C:\\game\\kojo\\K1';

function entryOf(functions: FaceFunction[]): CharacterEntry {
  return {
    no: 1,
    faces: [...new Set(functions.map((f) => f.face))],
    functions,
  };
}

const depsByFn: Record<string, StateDependency[]> = {
  M_KOJO_我的口上_EVENT_K1_22: [
    { key: 'CFLAG:318', name: 'CFLAG', indices: ['318'], count: 1, firstLine: 1, comparisons: [{ op: '>=', value: 500, text: '500' }] },
  ],
  M_KOJO_我的口上_MESSAGE_COM_K1_310: [
    { key: 'CFLAG:318', name: 'CFLAG', indices: ['318'], count: 1, firstLine: 1, comparisons: [{ op: '>=', value: 500, text: '500' }] },
  ],
  M_KOJO_我的口上_MESSAGE_COM_K1_310_1: [
    { key: 'CFLAG:318', name: 'CFLAG', indices: ['318'], count: 1, firstLine: 1, comparisons: [{ op: '>=', value: 500, text: '500' }] },
  ],
  M_KOJO_OTHER_DAILY_K1_4: [
    { key: 'TALENT:恋慕', name: 'TALENT', indices: ['恋慕'], count: 1, firstLine: 1, comparisons: [{ op: '==', value: 1, text: '1' }] },
  ],
};
const depsOf = (n: string): StateDependency[] => depsByFn[n] ?? [];
const labelOf = (key: string): string | null =>
  key === 'CFLAG:318' ? '生气中' : key === 'TALENT:恋慕' ? '恋慕' : null;

const myPack = [
  fn('M_KOJO_我的口上_EVENT_K1_22', `${CHARA_DIR}\\我的口上\\事件.ERB`, 'EVENT', '22', 10, '我的口上'),
  fn('M_KOJO_我的口上_MESSAGE_COM_K1_310', `${CHARA_DIR}\\我的口上\\指令.ERB`, 'MESSAGE_COM', '310', 20, '我的口上'),
  fn('M_KOJO_我的口上_MESSAGE_COM_K1_310_1', `${CHARA_DIR}\\我的口上\\指令.ERB`, 'MESSAGE_COM', '310_1', 30, '我的口上'),
];
const otherPack = [
  fn('M_KOJO_OTHER_DAILY_K1_4', `${CHARA_DIR}\\别人的\\日常.ERB`, 'DAILY_EVENT', '4', 10),
];
const rootPack = [fn('M_KOJO_ROOT_K1', `${CHARA_DIR}\\散文件.ERB`, 'EVENT', '9', 10)];
const external = [fn('M_KOJO_EXT_K1', 'D:\\elsewhere\\x.ERB', 'EVENT', '3', 10)];

const fullEntry = entryOf([...myPack, ...otherPack, ...rootPack, ...external]);

const columnOf = (f: FaceFunction): { key: string; instructionNo: number | null; label?: string } => {
  if (f.face !== 'MESSAGE_COM') return { key: f.face, instructionNo: null };
  const no = /^(\d+)/.exec(f.match.slot);
  if (!no) return { key: f.face, instructionNo: null };
  return { key: `${f.face}#${no[1]}`, instructionNo: Number(no[1]), label: `指令 ${no[1]}` };
};

/* ------------------------------ 路径与包 ------------------------------ */

describe('相对路径 / 口上包归属', () => {
  it('relativeSegments 折叠大小写与分隔符，保留原文大小写', () => {
    expect(relativeSegments('C:/Game/KOJO/K1/我的口上/a.ERB', CHARA_DIR)).toEqual(['我的口上', 'a.ERB']);
    expect(relativeSegments('D:/x/a.ERB', CHARA_DIR)).toBeNull();
  });

  it('包键：一层子目录 = 包；角色目录散文件 = 根；索引根兜底；对不上 = 索引外', () => {
    expect(authorPackKeyOf(`${CHARA_DIR}\\我的口上\\a.ERB`, CHARA_DIR)).toBe('我的口上');
    expect(authorPackKeyOf(`${CHARA_DIR}\\a.ERB`, CHARA_DIR)).toBe(ROOT_PACK_KEY);
    expect(authorPackKeyOf(`${CHARA_DIR}\\我的口上\\sub\\a.ERB`, CHARA_DIR)).toBe('我的口上');
    expect(authorPackKeyOf('D:\\elsewhere\\a.ERB', CHARA_DIR, ['D:\\elsewhere'])).toBe(EXTERNAL_PACK_KEY);
    expect(authorPackKeyOf('D:\\elsewhere\\角色\\包\\a.ERB', CHARA_DIR, ['D:\\elsewhere'])).toBe('包');
  });

  it('collectAuthorPacks：根在前、具名包按名序、索引外垫底，函数/文件计数正确', () => {
    const packs = collectAuthorPacks(fullEntry, CHARA_DIR);
    expect(packs.map((p) => p.key)).toEqual([ROOT_PACK_KEY, '别人的', '我的口上', EXTERNAL_PACK_KEY]);
    const mine = packs.find((p) => p.key === '我的口上')!;
    expect(mine.functionCount).toBe(3);
    expect(mine.fileCount).toBe(2);
    expect(mine.dirPath).toBe(`${CHARA_DIR}\\我的口上`);
    expect(packs.find((p) => p.isExternal)!.dirPath).toBeNull();
  });

  it('filterEntryByPack：只留该包函数，faces 随之收窄', () => {
    const mine = filterEntryByPack(fullEntry, '我的口上', CHARA_DIR);
    expect(mine.functions.map((f) => f.name)).toEqual([
      'M_KOJO_我的口上_EVENT_K1_22',
      'M_KOJO_我的口上_MESSAGE_COM_K1_310',
      'M_KOJO_我的口上_MESSAGE_COM_K1_310_1',
    ]);
    expect(mine.faces).toEqual(['EVENT', 'MESSAGE_COM']);
  });
});

describe('工作区包匹配', () => {
  const projects: WorkspaceProject[] = [
    {
      id: 'p1',
      name: '我的作品',
      createdAt: 1,
      updatedAt: 1,
      artifacts: [
        { id: 'a1', name: '影狼包', dirName: '我的口上', meta: {}, createdAt: 1 },
        { id: 'a2', name: '别的包', dirName: '不存在的包', meta: {}, createdAt: 1 },
      ],
      meta: {},
    },
  ];

  it('按 dirName 匹配（大小写折叠），返回项目/包名与绝对目录', () => {
    const packs = collectAuthorPacks(fullEntry, CHARA_DIR);
    const map = matchWorkspacePacks(packs, projects, (id) => `C:\\ws\\${id}`);
    const hit = map.get('我的口上');
    expect(hit).toMatchObject({
      projectId: 'p1',
      projectName: '我的作品',
      artifactName: '影狼包',
      rootPath: 'C:\\ws\\p1\\我的口上',
    });
    expect(map.has('别人的')).toBe(false);
  });
});

/* ------------------------------ 作用域矩阵 ------------------------------ */

function scopedMatrix(packKey: string): ConditionMatrix {
  const packEntry = filterEntryByPack(fullEntry, packKey, CHARA_DIR);
  return buildMatrix(packEntry, depsOf, labelOf, undefined, columnOf, {
    columnsFrom: fullEntry,
    rowsFrom: fullEntry,
  });
}

describe('buildMatrix · 口上包作用域', () => {
  it('列/行取全角色：别的包的时机与状态也可见；填色只算本包', () => {
    const mine = scopedMatrix('我的口上');
    expect(mine.columns.map((c) => c.key)).toEqual([
      'EVENT',
      'DAILY_EVENT',
      'MESSAGE_COM#310',
    ]);
    const daily = mine.columns.find((c) => c.key === 'DAILY_EVENT')!;
    expect(daily.functions).toHaveLength(0); // 本包整列缺席
    expect(daily.universeFunctions).toHaveLength(1);
    expect(daily.fillCount).toBe(0);
    expect(daily.gapCount).toBe(mine.rows.length);

    const talent = mine.rows.find((r) => r.key === 'TALENT:恋慕')!;
    expect(talent.totalCount).toBe(0); // 别的包写过，本包没写
    expect(talent.gapCount).toBe(mine.columns.length);
    expect(talent.universeComparisons).toEqual(['== 1']);
  });

  it('无作用域时列函数与全角色函数同一批；统计字段自洽', () => {
    const full = buildMatrix(fullEntry, depsOf, labelOf, undefined, columnOf);
    const event = full.columns.find((c) => c.key === 'EVENT')!;
    expect(event.functions).toBe(event.universeFunctions);
    expect(full.totalCells).toBe(full.rows.length * full.columns.length);
    expect(full.filledCells + full.gapCells).toBe(full.totalCells);
    expect(full.columns.every((c) => c.fillCount + c.gapCount === full.rows.length)).toBe(true);
  });

  it('作用域内列统计：指令列两个函数只填一格', () => {
    const mine = scopedMatrix('我的口上');
    const cmd = mine.columns.find((c) => c.key === 'MESSAGE_COM#310')!;
    expect(cmd.functions).toHaveLength(2);
    expect(cmd.fillCount).toBe(1);
  });
});

/* ------------------------------ 剧情线 / 选格 ------------------------------ */

describe('剧情线选格', () => {
  const mine = scopedMatrix('我的口上');

  it('按状态键精确命中（变量名大小写不敏感）', () => {
    const rows = storyLineRows(mine, { keys: ['cflag:318'] });
    expect(rows.map((r) => r.key)).toEqual(['CFLAG:318']);
    expect(storyLineRows(mine, { keys: ['TALENT:恋慕'] }).map((r) => r.key)).toEqual(['TALENT:恋慕']);
    expect(storyLineRows(mine, { keys: [] })).toEqual([]);
  });

  it('只选可见列上的空格；已填格不选', () => {
    const refs = gapCellsOfRows(mine, new Set(['CFLAG:318']), ['EVENT', 'DAILY_EVENT', 'MESSAGE_COM#310']);
    // CFLAG:318 在 EVENT / MESSAGE_COM#310 已有响应，唯一缺口是 DAILY_EVENT
    expect(refs).toEqual([{ rowKey: 'CFLAG:318', columnKey: 'DAILY_EVENT' }]);
  });

  it('覆盖率对 0 格给 0（不产生 NaN）', () => {
    expect(coveragePercent(0, 0)).toBe(0);
    expect(coveragePercent(1, 3)).toBe(33);
  });
});

/* ------------------------------ 填格生成 ------------------------------ */

const pack: FillPack = { key: '我的口上', dirName: '我的口上', label: '我的口上', dirPath: `${CHARA_DIR}\\我的口上`, family: '' };
const chara = { no: 1, name: '测试角色' };

describe('家族段替换 / 目标函数选择 / 条件示例', () => {
  it('substituteFamily：有/无家族段都替换，无法安全替换返回 null', () => {
    const withFam = { prefix: 'M_KOJO', family: '旧家族' };
    expect(substituteFamily('M_KOJO_旧家族_EVENT_K1_22', withFam, '新家族')).toBe(
      'M_KOJO_新家族_EVENT_K1_22',
    );
    const plain = { prefix: 'M_KOJO', family: '' };
    expect(substituteFamily('M_KOJO_EVENT_K1_22', plain, '新家族')).toBe(
      'M_KOJO_新家族_EVENT_K1_22',
    );
    expect(substituteFamily('M_KOJO_EVENT_K1_22', plain, '')).toBe('M_KOJO_EVENT_K1_22');
    expect(substituteFamily('K1_FOO', { prefix: '', family: '' }, '新家族')).toBeNull();
  });

  it('dominantFamily 取最常见非空家族', () => {
    const fns = [fn('A', '/x', 'EVENT', '1', 1, '甲'), fn('B', '/x', 'EVENT', '2', 2, '甲'), fn('C', '/x', 'EVENT', '3', 3, '乙')];
    const colFns = fns.map((f) => ({
      name: f.name, filePath: f.filePath, startLine: f.startLine, family: f.match.family,
      prefix: f.match.prefix, kind: f.match.kind, face: f.match.face, slot: f.match.slot,
      isMessageCheck: false,
    }));
    expect(dominantFamily(colFns)).toBe('甲');
    expect(dominantFamily([])).toBe('');

    const withSel = [
      { ...fn('A', '/x', 'EVENT', '1', 1, '甲'), match: match('EVENT', '1', '甲', { selector: 2 }) },
      { ...fn('B', '/x', 'EVENT', '2', 2, '甲'), match: match('EVENT', '2', '甲', { selector: 2 }) },
      { ...fn('C', '/x', 'EVENT', '3', 3, '乙'), match: match('EVENT', '3', '乙', { selector: 5 }) },
    ];
    expect(dominantSelectorOfEntry(entryOf(withSel))).toBe(2);
    expect(dominantSelectorOfEntry(entryOf([]))).toBe(0);
  });

  it('pickMergeTarget 跳过 MESSAGECHECK，优先更具体的正文 slot', () => {
    const colFns = [
      { name: 'hook', filePath: '/x', startLine: 1, family: '', prefix: 'M_KOJO', kind: 'ok' as const, face: 'MESSAGE_COM', slot: '310', isMessageCheck: true },
      { name: 'wrapper', filePath: '/x', startLine: 2, family: '', prefix: 'M_KOJO', kind: 'ok' as const, face: 'MESSAGE_COM', slot: '310', isMessageCheck: false },
      { name: 'body', filePath: '/x', startLine: 3, family: '', prefix: 'M_KOJO', kind: 'ok' as const, face: 'MESSAGE_COM', slot: '310_1', isMessageCheck: false },
    ];
    expect(pickMergeTarget(colFns)?.name).toBe('body');
  });

  it('sampleCondition：本包比较 → 全角色比较 → != 0', () => {
    const mine = scopedMatrix('我的口上');
    const row = mine.rows.find((r) => r.key === 'CFLAG:318')!;
    expect(sampleCondition(row)).toBe('CFLAG:318 >= 500');
    const talent = mine.rows.find((r) => r.key === 'TALENT:恋慕')!;
    expect(sampleCondition(talent)).toBe('TALENT:恋慕 == 1');
    expect(sampleCondition({ ...talent, comparisons: [], universeComparisons: [] })).toBe('TALENT:恋慕 != 0');
  });
});

describe('buildFillPlan · ERB', () => {
  it('已有函数的列 → 并入片段，包含目标函数与 PRINTFORMW 占位', () => {
    const matrix = scopedMatrix('我的口上');
    const plan = buildFillPlan({
      matrix,
      cells: [{ rowKey: 'TALENT:恋慕', columnKey: 'EVENT' }],
      language: 'erb',
      pack,
      chara,
    });
    expect(plan.mergeCount).toBe(1);
    expect(plan.newCount).toBe(0);
    expect(plan.code).toContain('目标函数：@M_KOJO_我的口上_EVENT_K1_22');
    expect(plan.code).toContain('IF TALENT:恋慕 == 1');
    expect(plan.code).toContain('PRINTFORMW 「……」');
    expect(plan.code).not.toMatch(/^@M_KOJO_我的口上_EVENT_K1_22$/m);
  });

  it('整列缺席 → 完整骨架：换家族段、wrapper+正文都生成', () => {
    const packEntry = filterEntryByPack(fullEntry, '我的口上', CHARA_DIR);
    // 从「我的口上」里删掉指令列，制造整列缺席；全角色列仍在
    const withoutCmd = entryOf(packEntry.functions.filter((f) => f.face !== 'MESSAGE_COM'));
    const matrix = buildMatrix(withoutCmd, depsOf, labelOf, undefined, columnOf, {
      columnsFrom: fullEntry,
      rowsFrom: fullEntry,
    });
    const plan = buildFillPlan({
      matrix,
      cells: [{ rowKey: 'CFLAG:318', columnKey: 'MESSAGE_COM#310' }],
      language: 'erb',
      pack: { ...pack, family: '我的家族' },
      chara,
    });
    expect(plan.newCount).toBe(1);
    expect(plan.code).toContain('@M_KOJO_我的家族_MESSAGE_COM_K1_310');
    expect(plan.code).toContain('CALL M_KOJO_我的家族_MESSAGE_COM_K1_310_1');
    expect(plan.code).toContain('@M_KOJO_我的家族_MESSAGE_COM_K1_310_1');
    expect(plan.code).toContain('IF CFLAG:318 >= 500');
  });
});

describe('buildFillPlan · .kojo', () => {
  const faceTable: KojoFaceTable = {
    faces: {
      事件: { template: 'M_KOJO{t}_EVENT_K{n}_{i}', autoIndex: true },
      指令: {
        template: 'M_KOJO{t}_MESSAGE_${com}_K{n}_{i}',
        segments: { com: { COM: 'COM', SCOM: 'SCOM' } },
      },
    },
  };

  it('已有函数 → 只给分支片段（不写时机头，避免撞重复定义）', () => {
    const matrix = scopedMatrix('我的口上');
    const plan = buildFillPlan({
      matrix,
      cells: [{ rowKey: 'TALENT:恋慕', columnKey: 'EVENT' }],
      language: 'kojo',
      pack,
      chara,
      faceTable,
    });
    expect(plan.code).toContain('目标函数：@M_KOJO_我的口上_EVENT_K1_22');
    expect(plan.code).toContain('如果 TALENT:恋慕 == 1：');
    expect(plan.code).toContain('条件矩阵填空');
    expect(plan.code).not.toContain('时机 事件');
  });

  it('整列缺席 → 反查分野关键字并生成完整时机块', () => {
    const packEntry = filterEntryByPack(fullEntry, '我的口上', CHARA_DIR);
    const withoutCmd = entryOf(packEntry.functions.filter((f) => f.face !== 'MESSAGE_COM'));
    const matrix = buildMatrix(withoutCmd, depsOf, labelOf, undefined, columnOf, {
      columnsFrom: fullEntry,
      rowsFrom: fullEntry,
    });
    const plan = buildFillPlan({
      matrix,
      cells: [{ rowKey: 'CFLAG:318', columnKey: 'MESSAGE_COM#310' }],
      language: 'kojo',
      pack,
      chara,
      faceTable,
    });
    expect(plan.code).toContain('时机 指令 310：');
    expect(plan.code).toContain('如果 CFLAG:318 >= 500：');
    expect(plan.code).not.toContain('原生 ERB');
    expect(plan.code).not.toContain('角色:'); // 追加模式：既有文件已有文件头
  });

  it('新建 .kojo 文件 → 补 `角色:` / `口上:` 文件头（糖层据此渲染函数名）', () => {
    const packEntry = filterEntryByPack(fullEntry, '我的口上', CHARA_DIR);
    const withoutCmd = entryOf(packEntry.functions.filter((f) => f.face !== 'MESSAGE_COM'));
    const matrix = buildMatrix(withoutCmd, depsOf, labelOf, undefined, columnOf, {
      columnsFrom: fullEntry,
      rowsFrom: fullEntry,
    });
    const plan = buildFillPlan({
      matrix,
      cells: [{ rowKey: 'CFLAG:318', columnKey: 'MESSAGE_COM#310' }],
      language: 'kojo',
      pack: { ...pack, family: '我的家族', selector: 2 },
      chara,
      faceTable,
      standalone: true,
    });
    expect(plan.code.startsWith('角色: 1\n口上: 我的家族 选择器: 2')).toBe(true);
    expect(plan.code).toContain('时机 指令 310：');
  });

  it('无分野表 / 反查不到 → 退回原生 ERB 并显式注明', () => {
    const packEntry = filterEntryByPack(fullEntry, '我的口上', CHARA_DIR);
    const withoutCmd = entryOf(packEntry.functions.filter((f) => f.face !== 'MESSAGE_COM'));
    const matrix = buildMatrix(withoutCmd, depsOf, labelOf, undefined, columnOf, {
      columnsFrom: fullEntry,
      rowsFrom: fullEntry,
    });
    const plan = buildFillPlan({
      matrix,
      cells: [{ rowKey: 'CFLAG:318', columnKey: 'MESSAGE_COM#310' }],
      language: 'kojo',
      pack,
      chara,
    });
    expect(plan.code).toContain('原生 ERB');
    expect(plan.code).toContain('@M_KOJO_MESSAGE_COM_K1_310_1');
  });
});

describe('buildFillPlan · 新建文件（standalone）', () => {
  it('并入片段写不进新文件：跳过并计数，只生成整列缺席的时机', () => {
    const matrix = scopedMatrix('我的口上'); // EVENT 有函数（merge）、DAILY_EVENT 整列缺席（new）
    const plan = buildFillPlan({
      matrix,
      cells: [
        { rowKey: 'TALENT:恋慕', columnKey: 'EVENT' },
        { rowKey: 'CFLAG:318', columnKey: 'DAILY_EVENT' },
      ],
      language: 'erb',
      pack,
      chara,
      standalone: true,
    });
    expect(plan.mergeCount).toBe(0);
    expect(plan.newCount).toBe(1);
    expect(plan.cellCount).toBe(1);
    expect(plan.skipped).toBe(1);
    expect(plan.skippedMerge).toBe(1);
    expect(plan.code).not.toContain('目标函数：@M_KOJO_我的口上_EVENT_K1_22');
    expect(plan.code).toContain('DAILY_EVENT');
  });

  it('全选并入片段 → 代码为空、skippedMerge 明示（不静默生成残片）', () => {
    const matrix = scopedMatrix('我的口上');
    const plan = buildFillPlan({
      matrix,
      cells: [{ rowKey: 'TALENT:恋慕', columnKey: 'EVENT' }],
      language: 'kojo',
      pack,
      chara,
      faceTable: {
        faces: { 事件: { template: 'M_KOJO{t}_EVENT_K{n}_{i}', autoIndex: true } },
      },
      standalone: true,
    });
    expect(plan.code).toBe('');
    expect(plan.cellCount).toBe(0);
    expect(plan.skipped).toBe(1);
    expect(plan.skippedMerge).toBe(1);
  });

  it('追加模式不受 standalone 规则影响：并入片段照常生成', () => {
    const matrix = scopedMatrix('我的口上');
    const plan = buildFillPlan({
      matrix,
      cells: [{ rowKey: 'TALENT:恋慕', columnKey: 'EVENT' }],
      language: 'erb',
      pack,
      chara,
    });
    expect(plan.mergeCount).toBe(1);
    expect(plan.skippedMerge).toBe(0);
  });
});

describe('resolveFaceTiming', () => {
  const table: KojoFaceTable = {
    faces: {
      事件: { template: 'M_KOJO{t}_EVENT_K{n}_{i}', autoIndex: true },
      指令: {
        template: 'M_KOJO{t}_MESSAGE_${com}_K{n}_{i}',
        segments: { com: { COM: 'COM', SCOM: 'SCOM' } },
      },
      图像: { template: 'M_KOJO{t}_IMAGE_K{n}_{i}', indexKind: 'literal' },
    },
  };

  const colFn = (name: string, face: string, slot: string, family = '') => ({
    name, filePath: '/x', startLine: 1, family, prefix: 'M_KOJO', kind: 'ok' as const,
    face, slot, isMessageCheck: false,
  });

  it('按真实函数名反查（含段与家族段）', () => {
    expect(
      resolveFaceTiming(table, { face: 'MESSAGE_COM', instructionNo: 310 }, [colFn('M_KOJO_我的口上_MESSAGE_COM_K1_310', 'MESSAGE_COM', '310', '我的口上')], 1),
    ).toEqual({ keyword: '指令', index: '310' });
    expect(
      resolveFaceTiming(table, { face: 'EVENT', instructionNo: null }, [colFn('M_KOJO_EVENT_K1_22', 'EVENT', '22')], 1),
    ).toEqual({ keyword: '事件', index: '22' });
  });

  it('默认 command 模板不接受非数字 token；literal 模板接受', () => {
    expect(
      resolveFaceTiming(table, { face: 'EVENT', instructionNo: null }, [colFn('M_KOJO_EVENT_K1_GIFT', 'EVENT', 'GIFT')], 1),
    ).toBeNull();
    expect(
      resolveFaceTiming(table, { face: 'IMAGE', instructionNo: null }, [colFn('M_KOJO_IMAGE_K1_特殊服装', 'IMAGE', '特殊服装')], 1),
    ).toEqual({ keyword: '图像', index: '特殊服装' });
  });

  it('没有分野表 → null（不猜）', () => {
    expect(resolveFaceTiming(undefined, { face: 'EVENT', instructionNo: null }, [colFn('M_KOJO_EVENT_K1_22', 'EVENT', '22')], 1)).toBeNull();
  });
});
