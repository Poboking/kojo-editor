/**
 * 反向引用索引（H2 批）单测：引用面口径的**自证**。
 *
 * 纯函数面（scanFileRefs / buildReferenceIndex / referencesOf）逐条钉边界；
 * 装配面用本文件自带夹具（不动 plugin.test.ts / language-service.test.ts 的共享上下文体，
 * 避免并行批次撞同一文件）：冷建二次读、热复用零读、快照 refs 往返后查询逐位一致。
 */
import { describe, expect, it } from 'vitest';
import type { ErbIndex, ErbParserService, FileIO, Plugin, PluginContext, Unsubscribe } from '@kojo/plugin-api';
import { createErbParserPlugin } from '../src/plugin';
import { buildReferenceIndex, referencesOf, scanFileRefs, type FileRefs } from '../src/references';
import { makeComputeStub } from './support';

const dict = (names: readonly string[]) => {
  const set = new Set(names.map((n) => n.toUpperCase()));
  return (upper: string) => set.has(upper);
};

describe('scanFileRefs · 引用面口径', () => {
  it('定义 / 同文件调用 / 跨行提及：种类与 1 基行列', () => {
    const text = '@ALPHA(ARG)\nPRINT ALPHA(1)\n  CALL ALPHA(2)\n';
    const refs = scanFileRefs(text, dict(['ALPHA']));
    expect(refs).toEqual([
      ['ALPHA', 1, 2, 0], // definition：`@` 后名字首字符的列
      ['ALPHA', 2, 7, 2], // mention（表达式调用位）
      ['ALPHA', 3, 8, 1], // call：CALL 关键字后的名字槽位
    ]);
  });

  it('重名两处定义都进表（byName 判据不裁决哪一个是"对的"）', () => {
    const refs = scanFileRefs('@FOO\n@FOO\nCALL FOO\n', dict(['FOO']));
    expect(refs).toEqual([
      ['FOO', 1, 2, 0],
      ['FOO', 2, 2, 0],
      ['FOO', 3, 6, 1],
    ]);
  });

  it('大小写不敏感：`call alpha` 命中 ALPHA，键归一为大写', () => {
    expect(scanFileRefs('call alpha\n', dict(['ALPHA']))).toEqual([['ALPHA', 1, 6, 1]]);
  });

  it('注释不算引用：整行 `;` 与行内 `;` 尾巴都不扫（改名不重写散文，口径自证）', () => {
    const text = '; 这是 ALPHA 的说明\nPRINT 1 ; ALPHA 在注释里\nALPHA := ALPHA(1) ; ALPHA 尾巴\n';
    const refs = scanFileRefs(text, dict(['ALPHA']));
    expect(refs).toEqual([
      ['ALPHA', 3, 1, 2],
      ['ALPHA', 3, 10, 2],
    ]);
  });

  it('字符串内容不算引用；引号外的 `;` 才切注释（PRINT "a;b" 不误伤）', () => {
    const text = 'PRINT "ALPHA"\nPRINT "say; ALPHA" FOO\n';
    expect(scanFileRefs(text, dict(['ALPHA', 'FOO']))).toEqual([['FOO', 2, 20, 2]]);
  });

  it('未闭合引号：到行尾一律刷白（引擎本就编译不过，安全方向）', () => {
    expect(scanFileRefs('PRINT "ALPHA rest\n', dict(['ALPHA']))).toEqual([]);
  });

  it('[SKIPSTART]…[SKIPEND] 死代码段不扫（与 scanControlFlow 同一屏蔽面）', () => {
    const text = 'CALL ALPHA\n[SKIPSTART]\nCALL ALPHA\n[SKIPEND]\nCALL ALPHA\n';
    expect(scanFileRefs(text, dict(['ALPHA'])).map((r) => r[1])).toEqual([1, 5]);
  });

  it('#DIM 声明行与 $ 标签行不算函数引用（那是变量与标签的 namespace）', () => {
    expect(scanFileRefs('#DIM ALPHA[10]\n$ALPHA\nALPHA = 1\n', dict(['ALPHA']))).toEqual([['ALPHA', 3, 1, 2]]);
  });

  it('定义行只认名字记号：形参表与行内注释都不扫', () => {
    const text = '@ALPHA(ALPHA) ; ALPHA 是注释\n';
    expect(scanFileRefs(text, dict(['ALPHA']))).toEqual([['ALPHA', 1, 2, 0]]);
  });

  it('整串匹配：前缀/后缀/下划线粘连都不算（XALPHA≠ALPHA）', () => {
    const text = 'XALPHA ALPHAX ALPHA2 _ALPHA\nMY_ALPHA\n';
    expect(scanFileRefs(text, dict(['ALPHA', 'MY_ALPHA']))).toEqual([['MY_ALPHA', 2, 1, 2]]);
  });

  it('CALL 槽位只消耗一次：`CALL A B` 里 A 是 call、B 是 mention', () => {
    const refs = scanFileRefs('CALL ALPHA BETA\n', dict(['ALPHA', 'BETA']));
    expect(refs).toEqual([
      ['ALPHA', 1, 6, 1],
      ['BETA', 1, 12, 2],
    ]);
  });

  it('调用族全表 + SIF 前缀让槽位退化为 mention', () => {
    const cases = ['CALL F', 'TRYCALL F', 'TRYCCALL F', 'TRYCALLLIST F', 'TRYCCALLLIST F'];
    for (const line of cases) {
      expect(scanFileRefs(`${line} F\n`, dict(['F']))[0]?.[3], line).toBe(1);
    }
    // SIF 不是调用族：F 落 mention；`JUMP 123` 的目标是行号，不产出引用
    expect(scanFileRefs('SIF F > 1\n', dict(['F']))[0]?.[3]).toBe(2);
    expect(scanFileRefs('JUMP 123\n', dict(['F']))).toEqual([]);
  });

  it('行尾空白不破坏 CALL 槽位（keywordEnd 用行首缩进算，与 trailing trim 无关）', () => {
    expect(scanFileRefs('\t\tCALL ALPHA   \n', dict(['ALPHA']))).toEqual([['ALPHA', 1, 8, 1]]);
  });

  it('空文本 / 空词典 ⇒ 空流水', () => {
    expect(scanFileRefs('', dict(['A']))).toEqual([]);
    expect(scanFileRefs('@A\nCALL A\n', dict([]))).toEqual([]);
  });

  it('CJK 函数名：定义与调用都算（真语料 99,118 条定义里 20,805 条含 CJK，字符集必须 Unicode）', () => {
    const text = '@M_KOJO_無個性_TEST\nCALL M_KOJO_無個性_TEST\n';
    expect(scanFileRefs(text, dict(['M_KOJO_無個性_TEST']))).toEqual([
      ['M_KOJO_無個性_TEST', 1, 2, 0],
      ['M_KOJO_無個性_TEST', 2, 6, 1],
    ]);
  });

  it('变量成员访问整体不算：`:` / `：` 任一侧紧邻都不算提及', () => {
    const text = 'IF CFLAG:ALPHA == 1\nALPHA:CFLAG\nPRINT ：ALPHA\n';
    expect(scanFileRefs(text, dict(['ALPHA']))).toEqual([]);
  });

  it('定义名按解析器终止符口径截（`(` / 空白 / `;`）：含 `.` 的名字整体是定义', () => {
    expect(scanFileRefs('@A.B(X) ; 尾注\n', dict(['A.B']))).toEqual([['A.B', 1, 2, 0]]);
  });

  it('定义名截后 trim 与列修正（真语料 4 条 `@` 名带全角空白的对齐口径）', () => {
    expect(scanFileRefs('@　FOO\n', dict(['FOO']))).toEqual([['FOO', 1, 3, 0]]);
  });

  it('CALL 名字槽被成员访问占据时不向后顺延（`CALL FLAG:ALPHA` 零产出）', () => {
    expect(scanFileRefs('CALL FLAG:ALPHA\n', dict(['ALPHA', 'FLAG']))).toEqual([]);
  });
});

