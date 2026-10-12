import { describe, expect, it } from 'vitest';
import {
  CORE_FACES,
  FACE_STUB_EXT,
  buildFaceStub,
  buildReadme,
  scaffoldDirName,
  scaffoldKojoProject,
  sanitizeSegment,
  type KojoScaffoldOptions,
} from '../src/scaffold';
import { createEratwFaceTable } from '../src/face-templates';

const base: KojoScaffoldOptions = {
  workName: '东方口上合集',
  authorName: '某作者',
  version: '1.0',
  charaNo: 1,
  charaName: '博丽 灵梦',
  scriptNo: 1,
  includeLicense: false,
};

describe('文件系统非法字符消毒', () => {
  it('剔除 Windows 非法字符与控制字符', () => {
    expect(sanitizeSegment('a\\b/c:d*e?f"g<h>i|j\u0000k')).toBe('abcdefghijk');
  });

  it('压缩连续空白、去首尾空白与尾随点号', () => {
    expect(sanitizeSegment('  东方  口上  ...  ')).toBe('东方 口上');
  });

  it('合法字符保留（中日文、空格、连字符）', () => {
    expect(sanitizeSegment('博丽 灵梦-改 v2')).toBe('博丽 灵梦-改 v2');
  });

  it('只剩非法字符 → 空串（向导据此禁用创建）', () => {
    expect(sanitizeSegment('***')).toBe('');
  });
});

describe('包目录名（中文命名约定）', () => {
  it('{作品名}-{角色名} v{版本}', () => {
    expect(scaffoldDirName(base)).toBe('东方口上合集-博丽 灵梦 v1.0');
  });

  it('逐段消毒（非法字符不进入目录名）', () => {
    expect(
      scaffoldDirName({ workName: '作/品', charaName: '角*色', version: '1.0|beta' }),
    ).toBe('作品-角色 v1.0beta');
  });
});

describe('脚手架产物', () => {
  it('README + 8 核心面空壳；默认不含 LICENSE', () => {
    const r = scaffoldKojoProject(base);
    expect(r.dirName).toBe('东方口上合集-博丽 灵梦 v1.0');
    expect(Object.keys(r.files).sort()).toEqual(
      ['README.md', ...CORE_FACES.map((f) => `${f.stem}${FACE_STUB_EXT}`)].sort(),
    );
  });

  /**
   * 用户反馈 1：「新建项目后的文件默认都是 .kojo，这样既能写语法糖也能写原始 ERB」。
   * `.kojo` 是超集，`.ERB` 只能写原生——脚手架不该替作者先收窄表达。
   * 这条断言同时守住另一半：**工作区里不该出现 .ERB**，否则同一份内容两个权威源。
   */
  it('核心面空壳一律 .kojo，产物里没有任何 .ERB（工作区唯一源）', () => {
    const r = scaffoldKojoProject({ ...base, includeLicense: true });
    const names = Object.keys(r.files);
    for (const face of CORE_FACES) expect(names).toContain(`${face.stem}.kojo`);
    expect(names.filter((n) => /\.ERB$/i.test(n))).toEqual([]);
  });

  it('勾选 LICENSE → 多一个 LICENSE 文件', () => {
    const r = scaffoldKojoProject({ ...base, includeLicense: true });
    expect(r.files['LICENSE']).toContain('某作者');
  });

  it('8 核心面清单即讨论纪要定稿（顺序与命名）', () => {
    expect(CORE_FACES.map((f) => f.stem)).toEqual([
      '事件',
      '日常指令',
      '性交指令',
      '奉仕指令',
      '爱抚指令',
      '绝顶',
      '刻印取得',
      '性骚扰指令',
    ]);
  });

  it('空壳内容纯注释：无活函数（@ 开头行）、无空行以外的非注释行', () => {
    const r = scaffoldKojoProject(base);
    for (const face of CORE_FACES) {
      const text = r.files[`${face.stem}${FACE_STUB_EXT}`]!;
      const lines = text.split('\n');
      for (const line of lines) {
        if (line.trim() === '') continue;
        expect(line.startsWith(';'), `${face.stem}${FACE_STUB_EXT} 出现非注释行：${line}`).toBe(true);
      }
      expect(text).not.toContain('\n@');
    }
  });

  it('空壳注释引用分野表函数形态（角色号代入；游戏知识来自 face-templates）', () => {
    const r = scaffoldKojoProject(base);
    expect(r.files['事件.kojo']).toContain('M_KOJO_EVENT_K1_{i}');
    expect(r.files['绝顶.kojo']).toContain('M_KOJO_MESSAGE_PALAMCNG_B_K1');
    expect(r.files['刻印取得.kojo']).toContain('M_KOJO_MESSAGE_MARKCNG_K1');
    expect(r.files['性交指令.kojo']).toContain('M_KOJO_MESSAGE_${com}_K1_{i}');
  });

  it('README 含作品信息、面清单与部署说明', () => {
    const readme = buildReadme(base);
    expect(readme).toContain('《东方口上合集》');
    expect(readme).toContain('某作者');
    expect(readme).toContain('博丽 灵梦（编号 1）');
    expect(readme).toContain('剧本1');
    expect(readme).toContain('個人口上');
    for (const face of CORE_FACES) expect(readme).toContain(`${face.stem}${FACE_STUB_EXT}`);
  });

  it('不生成四件套文件（登记/配色/开关是函数级产物）', () => {
    const r = scaffoldKojoProject(base);
    const names = Object.keys(r.files);
    expect(names.some((n) => /登记|配色|开关|FLAGSETTING|COLOR/i.test(n))).toBe(false);
  });
});

describe('面空壳生成（单面）', () => {
  it('含作品/角色/剧本元信息行', () => {
    const stub = buildFaceStub(CORE_FACES[0]!, base, createEratwFaceTable());
    expect(stub).toContain('《东方口上合集》');
    expect(stub).toContain('K1');
    expect(stub).toContain('剧本1');
  });
});

describe('输入兜底校验', () => {
  it('剧本号越界拒绝', () => {
    expect(() => scaffoldKojoProject({ ...base, scriptNo: 0 })).toThrow(/1-10/);
    expect(() => scaffoldKojoProject({ ...base, scriptNo: 11 })).toThrow(/1-10/);
  });

  it('空作品名 / 空作者名拒绝', () => {
    expect(() => scaffoldKojoProject({ ...base, workName: '  ' })).toThrow(/作品名/);
    expect(() => scaffoldKojoProject({ ...base, authorName: '' })).toThrow(/作者名/);
  });
});
