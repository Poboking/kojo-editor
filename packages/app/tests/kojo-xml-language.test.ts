/**
 * 口上 XML 语言面判据：认路 / 折叠 / 大纲 / 属性解析 / 诊断。
 *
 * 真盘那一组只做**误报率**判据（293 份跑完统计诊断条数），不钉死到个位——
 * 语料会随游戏版本变；钉死的是"不许把正常写法报成错"这条性质。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join as nodeJoin } from 'node:path';
import { describe, expect, it } from 'vitest';
import { languageForPath } from '../src/monaco/languages';
import { languageDescriptors } from '../src/monaco/language-registry';
import {
  KOJO_XML_LANGUAGE_ID,
  KOJO_XML_SOURCE_EXTENSION,
} from '../src/monaco/xml-language';
import {
  attrsOnLine,
  computeXmlCommandSymbols,
  computeXmlFoldingRanges,
  currentKojoXmlSchema,
  setKojoXmlSchemaSource,
} from '../src/monaco/kojo-xml-providers';
import { checkKojoXmlText } from '../src/monaco/kojo-xml-diagnostics';
import type { KojoXmlSchema } from '@kojo/plugin-api';
// 真盘判据要用 adapter 的**真实规格表**（用测试用的小表会把合法属性全报成未知）
import { buildKojoXmlSchema } from '../../plugins/erafl-adapter/src/kojo-xml/schema';

/** 测试用规格：形状照 adapter 交来的那份，只留判据需要的几条 */
const SCHEMA: KojoXmlSchema = {
  attributes: [
    { name: 'com', doc: '命令', required: true },
    { name: 'name', doc: '显示名' },
    { name: 'kojoPlace', doc: '位置', values: ['TOP', 'BOTTOM'], closed: true },
    { name: 'priority', doc: '优先级' },
    { name: 'isFall', doc: '恋爱状态', values: ['LOVER', 'FALLEN'] },
    { name: 'isMob', doc: '杂兵', values: ['TRUE', 'FALSE'], closed: true },
  ],
  commands: [
    { code: '300', label: '会話' },
    { code: 'ANY', label: '汎用' },
  ],
  places: ['TOP', 'BOTTOM'],
};

describe('语言注册', () => {
  it('.xml 认到 kojo-xml，且 descriptor 不参与通用语言服务双注册', () => {
    expect(KOJO_XML_SOURCE_EXTENSION).toBe('.xml');
    expect(languageForPath('D:/g/ERB/口上/1_x/a.xml')).toBe(KOJO_XML_LANGUAGE_ID);
    const descriptor = languageDescriptors().find((d) => d.id === KOJO_XML_LANGUAGE_ID);
    expect(descriptor).toBeTruthy();
    // 声明了 languageServices 就会被挂上 ERB/kojo 那 11 枚 provider（空结果顶掉内建行为）
    expect(descriptor?.languageServices).toBeUndefined();
  });

  it('其它扩展名不被 XML 抢走（.ERB / .kojo 各自归位）', () => {
    expect(languageForPath('a.ERB')).not.toBe(KOJO_XML_LANGUAGE_ID);
    expect(languageForPath('a.kojo')).not.toBe(KOJO_XML_LANGUAGE_ID);
    expect(languageForPath('a.txt')).not.toBe(KOJO_XML_LANGUAGE_ID);
  });
});

describe('attrsOnLine', () => {
  it('解析属性名/值/区间，值内引号不含端点', () => {
    const line = '  <command com="300" name="会話" kojoPlace="TOP">';
    const attrs = attrsOnLine(line);
    expect(attrs.map((a) => a.name)).toEqual(['com', 'name', 'kojoPlace']);
    expect(attrs[1]!.value).toBe('会話');
    expect(line.slice(attrs[0]!.valueStart, attrs[0]!.valueEnd)).toBe('300');
    expect(line.slice(attrs[0]!.nameStart, attrs[0]!.nameEnd)).toBe('com');
  });

  it('单引号值也认；没有属性的行返回空数组', () => {
    expect(attrsOnLine("<kojo place='TOP'>")[0]!.value).toBe('TOP');
    expect(attrsOnLine('</command>')).toEqual([]);
  });
});

describe('computeXmlFoldingRanges', () => {
  it('按标签配对折叠，跨行才出区间', () => {
    const lines = [
      '<data>', // 1
      '  <command com="1">', // 2
      '    <contents>x</contents>', // 3
      '  </command>', // 4
      '</data>', // 5
    ];
    expect(computeXmlFoldingRanges(lines)).toEqual([
      { start: 2, end: 4 },
      { start: 1, end: 5 },
    ]);
  });

  it('自闭合标签不产生折叠；未闭合标签不越界', () => {
    expect(computeXmlFoldingRanges(['<data>', '<command com="1"/>', '</data>'])).toEqual([
      { start: 1, end: 3 },
    ]);
    expect(computeXmlFoldingRanges(['<data>', '<command>'])).toEqual([]);
  });
});

describe('computeXmlCommandSymbols', () => {
  it('每条 command 一条符号：标签 = com · name，detail 带位置与优先级', () => {
    const lines = [
      '<data>',
      '  <command com="300" name="会話" kojoPlace="TOP" priority="2">',
      '  <command com="ANY" name="凌辱汎用">',
      '  <command_ com="9">',
      '</data>',
    ];
    const symbols = computeXmlCommandSymbols(lines);
    expect(symbols.length).toBe(2);
    expect(symbols[0]!.label).toBe('300 · 会話');
    expect(symbols[0]!.detail).toBe('TOP / 优先级 2');
    expect(symbols[0]!.line).toBe(2);
  });
});

