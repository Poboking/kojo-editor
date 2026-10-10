import { describe, expect, it } from 'vitest';
import type { FileIO, Logger } from '@kojo/plugin-api';
import { loadEratwVariableSchema, parseVariableCsv } from '../src/variable-schema';

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
        const entries = Object.keys(files).map((name) => ({
          name,
          path: `/game/CSV/${name}`,
          isDirectory: false,
        }));
        entries.push({ name: 'Chara', path: '/game/CSV/Chara', isDirectory: true });
        return entries;
      },
      readText: async (path: string) => ({ text: files[path.replace('/game/CSV/', '')] ?? '', path }),
    } as unknown as FileIO;
  }

  it('扫描目录、按文件名大写建表、lookup 双向可用', async () => {
    const schema = await loadEratwVariableSchema({
      io: fakeIo({
        'CFLAG.csv': '2,好感度\n4,信頼度\n',
        'Talent.csv': '3,恋慕\n',
      }),
      csvDir: '/game/CSV',
      log: silentLog,
    });

    expect(schema.lookup('CFLAG', 2)).toEqual({ name: 'CFLAG', index: 2, description: '好感度' });
    expect(schema.lookup('cflag', '2')).toEqual({ name: 'CFLAG', index: '2', description: '好感度' });
    expect(schema.lookup('TALENT', '恋慕')).toEqual({ name: 'TALENT', index: '恋慕', description: '恋慕' });
    expect(schema.lookup('CFLAG')).toEqual({ name: 'CFLAG' });
    expect(schema.lookup('CFLAG', 999)).toEqual({ name: 'CFLAG', index: 999 });
    expect(schema.lookup('NOPE', 1)).toBeUndefined();
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
});
