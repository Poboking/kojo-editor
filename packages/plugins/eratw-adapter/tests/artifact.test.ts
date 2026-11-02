/**
 * 制品计划单测（导出批）。
 *
 * 重点不在"改扩展名"这种一看就对的部分，而在三条**会不会静默丢东西**的边界：
 * 命名冲突、转译失败必须整体拒绝、非 `.kojo1` 一个字节都不能被改动。
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DirEntry, FileIO, SugarCompiledBytes } from '@kojo/plugin-api';
import { KOJO_SOURCE_EXTENSION } from '@kojo/plugin-api';
import {
  isKojo2Source,
  isKojoSource,
  KOJO2_NOTICE_MAX_PATHS,
  kojo2UntranspiledNotice,
  listKojo2Sources,
  planArtifacts,
  toRelPath,
  type ArtifactSource,
  type KojoCompiler,
} from '@kojo/kojo-project-kit';

const enc = new TextEncoder();
const src = (relPath: string, text: string): ArtifactSource => ({ relPath, bytes: enc.encode(text) });

/** 替身编译器：把源文本原样加个前缀当产物，便于断言"哪个文件走了转译" */
const fakeCompile: KojoCompiler = (source, label) => ({
  bytes: enc.encode(`; compiled from ${label}\n${source}`),
  transpile: { erb: `; compiled from ${label}\n${source}`, sourceMap: [], diagnostics: [] },
}) satisfies SugarCompiledBytes;

const byName = (plan: { entries: { relPath: string; bytes: Uint8Array }[] }, name: string): string | undefined => {
  const hit = plan.entries.find((e) => e.relPath === name);
  return hit ? new TextDecoder().decode(hit.bytes) : undefined;
};

describe('toRelPath / isKojoSource', () => {
  it('反斜杠归一为正斜杠并去首部斜杠', () => {
    expect(toRelPath('\\a\\b\\c.kojo1')).toBe('a/b/c.kojo1');
    expect(toRelPath('/x.ERB')).toBe('x.ERB');
  });
  it('扩展名大小写不敏感', () => {
    expect(isKojoSource('事件.KOJO1')).toBe(true);
    expect(isKojoSource('事件.kojo1')).toBe(true);
    expect(isKojoSource('事件.ERB')).toBe(false);
    expect(isKojoSource('kojo.说明.txt')).toBe(false);
  });
});

