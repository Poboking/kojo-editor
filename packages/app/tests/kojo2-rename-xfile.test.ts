/**
 * Kojo 2.0 **跨文件改名 plan**（`kojo2RenamePlan` / `kojo2RenamePlanXFile`，K2-RENAME-XFILE）
 * 单测——**不依赖真 Monaco、不碰真盘**：候选文件由假 resolvers 注入。
 *
 * 覆盖面（任务口径）：
 * 1. **跨文件编辑合并**：请求文件在前 + 候选按 resolver 序；每份文件的编辑与同一条
 *    `kojo2RenameAt` **逐字相等**（复用尺子，不是第二套算法）；
 * 2. **候选筛选**：请求文件自己 / 重复路径去重；没有同名声明的文件跳过；
 * 3. **resolver 缺失 / 不可用 ⇒ 退回同文件 plan**：整体缺失、`null`、缺 `listFilesWithSymbol`、
 *    缺 `readSource`、列候选抛错、读候选抛错；
 * 4. **全或无阻断**：请求文件自身的闸（非法名 / 同名 / 不在符号上）不调 resolver；候选读取为
 *    `null`、候选重名、候选 parse 闸 ⇒ `editsByPath` 整体为空（正常候选的编辑也不落）；
 * 5. **上限**：文件 64 份（含请求文件，65 ⇒ 阻断、64 ⇒ 放行）、编辑 2000 段（超 ⇒ 阻断）；
 * 6. **路径形状**：逐字保留（反斜杠 / 中文 / 大小写），空串路径忽略；
 * 7. **CRLF / 中文**：候选 CRLF 源逐字保留换行、列坐标正确。
 */

import { describe, expect, it, vi } from 'vitest';
import { parseSource } from '@kojo/kojo-core';
import {
  KOJO2_RENAME_PLAN_MAX_EDITS,
  KOJO2_RENAME_PLAN_MAX_FILES,
  kojo2RenameAt,
  kojo2RenamePlan,
  kojo2RenamePlanXFile,
  kojo2RenamedSource,
  type Kojo2RenameEdit,
  type Kojo2RenamePosition,
  type Kojo2RenameResolvers,
} from '../src/monaco/kojo2-rename';

/* ============================== 夹具 ============================== */

const REQUEST_PATH = 'D:/proj/chara/灵梦/开场.kojo2';
const DAILY_PATH = 'D:/proj/chara/灵梦/日常.kojo2';
const OTHER_PATH = 'D:/proj/chara/魔理沙/支线.kojo2';

/** 请求文件：一个 `# 变量 好感度` + 池条件 / 叙事插值两处引用（3 段编辑）。 */
const REQUEST_LINES: readonly string[] = [
  '// 注释里的好感度不参与改名', // 1
  '# 视 灵梦', // 2
  '# 机 指令 310', // 3
  '# 变量 好感度 整数 = 0 存档', // 4
  '# 池 问候', // 5
  '    ? 好感度 < 100', // 6
  '        「……早。」', // 7
  '    ? 否', // 8
  '        「早上好。」', // 9
  '! 问候', // 10
  '> 她的好感是{好感度}。', // 11
];

/** 候选：自己声明同名变量 + 注释 / 普通文字里的同名不算引用。 */
const DAILY_LINES: readonly string[] = [
  '# 机 指令 310', // 1
  '# 变量 好感度 整数 = 0 存档', // 2
  '// 注释里的好感度也不动', // 3
  '> 别处：{好感度} 点。', // 4
  '灵梦：「{好感度 + 1}」', // 5
  '> 她说「好感度」三个字。', // 6
];

/** 候选：**没有**同名声明（同名文字在普通文字里，不是这个符号）⇒ 整个文件跳过。 */
const OTHER_LINES: readonly string[] = [
  '# 机 指令 310', // 1
  '# 变量 别的东西 整数 = 0', // 2
  '> 这里没有那个名字。', // 3
];

