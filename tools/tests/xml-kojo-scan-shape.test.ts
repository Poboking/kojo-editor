/**
 * **XML 口上体检的读数形状守门**（2026-10-24）。
 *
 * `tools/xml-kojo-scan.mjs` 是给人看的体检工具，它的价值全在「读数可信」：
 * 份数少算一份 → 以为覆盖全了；编码分布错 → 以为 UTF-16 那批不存在；
 * 坏样本不计诊断 → 适配器上线才发现整份台词被丢。所以这里不测排版，
 * 只把样本盘上的**数字**钉死：4 份 / 15 条 / 1 份坏 / 1 份编码声明不符。
 *
 * 为什么样本要四种形态各一份：真实盘同时存在现行 `<data>`、旧 `<kojodef>`、
 * UTF-16LE+BOM 却声明 utf-8、以及结构坏掉的文件；少一种，对应的容错分支就没人守。
 * 另外两条钉口味判定：样本盘是 `flavor-x`（FLconfig.xml + ERB/口上 都在），
 * 仓库原有的 eraTW 迷你盘必须是 `default`（不能因为加了口味就把旧形态误判走）。
 *
 * 全部纯读 `fixtures/xml-kojo/`，不碰真实语料。
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { detectFlavor } from '../corpus.mjs';
import { scanXmlKojo } from '../xml-kojo-scan.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const FIXTURE = path.join(ROOT, 'fixtures', 'xml-kojo');
const REPORT = scanXmlKojo(FIXTURE);

/** 按目录名取样本读数（路径分隔符随平台，故用 includes）。 */
const sample = (dir: string) => {
  const hit = REPORT.files.find((f) => f.file.includes(dir));
  if (!hit) throw new Error(`样本缺失: ${dir}`);
  return hit;
};

describe('xml-kojo 体检 ① 份数与条目数', () => {
  it('样本盘共 4 份 XML、15 条 <command>（四形态各一份，条目 6+4+3+2）', () => {
    expect(REPORT.kojoDir).not.toBeNull();
    expect(REPORT.fileCount).toBe(4);
    expect(REPORT.entryCount).toBe(15);
  });

  it('旧式 <kojo> 台词单独计 5 行（不能拿它冒充条目数）', () => {
    expect(REPORT.kojoCount).toBe(5);
  });
});

describe('xml-kojo 体检 ② 编码分布', () => {
  it('编码按 BOM 归口：UTF-8 BOM 1 / UTF-8 2 / UTF-16LE BOM 1 / 其余 0', () => {
    expect(REPORT.encodings).toEqual({
      'utf-8-bom': 1,
      'utf-8': 2,
      'utf-16le': 1,
      'utf-16be': 0,
      other: 0,
    });
  });

  it('UTF-16LE+BOM 样本：字节说 utf-16le、声明说 utf-8，读数两者都留', () => {
    const f = sample('9003_十六位编码');
    expect(f.encoding).toBe('utf-16le');
    expect(f.declared).toBe('utf-8');
  });

  it('UTF-16LE 样本仍读出 3 条条目（BOM 优先于声明，不许归零）', () => {
    const f = sample('9003_十六位编码');
    expect(f.parsed).toBe(true);
    expect(f.entries).toBe(3);
    expect(f.root).toBe('data');
  });
});

describe('xml-kojo 体检 ③ 解析诊断分布', () => {
  it('诊断分布：正常 2 / 编码声明不符 1 / 结构错误 1 / 空 0 / 非口上根 0', () => {
    expect(REPORT.diagnoses).toEqual({
      ok: 2,
      'enc-mismatch': 1,
      'bad-structure': 1,
      empty: 0,
      'foreign-root': 0,
    });
  });

  it('坏样本恰好 1 份，且诊断指向未闭合的 <contents>', () => {
    const bad = REPORT.files.filter((f) => f.diagnosis === 'bad-structure');
    expect(bad).toHaveLength(1);
    expect(bad[0].file).toContain('9004_坏样本');
    expect(bad[0].detail).toContain('contents');
  });

  it('坏样本的结构虽坏，条目读数仍为 2（读数不因坏样本归零）', () => {
    const f = sample('9004_坏样本');
    expect(f.parsed).toBe(false);
    expect(f.entries).toBe(2);
  });

  it('编码声明不符只有 1 份，且不是坏样本（两类问题分开记）', () => {
    const mismatch = REPORT.files.filter((f) => f.diagnosis === 'enc-mismatch');
    expect(mismatch).toHaveLength(1);
    expect(mismatch[0].file).toContain('9003_十六位编码');
  });
});

describe('xml-kojo 体检 ④ 新旧格式与属性覆盖', () => {
  it('旧式样本根是 <kojodef>、4 条 command、5 行 kojo', () => {
    const f = sample('9002_旧式格式');
    expect(f.root).toBe('kojodef');
    expect(f.entries).toBe(4);
    expect(f.kojoLines).toBe(5);
  });

  it('现行格式样本 eval / isFall / emotion 三属性各至少出现 1 次', () => {
    const f = sample('9001_现行格式');
    expect(f.root).toBe('data');
    expect(f.entries).toBe(6);
    expect(f.attrs.eval ?? 0).toBeGreaterThanOrEqual(1);
    expect(f.attrs.isFall ?? 0).toBeGreaterThanOrEqual(1);
    expect(f.attrs.emotion ?? 0).toBeGreaterThanOrEqual(1);
  });

  it('每角色条目数按降序：首名 9001 共 6 条，末名 9004 共 2 条', () => {
    expect(REPORT.perChara).toHaveLength(4);
    expect(REPORT.perChara[0]).toMatchObject({ name: '9001_现行格式', entries: 6 });
    expect(REPORT.perChara[3]).toMatchObject({ name: '9004_坏样本', entries: 2 });
  });
});

describe('xml-kojo 口味判定', () => {
  it('样本盘（FLconfig.xml + ERB/口上）判为 flavor-x', () => {
    expect(detectFlavor(FIXTURE)).toBe('flavor-x');
  });

  it('仓库原有 eraTW 迷你盘没有 FLconfig.xml / 口上，仍判 default', () => {
    expect(detectFlavor(path.join(ROOT, 'fixtures', 'mini-game'))).toBe('default');
  });

  it('不存在的目录回落 default 且不抛（口味只是读数，不该让调用方处理异常）', () => {
    expect(() => detectFlavor(path.join(ROOT, 'fixtures', 'no-such-dir-9f3a'))).not.toThrow();
    expect(detectFlavor(path.join(ROOT, 'fixtures', 'no-such-dir-9f3a'))).toBe('default');
  });
});
