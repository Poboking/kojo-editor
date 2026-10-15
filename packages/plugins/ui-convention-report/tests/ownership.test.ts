import { describe, expect, it } from 'vitest';
import type { CharaInfo, ConventionIssue, FamilyIndexRule, FamilyMatch } from '@kojo/plugin-api';
import {
  attributeIssue,
  characterLabel,
  rollupByCharacter,
  rollupByFamily,
  rollupSummary,
  type FunctionAt,
  type OwnershipDeps,
} from '../src/ownership';

/* ------------------------------ 夹具 ------------------------------ */

function issue(patch: Partial<ConventionIssue> & { ruleId: string }): ConventionIssue {
  return {
    severity: 'warning',
    message: `m-${patch.ruleId}`,
    key: `${patch.ruleId}|${patch.filePath ?? ''}|${patch.line ?? 0}`,
    ...patch,
  };
}

/** 家族规则的最小实现：只按 `K{no}` 与 `_F{family}` 还原（判据形状与真实 adapter 同构，内容是本测试造的） */
function familyRule(table: ReadonlyMap<string, Partial<FamilyMatch>>): FamilyIndexRule {
  return {
    name: 'test-family-index',
    match(fnName): FamilyMatch | null {
      const hit = table.get(fnName);
      if (!hit) return null;
      return {
        kind: 'ok',
        prefix: '',
        family: '',
        characterNo: null,
        selector: 0,
        face: '',
        sub: '',
        isMessageCheck: false,
        slot: '',
        isPlaceholder: false,
        ...hit,
      };
    },
  };
}

const charas = new Map<number, CharaInfo>([
  [1, { no: 1, name: '灵梦' }],
  [36, { no: 36, name: '阿燐' }],
]);

const labelOf = (no: number): string => characterLabel(no, charas);

/** 位置 → 函数：只在 path==='A' 上认第 10 行是 FOO */
const functionAt: FunctionAt = (path, line) =>
  path === 'A' && line === 10 ? { normalizedName: 'FOO', filePath: 'A' } : undefined;

const depsWith = (table: ReadonlyMap<string, Partial<FamilyMatch>>): OwnershipDeps => ({
  familyIndex: familyRule(table),
  functionAt,
});

/* ============================ 归属判定 ============================ */

describe('attributeIssue', () => {
  it('规则声明优先于所在函数（声明才是规则的意图，位置只是佐证）', () => {
    const deps = depsWith(new Map([['FOO', { characterNo: 36, family: '少女之梦' }]]));
    const own = attributeIssue(issue({ ruleId: 'r', characterNo: 1, family: '初始', filePath: 'A', line: 10 }), deps);
    expect(own).toEqual({ characterNo: 1, family: '初始', source: 'rule' });
  });

  it('规则只声明角色没声明家族 ⇒ 家族用位置的，但空串不被当成"没有"', () => {
    const deps = depsWith(new Map([['FOO', { characterNo: 36, family: '' }]]));
    const own = attributeIssue(issue({ ruleId: 'r', characterNo: 1, filePath: 'A', line: 10 }), deps);
    expect(own.family).toBe(''); // 初始家族，不是 null
  });

  it('规则未声明 ⇒ 由所在函数还原角色与家族', () => {
    const deps = depsWith(new Map([['FOO', { characterNo: 36, family: '少女之梦' }]]));
    const own = attributeIssue(issue({ ruleId: 'r', filePath: 'A', line: 10 }), deps);
    expect(own).toEqual({ characterNo: 36, family: '少女之梦', source: 'function' });
  });

  it('无位置 / 函数不认识 / 无家族规则 ⇒ 显式未归属（不猜）', () => {
    const deps = depsWith(new Map([['FOO', { characterNo: 36 }]]));
    expect(attributeIssue(issue({ ruleId: 'r' }), deps).source).toBeNull();
    expect(attributeIssue(issue({ ruleId: 'r', filePath: 'B', line: 10 }), deps).source).toBeNull();
    expect(attributeIssue(issue({ ruleId: 'r', filePath: 'A', line: 99 }), deps).source).toBeNull();
    expect(attributeIssue(issue({ ruleId: 'r', filePath: 'A', line: 10 }), { familyIndex: null, functionAt }).source).toBeNull();
    // 家族规则认识这个函数但不给编号（如 KX 占位符形态）⇒ 仍算未归属
    expect(attributeIssue(issue({ ruleId: 'r', filePath: 'A', line: 10 }), depsWith(new Map([['FOO', {}]])))).toEqual({
      characterNo: null,
      family: '',
      source: null,
    });
  });

  it('只有 filePath 没有 line（或反之）不参与位置还原', () => {
    const deps = depsWith(new Map([['FOO', { characterNo: 36 }]]));
    expect(attributeIssue(issue({ ruleId: 'r', filePath: 'A' }), deps).source).toBeNull();
    expect(attributeIssue(issue({ ruleId: 'r', line: 10 }), deps).source).toBeNull();
  });
});