const REQUEST = `${REQUEST_LINES.join('\n')}\n`;
const DAILY = `${DAILY_LINES.join('\n')}\n`;
const OTHER = `${OTHER_LINES.join('\n')}\n`;

const REQUEST_POS: Kojo2RenamePosition = { line: 4, column: 6 };

function lineTextsOf(source: string): string[] {
  return source.split(/\r\n|\r|\n/);
}

/** 指定行上的 `needle` → 1 基行列。 */
function positionOf(source: string, line: number, needle: string): Kojo2RenamePosition {
  const text = lineTextsOf(source)[line - 1] ?? '';
  const index = text.indexOf(needle);
  if (index < 0) throw new Error(`第 ${line} 行里找不到「${needle}」`);
  return { line, column: index + 1 };
}

/** 编辑集逐段切下来的源码文本（验证"改的是名字、列没漂"）。 */
function editSlices(source: string, edits: readonly Kojo2RenameEdit[]): string[] {
  const lines = lineTextsOf(source);
  return edits.map((edit) => {
    const text = lines[edit.range.startLine - 1] ?? '';
    return text.slice(edit.range.startColumn - 1, edit.range.endColumn - 1);
  });
}

function errorsOf(source: string): string[] {
  return parseSource(source)
    .diagnostics.filter((diagnostic) => diagnostic.severity === 'error')
    .map((diagnostic) => diagnostic.message);
}

/** 假项目索引：路径 → 源文；`order` 是 `listFilesWithSymbol` 的返回值。 */
function filesOf(
  entries: ReadonlyArray<readonly [string, string]>,
): ReadonlyMap<string, string> {
  return new Map(entries);
}

function resolverFor(
  files: ReadonlyMap<string, string>,
  order: readonly string[],
): Kojo2RenameResolvers {
  return {
    listFilesWithSymbol: () => order,
    readSource: (path) => files.get(path) ?? null,
  };
}

/** 一条"应当成功"的 plan 断言：无 blocker、至少请求文件那一项。 */
function expectPlanOk(plan: ReturnType<typeof kojo2RenamePlan>): void {
  expect(plan.blockers).toEqual([]);
  expect(plan.editsByPath.length).toBeGreaterThan(0);
}

/** 一条"应当阻断"的 plan 断言：零编辑 + 理由里含关键词。 */
function expectBlocked(
  plan: ReturnType<typeof kojo2RenamePlan>,
  keyword: string,
): void {
  expect(plan.editsByPath).toEqual([]);
  expect(plan.blockers.length).toBeGreaterThan(0);
  expect(plan.blockers.join('\n')).toContain(keyword);
}

/* ============================== 夹具本身 ============================== */

describe('夹具：三份 2.0 源都 parse 零 error（改名落地的收口前提）', () => {
  it('请求文件 / 候选 / 无声明候选都干净', () => {
    expect(errorsOf(REQUEST)).toEqual([]);
    expect(errorsOf(DAILY)).toEqual([]);
    expect(errorsOf(OTHER)).toEqual([]);
  });
});

/* ============================== ① 跨文件编辑合并 ============================== */

