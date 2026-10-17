/**
 * `.kojo` 用户函数改名 / 查找引用（`rename.ts`）单测——转译器当判官的探针法。
 *
 * 钉死的行为契约（与文件头注一一对应）：
 * (a) **引用面**：定义点 + `调用` 语句 + 表达式位调用（条件 / 插值）全部命中；
 *     台词文本 / 注释 / 原生直通行里的同名出现**不算引用**（转译行为裁决，不是词法近似）；
 * (b) **全或无**：改后编译不过 / 产物 diff 越出产物名行 ⇒ 整次拒绝并给理由；
 * (c) **不硬造**：不是本文件「函数」声明的名字（时机产物名、原生行里的 ERB 函数名）拒绝；
 * (d) 引用查询与改名计划同判据（同一套探针）。
 *
 * 夹具不用 adapter：`函数前缀:` 文件头给命名模板（`normalizeFunctionPrefix` 的既定路径），
 * 转译器零游戏知识面即出真产物。
 */

import { describe, expect, it } from 'vitest';
import { createSugarTranspileService } from '../src/service';
import { kojoReferencesAt, planKojoRename, scanNameOccurrences } from '../src/rename';

const transpile = createSugarTranspileService().transpile;

const FIXTURE = [
  '; 改名测试夹具',
  '角色: 101',
  '函数前缀: K101_',
  '',
  '函数 问候()：',
  '    返回 1',
  '',
  '函数 记录(次数)：',
  '    ; 问候',
  '    调用 问候()',
  '    如果 问候() > 0：',
  '        「问候(你)」',
  '    她说：{问候()}',
  '    CALL 问候()',
  '',
].join('\n');

/** 光标定在 `函数 问候()` 的名字上（第 5 行） */
const CURSOR = { line: 5, column: 4 };

describe('scanNameOccurrences', () => {
  it('整串出现点全收（含台词 / 注释 / 原生行——判读交给探针），行列 1 基', () => {
    const occ = scanNameOccurrences(FIXTURE, '问候');
    expect(occ.map((o) => o.line)).toEqual([5, 9, 10, 11, 12, 13, 14]);
    expect(occ[0]).toEqual({ line: 5, column: 4, endColumn: 6 });
  });
});

describe('planKojoRename · 命中面', () => {
  const plan = planKojoRename({ source: FIXTURE, path: 't.kojo', ...CURSOR, newName: '问好', transpile });

  it('定义点 + 调用语句 + 条件与插值表达式命中；台词 / 注释 / 原生直通不算引用', () => {
    expect(plan.kind).toBe('hit');
    if (plan.kind !== 'hit') return;
    expect(plan.edits.map((e) => e.line)).toEqual([5, 10, 11, 13]); // 9 注释 / 12 台词 / 14 原生行不进
    expect(plan.productName).toBe('K101_问候');
    expect(plan.oldName).toBe('问候');
  });
  it('同行两个引用 + 不等长新名：整卷复核不再列错位假拒绝（withReplaced 倒序应用）', () => {
    const src = [
      '角色: 101',
      '函数前缀: K101_',
      '',
      '函数 问候()：',
      '    返回 1',
      '',
      '函数 记录()：',
      '    如果 问候() > 0 && 问候() < 9：',
      '        「台词」',
      '',
    ].join('\n');
    const plan = planKojoRename({ source: src, path: 't.kojo', line: 4, column: 4, newName: '问', transpile });
    expect(plan.kind).toBe('hit');
    if (plan.kind !== 'hit') return expect.unreachable();
    const sameLine = plan.edits.filter((e) => e.line === 8);
    expect(sameLine.length).toBe(2);
    expect(sameLine.map((e) => e.column)).toEqual([8, 20]);
    // 宿主落地同款手工应用（降序）：改完的源必须逐字符正确
    const lines = src.split('\n');
    for (const e of [...plan.edits].sort((a, b) => b.line - a.line || b.column - a.column)) {
      const text = lines[e.line - 1]!;
      lines[e.line - 1] = text.slice(0, e.column - 1) + '问' + text.slice(e.endColumn - 1);
    }
    expect(lines[7]).toBe('    如果 问() > 0 && 问() < 9：');
  });

  it('验收判据：应用全部编辑后转译，产物 diff 只在含产物名的行（@ 头 + CALL / IF / 插值）', () => {
    if (plan.kind !== 'hit') return expect.unreachable();
    const lines = FIXTURE.split('\n');
    let renamed = FIXTURE;
    for (const e of [...plan.edits].sort((a, b) => b.line - a.line)) {
      const text = lines[e.line - 1]!;
      lines[e.line - 1] = text.slice(0, e.column - 1) + '问好' + text.slice(e.endColumn - 1);
      renamed = lines.join('\n');
    }
    const before = transpile(FIXTURE, { filePath: 't.kojo' });
    const after = transpile(renamed, { filePath: 't.kojo' });
    expect(after.diagnostics.some((d) => d.severity === 'error')).toBe(false);
    const a = before.erb.split('\n');
    const b = after.erb.split('\n');
    expect(a.length).toBe(b.length);
    const changed = a.map((l, i) => [i, l, b[i]] as const).filter(([, x, y]) => x !== y);
    expect(changed.length).toBeGreaterThan(0);
    for (const [, x, y] of changed) {
      expect(x).toContain('K101_问候');
      expect(y).toBe(x.replace(/K101_问候/g, 'K101_问好'));
    }
  });
});

