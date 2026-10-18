import { describe, expect, it } from 'vitest';
import {
  AM_DEPLOY_ROOT,
  AM_FACE_STUB_EXT,
  AM_SCAFFOLD_FILES,
  amCharaCsvRelPath,
  buildAMFileStub,
  buildAMReadme,
  buildErakumamaidCharaCsv,
  scaffoldErakumamaidProject,
  type ErakumamaidScaffoldOptions,
} from '../src/scaffold';
import { createErakumamaidFaceTable } from '../src/face-templates';

const base: ErakumamaidScaffoldOptions = {
  workName: '恶魔女仆口上集',
  authorName: '某作者',
  version: '1.0',
  charaNo: 67,
  charaName: '新角色',
};

describe('eraAkumaMaid 脚手架产物形态', () => {
  it('目录名沿用共享骨架的 {作品名}-{角色名} v{版本}', () => {
    expect(scaffoldErakumamaidProject(base).dirName).toBe('恶魔女仆口上集-新角色 v1.0');
  });

  it('产物按游戏根相对路径铺开：README + CSV/CHARA/ + ERB/EVENT_K/<n>/', () => {
    const names = Object.keys(scaffoldErakumamaidProject(base).files);
    expect(names).toContain('README.md');
    expect(names).toContain('CSV/CHARA/CHARA67.csv');
    for (const f of AM_SCAFFOLD_FILES) {
      expect(names).toContain(`ERB/EVENT_K/67/${f.stem.replaceAll('{n}', '67')}${AM_FACE_STUB_EXT}`);
    }
  });

  it('7 个口上文件 + 1 张角色表 + README = 9 件', () => {
    const names = Object.keys(scaffoldErakumamaidProject(base).files);
    expect(AM_SCAFFOLD_FILES.length).toBe(7);
    expect(names.length).toBe(9);
  });

  it('工作区里没有任何 .ERB（唯一源是 .kojo）', () => {
    const names = Object.keys(scaffoldErakumamaidProject(base).files);
    expect(names.filter((n) => /\.ERB$/i.test(n))).toEqual([]);
  });

  it('空壳内容纯注释：无非注释行、无活函数', () => {
    const r = scaffoldErakumamaidProject(base);
    for (const f of AM_SCAFFOLD_FILES) {
      const key = `ERB/EVENT_K/67/${f.stem.replaceAll('{n}', '67')}${AM_FACE_STUB_EXT}`;
      const text = r.files[key]!;
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue;
        expect(line.startsWith(';'), `${key} 出现非注释行：${line}`).toBe(true);
      }
      expect(text).not.toContain('\n@');
    }
  });

  it('每个空壳都点名本文件该写的函数（作者不必回去翻模板包）', () => {
    const r = scaffoldErakumamaidProject(base);
    const main = r.files['ERB/EVENT_K/67/EVENT_K67.kojo']!;
    expect(main).toContain('CNAME_K67');
    expect(main).toContain('EVENT_PROFILE_K67');
    expect(main).toContain('KOJO_MESSAGE_MARKCNG_K67');
    expect(r.files['ERB/EVENT_K/67/EVENT_K67_DAILY.kojo']).toContain('KOJO_DAILY_K67');
    expect(r.files['ERB/EVENT_K/67/EVENT_K67_SELECT.kojo']).toContain(
      'KOJO_WISH_K67_ADDSELECT',
    );
    expect(r.files['ERB/EVENT_K/67/UPDATE_K67.kojo']).toContain('UPDATE_K67');
    // 说明行里的 {n} 必须已被真实编号替换（原样抄进函数名引擎认不到）
    for (const text of Object.values(r.files)) expect(text).not.toContain('{n}');
  });

  it('主文件与日常文件带分野表函数形态；无分野表条目的文件不硬编形态', () => {
    const table = createErakumamaidFaceTable();
    const main = buildAMFileStub(AM_SCAFFOLD_FILES[0]!, base, table);
    expect(main).toContain('【函数形态】KOJO_MESSAGE_COM_K67');
    const comm = buildAMFileStub(AM_SCAFFOLD_FILES[2]!, base, table);
    expect(comm).not.toContain('【函数形态】');
    expect(comm).toContain('KOJO_COMM_K67');
  });

  it('元信息行没有剧本号（本游戏无剧本概念）', () => {
    const text = buildAMFileStub(AM_SCAFFOLD_FILES[0]!, base, createErakumamaidFaceTable());
    expect(text).not.toContain('剧本');
    expect(text).toContain('版本 1.0');
    expect(text).toContain('作者：某作者');
  });

  it('不生成活函数，也不生成 eraTW 的四件套（登记/配色/开关）', () => {
    const names = Object.keys(scaffoldErakumamaidProject(base).files);
    expect(names.some((n) => /登记|配色|开关|FLAGSETTING|COLOR/i.test(n))).toBe(false);
  });
});

