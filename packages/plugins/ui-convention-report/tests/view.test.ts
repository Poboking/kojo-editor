import { describe, expect, it } from 'vitest';
import type { CharaInfo, ConventionIssue, FamilyIndexRule, FamilyMatch } from '@kojo/plugin-api';
import { buildGroupView, GROUP_MODE_LABEL, GROUP_MODES } from '../src/view';

const charas = new Map<number, CharaInfo>([[1, { no: 1, name: '灵梦' }]]);

function issue(patch: Partial<ConventionIssue> & { ruleId: string }): ConventionIssue {
  return { severity: 'warning', message: 'm', key: `${patch.ruleId}|${patch.filePath ?? ''}|${patch.line ?? 0}`, ...patch };
}

const familyIndex: FamilyIndexRule = {
  name: 'test',
  match(fnName): FamilyMatch | null {
    return fnName === 'FOO'
      ? { kind: 'ok', prefix: '', family: '少女之梦', characterNo: 1, selector: 0, face: '', sub: '', isMessageCheck: false, slot: '', isPlaceholder: false }
      : null;
  },
};

const deps = {
  ruleDescription: (id: string) => (id === 'r.a' ? '规则 A 的说明' : id),
  ownership: { familyIndex, functionAt: (p: string, l: number) => (p === 'A' && l === 3 ? { normalizedName: 'FOO', filePath: 'A' } : undefined) },
  charaIndex: charas as ReadonlyMap<number, CharaInfo>,
};

describe('按规则看（默认视角）', () => {
  it('分组序 = 条数降序，同数按规则标识码点；说明行取规则描述，未知 id 原样显示', () => {
    const issues = [
      issue({ ruleId: 'r.b' }),
      issue({ ruleId: 'r.b' }),
      issue({ ruleId: 'r.z' }),
      issue({ ruleId: 'r.a' }),
    ];
    const v = buildGroupView('rule', issues, deps);
    expect(v.groups.map((g) => g.title)).toEqual(['r.b', 'r.a', 'r.z']);
    expect(v.groups.map((g) => g.count)).toEqual([2, 1, 1]);
    expect(v.groups.map((g) => g.desc)).toEqual(['r.b', '规则 A 的说明', 'r.z']);
    expect(v.summary).toBeNull();
    expect(v.groups.every((g) => !g.showRuleTag)).toBe(true);
    expect(v.groups.reduce((s, g) => s + g.count, 0)).toBe(issues.length);
  });
});

describe('按角色看 / 按家族看', () => {
  const issues = [
    issue({ ruleId: 'r.a', filePath: 'A', line: 3 }), // 位置还原 → #1 灵梦 · 少女之梦
    issue({ ruleId: 'r.b', filePath: 'A', line: 3, severity: 'error' }), // 同上，error
    issue({ ruleId: 'r.c' }), // 无从归属
  ];

  it('切换视角不产生新数据：三个视角的条数之和都等于入参条数', () => {
    for (const mode of GROUP_MODES) {
      const v = buildGroupView(mode, issues, deps);
      expect(v.groups.reduce((s, g) => s + g.count, 0)).toBe(issues.length);
    }
  });

  it('组头 = 归属名，说明行 = 严重度构成（0 档不写），条目行带规则标识', () => {
    const v = buildGroupView('character', issues, deps);
    expect(v.groups.map((g) => g.title)).toEqual(['#1 灵梦', '未归属角色']);
    expect(v.groups[0]!.desc).toBe('错误 1 / 警告 1');
    expect(v.groups.every((g) => g.showRuleTag)).toBe(true);
    expect(v.summary).toContain('按角色：2 组 · 合计 3 处');
    expect(v.summary).toContain('未归属 1 处');
  });

  it('家族视角把位置还原出的家族名也带出来', () => {
    const v = buildGroupView('family', issues, deps);
    expect(v.groups.map((g) => g.title)).toEqual(['#1 灵梦 · 少女之梦', '未归属角色']);
    expect(v.summary).toMatch(/^按家族：/);
  });

  it('没有条目时三个视角都是空分组，总账说 0 处（不显示"未发现问题"以外的数字）', () => {
    for (const mode of GROUP_MODES) {
      const v = buildGroupView(mode, [], deps);
      expect(v.groups).toEqual([]);
    }
    expect(buildGroupView('character', [], deps).summary).toContain('合计 0 处');
  });

  it('视角标签是人话：不许出现工程黑话', () => {
    expect(GROUP_MODES).toEqual(['rule', 'character', 'family']);
    expect(Object.values(GROUP_MODE_LABEL).join('')).toBe('按规则看按角色看按家族看');
  });
});
