/**
 * eraFL 口上约定规则测试。
 *
 * 形态照 `eraakumamaid-adapter/tests/conventions.test.ts`：内存 FileIO 桩（签名照
 * `plugin-api/src/io.ts` 原文）+ `parseErbText` 造索引 + 逐条规则断言。
 *
 * 两条本包独有的裁决，各有用例守着：
 * - **注册点按全树 `.xml` 字面量算**（真盘 `PORTRAIT_K28.xml` 由
 *   `LOAD_UNIQUE_XML_PORTRAIT("…")` 注册，只认 `XML_PATH` 常量会误报）；
 * - **`FROM_SPLIT_FILES` 的整目录豁免**（真盘 `99_戦闘メッセージ` 按目录批量注册）。
 *
 * 真盘用例以 `D:/Game/erafl` 存在为守卫，断言的是本机实测读数（2 / 0 / 30 / 0 / 9）。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join as nodeJoin } from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  ConventionCheckContext,
  ConventionIssue,
  DirEntry,
  ErbFile,
  ErbFunctionRef,
  ErbIndex,
  Logger,
} from '@kojo/plugin-api';
import { parseErbText } from '@kojo/plugin-erb-parser';
import { createEraflConventions, type EraflConventionDeps } from '../src/conventions';

const GAME_ROOT = 'D:/Game/erafl';
const ROOT = '/p';

const silentLog: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/* ============================ 内存桩 ============================ */

/** 文件内容：文本（UTF-8 编码后当作字节）或现成字节（UTF-16 那几条用例用） */
type FileSpec = string | Uint8Array;

interface StubOpts {
  /** 这些路径读失败（`readBytes` 抛错） */
  failBytes?: readonly string[];
}

function memDeps(files: Record<string, FileSpec>, opts: StubOpts = {}): EraflConventionDeps {
  const paths = Object.keys(files);
  const dirs = new Set<string>();
  for (const p of paths) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  const directChildren = (dir: string): DirEntry[] => {
    const prefix = `${dir}/`;
    const found = new Map<string, boolean>();
    for (const d of dirs) {
      if (!d.startsWith(prefix)) continue;
      const rest = d.slice(prefix.length);
      if (rest.length > 0 && !rest.includes('/')) found.set(rest, true);
    }
    for (const f of paths) {
      if (!f.startsWith(prefix)) continue;
      const rest = f.slice(prefix.length);
      if (rest.length > 0 && !rest.includes('/')) found.set(rest, false);
    }
    return [...found].map(([name, isDirectory]) => ({ name, path: `${prefix}${name}`, isDirectory }));
  };
  return {
    exists: async (p: string) => files[p] !== undefined || dirs.has(p),
    listDir: async (dir: string) => {
      if (!dirs.has(dir)) throw new Error(`没有这个目录：${dir}`);
      return directChildren(dir);
    },
    readBytes: async (p: string) => {
      if (opts.failBytes?.includes(p) === true) throw new Error(`模拟读盘失败：${p}`);
      const spec = files[p];
      if (spec === undefined) throw new Error(`没有这个文件：${p}`);
      return typeof spec === 'string' ? new TextEncoder().encode(spec) : spec;
    },
  };
}