describe('buildReferenceIndex / referencesOf · 聚合与查询', () => {
  const f = (path: string): import('@kojo/plugin-api').ErbFile => ({
    path,
    functions: [],
    dims: [],
    hasFunctionDirective: false,
    lineCount: 10,
  });

  it('按文件迭代序（= walk 序）→ 行 → 列确定排序；跨文件合并同名', () => {
    const refsByPath = new Map<string, FileRefs>([
      ['/b.ERB', [['FOO', 2, 3, 1]]],
      ['/a.ERB', [['FOO', 9, 1, 2], ['BAR', 1, 2, 0]]],
    ]);
    const idx = buildReferenceIndex([f('/a.ERB'), f('/b.ERB')], refsByPath);
    expect(idx.bySymbol.get('FOO')).toEqual([
      { filePath: '/a.ERB', line: 9, column: 1, endColumn: 4, kind: 'mention' },
      { filePath: '/b.ERB', line: 2, column: 3, endColumn: 6, kind: 'call' },
    ]);
    expect(idx.bySymbol.get('BAR')).toEqual([
      { filePath: '/a.ERB', line: 1, column: 2, endColumn: 5, kind: 'definition' },
    ]);
  });

  it('endColumn = column + 归一化名长度；查询返回引用表本体', () => {
    const idx = buildReferenceIndex([f('/a.ERB')], new Map([['/a.ERB', [['LONG_NAME', 4, 7, 2]] as FileRefs]]));
    const refs = referencesOf({ files: new Map(), byName: new Map(), references: idx } as ErbIndex, 'long_name');
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ line: 4, column: 7, endColumn: 16, kind: 'mention' });
  });

  it('空索引 / 无引用名 ⇒ 空数组（不是 undefined，消费方零分支）', () => {
    const empty = buildReferenceIndex([], new Map());
    const index = { files: new Map(), byName: new Map(), references: empty } as ErbIndex;
    expect(empty.bySymbol.size).toBe(0);
    expect(referencesOf(index, 'ANY')).toEqual([]);
    expect(referencesOf({ files: new Map(), byName: new Map() } as ErbIndex, 'ANY')).toEqual([]);
  });
});