/* ============================ 分组聚合 ============================ */

const mixed: ConventionIssue[] = [
  issue({ ruleId: 'a', characterNo: 1, filePath: 'A', line: 10 }), // 位置命中 36，声明优先
  issue({ ruleId: 'b', characterNo: 1, severity: 'error' }),
  issue({ ruleId: 'c', severity: 'info' }), // 无归属
  issue({ ruleId: 'd', filePath: 'A', line: 10 }), // 位置还原 → 36
];
const deps36 = depsWith(new Map([['FOO', { characterNo: 36, family: '' }]]));

describe('rollupByCharacter', () => {
  it('总账不变量：各分组之和 === 入参条数，未归属单列在最后', () => {
    const r = rollupByCharacter(mixed, deps36, labelOf);
    expect(r.total).toBe(mixed.length);
    expect(r.groups.reduce((s, g) => s + g.count, 0)).toBe(r.total);
    expect(r.groups.at(-1)!.label).toBe('未归属角色');
    expect(r.groups.at(-1)!.residual).toBe(true);
    expect(r.sourceCounts).toEqual({ rule: 2, function: 1, none: 1 });
    expect(r.groups.map((g) => g.label)).toEqual(['#1 灵梦', '#36 阿燐', '未归属角色']);
  });

  it('排序判据：最严重级别优先 → 条数降序 → 编号升序 → 码点', () => {
    const issues = [
      issue({ ruleId: 'x', characterNo: 5 }),
      issue({ ruleId: 'y', characterNo: 3, severity: 'info' }),
      issue({ ruleId: 'z', characterNo: 4, severity: 'info' }),
      issue({ ruleId: 'w', characterNo: 4, severity: 'info' }),
    ];
    const deps: OwnershipDeps = { familyIndex: null };
    const r = rollupByCharacter(issues, deps, (no) => `#${no}`);
    // 5 号是 warning（最重）⇒ 第一；4 号两条 info ⇒ 第二；3 号一条 info ⇒ 第三
    expect(r.groups.map((g) => g.key)).toEqual(['K\u00005', 'K\u00004', 'K\u00003']);
    // 同严重度同条数时按编号升序（3 号那档与别的单条档比较时才是这条判据起作用）
    const tie = rollupByCharacter([issue({ ruleId: 'p', characterNo: 9, severity: 'info' }), issue({ ruleId: 'q', characterNo: 2, severity: 'info' })], deps, (no) => `#${no}`);
    expect(tie.groups.map((g) => g.key)).toEqual(['K\u00002', 'K\u00009']);
  });

  it('组内严重度计数与条数逐字相加；组内条目保持入参序', () => {
    const r = rollupByCharacter(mixed, deps36, labelOf);
    const one = r.groups.find((g) => g.characterNo === 1)!;
    expect(one.counts).toEqual({ error: 1, warning: 1, info: 0 });
    expect(one.issues.map((i) => i.ruleId)).toEqual(['a', 'b']);
  });

  it('没有家族规则时也照常按声明聚合（降级不静默：sourceCounts 说清出处）', () => {
    const r = rollupByCharacter(mixed, { familyIndex: null }, labelOf);
    expect(r.sourceCounts).toEqual({ rule: 2, function: 0, none: 2 });
    expect(r.groups.reduce((s, g) => s + g.count, 0)).toBe(4);
  });

  it('同一份数据重跑必得同一分组序（确定性判据，不碰运气）', () => {
    const a = rollupByCharacter(mixed, deps36, labelOf).groups.map((g) => g.key);
    for (let i = 0; i < 5; i++) expect(rollupByCharacter(mixed, deps36, labelOf).groups.map((g) => g.key)).toEqual(a);
  });
});