/** 索引：只把 `.ERB` / `.ERH` 交给解析器（XML 不进索引，与真实现一致） */
function makeIndex(files: Record<string, FileSpec>): ErbIndex {
  const map = new Map<string, ErbFile>();
  const byName = new Map<string, ErbFunctionRef[]>();
  for (const [path, spec] of Object.entries(files)) {
    if (!/\.(erb|erh)$/i.test(path)) continue;
    if (typeof spec !== 'string') continue;
    const parsed = parseErbText(spec.replace(/^\uFEFF/, ''), path);
    map.set(path, parsed);
    for (const fn of parsed.functions) {
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
  files: Record<string, FileSpec>,
  opts: StubOpts & { failReads?: readonly string[] } = {},
): ConventionCheckContext {
  const index = makeIndex(files);
  return {
    project: {
      rootDir: ROOT,
      adapterId: 'erafl',
      kojoPaths: [`${ROOT}/ERB`],
      writablePaths: [`${ROOT}/ERB/口上`],
      charaIndex: new Map(),
    },
    index,
    readFile: async (path: string) => {
      if (opts.failReads?.includes(path) === true) throw new Error(`模拟读盘失败：${path}`);
      const spec = files[path];
      if (spec === undefined) throw new Error(`没有这个文件：${path}`);
      return typeof spec === 'string' ? spec.replace(/^\uFEFF/, '') : '';
    },
    log: silentLog,
  };
}

/** 跑一条规则（deps 与 ctx 分别给：用例要能换桩） */
async function run(
  id: string,
  files: Record<string, FileSpec>,
  opts: StubOpts & { failReads?: readonly string[] } = {},
): Promise<ConventionIssue[]> {
  const deps = memDeps(files, opts);
  const rule = createEraflConventions(deps).find((r) => r.id === id)!;
  return rule.check!(ctxFor(files, opts));
}

/* ============================ 夹具 ============================ */

/** 最小 define 壳（形态照真盘 `KOJO_DEFINE_K1099.ERB`） */
function defineErb(no: number, xmlRel: string, extra: readonly string[] = []): string {
  return [
    ';-------------------------------------------------',
    `@KOJO_DEFINE_K${no}`,
    `#DIMS CONST XML_PATH_COM = "${xmlRel}"`,
    `#DIM CONST 汎用口上番号 = ${no}`,
    '',
    'CALL KOJO_XML_REGISTER(XML_PATH_COM, 汎用口上番号, XMLID_KOJO_CLASS_COM)',
    'RETURN 1',
    ...extra,
  ].join('\r\n');
}

const NAME_LINE = (no: number, label: string) =>
  [';口上選択画面の表示名', `@KOJO_DEFINE_NAME_K${no}`, `RESULTS '= "${label}"`, 'RETURN 1'].join('\r\n');

/** 带 UTF-16LE BOM 的字节（`FF FE` + 每字符两字节） */
function utf16leBytes(text: string): Uint8Array {
  const out = new Uint8Array(2 + text.length * 2);
  out[0] = 0xff;
  out[1] = 0xfe;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    out[2 + i * 2] = code & 0xff;
    out[3 + i * 2] = code >> 8;
  }
  return out;
}

const XML_HEAD = '<?xml version="1.0" encoding="utf-8"?>\r\n<data>\r\n</data>';

/* ============================ 规则 1：孤儿 XML ============================ */

describe('erafl.kojo-xml.unregistered（没有任何注册点的 XML）', () => {
  it('被 XML_PATH_COM 指向的 XML 不报；没有任何字面量指向的报 1 条 warning', async () => {
    const files = {
      [`${ROOT}/ERB/口上/7_测试/KOJO_DEFINE_K7.ERB`]: defineErb(7, 'ERB/口上/7_测试/a.xml'),
      [`${ROOT}/ERB/口上/7_测试/a.xml`]: XML_HEAD,
      [`${ROOT}/ERB/口上/7_测试/orphan.xml`]: XML_HEAD,
    };
    const issues = await run('erafl.kojo-xml.unregistered', files);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('warning');
    expect(issues[0]!.filePath).toBe(`${ROOT}/ERB/口上/7_测试/orphan.xml`);
    expect(issues[0]!.characterNo).toBe(7);
    expect(issues[0]!.message).toContain('没有任何注册点');
  });

  it('FROM_SPLIT_FILES 的整目录豁免：目录下 2 份 XML（含子目录）一条都不报', async () => {
    const split = [
      '@KOJO_DEFINE_K99',
      '#DIMS CONST XML_PATH_COMBAT = "ERB/口上/99_戦闘メッセージ"',
      '#DIMS CONST XML_PATTERN_COMBAT = "KOJO_K99_COMBAT*"',
      '#DIM CONST 汎用口上番号 = 99',
      '',
      'CALL KOJO_XML_REGISTER_FROM_SPLIT_FILES(XML_PATH_COMBAT, XML_PATTERN_COMBAT, "data", 汎用口上番号, XMLID_KOJO_CLASS_COMBAT)',
      'RETURN 1',
    ].join('\r\n');
    const files = {
      [`${ROOT}/ERB/口上/99_戦闘メッセージ/KOJO_DEFINE_K99.ERB`]: split,
      [`${ROOT}/ERB/口上/99_戦闘メッセージ/KOJO_K99_COMBAT1.xml`]: XML_HEAD,
      [`${ROOT}/ERB/口上/99_戦闘メッセージ/別名/KOJO_K99_COMBAT2.xml`]: XML_HEAD,
    };
    expect(await run('erafl.kojo-xml.unregistered', files)).toHaveLength(0);
  });

  it('非 XML_PATH 的字面量也算注册点：LOAD_UNIQUE_XML_PORTRAIT 指向的立绘 XML 不报（真盘 28 号形态）', async () => {
    const files = {
      [`${ROOT}/ERB/口上/28_X/KOJO_DEFINE_K28.ERB`]: defineErb(28, 'ERB/口上/28_X/KOJO_K28_COM.xml'),
      [`${ROOT}/ERB/口上/28_X/KOJO_K28_COM.xml`]: XML_HEAD,
      // 立绘 XML 的注册点写在另一个文件里，且是字面路径实参（真盘 KOJO_FUNCTION_K28.ERB:403）
      [`${ROOT}/ERB/口上/28_X/KOJO_FUNCTION_K28.ERB`]:
        'CALL LOAD_UNIQUE_XML_PORTRAIT("ERB/口上/28_X/PORTRAIT_K28.xml", CHARA_ID, 1)',
      [`${ROOT}/ERB/口上/28_X/PORTRAIT_K28.xml`]: XML_HEAD,
    };
    expect(await run('erafl.kojo-xml.unregistered', files)).toHaveLength(0);
  });
});

/* ============================ 规则 2：XML 缺失 ============================ */

describe('erafl.kojo-xml.missing-file（XML_PATH 常量指向的文件不存在）', () => {
  it('指向不存在的 gone.xml：1 条 error，行号落在常量行（第 3 行）', async () => {
    const files = {
      [`${ROOT}/ERB/口上/7_测试/KOJO_DEFINE_K7.ERB`]: defineErb(7, 'ERB/口上/7_测试/gone.xml'),
    };
    const issues = await run('erafl.kojo-xml.missing-file', files);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('error');
    expect(issues[0]!.line).toBe(3);
    expect(issues[0]!.message).toContain('gone.xml');
    expect(issues[0]!.message).toContain('THROW');
  });

  it('目标存在、以及目录形态（FROM_SPLIT_FILES 的 DIR）都不报：0 条', async () => {
    const files = {
      [`${ROOT}/ERB/口上/7_测试/KOJO_DEFINE_K7.ERB`]: defineErb(7, 'ERB/口上/7_测试/a.xml'),
      [`${ROOT}/ERB/口上/7_测试/a.xml`]: XML_HEAD,
      [`${ROOT}/ERB/口上/99_戦闘メッセージ/KOJO_DEFINE_K99.ERB`]: [
        '@KOJO_DEFINE_K99',
        '#DIMS CONST XML_PATH_COMBAT = "ERB/口上/99_戦闘メッセージ"',
        '#DIM CONST 汎用口上番号 = 99',
        'CALL KOJO_XML_REGISTER_FROM_SPLIT_FILES(XML_PATH_COMBAT, "KOJO_K99_COMBAT*", "data", 汎用口上番号, XMLID_KOJO_CLASS_COMBAT)',
        'RETURN 1',
      ].join('\r\n'),
      [`${ROOT}/ERB/口上/99_戦闘メッセージ/KOJO_K99_COMBAT1.xml`]: XML_HEAD,
    };
    expect(await run('erafl.kojo-xml.missing-file', files)).toHaveLength(0);
  });
});

/* ============================ 规则 3：缺 NAME ============================ */

describe('erafl.kojo-define.missing-name（有 define 没有 KOJO_DEFINE_NAME）', () => {
  it('K7 缺 NAME 报 1 条；K8 的 NAME 写在另一个文件里也算有（共 1 条）', async () => {
    const files = {
      [`${ROOT}/ERB/口上/7_测试/KOJO_DEFINE_K7.ERB`]: defineErb(7, 'ERB/口上/7_测试/a.xml'),
      [`${ROOT}/ERB/口上/8_测试/KOJO_DEFINE_K8.ERB`]: defineErb(8, 'ERB/口上/8_测试/a.xml'),
      [`${ROOT}/ERB/口上/8_测试/KOJO_INFO_K8.ERB`]: NAME_LINE(8, '八号'),
    };
    const issues = await run('erafl.kojo-define.missing-name', files);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('warning');
    expect(issues[0]!.characterNo).toBe(7);
    expect(issues[0]!.message).toContain('KOJO_DEFINE_NAME_K7');
  });

  it('函数名大小写不敏感：@kojo_define_name_k8 也算（Emuera 不分大小写）', async () => {
    const files = {
      [`${ROOT}/ERB/口上/8_测试/KOJO_DEFINE_K8.ERB`]: defineErb(8, 'ERB/口上/8_测试/a.xml'),
      [`${ROOT}/ERB/口上/8_测试/name.ERB`]: '@kojo_define_name_k8\r\nRESULTS \'= "八号"\r\nRETURN 1',
    };
    expect(await run('erafl.kojo-define.missing-name', files)).toHaveLength(0);
  });
});

/* ============================ 规则 4：编号重复 ============================ */

describe('erafl.kojo-define.duplicate-number（两个文件定义同一编号）', () => {
  it('两个文件都定义 K7：1 条 error，消息里两处路径都在', async () => {
    const files = {
      [`${ROOT}/ERB/口上/7_甲/KOJO_DEFINE_K7.ERB`]: defineErb(7, 'ERB/口上/7_甲/a.xml'),
      [`${ROOT}/ERB/口上/7_乙/KOJO_DEFINE_K7.ERB`]: defineErb(7, 'ERB/口上/7_乙/a.xml'),
    };
    const issues = await run('erafl.kojo-define.duplicate-number', files);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('error');
    expect(issues[0]!.message).toContain('7_甲/KOJO_DEFINE_K7.ERB');
    expect(issues[0]!.message).toContain('7_乙/KOJO_DEFINE_K7.ERB');
    expect(issues[0]!.message).toContain('2 个文件');
  });

  it('同一文件里重复定义同名函数不算「两个文件」：0 条', async () => {
    const files = {
      [`${ROOT}/ERB/口上/7_甲/KOJO_DEFINE_K7.ERB`]: `${defineErb(7, 'ERB/口上/7_甲/a.xml')}\r\n${defineErb(7, 'ERB/口上/7_甲/a.xml')}`,
    };
    expect(await run('erafl.kojo-define.duplicate-number', files)).toHaveLength(0);
  });
});

/* ============================ 规则 5：编码不一致 ============================ */

describe('erafl.kojo-xml.encoding-mismatch（声明 utf-8 但字节是 UTF-16 BOM）', () => {
  it('UTF-16LE BOM + 声明 utf-8：1 条 warning', async () => {
    const files = {
      [`${ROOT}/ERB/口上/7_测试/a.xml`]: utf16leBytes(XML_HEAD),
    };
    const issues = await run('erafl.kojo-xml.encoding-mismatch', files);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('warning');
    expect(issues[0]!.message).toContain('UTF-16LE');
    expect(issues[0]!.message).toContain('encoding="utf-8"');
  });

  it('UTF-8 BOM 声明 utf-8、UTF-16LE 声明 utf-16：都不报（0 条）', async () => {
    const utf8Bom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(XML_HEAD)]);
    const files = {
      [`${ROOT}/ERB/口上/7_测试/ok-utf8.xml`]: utf8Bom,
      [`${ROOT}/ERB/口上/7_测试/ok-utf16.xml`]: utf16leBytes(
        '<?xml version="1.0" encoding="utf-16"?>\r\n<data>\r\n</data>',
      ),
    };
    expect(await run('erafl.kojo-xml.encoding-mismatch', files)).toHaveLength(0);
  });
});

