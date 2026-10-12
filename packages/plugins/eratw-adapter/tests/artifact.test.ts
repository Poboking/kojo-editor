/**
 * 制品计划单测（导出批）。
 *
 * 重点不在"改扩展名"这种一看就对的部分，而在三条**会不会静默丢东西**的边界：
 * 命名冲突、转译失败必须整体拒绝、非 `.kojo` 一个字节都不能被改动。
 */

import { describe, expect, it } from 'vitest';
import type { SugarCompiledBytes } from '@kojo/plugin-api';
import { isKojoSource, planArtifacts, toRelPath, type ArtifactSource, type KojoCompiler } from '../src/artifact';

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
    expect(toRelPath('\\a\\b\\c.kojo')).toBe('a/b/c.kojo');
    expect(toRelPath('/x.ERB')).toBe('x.ERB');
  });
  it('扩展名大小写不敏感', () => {
    expect(isKojoSource('事件.KOJO')).toBe(true);
    expect(isKojoSource('事件.kojo')).toBe(true);
    expect(isKojoSource('事件.ERB')).toBe(false);
    expect(isKojoSource('kojo.说明.txt')).toBe(false);
  });
});

describe('planArtifacts', () => {
  it('.kojo 落成同名 .ERB，并计入 transpiled', () => {
    const plan = planArtifacts([src('事件.kojo', '如果 A：\n')], fakeCompile);
    expect(plan.entries.map((e) => e.relPath)).toEqual(['事件.ERB']);
    expect(plan.transpiled).toBe(1);
    expect(plan.passthrough).toBe(0);
    expect(byName(plan, '事件.ERB')).toContain('如果 A：');
  });

  it('制品里绝不残留 .kojo（引擎读不到，留着就是骗作者）', () => {
    const plan = planArtifacts(
      [src('事件.kojo', 'x'), src('日常指令.KOJO', 'y'), src('README.md', 'z')],
      fakeCompile,
    );
    expect(plan.entries.some((e) => /\.kojo$/i.test(e.relPath))).toBe(false);
  });

  it('非 .kojo 字节级原样携带（一个字节都不许动）', () => {
    const raw = enc.encode('改过编码就毁了\r\n第二行');
    const plan = planArtifacts([{ relPath: '说明.txt', bytes: raw }], fakeCompile);
    expect(plan.entries[0]!.bytes).toBe(raw); // 同一个数组引用，连复制都没发生
    expect(plan.passthrough).toBe(1);
    expect(plan.transpiled).toBe(0);
  });

  it('子目录结构保留，且用 / 分隔', () => {
    const plan = planArtifacts([src('辅助\\表\\数据.kojo', 'x'), src('a/b/c.txt', 'y')], fakeCompile);
    expect(plan.entries.map((e) => e.relPath).sort()).toEqual(['a/b/c.txt', '辅助/表/数据.ERB']);
  });

  it('作者手写的 .ERB 与 .kojo 混包：各归各位，不互相覆盖', () => {
    const plan = planArtifacts([src('事件.ERB', '原生'), src('日常.ERB', '原生2')], fakeCompile);
    expect(plan.entries.map((e) => e.relPath).sort()).toEqual(['事件.ERB', '日常.ERB']);
    expect(plan.passthrough).toBe(2);
  });

  it('命名冲突 → 拒绝，不静默二选一（丢哪个都是事故）', () => {
    expect(() => planArtifacts([src('事件.ERB', '原生'), src('事件.kojo', '糖')], fakeCompile)).toThrow(/产物名冲突/);
    // 顺序反过来也要报（谁先到都一样，不能因为 .kojo 先跑就躲过去）
    expect(() => planArtifacts([src('事件.kojo', '糖'), src('事件.ERB', '原生')], fakeCompile)).toThrow(/产物名冲突/);
  });

  it('大小写不同的同名也算冲突（Windows 文件系统上本就是同一个文件）', () => {
    expect(() => planArtifacts([src('a.Kojo', 'x'), src('A.ERB', 'y')], fakeCompile)).toThrow(/产物名冲突/);
  });

  it('转译失败 → 整体拒绝，不产半成品包（半成品比没有更危险）', () => {
    const boom: KojoCompiler = (_s, label) => {
      if (label === '坏.kojo') throw new Error('第 3 行：缺少 否则');
      return fakeCompile(_s, label);
    };
    expect(() => planArtifacts([src('好.kojo', 'x'), src('坏.kojo', 'y')], boom)).toThrow(
      /「坏\.kojo」转译失败，未生成制品：第 3 行：缺少 否则/,
    );
  });

  it('逃逸包目录的路径直接拒绝', () => {
    expect(() => planArtifacts([src('../逃逸.kojo', 'x')], fakeCompile)).toThrow(/逃逸包目录/);
  });

  it('空目录清单 → 空计划（不抛）', () => {
    expect(planArtifacts([], fakeCompile)).toEqual({ entries: [], transpiled: 0, passthrough: 0 });
  });

  it('带 BOM 的 .kojo 不把 BOM 当正文喂给转译器', () => {
    let seen = '';
    const spy: KojoCompiler = (s) => {
      seen = s;
      return fakeCompile(s, 'x');
    };
    const withBom = { relPath: '事件.kojo', bytes: new Uint8Array([0xef, 0xbb, 0xbf, ...enc.encode('如果 A：')]) };
    planArtifacts([withBom], spy);
    expect(seen).toBe('如果 A：');
  });
});
