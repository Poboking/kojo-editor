import { describe, expect, it } from 'vitest';
import type { FileIO, Logger } from '@kojo/plugin-api';
import { loadEratwVariableSchema, parseChsMap, parseVariableCsv } from '../src/variable-schema';

describe('parseVariableCsv', () => {
  it('基础解析：编号,名称', () => {
    const t = parseVariableCsv(['1,既成事実', '2,好感度', '4,信頼度'].join('\n'));
    expect(t.byIndex.get('2')).toBe('好感度');
    expect(t.byName.get('信頼度')).toBe('4');
  });

  it('注释行 / 空行 / 非数字行跳过', () => {
    const t = parseVariableCsv([';标题注释', '', '  ;缩进注释', '2,好感度', 'abc,非法', ',无名'].join('\n'));
    expect(t.byIndex.size).toBe(1);
    expect(t.byIndex.get('2')).toBe('好感度');
  });

  it('第三列注释不进入名称', () => {
    const t = parseVariableCsv('3,恋慕,;愛情に似た感情を抱いている状態。=2で上位互換');
    expect(t.byIndex.get('3')).toBe('恋慕');
  });

  it('tab 缩进的续行注释跳过（Talent.csv 真实形态）', () => {
    const text = ['10,胆量,', '\t; -1=膽怯,;ABL:従順が上げやすい', '11,態度,'].join('\n');
    const t = parseVariableCsv(text);
    expect(t.byIndex.get('10')).toBe('胆量');
    expect(t.byIndex.get('11')).toBe('態度');
    expect(t.byIndex.size).toBe(2);
  });

  it('同编号/名称首个定义优先', () => {
    const t = parseVariableCsv(['2,好感度', '2,重复'].join('\n'));
    expect(t.byIndex.get('2')).toBe('好感度');
  });
});

describe('parseChsMap', () => {
  it('解析 <p><k><v> 词典；空键跳过、同名取首条、容忍 BOM', () => {
    const m = parseChsMap(
      '\uFEFF<map><p><k>好感度</k><v>好感度</v></p><p><k></k><v>x</v></p>' +
        '<p><k>信頼度</k><v>信赖度</v></p><p><k>信頼度</k><v>重复</v></p></map>',
    );
    expect(m.get('信頼度')).toBe('信赖度');
    expect(m.get('好感度')).toBe('好感度');
    expect(m.size).toBe(2);
  });

  it('无 <p><k><v> 形态 → 空 Map（不抛）', () => {
    expect(parseChsMap('<map></map>').size).toBe(0);
  });
});

describe('loadEratwVariableSchema', () => {
  const silentLog: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };

  function fakeIo(files: Record<string, string>): FileIO {
    return {
      listDir: async (dir: string) => {
        void dir;
        const entries = Object.keys(files)
          .filter((name) => !name.includes('/'))
          .map((name) => ({
            name,
            path: `/game/CSV/${name}`,
            isDirectory: false,
          }));
        entries.push({ name: 'Chara', path: '/game/CSV/Chara', isDirectory: true });
        return entries;
      },
      readText: async (path: string) => ({
        text: files[path] ?? files[path.replace('/game/CSV/', '')] ?? '',
        path,
      }),
    } as unknown as FileIO;
  }

  it('扫描目录、按文件名大写建表、lookup 双向可用', async () => {    const schema = await loadEratwVariableSchema({
      io: fakeIo({
        'CFLAG.csv': '2,好感度\n4,信頼度\n',
        'Talent.csv': '3,恋慕\n',
      }),
      csvDir: '/game/CSV',
      log: silentLog,
    });

    expect(schema.lookup('CFLAG', 2)).toEqual({ name: 'CFLAG', index: 2, description: '好感度', resolvedIndex: 2 });
    expect(schema.lookup('cflag', '2')).toEqual({ name: 'CFLAG', index: '2', description: '好感度', resolvedIndex: 2 });
    expect(schema.lookup('TALENT', '恋慕')).toEqual({ name: 'TALENT', index: '恋慕', description: '恋慕', resolvedIndex: 3 });
    // 家族级（无索引）：游戏无机读族名表 → 取适配器内置策展常量
    expect(schema.lookup('CFLAG')).toEqual({ name: 'CFLAG', description: '角色标志' });
    expect(schema.lookup('CFLAG', 999)).toEqual({ name: 'CFLAG', index: 999 });
    expect(schema.lookup('NOPE', 1)).toBeUndefined();
  });

  it('汉化词典叠加：索引级名称 JP→CN（查不到回落原文）', async () => {
    const schema = await loadEratwVariableSchema({
      io: fakeIo({
        'CFLAG.csv': '2,好感度\n4,信頼度\n',
        '/game/plugins/tw_csv_chs.xml':
          '<map><p><k>信頼度</k><v>信赖度</v></p><p><k>恋慕</k><v>恋慕</v></p></map>',
      }),
      csvDir: '/game/CSV',
      chsMapPath: '/game/plugins/tw_csv_chs.xml',
      log: silentLog,
    });
    // 词典命中 → 中文
    expect(schema.lookup('CFLAG', 4)).toEqual({ name: 'CFLAG', index: 4, description: '信赖度', resolvedIndex: 4 });
    // 词典未收录 → 回落名称表原文
    expect(schema.lookup('CFLAG', 2)?.description).toBe('好感度');
  });

  it('目录不可读时返回空字典（不抛错）', async () => {
    const badIo = {
      listDir: async () => {
        throw new Error('boom');
      },
      readText: async () => ({ text: '' }),
    } as unknown as FileIO;
    const schema = await loadEratwVariableSchema({ io: badIo, csvDir: '/game/CSV', log: silentLog });
    expect(schema.lookup('CFLAG', 2)).toBeUndefined();
  });

  it('inputDigest：同输入稳定、改描述即变、与目录顺序无关', async () => {
    // 抽取结果里存着 schema 给的语义标签；变量字典由 CSV 驱动 ⇒ 判据必须含它，
    // 否则改了 `CFLAG.csv` 一行描述，派生缓存还会吐旧标签。
    const load = (files: Record<string, string>) =>
      loadEratwVariableSchema({ io: fakeIo(files), csvDir: '/game/CSV', log: silentLog });
    const set = { 'CFLAG.csv': '2,好感度\n', 'Talent.csv': '3,恋慕\n' };

    const a = await load(set);
    const b = await load({ 'Talent.csv': set['Talent.csv']!, 'CFLAG.csv': set['CFLAG.csv']! });
    const changed = await load({ 'CFLAG.csv': '2,心情\n', 'Talent.csv': '3,恋慕\n' });
    const extra = await load({ 'CFLAG.csv': set['CFLAG.csv']!, 'Talent.csv': '3,恋慕\n', 'Abl.csv': '1,身体\n' });

    expect(typeof a.inputDigest).toBe('string');
    expect(a.inputDigest).toBe(b.inputDigest);
    expect(changed.inputDigest).not.toBe(a.inputDigest);
    expect(extra.inputDigest).not.toBe(a.inputDigest);
    // 一张都读不到时也是确定值（区别于 undefined = "没有判据"）
    const none = await load({});
    expect(typeof none.inputDigest).toBe('string');
    expect(none.inputDigest).not.toBe(a.inputDigest);
  });
});