describe('checkKojoXmlText —— 只报可证明的问题', () => {
  it('没有规格 → 零诊断（不猜）', () => {
    expect(checkKojoXmlText(['<command com="1" foo="x">'], null)).toEqual([]);
  });

  it('未知属性报 warning，并给出最像的候选', () => {
    const problems = checkKojoXmlText(['<command com="1" ikojoPlace="TOP">'], SCHEMA);
    expect(problems.length).toBe(1);
    expect(problems[0]!.code).toBe('kojo-xml.attr.unknown');
    expect(problems[0]!.message).toContain('kojoPlace');
  });

  it('封闭枚举越界报 warning；大小写不敏感（TRUE/true/True 都算对）', () => {
    const bad = checkKojoXmlText(['<command com="1" isMob="Yes">'], SCHEMA);
    expect(bad.length).toBe(1);
    expect(bad[0]!.code).toBe('kojo-xml.attr.value');
    expect(checkKojoXmlText(['<command com="1" isMob="true">'], SCHEMA)).toEqual([]);
    expect(checkKojoXmlText(['<command com="1" isMob="True">'], SCHEMA)).toEqual([]);
  });

  it('开放枚举（isFall）不判越界：取值域会随游戏版本长', () => {
    expect(checkKojoXmlText(['<command com="1" isFall="恋人">'], SCHEMA)).toEqual([]);
  });

  it('多值按逗号切开逐项判（含 ! 取反前缀）', () => {
    expect(checkKojoXmlText(['<command com="1" kojoPlace="TOP,BOTTOM">'], SCHEMA)).toEqual([]);
    expect(checkKojoXmlText(['<command com="1" kojoPlace="!TOP">'], SCHEMA)).toEqual([]);
    const bad = checkKojoXmlText(['<command com="1" kojoPlace="TOP,SIDE">'], SCHEMA);
    expect(bad.length).toBe(1);
  });

  it('同 com/位置/优先级重复 → warning 指向首次出现的行', () => {
    const problems = checkKojoXmlText(
      [
        '<command com="300" kojoPlace="TOP" priority="1">',
        '<command com="300" kojoPlace="TOP" priority="1">',
        '<command com="300" kojoPlace="TOP" priority="2">',
      ],
      SCHEMA,
    );
    expect(problems.length).toBe(1);
    expect(problems[0]!.code).toBe('kojo-xml.command.duplicate-priority');
    expect(problems[0]!.message).toContain('第 1 行');
  });

  it('空正文给 info（不是 warning：空台词可能是刻意占位）', () => {
    const problems = checkKojoXmlText(['<command com="1"><contents></contents></command>'], SCHEMA);
    expect(problems.map((p) => p.code)).toEqual(['kojo-xml.contents.empty']);
    expect(problems[0]!.severity).toBe('info');
  });

  it('非 command 元素上的属性一律不查（<parts>/<color> 的属性不在口上属性表里）', () => {
    expect(checkKojoXmlText(['<parts layer="1" offsetX="2">'], SCHEMA)).toEqual([]);
    expect(checkKojoXmlText(['<color matrixName="x" r="1" g="2" b="3">'], SCHEMA)).toEqual([]);
  });
});

describe('规格来源注入', () => {
  it('注入后 currentKojoXmlSchema 取到；撤回后为 null；来源抛错按 null 处理', () => {
    setKojoXmlSchemaSource(() => SCHEMA);
    expect(currentKojoXmlSchema()).toBe(SCHEMA);
    setKojoXmlSchemaSource(() => {
      throw new Error('boom');
    });
    expect(currentKojoXmlSchema()).toBeNull();
    setKojoXmlSchemaSource(null);
    expect(currentKojoXmlSchema()).toBeNull();
  });
});

describe('真盘误报率（守卫：D:/Game/erafl 存在才跑）', () => {
  const KOJO_ROOT = 'D:/Game/erafl/ERB/口上';
  const hasCorpus = existsSync(KOJO_ROOT);

  it.skipIf(!hasCorpus)('293 份跑完：未知属性 ≤ 30 条、枚举越界 ≤ 30 条（都是真盘拼写错误量级）', () => {
    // 用 adapter 的真实规格表（跨包 import 在测试里允许：只读纯数据）
    const paths: string[] = [];
    const walk = (dir: string): void => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const full = nodeJoin(dir, ent.name);
        if (ent.isDirectory()) walk(full);
        else if (/\.xml$/i.test(ent.name)) paths.push(full);
      }
    };
    walk(KOJO_ROOT);
    expect(paths.length).toBe(293);

    let unknown = 0;
    let value = 0;
    for (const p of paths) {
      const bytes = readFileSync(p);
      const text =
        bytes[0] === 0xff && bytes[1] === 0xfe
          ? bytes.subarray(2).toString('utf16le')
          : bytes.toString('utf8').replace(/^\uFEFF/, '');
      const problems = checkKojoXmlText(text.split(/\r\n|\n|\r/), buildKojoXmlSchema());
      for (const problem of problems) {
        if (problem.code === 'kojo-xml.attr.unknown') unknown++;
        if (problem.code === 'kojo-xml.attr.value') value++;
      }
    }
    // 真盘实测（2026-10-24）：未知属性 4 条（`ikojoPlace` / `sExclusive` / `ust` / `date`），
    // 枚举越界 20 条（全是 `isExclusive="Ture"` 15 + `"ture"` 5 —— 作者手滑的拼写，
    // 引擎按"非 TRUE"处理 ⇒ 这些条目其实**没有**独占，是真实的静默缺陷）。
    // 判据留到 30 是为了容忍语料更新，同时守住"不许把合法写法当错"：若哪天暴涨到几百，
    // 说明判据开始查 <parts>/<color> 那一层或把开放枚举当封闭集了。
    expect(unknown).toBeLessThanOrEqual(30);
    expect(value).toBeLessThanOrEqual(30);
  });
});