describe('rollupByFamily', () => {
  it("位置给的 '' 是初始家族、无从判定的 null 是未记家族：两档必须分开", () => {
    const issues = [
      issue({ ruleId: 'named', characterNo: 1, family: '少女之梦' }),
      issue({ ruleId: 'initial', filePath: 'A', line: 10 }), // 位置给 family: ''
      issue({ ruleId: 'unknown', characterNo: 1 }), // 无家族信息
    ];
    const deps = depsWith(new Map([['FOO', { characterNo: 36, family: '' }]]));
    const r = rollupByFamily(issues, deps, labelOf);
    expect(r.groups.map((g) => g.label)).toEqual([
      '#1 灵梦 · 少女之梦',
      '#1 灵梦 · 未记家族',
      '#36 阿燐 · 初始家族',
    ]);
    expect(r.groups.every((g) => !g.residual)).toBe(true); // 三档都归到了角色，残余只有未归属（此处为空）
    expect(r.total).toBe(3);
    expect(r.groups.reduce((s, g) => s + g.count, 0)).toBe(3);
  });

  it('同名家族分属两个角色时不合并（家族作用域是角色）', () => {
    const issues = [
      issue({ ruleId: 'a', characterNo: 1, family: 'X' }),
      issue({ ruleId: 'b', characterNo: 36, family: 'X' }),
    ];
    const r = rollupByFamily(issues, { familyIndex: null }, labelOf);
    expect(r.groups).toHaveLength(2);
    expect(r.groups.map((g) => g.key)).toEqual(['F\u00001\u0000X', 'F\u000036\u0000X']);
  });

  it('未记家族档排在具名家族档之后、且不与未归属角色混淆', () => {
    const r = rollupByFamily([issue({ ruleId: 'no', severity: 'error' }), issue({ ruleId: 'fam', characterNo: 1 })], { familyIndex: null }, labelOf);
    expect(r.groups.map((g) => g.label)).toEqual(['#1 灵梦 · 未记家族', '未归属角色']);
    // error 那条未归属，但残余档恒最后 ⇒ 具名/未记在前
    expect(r.groups.at(-1)!.counts.error).toBe(1);
  });
});

/* ============================ 标签与文案 ============================ */

describe('标签', () => {
  it('编号不在角色表里 ⇒ 显式写「未知角色」，不编一个名字', () => {
    expect(characterLabel(777, charas)).toBe('#编号 777（未知角色）');
    expect(characterLabel(1, null)).toBe('#编号 1（未知角色）');
    expect(characterLabel(36, charas)).toBe('#36 阿燐');
  });

  it('总账那句话把三档数一次说全，且不带工程黑话', () => {
    const r = rollupByCharacter(mixed, deps36, labelOf);
    const text = rollupSummary('character', r);
    expect(text).toContain('合计 4 处');
    expect(text).toContain('已归属 3 处（规则声明 2 / 所在函数 1）');
    expect(text).toContain('未归属 1 处');
    expect(text).not.toMatch(/convention|rollup|facet|ownership|severity/i);
    expect(rollupSummary('family', r)).toMatch(/^按家族：/);
  });
});
