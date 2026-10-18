import { describe, expect, it } from 'vitest';
import {
  assembleScaffold,
  assertScaffoldIdentity,
  buildScaffoldDirName,
  buildScaffoldFaceStub,
  buildScaffoldReadme,
  faceTemplateExample,
  sanitizePathSegment,
  type ScaffoldFaceSpec,
  type ScaffoldIdentity,
  type KojoFaceTable,
} from '../src';

/**
 * 共享骨架的**自身**测试（AM-1 P4）：只钉"与游戏无关"的那部分。
 *
 * 为什么不拿 eraTW / eraAkumaMaid 的真实数据测：骨架的契约是"注入什么就渲染什么"，
 * 用真实数据会把两边的游戏知识混进契约层的测试里（A 项门禁的同一条理由）。
 * 这里的字段值一律用无意义占位（`W` / `N` / `F1`）。
 */

const identity: ScaffoldIdentity = {
  workName: '作品',
  authorName: '作者',
  version: '1.0',
  charaNo: 7,
  charaName: '角色',
};

const face: ScaffoldFaceSpec = { stem: 'F1', face: 'K1', blurb: '第一面。' };

const faceTable: KojoFaceTable = {
  faces: {
    K1: { template: 'FN_{t}_K{n}' },
    K2: { template: 'FN2_K{n}' },
  },
} as unknown as KojoFaceTable;

describe('路径消毒与目录名', () => {
  it('剔除文件系统非法字符与控制字符', () => {
    expect(sanitizePathSegment('a\\b/c:d*e?f"g<h>i|j\u0000k')).toBe('abcdefghijk');
  });

  it('压缩空白、去首尾空白与尾随点号', () => {
    expect(sanitizePathSegment('  甲  乙  ...  ')).toBe('甲 乙');
  });

  it('合法字符原样保留（中日文、空格、连字符）', () => {
    expect(sanitizePathSegment('角色 名-改 v2')).toBe('角色 名-改 v2');
  });

  it('只剩非法字符 → 空串（向导据此禁用创建）', () => {
    expect(sanitizePathSegment('***')).toBe('');
  });

  it('目录名 = {作品}-{角色} v{版本}，逐段消毒', () => {
    expect(buildScaffoldDirName(identity)).toBe('作品-角色 v1.0');
    expect(buildScaffoldDirName({ workName: '作/品', charaName: '角*色', version: '1.0|b' })).toBe(
      '作品-角色 v1.0b',
    );
  });
});

describe('分野表模板示例', () => {
  it('代入角色号、清掉家族段占位、保留编号占位原样', () => {
    expect(faceTemplateExample(faceTable, 'K1', 7)).toBe('FN__K7');
    expect(faceTemplateExample(faceTable, 'K2', 7)).toBe('FN2_K7');
  });

  it('该面没有模板 → null（调用方据此整段不输出）', () => {
    expect(faceTemplateExample(faceTable, '不存在', 7)).toBeNull();
  });
});

describe('单面空壳', () => {
  const base = { face, identity, metaLead: [] as string[], faceCase: null };

  it('段落次序：标题 → 元信息 → 面说明 → 尾注', () => {
    const text = buildScaffoldFaceStub({ ...base, templateExample: null }, '.kojo');
    const lines = text.split('\n');
    expect(lines[0]).toBe('; 《作品》· 角色（K7）— F1');
    expect(lines[1]).toBe('; 版本 1.0 · 作者：作者');
    expect(text).toContain('; 【面说明】第一面。');
    expect(text).toContain('脚手架生成的空壳文件：只有注释，没有活函数');
  });

  it('metaLead 拼接在版本之前（无内容则整段省略）', () => {
    const text = buildScaffoldFaceStub(
      { ...base, metaLead: ['剧本3'], templateExample: null },
      '.kojo',
    );
    expect(text).toContain('; 剧本3 · 版本 1.0 · 作者：作者');
  });

  it('纯注释：任何非空行都以 ; 开头，且不含活函数', () => {
    const text = buildScaffoldFaceStub(
      { ...base, templateExample: 'FN_K7', alwaysHints: ['提示行'] },
      '.kojo',
    );
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      expect(line.startsWith(';')).toBe(true);
    }
    expect(text).not.toContain('\n@');
  });

  it('占位符说明只在该占位符真出现时渲染', () => {
    const hints = [
      { token: '{i}', text: '编号。' },
      { token: '${com}', text: '类型段。' },
    ];
    const only = buildScaffoldFaceStub(
      { ...base, templateExample: 'FN_K7_{i}', templateHints: hints },
      '.kojo',
    );
    expect(only).toContain('{i} = 编号。');
    expect(only).not.toContain('${com} = 类型段。');
  });

  it('alwaysHints 与模板无关：无模板时也照常输出', () => {
    const text = buildScaffoldFaceStub(
      { ...base, templateExample: null, alwaysHints: ['该写 FN_K7。'] },
      '.kojo',
    );
    expect(text).toContain('该写 FN_K7。');
  });

  it('无案例 → 整块不输出（不留空头）', () => {
    const text = buildScaffoldFaceStub({ ...base, templateExample: 'FN_K7' }, '.kojo');
    expect(text).not.toContain('库内现成案例');
  });

  it('有案例 → 出处、函数名、逐行正文齐全；空行留 `;`', () => {
    const text = buildScaffoldFaceStub(
      {
        ...base,
        templateExample: null,
        faceCase: { source: 'P/X.ERB', fn: '@FN_K7', category: '「台词」', lines: ['甲', '', '乙'] },
      },
      '.kojo',
    );
    expect(text).toContain('【库内现成案例】照抄 P/X.ERB');
    expect(text).toContain('的 @FN_K7');
    expect(text).toContain('; 甲\n;\n; 乙');
  });

  it('案例收尾句里的扩展名跟着 stubExt 走（不写死）', () => {
    const text = buildScaffoldFaceStub(
      {
        ...base,
        templateExample: null,
        faceCase: { source: 'P/X.ERB', fn: '@F', category: '「台词」', lines: ['甲'] },
      },
      '.erb',
    );
    expect(text).toContain('写法详见「.erb 语言教程」');
  });

  it('tailNotes 可覆盖默认尾注', () => {
    const text = buildScaffoldFaceStub(
      { ...base, templateExample: null, tailNotes: ['自定义尾注'] },
      '.kojo',
    );
    expect(text).toContain('; 自定义尾注');
    expect(text).not.toContain('请在下方开始创作');
  });
});