describe('planKojoRename · 拒绝面', () => {
  it('台词里的同名出现不会被改名牵连（夹具自证：12 行的「问候(你)」不在编辑集）', () => {
    const plan = planKojoRename({ source: FIXTURE, path: 't.kojo', ...CURSOR, newName: '问好', transpile });
    if (plan.kind !== 'hit') return expect.unreachable();
    expect(plan.edits.some((e) => e.line === 12)).toBe(false);
  });

  it('新名非法（空白 / 标点）⇒ 拒绝', () => {
    const bad = planKojoRename({ source: FIXTURE, path: 't.kojo', ...CURSOR, newName: '问 好', transpile });
    expect(bad.kind).toBe('reject');
  });

  it('改名后编译不过（撞本文件既有函数）⇒ 整次拒绝', () => {
    const src = ['角色: 101', '函数前缀: K101_', '', '函数 问候()：', '    返回 1', '', '函数 问好()：', '    返回 2', ''].join('\n');
    const plan = planKojoRename({ source: src, path: 't.kojo', line: 4, column: 4, newName: '问好', transpile });
    expect(plan.kind).toBe('reject');
    if (plan.kind !== 'reject') return;
    expect(plan.reason).toContain('编译不过');
  });

  it('产物名撞项目已有函数（productNameExists）⇒ 拒绝', () => {
    const plan = planKojoRename({
      source: FIXTURE,
      path: 't.kojo',
      ...CURSOR,
      newName: '问好',
      transpile,
      productNameExists: (name) => name === 'K101_问好',
    });
    expect(plan.kind).toBe('reject');
    if (plan.kind !== 'reject') return;
    expect(plan.reason).toContain('K101_问好');
  });

  it('不是本文件「函数」声明的名字（原生行里的 ERB 函数名）⇒ 拒绝并说明', () => {
    const plan = planKojoRename({ source: FIXTURE, path: 't.kojo', line: 14, column: 6, newName: '别的东西', transpile });
    expect(plan.kind).toBe('reject');
    if (plan.kind !== 'reject') return;
    expect(plan.reason).toContain('「函数」块');
  });

  it('编译错误 ⇒ 产物不可信，拒绝', () => {
    const broken = ['角色: 101', '函数前缀: K101_', '', '函数 问候()：', '    她说：{如果}', ''].join('\n');
    const plan = planKojoRename({ source: broken, path: 't.kojo', line: 4, column: 4, newName: '问好', transpile });
    expect(plan.kind).toBe('reject');
  });

  it('新名与原名相同 ⇒ 拒绝', () => {
    const plan = planKojoRename({ source: FIXTURE, path: 't.kojo', ...CURSOR, newName: '问候', transpile });
    expect(plan.kind).toBe('reject');
  });
});

describe('kojoReferencesAt', () => {
  it('与改名计划同判据：定义点 + 语句调用 + 表达式调用，台词 / 注释 / 原生行不在列', () => {
    const locations = kojoReferencesAt({ source: FIXTURE, path: 't.kojo', ...CURSOR, transpile });
    expect(locations.map((l) => l.line)).toEqual([5, 10, 11, 13]);
    expect(locations.every((l) => l.filePath === 't.kojo')).toBe(true);
  });

  it('光标在台词文本里 ⇒ 空数组（不是可证明的引用对象）', () => {
    const locations = kojoReferencesAt({ source: FIXTURE, path: 't.kojo', line: 12, column: 4, transpile });
    expect(locations).toEqual([]);
  });

  it('编译错误 ⇒ 空数组（半成品不可信，不猜）', () => {
    const broken = ['角色: 101', '函数前缀: K101_', '', '函数 问候()：', '    她说：{如果}', ''].join('\n');
    const locations = kojoReferencesAt({ source: broken, path: 't.kojo', line: 4, column: 4, transpile });
    expect(locations).toEqual([]);
  });
});
