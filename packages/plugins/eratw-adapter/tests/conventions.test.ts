import { describe, expect, it } from 'vitest';
import type {
  CharaInfo,
  ConventionCheckContext,
  ErbFile,
  ErbFunctionRef,
  ErbIndex,
  Logger,
} from '@kojo/plugin-api';
import { parseErbText } from '@kojo/plugin-erb-parser';
import {
  formTripleSymbolRule,
  kojoCompletenessRule,
  kxPlaceholderRule,
  messageCheckStructureRule,
} from '../src/conventions';

const silentLog: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function makeIndex(files: Record<string, string>): ErbIndex {
  const map = new Map<string, ErbFile>();
  const byName = new Map<string, ErbFunctionRef[]>();
  for (const [path, text] of Object.entries(files)) {
    const f = parseErbText(text, path);
    map.set(path, f);
    for (const fn of f.functions) {
      const refs = byName.get(fn.normalizedName) ?? [];
      refs.push({
        name: fn.name,
        normalizedName: fn.normalizedName,
        filePath: fn.filePath,
        startLine: fn.startLine,
        endLine: fn.endLine,
      });
      byName.set(fn.normalizedName, refs);
    }
  }
  return { files: map, byName };
}

function ctxFor(
  index: ErbIndex,
  files: Record<string, string>,
  chara: CharaInfo[] = [],
  kojoDirByNo: Record<number, string> = {},
): ConventionCheckContext {
  const charaIndex = new Map<number, CharaInfo>();
  for (const c of chara) charaIndex.set(c.no, { ...c, kojoDir: kojoDirByNo[c.no] ?? c.kojoDir });
  return {
    project: {
      rootDir: '/p',
      adapterId: 'eratw',
      kojoPaths: ['/p/kojo'],
      writablePaths: [],
      charaIndex,
    },
    index,
    readFile: async (path: string) => {
      const t = files[path];
      if (t === undefined) throw new Error(`not found: ${path}`);
      return t;
    },
    log: silentLog,
  };
}