/* ============================ 失败必须可见 ============================ */

describe('解析失败进 failedRules（绝不静默跳过）', () => {
  it('一份 define 壳读不出来：5 条规则全部记入 failedRules，且不产出任何结论', async () => {
    const broken = `${ROOT}/ERB/口上/7_测试/KOJO_DEFINE_K7.ERB`;
    const files = {
      [broken]: defineErb(7, 'ERB/口上/7_测试/a.xml'),
      [`${ROOT}/ERB/口上/7_测试/a.xml`]: XML_HEAD,
    };
    const deps = memDeps(files);
    const rules = createEraflConventions(deps);
    const ctx = ctxFor(files, { failReads: [broken] });

    const issues: ConventionIssue[] = [];
    const failedRules: Array<{ ruleId: string; error: string }> = [];
    for (const rule of rules) {
      try {
        issues.push(...(await rule.check!(ctx)));
      } catch (err) {
        failedRules.push({ ruleId: rule.id, error: String(err) });
      }
    }

    expect(rules).toHaveLength(5);
    expect(failedRules).toHaveLength(5);
    expect(failedRules.map((f) => f.ruleId).sort()).toEqual([
      'erafl.kojo-define.duplicate-number',
      'erafl.kojo-define.missing-name',
      'erafl.kojo-xml.encoding-mismatch',
      'erafl.kojo-xml.missing-file',
      'erafl.kojo-xml.unregistered',
    ]);
    expect(failedRules[0]!.error).toContain(broken);
    expect(issues).toHaveLength(0);
  });
});