describe('跨文件编辑合并：请求文件在前 + 候选按 resolver 序', () => {
  it('合并请求 + 有声明候选，跳过没有同名声明的候选；路径 / 段数 / 文本逐项对', () => {
    const files = filesOf([
      [REQUEST_PATH, REQUEST],
      [DAILY_PATH, DAILY],
      [OTHER_PATH, OTHER],
    ]);
    const plan = kojo2RenamePlanXFile(
      REQUEST,
      REQUEST_PATH,
      REQUEST_POS,
      '羁绊值',
      resolverFor(files, [REQUEST_PATH, DAILY_PATH, OTHER_PATH]),
    );
    expectPlanOk(plan);
    expect(plan.symbol?.name).toBe('好感度');
    expect(plan.editsByPath.map((entry) => entry.path)).toEqual([REQUEST_PATH, DAILY_PATH]);

    const requestEntry = plan.editsByPath[0]!;
    expect(requestEntry.edits).toHaveLength(3);
    expect(editSlices(REQUEST, requestEntry.edits)).toEqual(['好感度', '好感度', '好感度']);
    for (const edit of requestEntry.edits) expect(edit.newText).toBe('羁绊值');

    const dailyEntry = plan.editsByPath[1]!;
    expect(dailyEntry.edits).toHaveLength(3);
    expect(editSlices(DAILY, dailyEntry.edits)).toEqual(['好感度', '好感度', '好感度']);
    // 普通文字 / 注释里的同名文字不在编辑集里
    const dailyRenamed = kojo2RenamedSource(DAILY, dailyEntry.edits);
    expect(dailyRenamed).toContain('// 注释里的好感度也不动');
    expect(dailyRenamed).toContain('> 她说「好感度」三个字。');
    expect(dailyRenamed).toContain('> 别处：{羁绊值} 点。');
    expect(dailyRenamed).toContain('灵梦：「{羁绊值 + 1}」');
  });

  it('每个候选的编辑与同一条 `kojo2RenameAt` 逐字相等（复用，不是第二把尺子）', () => {
    const files = filesOf([
      [REQUEST_PATH, REQUEST],
      [DAILY_PATH, DAILY],
    ]);
    const plan = kojo2RenamePlanXFile(
      REQUEST,
      REQUEST_PATH,
      REQUEST_POS,
      '羁绊值',
      resolverFor(files, [DAILY_PATH]),
    );
    const dailyPosition = positionOf(DAILY, 2, '好感度');
    const direct = kojo2RenameAt(DAILY, dailyPosition, '羁绊值');
    expect(direct.blockers).toEqual([]);
    expect(plan.editsByPath[1]!.edits).toEqual(direct.edits);
  });

  it('应用各自文件的编辑后 parse 零 error，请求文件与候选都换了名', () => {
    const files = filesOf([
      [REQUEST_PATH, REQUEST],
      [DAILY_PATH, DAILY],
    ]);
    const plan = kojo2RenamePlanXFile(
      REQUEST,
      REQUEST_PATH,
      REQUEST_POS,
      '羁绊值',
      resolverFor(files, [DAILY_PATH]),
    );
    expectPlanOk(plan);
    for (const entry of plan.editsByPath) {
      const renamed = kojo2RenamedSource(files.get(entry.path) ?? '', entry.edits);
      expect(errorsOf(renamed)).toEqual([]);
      expect(renamed).toContain('羁绊值');
      expect(renamed).not.toContain('# 变量 好感度');
    }
  });

  it('候选列表含请求文件自己 + 重复路径 ⇒ 各只收一次（请求文件仍只有一项）', () => {
    const files = filesOf([
      [REQUEST_PATH, REQUEST],
      [DAILY_PATH, DAILY],
    ]);
    const plan = kojo2RenamePlanXFile(
      REQUEST,
      REQUEST_PATH,
      REQUEST_POS,
      '羁绊值',
      resolverFor(files, [REQUEST_PATH, DAILY_PATH, DAILY_PATH, REQUEST_PATH]),
    );
    expectPlanOk(plan);
    expect(plan.editsByPath.map((entry) => entry.path)).toEqual([REQUEST_PATH, DAILY_PATH]);
  });

  it('候选顺序照 resolver 给的序（反向给序 ⇒ 反向输出；请求文件恒在前）', () => {
    const thirdPath = 'D:/proj/chara/灵梦/番外.kojo2';
    const third = '# 机 指令 310\n# 变量 好感度 整数 = 0 存档\n> {好感度}\n';
    const files = filesOf([
      [REQUEST_PATH, REQUEST],
      [DAILY_PATH, DAILY],
      [thirdPath, third],
    ]);
    const plan = kojo2RenamePlanXFile(
      REQUEST,
      REQUEST_PATH,
      REQUEST_POS,
      '羁绊值',
      resolverFor(files, [thirdPath, DAILY_PATH]),
    );
    expectPlanOk(plan);
    expect(plan.editsByPath.map((entry) => entry.path)).toEqual([
      REQUEST_PATH,
      thirdPath,
      DAILY_PATH,
    ]);
  });

  it('候选列表为空 ⇒ 只有请求文件那一项，无 blocker', () => {
    const files = filesOf([[REQUEST_PATH, REQUEST]]);
    const plan = kojo2RenamePlanXFile(
      REQUEST,
      REQUEST_PATH,
      REQUEST_POS,
      '羁绊值',
      resolverFor(files, []),
    );
    expectPlanOk(plan);
    expect(plan.editsByPath.map((entry) => entry.path)).toEqual([REQUEST_PATH]);
  });

  it('确定性：同输入两次调用逐字相同（纯函数）', () => {
    const files = filesOf([
      [REQUEST_PATH, REQUEST],
      [DAILY_PATH, DAILY],
    ]);
    const resolvers = resolverFor(files, [DAILY_PATH]);
    const first = kojo2RenamePlanXFile(REQUEST, REQUEST_PATH, REQUEST_POS, '羁绊值', resolvers);
    const second = kojo2RenamePlanXFile(REQUEST, REQUEST_PATH, REQUEST_POS, '羁绊值', resolvers);
    expect(second).toEqual(first);
  });
});