describe('planArtifacts', () => {
  it('.kojo1 落成同名 .ERB，并计入 transpiled', () => {
    const plan = planArtifacts([src('事件.kojo1', '如果 A：\n')], fakeCompile);
    expect(plan.entries.map((e) => e.relPath)).toEqual(['事件.ERB']);
    expect(plan.transpiled).toBe(1);
    expect(plan.passthrough).toBe(0);
    expect(byName(plan, '事件.ERB')).toContain('如果 A：');
  });

  it('制品里绝不残留 .kojo1（引擎读不到，留着就是骗作者）', () => {
    const plan = planArtifacts(
      [src('事件.kojo1', 'x'), src('日常指令.KOJO1', 'y'), src('README.md', 'z')],
      fakeCompile,
    );
    expect(plan.entries.some((e) => /\.kojo1$/i.test(e.relPath))).toBe(false);
  });

  it('非 .kojo1 字节级原样携带（一个字节都不许动）', () => {
    const raw = enc.encode('改过编码就毁了\r\n第二行');
    const plan = planArtifacts([{ relPath: '说明.txt', bytes: raw }], fakeCompile);
    expect(plan.entries[0]!.bytes).toBe(raw); // 同一个数组引用，连复制都没发生
    expect(plan.passthrough).toBe(1);
    expect(plan.transpiled).toBe(0);
  });

  it('子目录结构保留，且用 / 分隔', () => {
    const plan = planArtifacts([src('辅助\\表\\数据.kojo1', 'x'), src('a/b/c.txt', 'y')], fakeCompile);
    expect(plan.entries.map((e) => e.relPath).sort()).toEqual(['a/b/c.txt', '辅助/表/数据.ERB']);
  });

  it('作者手写的 .ERB 与 .kojo1 混包：各归各位，不互相覆盖', () => {
    const plan = planArtifacts([src('事件.ERB', '原生'), src('日常.ERB', '原生2')], fakeCompile);
    expect(plan.entries.map((e) => e.relPath).sort()).toEqual(['事件.ERB', '日常.ERB']);
    expect(plan.passthrough).toBe(2);
  });

  it('真正落成同一产物名的两个 .kojo1 仍拒绝，不静默二选一（丢哪个都是事故）', () => {
    expect(() => planArtifacts([src('事件.kojo1', '糖'), src('事件.KOJO1', '糖二版')], fakeCompile)).toThrow(/产物名冲突/);
  });

  it('两个 .kojo1 的大小写变体落成同一产物名 → 仍是命名冲突（Windows 上本就是同一个文件）', () => {
    expect(() => planArtifacts([src('a.Kojo1', 'x'), src('A.kojo1', 'y')], fakeCompile)).toThrow(/产物名冲突/);
  });

  it('转译失败 → 整体拒绝，不产半成品包（半成品比没有更危险）', () => {
    const boom: KojoCompiler = (_s, label) => {
      if (label === '坏.kojo1') throw new Error('第 3 行：缺少 否则');
      return fakeCompile(_s, label);
    };
    expect(() => planArtifacts([src('好.kojo1', 'x'), src('坏.kojo1', 'y')], boom)).toThrow(
      /「坏\.kojo1」转译失败，未生成制品：第 3 行：缺少 否则/,
    );
  });

  it('逃逸包目录的路径直接拒绝', () => {
    expect(() => planArtifacts([src('../逃逸.kojo1', 'x')], fakeCompile)).toThrow(/逃逸包目录/);
  });

  it('空目录清单 → 空计划（不抛）', () => {
    expect(planArtifacts([], fakeCompile)).toEqual({
      entries: [],
      transpiled: 0,
      passthrough: 0,
      ignoredDerived: [],
      // 2026-11-02 KW-1 的新字段：这里从 3 键变 4 键是**收紧**（多一枚键必须如实为空），
      // 不是放宽——原有三键的语义与取值一字未动。
      untranspiledKojo2: [],
    });
  });

  it('带 BOM 的 .kojo1 不把 BOM 当正文喂给转译器', () => {
    let seen = '';
    const spy: KojoCompiler = (s) => {
      seen = s;
      return fakeCompile(s, 'x');
    };
    const withBom = { relPath: '事件.kojo1', bytes: new Uint8Array([0xef, 0xbb, 0xbf, ...enc.encode('如果 A：')]) };
    planArtifacts([withBom], spy);
    expect(seen).toBe('如果 A：');
  });
});

/** 取回抛出的错误消息（要逐项检查消息里指认了谁） */
const msgOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error('预期抛错，但没有抛');
};

