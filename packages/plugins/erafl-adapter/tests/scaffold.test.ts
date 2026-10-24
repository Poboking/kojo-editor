/**
 * eraFL 口上脚手架单测。
 *
 * 钉住三件事：
 * 1. **两份产物**（define 壳 + XML）路径与内容形态——路径错一份，引擎就找不到另一份；
 * 2. **CRLF + BOM**（真盘 ERB/XML 都是这个形态），以及 `KOJO_XML_REGISTER` 真的把
 *    `XML_PATH_COM` 交给引擎（少了这行，XML 永远不会被加载）；
 * 3. 非法输入**抛中文错**（引擎只扫 K0..5999，编号越界必须是生成前失败而不是产出废件）。
 */
import { describe, expect, it } from 'vitest';
import { scaffoldEraflKojo } from '../src/scaffold';

const DEFINE_REL = 'ERB/口上/1099_うふふお姉さん/KOJO_DEFINE_K1099.ERB';
const XML_REL = 'ERB/口上/1099_うふふお姉さん/うふふお姉さん口上.xml';

describe('scaffoldEraflKojo（口上骨架两份产物）', () => {
  it('产出 2 个文件，路径是相对游戏根的 `ERB/口上/{编号}_{名称}/`', () => {
    const { files } = scaffoldEraflKojo({ charaNo: 1099, charaName: 'うふふお姉さん' });
    expect(Object.keys(files).sort()).toEqual([DEFINE_REL, XML_REL].sort());
    expect(Object.keys(files)).toHaveLength(2);
  });

  it('define 壳是 CRLF + BOM，且含 XML_PATH_COM / KOJO_XML_REGISTER / NAME / MALE / FEMALE 五个必备件', () => {
    const { files } = scaffoldEraflKojo({ charaNo: 1099, charaName: 'うふふお姉さん' });
    const erb = files[DEFINE_REL]!;

    expect(erb.startsWith('\uFEFF')).toBe(true);
    // 裸 \n（不被 \r 跟着）出现次数必须是 0：CRLF 是游戏侧的统一形态
    expect(erb.replace(/\r\n/g, '').includes('\n')).toBe(false);
    expect(erb.endsWith('\r\n')).toBe(true);

    expect(erb).toContain('@KOJO_DEFINE_K1099');
    expect(erb).toContain(`#DIMS CONST XML_PATH_COM = "${XML_REL}"`);
    expect(erb).toContain('#DIM CONST 汎用口上番号 = 1099');
    expect(erb).toContain(
      'CALL KOJO_XML_REGISTER(XML_PATH_COM, 汎用口上番号, XMLID_KOJO_CLASS_COM)',
    );
    expect(erb).toContain('@KOJO_DEFINE_NAME_K1099');
    expect(erb).toContain('@KOJO_FOR_MALE_K1099');
    expect(erb).toContain('@KOJO_FOR_FEMALE_K1099');
  });

  it('XML 是声明 + data + 一条 com=300 会話 的 command，2 空格缩进、CRLF', () => {
    const { files } = scaffoldEraflKojo({ charaNo: 1099, charaName: 'うふふお姉さん' });
    const xml = files[XML_REL]!;
    const body = xml.replace(/^\uFEFF/, '');

    expect(body.startsWith('<?xml version="1.0" encoding="utf-8"?>\r\n')).toBe(true);
    expect(body).toContain('\r\n<data>\r\n');
    expect(body).toContain(
      '\r\n  <command com="300" name="会話" kojoPlace="TOP" priority="1">\r\n' +
        '    <contents>',
    );
    expect(body.trimEnd().endsWith('</data>')).toBe(true);
    // 只有一条 command（多写空壳只会让作者先删后写）
    expect(body.match(/<command /g)).toHaveLength(1);
  });

  it('kojoName 进 KOJO_DEFINE_NAME 的 RESULTS；forMale / forFemale 分别落成 RETURN 0 / 1', () => {
    const { files } = scaffoldEraflKojo({
      charaNo: 12,
      charaName: '测试',
      kojoName: '温柔大姐',
      forMale: true,
      forFemale: false,
    });
    const erb = files['ERB/口上/12_测试/KOJO_DEFINE_K12.ERB']!;
    expect(erb).toContain('RESULTS \'= "温柔大姐"');
    expect(erb).toContain('@KOJO_FOR_MALE_K12\r\nRETURN 1');
    expect(erb).toContain('@KOJO_FOR_FEMALE_K12\r\nRETURN 0');
    expect(files['ERB/口上/12_测试/测试口上.xml']).toBeDefined();
  });

  it('缺省 forFemale=1 / forMale=0（照真盘 1099 模板），kojoName 缺省 = 角色名', () => {
    const { files } = scaffoldEraflKojo({ charaNo: 7, charaName: '七号' });
    const erb = files['ERB/口上/7_七号/KOJO_DEFINE_K7.ERB']!;
    expect(erb).toContain('@KOJO_FOR_MALE_K7\r\nRETURN 0');
    expect(erb).toContain('@KOJO_FOR_FEMALE_K7\r\nRETURN 1');
    expect(erb).toContain('RESULTS \'= "七号"');
  });

  it('目录名消毒：名称里的 `/` 与 `:` 换成 `_`，两份文件仍落在同一目录', () => {
    const { files } = scaffoldEraflKojo({ charaNo: 9, charaName: 'a/b:c' });
    const keys = Object.keys(files).sort();
    expect(keys).toEqual([
      'ERB/口上/9_a_b_c/KOJO_DEFINE_K9.ERB',
      'ERB/口上/9_a_b_c/a_b_c口上.xml',
    ]);
    expect(files['ERB/口上/9_a_b_c/KOJO_DEFINE_K9.ERB']).toContain(
      'XML_PATH_COM = "ERB/口上/9_a_b_c/a_b_c口上.xml"',
    );
  });

  it('编号越界（6000）抛中文错：引擎只扫 KOJO_DEFINE_K0..5999', () => {
    expect(() => scaffoldEraflKojo({ charaNo: 6000, charaName: 'x' })).toThrow(/5999/);
  });

  it('名称为空抛中文错（它同时决定目录名与 XML 文件名）', () => {
    expect(() => scaffoldEraflKojo({ charaNo: 7, charaName: '  ' })).toThrow(/名称不能为空/);
  });

  it('notes 至少 4 条，且点明「没注册就不加载」与编号上界 5999', () => {
    const { notes } = scaffoldEraflKojo({ charaNo: 1099, charaName: 'うふふお姉さん' });
    expect(notes.length).toBeGreaterThanOrEqual(4);
    const joined = notes.join('\n');
    expect(joined).toContain('5999');
    expect(joined).toContain('KOJO_XML_REGISTER');
  });
});