/* ============================== ② resolver 缺失 / 不可用 ⇒ 回退 ============================== */

describe('resolver 缺失 / 不可用 ⇒ 退回同文件 plan（编辑与 kojo2RenameAt 一致）', () => {
  const direct = (): ReturnType<typeof kojo2RenameAt> =>
    kojo2RenameAt(REQUEST, REQUEST_POS, '羁绊值');

  it('resolvers 整体缺失（undefined）⇒ 单文件 plan，path 用调用方给的那份', () => {
    const plan = kojo2RenamePlanXFile(REQUEST, REQUEST_PATH, REQUEST_POS, '羁绊值');
    expect(plan.blockers).toEqual([]);
    expect(plan.editsByPath.map((entry) => entry.path)).toEqual([REQUEST_PATH]);
    expect(plan.editsByPath[0]!.edits).toEqual(direct().edits);
    expect(plan.symbol).toEqual(direct().symbol);
  });

  it('resolvers = null ⇒ 同文件 plan', () => {
    const plan = kojo2RenamePlanXFile(REQUEST, REQUEST_PATH, REQUEST_POS, '羁绊值', null);
    expect(plan.editsByPath.map((entry) => entry.path)).toEqual([REQUEST_PATH]);
    expect(plan.editsByPath[0]!.edits).toEqual(direct().edits);
  });

  it('缺 listFilesWithSymbol ⇒ 回退，且 readSource 一次都不调', () => {
    const readSource = vi.fn((path: string) => (path === DAILY_PATH ? DAILY : null));
    const plan = kojo2RenamePlanXFile(REQUEST, REQUEST_PATH, REQUEST_POS, '羁绊值', { readSource });
    expect(plan.editsByPath.map((entry) => entry.path)).toEqual([REQUEST_PATH]);
    expect(readSource).not.toHaveBeenCalled();
  });

  it('缺 readSource（形状不对）⇒ 回退，listFilesWithSymbol 一次都不调', () => {
    const list = vi.fn(() => [DAILY_PATH]);
    const malformed = { listFilesWithSymbol: list } as unknown as Kojo2RenameResolvers;
    const plan = kojo2RenamePlanXFile(REQUEST, REQUEST_PATH, REQUEST_POS, '羁绊值', malformed);
    expect(plan.editsByPath.map((entry) => entry.path)).toEqual([REQUEST_PATH]);
    expect(list).not.toHaveBeenCalled();
  });

  it('listFilesWithSymbol 抛错 ⇒ 回退同文件 plan，不产生半截跨文件编辑', () => {
    const readSource = vi.fn(() => DAILY);
    const resolvers: Kojo2RenameResolvers = {
      listFilesWithSymbol: () => {
        throw new Error('桩：项目索引炸了');
      },
      readSource,
    };
    const plan = kojo2RenamePlanXFile(REQUEST, REQUEST_PATH, REQUEST_POS, '羁绊值', resolvers);
    expect(plan.blockers).toEqual([]);
    expect(plan.editsByPath.map((entry) => entry.path)).toEqual([REQUEST_PATH]);
    expect(plan.editsByPath[0]!.edits).toEqual(direct().edits);
    expect(readSource).not.toHaveBeenCalled();
  });

  it('readSource 抛错 ⇒ 整次退回同文件 plan（不保留已处理候选的编辑）', () => {
    const resolvers: Kojo2RenameResolvers = {
      listFilesWithSymbol: () => [DAILY_PATH],
      readSource: () => {
        throw new Error('桩：读取炸了');
      },
    };
    const plan = kojo2RenamePlanXFile(REQUEST, REQUEST_PATH, REQUEST_POS, '羁绊值', resolvers);
    expect(plan.blockers).toEqual([]);
    expect(plan.editsByPath.map((entry) => entry.path)).toEqual([REQUEST_PATH]);
    expect(plan.editsByPath[0]!.edits).toEqual(direct().edits);
  });

  it('第二个候选读取抛错 ⇒ 仍退整份同文件编辑（第一个候选的编辑也不落）', () => {
    const secondPath = 'D:/proj/chara/灵梦/番外.kojo2';
    const resolvers: Kojo2RenameResolvers = {
      listFilesWithSymbol: () => [DAILY_PATH, secondPath],
      readSource: (path) => {
        if (path === secondPath) throw new Error('桩：第二份读取炸了');
        return DAILY;
      },
    };
    const plan = kojo2RenamePlanXFile(REQUEST, REQUEST_PATH, REQUEST_POS, '羁绊值', resolvers);
    expect(plan.editsByPath).toHaveLength(1);
    expect(plan.editsByPath[0]!.path).toBe(REQUEST_PATH);
  });

  it('同文件 plan（3 参）path 为 `\'\'`；第 4 参给了路径就逐字用', () => {
    const bare = kojo2RenamePlan(REQUEST, REQUEST_POS, '羁绊值');
    expect(bare.blockers).toEqual([]);
    expect(bare.editsByPath).toHaveLength(1);
    expect(bare.editsByPath[0]!.path).toBe('');
    expect(bare.editsByPath[0]!.edits).toEqual(direct().edits);

    const pathed = kojo2RenamePlan(REQUEST, REQUEST_POS, '羁绊值', REQUEST_PATH);
    expect(pathed.editsByPath[0]!.path).toBe(REQUEST_PATH);
    expect(pathed.editsByPath[0]!.edits).toEqual(bare.editsByPath[0]!.edits);
  });
});