describe('跨文件函数名唯一性（制品级 fail-closed，2026-10-16 T4）', () => {
  it('两个不同子目录的 .kojo1 产出同名函数 → 拒绝，并指认双方来源与函数名', () => {
    const a = src('a/事件.kojo1', '@M_KOJO_K12_问候(ARG = 1)\n');
    const b = src('b/问候.kojo1', '@M_KOJO_K12_问候(ARG = 1, ARG:1)\n');
    const msg = msgOf(() => planArtifacts([a, b], fakeCompile));
    expect(msg).toContain('函数名冲突');
    expect(msg).toContain('a/事件.kojo1');
    expect(msg).toContain('b/问候.kojo1');
    expect(msg).toContain('@M_KOJO_K12_问候');
    // 判定是**全包级**：两者在不同目录（不会落成同一产物名）也必须拒绝
    expect(msg).not.toContain('产物名冲突');
  });

  it('.kojo1 产物与包内手写 .ERB 撞名 → 拒绝（不同目录，产物名并不冲突）', () => {
    expect(() =>
      planArtifacts([src('糖/问候.kojo1', '@X\n'), src('原生/问候.ERB', '@X\n')], fakeCompile),
    ).toThrow(/函数名冲突/);
  });

  it('同名但形参不同 → 仍拒绝（引擎按名匹配，不看形参）', () => {
    const msg = msgOf(() =>
      planArtifacts([src('a/事件.kojo1', '@X\n'), src('b/事件.kojo1', '@X(ARG)\n')], fakeCompile),
    );
    expect(msg).toContain('函数名冲突');
    expect(msg).toContain('@X');
  });

  it('仅大小写不同也算同名（语料实证引擎大小写不敏感）', () => {
    expect(() =>
      planArtifacts([src('a/事件.kojo1', '@M_KOJO_问候\n'), src('b/问候.kojo1', '@m_kojo_问候\n')], fakeCompile),
    ).toThrow(/函数名冲突/);
  });

  it('.ERH 头文件里的函数定义同样参与判定', () => {
    expect(() =>
      planArtifacts([src('a/事件.kojo1', '@X\n'), src('b/声明.ERH', '@X\n')], fakeCompile),
    ).toThrow(/函数名冲突/);
  });

  it('不同名 → 正常出计划（不误报）', () => {
    const plan = planArtifacts([src('a/事件.kojo1', '@A\n'), src('b/问候.kojo1', '@B\n')], fakeCompile);
    expect(plan.entries.map((e) => e.relPath).sort()).toEqual(['a/事件.ERB', 'b/问候.ERB']);
    expect(plan.transpiled).toBe(2);
  });

  it('同一个文件内自己重复定义同名函数 → 不报（那是单文件内部的事）', () => {
    const plan = planArtifacts([src('a/事件.kojo1', '@X\n@X(ARG)\n')], fakeCompile);
    expect(plan.transpiled).toBe(1);
  });

  it('只扫会被引擎编译的产物：.txt 里的 @ 不参与判定', () => {
    const plan = planArtifacts([src('a/事件.kojo1', '@X\n'), src('说明.txt', '@X\n')], fakeCompile);
    expect(plan.transpiled).toBe(1);
    expect(plan.passthrough).toBe(1);
  });

  it('走过新扫描后，原样携带的 .ERB 依旧逐字节不变（铁律 2）', () => {
    const raw = enc.encode('; 注释\n@SHARED(ARG)\n改过编码就毁了\r\n');
    const expected = [...raw];
    const plan = planArtifacts([{ relPath: '原生/事件.ERB', bytes: raw }], fakeCompile);
    expect(plan.entries[0]!.bytes).toBe(raw); // 同一个数组引用：连复制都没发生
    expect([...plan.entries[0]!.bytes]).toEqual(expected); // 逐字节复核
  });

  it('#声明行 / $标签 / ;注释放了 @ 也不参与判定', () => {
    const other = src('b/问候.kojo1', ';@X\n#DIM @X\n$@X\n');
    const plan = planArtifacts([src('a/事件.kojo1', '@X\n'), other], fakeCompile);
    expect(plan.transpiled).toBe(2);
  });
});