/* ---------------------------------------------------------------------------
 * 装配面：冷建（二次读）→ 快照落盘 → 热复用（零额外读、查询逐位一致）
 * ------------------------------------------------------------------------- */

const A = '/t/A.ERB';
const B = '/t/B.ERB';
const FILES: Record<string, string> = {
  [A]: '@ALPHA(ARG)\nRETURN 1\n',
  [B]: '@CALLER\n\tCALL ALPHA(1)\n\t; ALPHA 注释里不算\n',
};
const MTIME = 1000;

function fakeIO(counters: { readText: number }): FileIO {
  type TF = { path: string; text: string; encoding: 'utf-8'; eol: 'lf'; mtimeMs: number };
  /** 会话文本缓存（镜像内核 io.readTexts 的判据：mtime+size 全等才命中） */
  const textCache = new Map<string, TF>();
  const readOne = (path: string): TF => {
    const text = FILES[path];
    if (text === undefined) throw new Error(`not found: ${path}`);
    counters.readText++;
    return { path, text, encoding: 'utf-8', eol: 'lf', mtimeMs: MTIME };
  };
  return {
    async readText(path: string) {
      return readOne(path); // 单文件路径不接缓存（与内核一致）
    },
    async readTexts(paths: readonly string[]) {
      return paths.map((path) => {
        const text = FILES[path];
        if (text === undefined) return null;
        const cached = textCache.get(path);
        if (cached && cached.mtimeMs === MTIME && cached.text.length === text.length) return cached;
        const tf = readOne(path);
        textCache.set(path, tf);
        return tf;
      });
    },
    async stat(path: string) {
      const text = FILES[path];
      return text === undefined ? null : { size: text.length, mtimeMs: MTIME, isDirectory: false };
    },
    async walkDir(root: string) {
      return Object.keys(FILES)
        .filter((p) => p.startsWith(root))
        .map((p) => ({ name: p.split('/').pop() ?? p, path: p, isDirectory: false, mtimeMs: MTIME, size: FILES[p]!.length }));
    },
  } as unknown as FileIO;
}