/* ============================== ③ 全或无阻断 ============================== */

describe('全或无：请求文件自身的闸 ⇒ 零编辑，resolver 一次都不调', () => {
  it('非法新名 ⇒ 阻断，listFilesWithSymbol / readSource 零调用', () => {
    const list = vi.fn(() => [DAILY_PATH]);
    const readSource = vi.fn(() => DAILY);
    const plan = kojo2RenamePlanXFile(REQUEST, REQUEST_PATH, REQUEST_POS, '1坏名', {
      listFilesWithSymbol: list,
      readSource,
    });
    expectBlocked(plan, '合法');
    expect(list).not.toHaveBeenCalled();
    expect(readSource).not.toHaveBeenCalled();
  });

  it('新名与原名相同 ⇒ 阻断，resolver 零调用', () => {
    const list = vi.fn(() => [DAILY_PATH]);
    const plan = kojo2RenamePlanXFile(REQUEST, REQUEST_PATH, REQUEST_POS, '好感度', {
      listFilesWithSymbol: list,
      readSource: () => DAILY,
    });
    expectBlocked(plan, '新名与原名相同');
    expect(list).not.toHaveBeenCalled();
  });

  it('光标不在符号上（注释行）⇒ 阻断，resolver 零调用', () => {
    const list = vi.fn(() => [DAILY_PATH]);
    const plan = kojo2RenamePlanXFile(
      REQUEST,
      REQUEST_PATH,
      { line: 1, column: 5 },
      '羁绊值',
      { listFilesWithSymbol: list, readSource: () => DAILY },
    );
    expectBlocked(plan, '注释');
    expect(list).not.toHaveBeenCalled();
  });

  it('与请求文件既有声明重名 ⇒ 阻断，resolver 零调用', () => {
    const list = vi.fn(() => [DAILY_PATH]);
    const plan = kojo2RenamePlanXFile(REQUEST, REQUEST_PATH, REQUEST_POS, '问候', {
      listFilesWithSymbol: list,
      readSource: () => DAILY,
    });
    expectBlocked(plan, '声明过');
    expect(list).not.toHaveBeenCalled();
  });
});