/* ============================ 真实语料 ============================ */

const hasCorpus = existsSync(GAME_ROOT);

/** node:fs 支撑的 deps（只读；本用例不写盘） */
function realDeps(): EraflConventionDeps {
  return {
    exists: async (p: string) => existsSync(p),
    listDir: async (p: string) =>
      readdirSync(p, { withFileTypes: true }).map((d) => ({
        name: d.name,
        path: nodeJoin(p, d.name),
        isDirectory: d.isDirectory(),
      })),
    readBytes: async (p: string) => new Uint8Array(readFileSync(p)),
  };
}

function walkErb(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = nodeJoin(dir, d.name);
    if (d.isDirectory()) return walkErb(p);
    return /\.(erb|erh)$/i.test(d.name) ? [p] : [];
  });
}

describe.skipIf(!hasCorpus)('真实语料读数（D:/Game/erafl）', () => {
  /** 真盘索引：全树 ERB 都进 `files`（路径清单要全），函数只解析 define 壳（省掉 2k 份正文解析） */
  function realContext(): ConventionCheckContext {
    const erbPaths = walkErb(nodeJoin(GAME_ROOT, 'ERB'));
    const map = new Map<string, ErbFile>();
    const byName = new Map<string, ErbFunctionRef[]>();
    for (const path of erbPaths) {
      const stub: ErbFile = { path, functions: [], dims: [], hasFunctionDirective: false, lineCount: 0 };
      map.set(path, stub);
      if (!/KOJO_DEFINE_K\d+\.ERB$/i.test(path)) continue;
      const parsed = parseErbText(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''), path);
      map.set(path, parsed);
      for (const fn of parsed.functions) {
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
    return {
      project: {
        rootDir: GAME_ROOT,
        adapterId: 'erafl',
        kojoPaths: [nodeJoin(GAME_ROOT, 'ERB')],
        writablePaths: [nodeJoin(GAME_ROOT, 'ERB', '口上')],
        charaIndex: new Map(),
      },
      index: { files: map, byName },
      readFile: async (path: string) => readFileSync(path, 'utf8').replace(/^\uFEFF/, ''),
      log: silentLog,
    };
  }

  it('五条规则真盘读数：孤儿 2 / 缺文件 0 / 缺名 30 / 重号 0 / 编码 9', async () => {
    const deps = realDeps();
    const rules = createEraflConventions(deps);
    const ctx = realContext();
    const byId = new Map<string, ConventionIssue[]>();
    for (const rule of rules) byId.set(rule.id, await rule.check!(ctx));

    const unregistered = byId.get('erafl.kojo-xml.unregistered')!;
    expect(unregistered).toHaveLength(2);
    expect(unregistered.map((i) => i.message).join('\n')).toContain(
      '1146_汎用_負け癖/嫌がるオプション/kojo_k1146_com.xml',
    );
    expect(unregistered.map((i) => i.message).join('\n')).toContain('31_爱丽丝/kojo_k31_event.xml');

    expect(byId.get('erafl.kojo-xml.missing-file')).toHaveLength(0);
    expect(byId.get('erafl.kojo-define.missing-name')).toHaveLength(30);
    expect(byId.get('erafl.kojo-define.duplicate-number')).toHaveLength(0);
    expect(byId.get('erafl.kojo-xml.encoding-mismatch')).toHaveLength(9);
  }, 180000);
});