/** 极小上下文体：bus 可 emit、storage 是内存 Map（快照落盘/读回都经它） */
function harness(): {
  services: Map<string, unknown>;
  emit: (ev: string, payload: unknown) => void;
  store: Map<string, string>;
  reads: { readText: number };
} {
  const services = new Map<string, unknown>();
  const store = new Map<string, string>();
  const handlers = new Map<string, (p: never) => void>();
  const reads = { readText: 0 };
  const noop = (): void => undefined;
  const ctx = {
    pluginId: 'erb-parser',
    log: { debug: noop, info: noop, warn: noop, error: noop },
    bus: {
      on: (t: string, h: (p: never) => void) => {
        handlers.set(t, h);
        return noop as Unsubscribe;
      },
      once: (() => noop) as unknown as (t: string, h: (p: unknown) => void) => Unsubscribe,
      emit: noop,
    },
    inject: <T,>(key: string): T => {
      if (key === 'kernel.io') return fakeIO(reads) as unknown as T;
      if (key === 'kernel.compute') return makeComputeStub() as unknown as T;
      throw new Error(`unexpected inject: ${key}`);
    },
    provide: (key: string, value: unknown) => services.set(key, value),
    storage: {
      get: async (k: string) => (store.has(k) ? JSON.parse(store.get(k)!) : undefined),
      set: async (k: string, v: unknown) => void store.set(k, JSON.stringify(v)),
      delete: async (k: string) => void store.delete(k),
      keys: async () => [...store.keys()],
    },
    slots: { register: () => noop, query: () => [] },
    onDispose: noop,
  } as unknown as PluginContext;
  (createErbParserPlugin() as Plugin).activate(ctx);
  return {
    services,
    emit: (ev, payload) => handlers.get(ev)?.(payload as never),
    store,
    reads,
  };
}

async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

describe('erb-parser · 反向索引装配（冷建/热复用/快照往返）', () => {
  it('service.buildIndex 产出 references：定义 2 + 调用 1，注释里那条不算', async () => {
    const { services } = harness();
    const parser = services.get('erb.parser') as ErbParserService;
    const index = await parser.buildIndex(['/t']);
    expect(index.references).toBeDefined();
    expect(index.references!.bySymbol.get('ALPHA')).toEqual([
      { filePath: A, line: 1, column: 2, endColumn: 7, kind: 'definition' },
      { filePath: B, line: 2, column: 7, endColumn: 12, kind: 'call' },
    ]);
    expect(index.references!.bySymbol.get('CALLER')).toEqual([
      { filePath: B, line: 1, column: 2, endColumn: 8, kind: 'definition' },
    ]);
  });

  it('冷建每文件正文只读一遍（批量）；引用重扫命中会话缓存，热复用零额外读且查询逐位一致', async () => {
    const h = harness();
    h.emit('project.opened', { project: { rootDir: '/t', kojoPaths: ['/t'] } });
    const parser = h.services.get('erb.parser') as ErbParserService;
    const cold = await parser.ensureIndex();
    const coldRefs = JSON.stringify([...cold.references!.bySymbol.entries()]);
    // 2 文件：解析段每文件一遍（批量 readTexts）；引用重扫走会话缓存（mtime+size 未变 ⇒ 零读盘）
    expect(h.reads.readText).toBe(2);
    expect(parser.referencesTo!('caller')).toHaveLength(1);
    await settle(); // 等快照异步落盘
    expect(h.store.size).toBeGreaterThan(0);

    h.emit('project.closed', undefined);
    h.emit('project.opened', { project: { rootDir: '/t', kojoPaths: ['/t'] } });
    const hot = await parser.ensureIndex();
    const hotRefs = JSON.stringify([...hot.references!.bySymbol.entries()]);
    expect(hotRefs).toBe(coldRefs);
    // 热段：解析与引用都走快照 ⇒ readText 增量 0
    expect(h.reads.readText).toBe(2);
    expect(parser.referencesTo!('ALPHA').map((r) => r.kind)).toEqual(['definition', 'call']);
  });

  it('未建索引时 referencesTo ⇒ 空数组（不猜、不读盘）', () => {
    const { services } = harness();
    const parser = services.get('erb.parser') as ErbParserService;
    expect(parser.referencesTo!('ALPHA')).toEqual([]);
  });
});