describe('全或无：候选侧任一路由阻断 ⇒ 整体 editsByPath 为空', () => {
  it('候选读取返回 null ⇒ 阻断，理由含路径', () => {
    const plan = kojo2RenamePlanXFile(REQUEST, REQUEST_PATH, REQUEST_POS, '羁绊值', {
      listFilesWithSymbol: () => [DAILY_PATH],
      readSource: () => null,
    });
    expectBlocked(plan, '读不到候选文件');
    expect(plan.blockers.join('\n')).toContain(DAILY_PATH);
  });

  it('两个候选都读不到 ⇒ blockers 逐条列出两份路径（聚合，不是只报第一条）', () => {
    const secondPath = 'D:/proj/chara/灵梦/番外.kojo2';
    const plan = kojo2RenamePlanXFile(REQUEST, REQUEST_PATH, REQUEST_POS, '羁绊值', {
      listFilesWithSymbol: () => [DAILY_PATH, secondPath],
      readSource: () => null,
    });
    expectBlocked(plan, '读不到');
    const text = plan.blockers.join('\n');
    expect(text).toContain(DAILY_PATH);
    expect(text).toContain(secondPath);
  });

  it('候选 readSource 返回 undefined（坏 resolver）也按读取失败阻断', () => {
    const malformed = {
      listFilesWithSymbol: () => [DAILY_PATH],
      readSource: () => undefined,
    } as unknown as Kojo2RenameResolvers;
    const plan = kojo2RenamePlanXFile(REQUEST, REQUEST_PATH, REQUEST_POS, '羁绊值', malformed);
    expectBlocked(plan, '读不到候选文件');
  });

  it('一个候选正常、另一个读不到 ⇒ 正常候选的编辑也不落（无半截）', () => {
    const secondPath = 'D:/proj/chara/灵梦/番外.kojo2';
    const files = filesOf([[DAILY_PATH, DAILY]]);
    const plan = kojo2RenamePlanXFile(REQUEST, REQUEST_PATH, REQUEST_POS, '羁绊值', {
      listFilesWithSymbol: () => [DAILY_PATH, secondPath],
      readSource: (path) => files.get(path) ?? null,
    });
    expectBlocked(plan, '读不到候选文件');
    expect(plan.editsByPath).toEqual([]);
  });

  it('候选自己声明重名 ⇒ 阻断，理由含候选路径与「同名声明」', () => {
    const duplicated = '# 变量 好感度 整数 = 0\n# 变量 好感度 整数 = 0\n';
    const plan = kojo2RenamePlanXFile(REQUEST, REQUEST_PATH, REQUEST_POS, '羁绊值', {
      listFilesWithSymbol: () => [DAILY_PATH],
      readSource: () => duplicated,
    });
    expectBlocked(plan, '同名声明');
    expect(plan.blockers.join('\n')).toContain(DAILY_PATH);
  });

  it('候选 parse 闸（候选源文本来就有语法错）⇒ 阻断，理由含候选路径与「解析错误」', () => {
    const broken = '# 变量 好感度 整数 = 0 存档\n@断\n';
    expect(errorsOf(broken)).not.toEqual([]);
    const plan = kojo2RenamePlanXFile(REQUEST, REQUEST_PATH, REQUEST_POS, '羁绊值', {
      listFilesWithSymbol: () => [DAILY_PATH],
      readSource: () => broken,
    });
    expectBlocked(plan, '解析错误');
    expect(plan.blockers.join('\n')).toContain(DAILY_PATH);
  });

  it('候选与请求文件撞新名（候选已声明「羁绊值」）⇒ 阻断（重名闸在同一条尺子上）', () => {
    const conflict = '# 变量 好感度 整数 = 0 存档\n# 变量 羁绊值 整数 = 0 存档\n';
    const plan = kojo2RenamePlanXFile(REQUEST, REQUEST_PATH, REQUEST_POS, '羁绊值', {
      listFilesWithSymbol: () => [DAILY_PATH],
      readSource: () => conflict,
    });
    expectBlocked(plan, '羁绊值');
    expect(plan.blockers.join('\n')).toContain(DAILY_PATH);
  });

  it('候选空串源（没有同名声明）⇒ 跳过而不是阻断', () => {
    const plan = kojo2RenamePlanXFile(REQUEST, REQUEST_PATH, REQUEST_POS, '羁绊值', {
      listFilesWithSymbol: () => [DAILY_PATH],
      readSource: () => '',
    });
    expectPlanOk(plan);
    expect(plan.editsByPath.map((entry) => entry.path)).toEqual([REQUEST_PATH]);
  });
});