describe('eratw 约定规则', () => {
  describe('kx-placeholder（KX 占位符残留）', () => {
    it('按归一化函数名去重：同名多处只报一条', async () => {
      const index = makeIndex({
        '/p/a.ERB': '@M_KOJO_MESSAGE_COM_KX_1\nPRINTL x\n',
        '/p/b.ERB': '@M_KOJO_MESSAGE_COM_KX_1\nPRINTL y\n@M_KOJO_COLOR_KX\nRETURN\n',
      });
      const ctx = ctxFor(index, {});
      const issues = (await kxPlaceholderRule.check!(ctx)) as { message: string; severity: string }[];
      expect(issues).toHaveLength(2); // MESSAGE_COM_KX_1（2 处合并）+ COLOR_KX
      expect(issues.every((i) => i.severity === 'warning')).toBe(true);
      expect(issues.some((i) => i.message.includes('共 2 处'))).toBe(true);
    });

    it('正常函数不误报', async () => {
      const index = makeIndex({ '/p/a.ERB': '@M_KOJO_MESSAGE_COM_K1_1\nPRINTL x\n' });
      expect(await kxPlaceholderRule.check!(ctxFor(index, {}))).toEqual([]);
    });
  });

  describe('kojo-completeness（家族声明 + 标配四件套）', () => {
    const chara: CharaInfo[] = [{ no: 1, name: '灵梦' }];

    it('缺 FLAGSETTING → warning；缺 COLOR/ENCOUNTER/EXTRASOURCE → info', async () => {
      const index = makeIndex({
        '/p/kojo/001/init.ERB': '@M_KOJO_K1\nRESULTS = "灵梦"\n@M_KOJO_MESSAGE_COM_K1_1\nPRINTL x\n',
      });
      const ctx = ctxFor(index, {}, chara, { 1: '/p/kojo/001' });
      const issues = (await kojoCompletenessRule.check!(ctx)) as { severity: string; key: string }[];
      const byKey = new Map(issues.map((i) => [i.key, i.severity]));
      expect(byKey.get('eratw.kojo-completeness|FLAGSETTING|1')).toBe('warning');
      expect(byKey.get('eratw.kojo-completeness|COLOR|1')).toBe('info');
      expect(byKey.get('eratw.kojo-completeness|ENCOUNTER|1')).toBe('info');
      expect(byKey.get('eratw.kojo-completeness|EXTRASOURCE|1')).toBe('info');
      expect(byKey.has('eratw.kojo-completeness|declare|1')).toBe(false); // 有 declare
    });

    it('缺少家族声明函数 → warning', async () => {
      const index = makeIndex({ '/p/kojo/001/com.ERB': '@M_KOJO_MESSAGE_COM_K1_1\nPRINTL x\n' });
      const ctx = ctxFor(index, {}, chara, { 1: '/p/kojo/001' });
      const issues = (await kojoCompletenessRule.check!(ctx)) as { key: string }[];
      expect(issues.map((i) => i.key)).toContain('eratw.kojo-completeness|declare|1');
    });

    it('四件套齐备 → 无问题', async () => {
      const index = makeIndex({
        '/p/kojo/001/all.ERB':
          '@M_KOJO_K1\nRESULTS = "灵梦"\n' +
          '@M_KOJO_FLAGSETTING_K1\nRETURN\n' +
          '@M_KOJO_COLOR_K1\nRETURN 0\n' +
          '@M_KOJO_ENCOUNTER_K1\nRETURN\n' +
          '@M_KOJO_EXTRASOURCE_K1\nRETURN\n',
      });
      const ctx = ctxFor(index, {}, chara, { 1: '/p/kojo/001' });
      expect(await kojoCompletenessRule.check!(ctx)).toEqual([]);
    });

    it('口上目录内无任何可识别函数 → 跳过（非完整性问题）', async () => {
      const index = makeIndex({ '/p/kojo/001/x.ERB': '@HELPER\nRETURN\n' });
      const ctx = ctxFor(index, {}, chara, { 1: '/p/kojo/001' });
      expect(await kojoCompletenessRule.check!(ctx)).toEqual([]);
    });
  });

  describe('form-triple-symbol（PRINTFORM 三连符号）', () => {
    it('PRINTFORM 串里的三连符号报 warning；注释行与普通 PRINTL 不报', async () => {
      const text =
        '@M_KOJO_MESSAGE_COM_K1_1\n' +
        '; PRINTFORML "==="\n' +
        'PRINTFORML "===分隔==="\n' +
        'PRINTL "/// 无 FORM 处理 ///"\n';
      const files = { '/p/a.ERB': text };
      const index = makeIndex(files);
      const issues = (await formTripleSymbolRule.check!(ctxFor(index, files))) as {
        line: number;
        message: string;
        severity: string;
      }[];
      expect(issues).toHaveLength(1);
      expect(issues[0]!.line).toBe(3);
      expect(issues[0]!.message).toContain('===');
      expect(issues[0]!.message).toContain('CALLNAME:PLAYER');
      expect(issues[0]!.severity).toBe('warning');
    });

    it('每文件每符号聚合为一条（含出现次数与首次行号）', async () => {
      const text =
        '@M_KOJO_MESSAGE_COM_K1_1\n' +
        'PRINTFORML "a///b"\n' +
        'PRINTFORMDL "c///d///e"\n';
      const files = { '/p/a.ERB': text };
      const index = makeIndex(files);
      const issues = (await formTripleSymbolRule.check!(ctxFor(index, files))) as {
        line: number;
        message: string;
      }[];
      expect(issues).toHaveLength(1);
      expect(issues[0]!.line).toBe(2);
      expect(issues[0]!.message).toContain('3 处');
    });

    it('`+++`（有意的主人名占位）不报', async () => {
      const files = { '/p/a.ERB': '@M_KOJO_MESSAGE_COM_K1_1\nPRINTFORMDW +++轻轻吻了她\n' };
      const index = makeIndex(files);
      expect(await formTripleSymbolRule.check!(ctxFor(index, files))).toEqual([]);
    });
  });

  describe('messagecheck-structure（MESSAGECHECK 位协议）', () => {
    it('位掩码 0..3 合法；越界 warning；无 RETURN info', async () => {
      const text =
        '@M_KOJO_MESSAGE_COM_MESSAGECHECK_K1_1\n' +
        '#LOCALSIZE 1\n' +
        'RETURN 5\n' +
        '@M_KOJO_MESSAGE_COM_MESSAGECHECK_K1_2\n' +
        'RETURN 2\n' +
        '@M_KOJO_MESSAGE_COM_MESSAGECHECK_K1_3\n' +
        'PRINTL x\n';
      const files = { '/p/a.ERB': text };
      const index = makeIndex(files);
      const issues = (await messageCheckStructureRule.check!(ctxFor(index, files))) as {
        severity: string;
        line: number;
        message: string;
      }[];
      const warn = issues.filter((i) => i.severity === 'warning');
      const info = issues.filter((i) => i.severity === 'info');
      expect(warn).toHaveLength(1);
      expect(warn[0]!.message).toContain('RETURN 5');
      expect(info).toHaveLength(1);
      expect(info[0]!.message).toContain('没有 RETURN');
    });
  });
});