describe('同名 .ERB = 派生产物（2026-10-18 反馈修复批）', () => {
  /** `.kojo1` 走同一替身编译器后的落盘字节（保存过一次的包目录里就是这样一对） */
  const compiledBytesOf = (rel: string, text: string): Uint8Array => fakeCompile(text, rel).bytes;
  const kojo = src('主口上.kojo1', '如果 A：\n');

  it('与当前编译结果逐字节一致 → 跳过；条目只有编译产物，ignoredDerived 有记录', () => {
    const erb = { relPath: '主口上.ERB', bytes: compiledBytesOf('主口上.kojo1', '如果 A：\n') };
    const plan = planArtifacts([kojo, erb], fakeCompile);
    expect(plan.entries.map((e) => e.relPath)).toEqual(['主口上.ERB']);
    expect(plan.transpiled).toBe(1);
    expect(plan.passthrough).toBe(0);
    expect(plan.ignoredDerived).toEqual([{ relPath: '主口上.ERB', sourceRel: '主口上.kojo1' }]);
  });

  it('枚举顺序无关：.ERB 先于 .kojo1 出现也照样判定为派生产物', () => {
    const erb = { relPath: '主口上.ERB', bytes: compiledBytesOf('主口上.kojo1', '如果 A：\n') };
    const plan = planArtifacts([erb, kojo], fakeCompile);
    expect(plan.entries.map((e) => e.relPath)).toEqual(['主口上.ERB']);
    expect(plan.passthrough).toBe(0);
    expect(plan.ignoredDerived).toHaveLength(1);
  });

  it('仅 BOM / CRLF 差异、规范化文本一致 → 同样跳过，并标注编码差异', () => {
    const text = new TextDecoder().decode(compiledBytesOf('主口上.kojo1', '如果 A：\n'));
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...enc.encode(text.replaceAll('\n', '\r\n'))]);
    const plan = planArtifacts([kojo, { relPath: '主口上.ERB', bytes }], fakeCompile);
    expect(plan.passthrough).toBe(0);
    expect(plan.transpiled).toBe(1);
    expect(plan.ignoredDerived).toEqual([
      { relPath: '主口上.ERB', sourceRel: '主口上.kojo1', reason: 'encoding' },
    ]);
  });

  it('末尾换行不同也算文本差异（只容忍 BOM / 换行风格，不容忍缺行）→ 按过期拒绝', () => {
    const text = new TextDecoder().decode(compiledBytesOf('主口上.kojo1', '如果 A：\n'));
    const bytes = enc.encode(text.endsWith('\n') ? text.slice(0, -1) : text);
    expect(() => planArtifacts([kojo, { relPath: '主口上.ERB', bytes }], fakeCompile)).toThrow(/编译产物/);
  });

  it('内容不同（过期 / 被手改）→ fail-closed；消息指认双方文件并给出两条可执行路径', () => {
    const msg = msgOf(() => planArtifacts([kojo, src('主口上.ERB', '; 手改过的旧产物\n')], fakeCompile));
    expect(msg).toContain('主口上.ERB');
    expect(msg).toContain('主口上.kojo1');
    expect(msg).toContain('过期');
    expect(msg).toContain('重新保存');
    expect(msg).toContain('移出包目录');
    // 这是"过期产物"，不是"两个源抢一个名字"——不要把作者引去改名
    expect(msg).not.toContain('产物名冲突');
  });

  it('大小写不同的同名 .ERB（Windows 上同一文件）同样按派生产物判等', () => {
    const erb = { relPath: '主口上.erb', bytes: compiledBytesOf('主口上.kojo1', '如果 A：\n') };
    const plan = planArtifacts([kojo, erb], fakeCompile);
    expect(plan.ignoredDerived).toEqual([{ relPath: '主口上.erb', sourceRel: '主口上.kojo1' }]);
  });

  it('不同目录的同名 .ERB 不是派生产物 → 正常原样携带', () => {
    const plan = planArtifacts([src('a/主口上.kojo1', '如果 A：\n'), src('b/主口上.ERB', '; 原生\n')], fakeCompile);
    expect(plan.entries.map((e) => e.relPath).sort()).toEqual(['a/主口上.ERB', 'b/主口上.ERB']);
    expect(plan.passthrough).toBe(1);
    expect(plan.ignoredDerived).toEqual([]);
  });

  it('只有 .ERB 没有 .kojo1 → 照常 passthrough（字节引用不变）', () => {
    const raw = enc.encode('; 原生手写\n');
    const plan = planArtifacts([{ relPath: '主口上.ERB', bytes: raw }], fakeCompile);
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0]!.bytes).toBe(raw);
    expect(plan.passthrough).toBe(1);
    expect(plan.ignoredDerived).toEqual([]);
  });

  it('.ERH 不当作派生产物（.kojo1 只生成 .ERB）→ 与 .kojo1 并存', () => {
    const plan = planArtifacts([src('主口上.kojo1', '如果 A：\n'), src('主口上.ERH', '#DIM X\n')], fakeCompile);
    expect(plan.entries.map((e) => e.relPath).sort()).toEqual(['主口上.ERB', '主口上.ERH']);
    expect(plan.passthrough).toBe(1);
    expect(plan.ignoredDerived).toEqual([]);
  });
});

/* ==================== 发布诚实闸（KW-1，2026-11-02） ====================
 *
 * `.kojo` 自 2026-10-27 LAU-3b-FLIP 起归 **Kojo 2.0**，而 2.0 的转译腿没接进导出 / 部署。
 * 于是这种包**发得出去、部署得进去，游戏里却什么都不会多出来**——本批不接转译（那是
 * 另一批的大工程），只做一件事：**让它点名**。以下每条都盯着"点名而不改产物"这一寸：
 * 产物字节、`transpiled` / `passthrough` / `ignoredDerived` 三格语义与改前逐字相同，
 * 多出来的只有 `untranspiledKojo2` 这一份可见清单。
 */