/* ============================== ④ 上限 ============================== */

describe(`上限：文件 ${KOJO2_RENAME_PLAN_MAX_FILES} 份 / 编辑 ${KOJO2_RENAME_PLAN_MAX_EDITS} 段`, () => {
  /** 每份候选一个声明 ⇒ 1 段编辑。 */
  const ONE_EDIT_FILE = '# 变量 好感度 整数 = 0 存档\n';

  function candidatePaths(count: number): string[] {
    return Array.from({ length: count }, (_, index) => `D:/proj/候选/文件${index + 1}.kojo2`);
  }

  it('候选 64 份（+请求文件 = 65）⇒ 阻断，readSource 零调用（超限不做截断）', () => {
    const paths = candidatePaths(KOJO2_RENAME_PLAN_MAX_FILES);
    const readSource = vi.fn(() => ONE_EDIT_FILE);
    const plan = kojo2RenamePlanXFile(REQUEST, REQUEST_PATH, REQUEST_POS, '羁绊值', {
      listFilesWithSymbol: () => paths,
      readSource,
    });
    expectBlocked(plan, String(KOJO2_RENAME_PLAN_MAX_FILES));
    expect(readSource).not.toHaveBeenCalled();
  });

  it('边界：候选 63 份（+请求文件 = 64）⇒ 放行，editsByPath 恰 64 项', () => {
    const paths = candidatePaths(KOJO2_RENAME_PLAN_MAX_FILES - 1);
    const files = new Map(paths.map((path) => [path, ONE_EDIT_FILE] as const));
    const plan = kojo2RenamePlanXFile(
      REQUEST,
      REQUEST_PATH,
      REQUEST_POS,
      '羁绊值',
      resolverFor(files, paths),
    );
    expectPlanOk(plan);
    expect(plan.editsByPath).toHaveLength(KOJO2_RENAME_PLAN_MAX_FILES);
    expect(plan.editsByPath[0]!.path).toBe(REQUEST_PATH);
    expect(plan.editsByPath.at(-1)!.path).toBe(paths.at(-1));
  });

  it('编辑合计超 2000 段 ⇒ 阻断（逐文件累加，不落半截）', () => {
    const perFile = 60; // 1 声明 + 60 插值 = 61 段/份（外加 `# 机` 声明）
    const source = `# 机 指令 310\n# 变量 好感度 整数 = 0 存档\n${Array.from(
      { length: perFile },
      (_, index) => `> 第${index}句：{好感度}。`,
    ).join('\n')}\n`;
    const filesCount = Math.ceil(KOJO2_RENAME_PLAN_MAX_EDITS / (perFile + 1));
    const paths = candidatePaths(filesCount);
    const files = new Map(paths.map((path) => [path, source] as const));
    const plan = kojo2RenamePlanXFile(
      REQUEST,
      REQUEST_PATH,
      REQUEST_POS,
      '羁绊值',
      resolverFor(files, paths),
    );
    expectBlocked(plan, String(KOJO2_RENAME_PLAN_MAX_EDITS));
    expect(plan.editsByPath).toEqual([]);
  });
});