describe('README 骨架', () => {
  const spec = {
    identity,
    title: '《作品》· 角色 口上包',
    metaRows: [{ label: '作者', value: '作者' }],
    intro: ['> 简介占位。'],
    contentNote: ['内容说明。'],
    faces: [face],
    stubExt: '.kojo',
    deployIntro: ['放到这里：'],
    deployPath: 'P/<n>/',
    deployNote: ['部署后注。'],
    licenseNote: ['许可说明。'],
  };

  it('四段齐全且次序固定：简介 → 内容 → 部署 → 许可', () => {
    const md = buildScaffoldReadme(spec);
    const at = (s: string): number => md.indexOf(s);
    expect(at('## 简介')).toBeGreaterThan(-1);
    expect(at('## 简介')).toBeLessThan(at('## 内容'));
    expect(at('## 内容')).toBeLessThan(at('## 部署'));
    expect(at('## 部署')).toBeLessThan(at('## 许可'));
    expect(md.startsWith('# 《作品》· 角色 口上包')).toBe(true);
  });

  it('元信息表与面清单按输入渲染（文件名 = stem + stubExt）', () => {
    const md = buildScaffoldReadme(spec);
    expect(md).toContain('| 作者 | 作者 |');
    expect(md).toContain('- `F1.kojo` — 第一面。');
  });

  it('部署路径进代码块', () => {
    expect(buildScaffoldReadme(spec)).toContain('```\nP/<n>/\n```');
  });

  it('deployNote 里的空串渲染成空行（调用方靠它分段）', () => {
    const md = buildScaffoldReadme({ ...spec, deployNote: ['甲', '', '乙'] });
    expect(md).toContain('甲\n\n乙');
  });
});

describe('校验与装配', () => {
  const run = (patch: Partial<ScaffoldIdentity>) => (): void => {
    assertScaffoldIdentity({ ...identity, ...patch });
  };

  it('必填字段空则抛中文错', () => {
    expect(run({ workName: ' ' })).toThrow(/作品名/);
    expect(run({ authorName: '' })).toThrow(/作者名/);
    expect(run({ version: ' ' })).toThrow(/版本/);
    expect(run({ charaName: '' })).toThrow(/角色名/);
  });

  it('角色编号必须是 >= 0 的整数', () => {
    expect(run({ charaNo: -1 })).toThrow(/角色编号/);
    expect(run({ charaNo: 1.5 })).toThrow(/角色编号/);
    expect(run({ charaNo: 0 })).not.toThrow();
  });

  it('键次序：README.md → 附加文件 → 各面空壳（顺序即 faces 顺序）', () => {
    const r = assembleScaffold({
      identity,
      faces: [face, { stem: 'F2', face: 'K2', blurb: '第二面。' }],
      stubExt: '.kojo',
      readme: () => 'R',
      stub: (f) => `stub:${f.stem}`,
      extraFiles: () => ({ 'CSV/A.csv': 'csv' }),
    });
    expect(Object.keys(r.files)).toEqual(['README.md', 'CSV/A.csv', 'F1.kojo', 'F2.kojo']);
    expect(r.files['F1.kojo']).toBe('stub:F1');
    expect(r.dirName).toBe('作品-角色 v1.0');
  });

  it('faces 的 stem 可含目录段（产物键 = stem + 扩展名）', () => {
    const r = assembleScaffold({
      identity,
      faces: [{ stem: 'D/F1', face: 'K1', blurb: '' }],
      stubExt: '.kojo',
      readme: () => 'R',
      stub: () => '',
    });
    expect(Object.keys(r.files)).toContain('D/F1.kojo');
  });

  it('无附加文件时不多键', () => {
    const r = assembleScaffold({
      identity,
      faces: [],
      stubExt: '.kojo',
      readme: () => 'R',
      stub: () => '',
    });
    expect(Object.keys(r.files)).toEqual(['README.md']);
  });

  it('assertExtra 在通用校验之后跑（适配器补自己的区间）', () => {
    const order: string[] = [];
    expect(() =>
      assembleScaffold({
        identity,
        faces: [],
        stubExt: '.kojo',
        readme: () => {
          order.push('readme');
          return '';
        },
        stub: () => '',
        assertExtra: () => {
          order.push('extra');
          throw new Error('剧本号必须是 1-10 的整数：0');
        },
      }),
    ).toThrow(/剧本号/);
    // 校验先于任何内容求值（非法输入不该先跑一遍构建）
    expect(order).toEqual(['extra']);
  });

  it('通用校验不过就不跑 assertExtra', () => {
    let ran = false;
    expect(() =>
      assembleScaffold({
        identity: { ...identity, workName: '' },
        faces: [],
        stubExt: '.kojo',
        readme: () => '',
        stub: () => '',
        assertExtra: () => {
          ran = true;
        },
      }),
    ).toThrow(/作品名/);
    expect(ran).toBe(false);
  });
});