describe('isKojo2Source：2.0 主场源判据（只认契约那一枚扩展名）', () => {
  it('认 `.kojo`（大小写不敏感），不认封存档 `.kojo1`、不认原生与文档', () => {
    expect(isKojo2Source('事件.kojo')).toBe(true);
    expect(isKojo2Source('事件.KOJO')).toBe(true);
    expect(isKojo2Source('子/日常.kojo')).toBe(true);
    expect(isKojo2Source('事件.kojo1')).toBe(false);
    expect(isKojo2Source('事件.ERB')).toBe(false);
    expect(isKojo2Source('README.kojo.md')).toBe(false);
  });

  it('判据指回契约单源（本层不抄第二份扩展名 / 正则）', () => {
    // 同一枚常量换了，判据当场跟着变——这条断言就是"没抄字面量"的正面证据
    expect(isKojo2Source(`事件${KOJO_SOURCE_EXTENSION}`)).toBe(true);
    const impl = readFileSync(
      path.resolve(import.meta.dirname, '../../../kojo-project-kit/src/artifact.ts'),
      'utf8',
    );
    const fn = /export function isKojo2Source\(relPath: string\): boolean \{\n\s*return ([^\n]+);/.exec(impl);
    expect(fn, 'isKojo2Source 的实现行（换了形态就得同步改这条）').not.toBeNull();
    expect(fn![1]).toBe('extname(relPath).toLowerCase() === KOJO_SOURCE_EXTENSION');
    // 反潮守卫：全文件不许出现手抄的 `\.kojo` 尾巴正则
    // （`\.kojo1` 那一枚是既有的**封存层**糖源判据，词边界撞不上它，不在本条面上）
    expect(impl).not.toMatch(/\\\.kojo\b/);
  });
});

describe('planArtifacts：2.0 源点名（不改产物，只留名）', () => {
  it('.kojo 仍走字节级原样携带，同时进 untranspiledKojo2（一次都不叫编译器）', () => {
    const raw = new TextEncoder().encode('# 台词\n@M_KOJO_K1_TEST\n');
    const plan = planArtifacts([{ relPath: '事件.kojo', bytes: raw }], () => {
      throw new Error('2.0 源不许被送去转译');
    });
    expect(plan.entries.map((e) => e.relPath)).toEqual(['事件.kojo']);
    expect(plan.entries[0]!.bytes).toBe(raw); // 同一份引用：连复制都没发生（规矩 2）
    expect(plan.passthrough).toBe(1);
    expect(plan.transpiled).toBe(0);
    expect(plan.untranspiledKojo2).toEqual([{ relPath: '事件.kojo' }]);
  });

  it('混包（原生 .ERB + 封存 .kojo1 + 2.0 .kojo）：三档各归各位，只有 2.0 被点名', () => {
    const plan = planArtifacts(
      [src('原生.ERB', '@A\n'), src('封存.kojo1', '如果 A：\n'), src('正文.kojo', '# x'), src('说明.txt', 'z')],
      fakeCompile,
    );
    expect(plan.transpiled).toBe(1);
    expect(plan.passthrough).toBe(3);
    expect(plan.ignoredDerived).toEqual([]);
    // 顺序 = 源顺序，且只收 2.0 源（.kojo1 走的是转译腿，不是"未转译"）
    expect(plan.untranspiledKojo2).toEqual([{ relPath: '正文.kojo' }]);
  });

  it('大小写形态与子目录一起点出来，顺序按源顺序', () => {
    const plan = planArtifacts(
      [src('b/第二份.KOJO', 'x'), src('a/第一份.kojo', 'y'), src('README.md', 'z')],
      fakeCompile,
    );
    expect(plan.untranspiledKojo2.map((i) => i.relPath)).toEqual(['b/第二份.KOJO', 'a/第一份.kojo']);
  });

  it('不含 2.0 源的包 → 清单恒为空数组（两腿文案逐字相同的自证）', () => {
    const plan = planArtifacts([src('事件.kojo1', 'x'), src('说明.txt', 'y')], fakeCompile);
    expect(plan.untranspiledKojo2).toEqual([]);
  });
});

describe('kojo2UntranspiledNotice：两腿共用的那一句白话', () => {
  const items = (rels: readonly string[]) => rels.map((relPath) => ({ relPath }));

  it('空清单 → null（调用方整句不出现，不是空串占位）', () => {
    expect(kojo2UntranspiledNotice([])).toBeNull();
  });

  it('非空 → 说全"几份 / 哪枚扩展名 / 什么后果"，并列出相对路径', () => {
    const text = kojo2UntranspiledNotice(items(['事件.kojo', '子/日常.kojo']))!;
    expect(text).toContain('本包含 2 份');
    expect(text).toContain(KOJO_SOURCE_EXTENSION);
    expect(text).toContain('不会被转译');
    expect(text).toContain('游戏读不到');
    expect(text).toContain('事件.kojo');
    expect(text).toContain('子/日常.kojo');
    // 去黑话：作者看得懂，不许漏出 untranspiled / fail-closed / 制品计划这类词
    expect(text).not.toMatch(/untranspiled|fail-closed|passthrough/i);
  });

  it('超出点名上限时如实说"另有 N 份未列出"，不假装列全了', () => {
    const many = items(Array.from({ length: KOJO2_NOTICE_MAX_PATHS + 3 }, (_v, i) => `f${i}.kojo`));
    const text = kojo2UntranspiledNotice(many)!;
    expect(text).toContain('本包含 9 份');
    expect(text).toContain('另有 3 份未列出');
    expect(text).toContain('f0.kojo');
    expect(text).not.toContain('f8.kojo');
  });

  it('窄面（原生对话框标题）maxPaths=0 → 只报数量，不列路径', () => {
    const text = kojo2UntranspiledNotice(items(['事件.kojo', '别的.kojo']), 0)!;
    expect(text).toContain('本包含 2 份');
    expect(text).not.toContain('事件.kojo');
  });
});

describe('listKojo2Sources：确认框的只读前置核对', () => {
  const DIR = '/appdata/workspaces/p1/包';

  function ioOf(files: readonly string[], overrides: Partial<FileIO> = {}): FileIO {
    return {
      walkDir: async () =>
        files.map((rel): DirEntry => ({ name: rel, path: `${DIR}/${rel}`, isDirectory: false })),
      readBytes: async () => {
        throw new Error('前置核对一个字节都不许读（确认框只该拿路径）');
      },
      ...overrides,
    } as unknown as FileIO;
  }

  it('只走 walkDir：一个字节都不读、一次都不叫编译器', async () => {
    const io = ioOf(['事件.kojo', '说明.txt']);
    expect(await listKojo2Sources(io, DIR)).toEqual([{ relPath: '事件.kojo' }]);
  });

  it('相对路径形态与制品计划同源（反斜杠归一 / 去首斜杠 / 丢目录与越界项）', async () => {
    const io = {
      walkDir: async (): Promise<DirEntry[]> => [
        { name: '子', path: `${DIR}\\子`, isDirectory: true },
        { name: 'a', path: `${DIR}\\子\\日常.KOJO`, isDirectory: false },
        { name: 'b', path: `${DIR}/../外面.kojo`, isDirectory: false },
        { name: 'c', path: `${DIR}/正文.kojo`, isDirectory: false },
      ],
    } as unknown as FileIO;
    expect(await listKojo2Sources(io, DIR)).toEqual([{ relPath: '子/日常.KOJO' }, { relPath: '正文.kojo' }]);
  });

  it('与 planArtifacts 同一份判据：核对出来的清单 == 计划里的清单', async () => {
    const rels = ['事件.kojo', '封存.kojo1', '原生.ERB', '子/正文.kojo'];
    const io = ioOf(rels);
    const plan = planArtifacts(rels.map((relPath) => src(relPath, 'x')), fakeCompile);
    expect(await listKojo2Sources(io, DIR)).toEqual(plan.untranspiledKojo2);
  });
});