/* ============================== ⑤ 路径形状 ============================== */

describe('路径形状：逐字保留，不归一化', () => {
  it('反斜杠 / 中文 / 大小写都逐字保留（与 resolver 给的字符串相等）', () => {
    const windowsPath = 'D:\\proj\\chara\\灵梦\\日常.kojo2';
    const lowerDrivePath = 'd:/proj/chara/灵梦/番外.kojo2';
    const files = filesOf([
      [windowsPath, DAILY],
      [lowerDrivePath, DAILY],
    ]);
    const plan = kojo2RenamePlanXFile(REQUEST, 'D:\\proj\\chara\\灵梦\\开场.kojo2', REQUEST_POS, '羁绊值', {
      listFilesWithSymbol: () => [windowsPath, lowerDrivePath],
      readSource: (path) => files.get(path) ?? null,
    });
    expectPlanOk(plan);
    expect(plan.editsByPath.map((entry) => entry.path)).toEqual([
      'D:\\proj\\chara\\灵梦\\开场.kojo2',
      windowsPath,
      lowerDrivePath,
    ]);
  });

  it('空串路径被忽略（不产生 `path: \'\'` 的候选项）', () => {
    const files = filesOf([[DAILY_PATH, DAILY]]);
    const plan = kojo2RenamePlanXFile(
      REQUEST,
      REQUEST_PATH,
      REQUEST_POS,
      '羁绊值',
      resolverFor(files, ['', DAILY_PATH]),
    );
    expectPlanOk(plan);
    expect(plan.editsByPath.map((entry) => entry.path)).toEqual([REQUEST_PATH, DAILY_PATH]);
  });
});

/* ============================== ⑥ CRLF / 中文 ============================== */

describe('CRLF / 中文：候选换行逐字保留、列坐标按行内码元', () => {
  const REQUEST_CRLF = `${REQUEST_LINES.join('\r\n')}\r\n`;
  const DAILY_CRLF = `${DAILY_LINES.join('\r\n')}\r\n`;

  it('CRLF 请求 + CRLF 候选：行 / 列与 LF 源一致，应用后不出现裸 LF', () => {
    const files = filesOf([
      [REQUEST_PATH, REQUEST_CRLF],
      [DAILY_PATH, DAILY_CRLF],
    ]);
    const plan = kojo2RenamePlanXFile(
      REQUEST_CRLF,
      REQUEST_PATH,
      positionOf(REQUEST_CRLF, 4, '好感度'),
      '羁绊值',
      resolverFor(files, [DAILY_PATH]),
    );
    expectPlanOk(plan);
    const requestEntry = plan.editsByPath[0]!;
    expect(requestEntry.edits.map((edit) => edit.range.startLine)).toEqual([4, 6, 11]);
    const dailyEntry = plan.editsByPath[1]!;
    expect(dailyEntry.edits.map((edit) => edit.range.startLine)).toEqual([2, 4, 5]);

    for (const entry of plan.editsByPath) {
      const source = entry.path === REQUEST_PATH ? REQUEST_CRLF : DAILY_CRLF;
      const renamed = kojo2RenamedSource(source, entry.edits);
      expect(/[^\r]\n/.test(renamed)).toBe(false);
      expect(renamed.split('\r\n')).toHaveLength(lineTextsOf(source).length);
      expect(errorsOf(renamed)).toEqual([]);
    }
    const dailyRenamed = kojo2RenamedSource(DAILY_CRLF, dailyEntry.edits);
    expect(dailyRenamed).toContain('> 别处：{羁绊值} 点。');
  });
});