describe('角色表 CSV 骨架', () => {
  it('BOM + CRLF（与游戏侧 CSV 逐字同形态）', () => {
    const csv = buildErakumamaidCharaCsv(base);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain('\r\n');
    // 除 CRLF 之外不得出现裸 LF（去掉全部 CRLF 后就不该再有 LF）
    expect(csv.replaceAll('\r\n', '')).not.toContain('\n');
  });

  it('必填七项齐全（番号/名前/呼び名/基礎/肩書/学年/関係）', () => {
    const csv = buildErakumamaidCharaCsv(base);
    expect(csv).toContain('番号,67');
    expect(csv).toContain('名前,新角色');
    expect(csv).toContain('呼び名,新角色');
    expect(csv).toContain('基礎,体力,2000');
    expect(csv).toContain('CSTR,肩書,');
    expect(csv).toContain('CSTR,学年,');
    expect(csv).toContain('CSTR,関係,');
  });

  it('键名用 CSTR 而不是独立行（本游戏角色卡结构）', () => {
    const csv = buildErakumamaidCharaCsv(base);
    expect(csv).not.toMatch(/^肩書,/m);
    expect(csv).not.toMatch(/^学年,/m);
    expect(csv).not.toMatch(/^関係,/m);
  });

  it('路径是游戏实际布局 CSV/CHARA/CHARA<n>.csv', () => {
    expect(amCharaCsvRelPath(67)).toBe('CSV/CHARA/CHARA67.csv');
    expect(scaffoldErakumamaidProject(base).files[amCharaCsvRelPath(67)]).toContain('番号,67');
  });
});

describe('README', () => {
  it('含作品信息、文件清单与部署说明', () => {
    const md = buildAMReadme(base);
    expect(md).toContain('《恶魔女仆口上集》');
    expect(md).toContain('某作者');
    expect(md).toContain('新角色（编号 67）');
    expect(md).toContain('eraAkumaMaid');
    for (const f of AM_SCAFFOLD_FILES) {
      expect(md).toContain(`${f.stem.replaceAll('{n}', '67')}${AM_FACE_STUB_EXT}`);
    }
    expect(md).toContain(`${AM_DEPLOY_ROOT}/67/`);
    expect(md).toContain('CSV/CHARA/CHARA67.csv');
  });

  it('不提剧本号（本游戏无此概念）', () => {
    expect(buildAMReadme(base)).not.toContain('剧本');
  });

  it('许可段指向游戏自带的许可一览，不代填条款正文', () => {
    const md = buildAMReadme(base);
    expect(md).toContain('口上ライセンス一覧.txt');
    expect(md).not.toContain('■ライセンス本文');
  });

  it('填了发布页才多一行元信息（不填不留空行）', () => {
    expect(buildAMReadme(base)).not.toContain('发布页');
    expect(buildAMReadme({ ...base, homepage: 'https://example.invalid/x' })).toContain(
      '| 发布页 | https://example.invalid/x |',
    );
  });
});

describe('输入兜底校验', () => {
  it('空作品名 / 空作者名 / 空版本 / 空角色名拒绝', () => {
    expect(() => scaffoldErakumamaidProject({ ...base, workName: '  ' })).toThrow(/作品名/);
    expect(() => scaffoldErakumamaidProject({ ...base, authorName: '' })).toThrow(/作者名/);
    expect(() => scaffoldErakumamaidProject({ ...base, version: ' ' })).toThrow(/版本/);
    expect(() => scaffoldErakumamaidProject({ ...base, charaName: '' })).toThrow(/角色名/);
  });

  it('角色编号非法拒绝（负数 / 非整数 / 超上限）', () => {
    expect(() => scaffoldErakumamaidProject({ ...base, charaNo: -1 })).toThrow(/角色编号/);
    expect(() => scaffoldErakumamaidProject({ ...base, charaNo: 1.5 })).toThrow(/角色编号/);
    expect(() => scaffoldErakumamaidProject({ ...base, charaNo: 100_000 })).toThrow(/角色编号/);
  });

  it('编号 0 合法（游戏侧存在 CHARA0.csv）', () => {
    expect(() => scaffoldErakumamaidProject({ ...base, charaNo: 0 })).not.toThrow();
  });
});
