import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { SugarCompiledBytes } from '@kojo/plugin-api';
import { FileIOServiceImpl } from '../../../kernel/src/io';
import { NodeBridge } from '../../../kernel/tests/helpers/node-bridge';
import { planArtifacts, type ArtifactEntry, type KojoCompiler } from '../src/artifact';
import {
  bytesEqual,
  collectDeployDiff,
  compareDeployPlan,
  deployDiffBanner,
  rowToDiffPayload,
  summarizeDeployDiff,
  type GameFile,
} from '../src/deploy-diff';

/**
 * 部署比对（1015 比对批）判据。
 *
 * 钉死四件：①四态归类（含"字节相同 = 明确的一致"与两侧独有的是/非）；
 * ②期望侧素材来源（`.kojo` 用内存产物文本，原样文件用工作区路径——宿主读得到）；
 * ③横幅必须把「无差异 / 尚未部署」说出口，不留空白；④落点缺失整包按未部署归类。
 */

const compile: KojoCompiler = (source, label) => {
  const erb = `@M_KOJO_EVENT_${label}\nPRINTL ${source.toUpperCase()}\n`;
  return {
    bytes: new TextEncoder().encode(erb),
    transpile: { erb, sourceMap: [], diagnostics: [] } as SugarCompiledBytes['transpile'],
  };
};

const entry = (relPath: string, bytes: Uint8Array, over: Partial<ArtifactEntry> = {}): ArtifactEntry => ({
  relPath,
  bytes,
  sourceRel: over.sourceRel ?? relPath,
  ...(over.text !== undefined ? { text: over.text } : {}),
});

const game = (relPath: string, text: string, base = 'C:/game/kojo/001 包'): GameFile => ({
  relPath,
  bytes: new TextEncoder().encode(text),
  absPath: path.posix.join(base, relPath),
});

describe('compareDeployPlan · 四态归类', () => {
  const srcDir = 'C:/ws/包';
  const targetDir = 'C:/game/kojo/001 包';
  const A = new TextEncoder().encode('AAA');
  const A2 = new TextEncoder().encode('AAAB');

  it('相同 / 修改 / 仅工作区 / 仅游戏目录 各归各类', () => {
    const rows = compareDeployPlan(
      [entry('a.ERB', A), entry('b.ERB', A), entry('c.ERB', A)],
      [game('a.ERB', 'AAA'), game('b.ERB', 'AAAB'), game('d.ERB', 'DDD')],
      srcDir,
      targetDir,
    );
    expect(rows.map((r) => [r.relPath, r.state])).toEqual([
      ['a.ERB', 'identical'],
      ['b.ERB', 'modified'],
      ['c.ERB', 'workspace-only'],
      ['d.ERB', 'game-only'],
    ]);
  });

  it('比较键大小写不敏感（Windows 同一文件的两种写法不许被判成 modified+game-only 两行）', () => {
    const rows = compareDeployPlan([entry('事件.ERB', A)], [game('事件.erb', 'AAA')], srcDir, targetDir);
    // plan 键与 actual 键折叠同小写 ⇒ 命中同一行：只剩一条"一致"，而不是"差异 + 多余"两行假警报
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe('identical');
  });

  it('仅工作区一侧给出"不存在"的空侧；仅游戏目录一侧同理', () => {
    const rows = compareDeployPlan([entry('a.ERB', A)], [], srcDir, targetDir);
    expect(rows[0]!.game).toEqual({ label: '游戏目录 · （该文件不存在）', text: '' });
    const rows2 = compareDeployPlan([], [game('x.ERB', 'X')], srcDir, targetDir);
    expect(rows2[0]!.workspace).toEqual({ label: '工作区 · （包内没有此文件）', text: '' });
  });

  it('.kojo 转译行：工作区侧给内联产物文本；原样行给工作区路径', () => {
    const rows = compareDeployPlan(
      [
        entry('事件.ERB', A, { sourceRel: '事件.kojo', text: 'COMPILED' }),
        entry('说明.txt', A, { sourceRel: '说明.txt' }),
      ],
      [],
      srcDir,
      targetDir,
    );
    const kojoRow = rows.find((r) => r.relPath === '事件.ERB')!;
    expect(kojoRow.workspace).toEqual({ label: '工作区 · 事件.kojo → 事件.ERB', text: 'COMPILED' });
    const txtRow = rows.find((r) => r.relPath === '说明.txt')!;
    expect(txtRow.workspace!.text).toBeUndefined();
    expect(txtRow.workspace!.path).toContain(path.join(srcDir, '说明.txt'));
  });
});

describe('bytesEqual / 汇总横幅', () => {
  it('长度短路 + 逐字节', () => {
    expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(bytesEqual(new Uint8Array([1]), new Uint8Array([1, 0]))).toBe(false);
  });

  it('全一致 / 未部署 / 空包各有明示文案（无差异不许是空白）', () => {
    const rows = compareDeployPlan([entry('a.ERB', new Uint8Array([1]))], [game('a.ERB', '\u0001')], 'C:/ws', 'C:/g');
    expect(deployDiffBanner(summarizeDeployDiff(rows, false))).toContain('逐字节一致');
    expect(deployDiffBanner(summarizeDeployDiff(rows, true))).toContain('尚未部署');
    expect(deployDiffBanner(summarizeDeployDiff([], false))).toContain('没有任何文件');
    const mixed = summarizeDeployDiff(
      compareDeployPlan(
        [entry('a.ERB', new Uint8Array([1])), entry('b.ERB', new Uint8Array([1]))],
        [game('a.ERB', '\u0002')],
        'C:/ws',
        'C:/g',
      ),
      false,
    );
    expect(mixed.modified).toBe(1);
    expect(mixed.workspaceOnly).toBe(1);
  });
});

describe('collectDeployDiff · 真实落盘端到端', () => {
  let tmp: string;
  let io: FileIOServiceImpl;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'kojo-deploydiff-'));
    io = new FileIOServiceImpl(new NodeBridge(path.join(tmp, 'appdata')));
  });

  const write = async (p: string, content: string | Uint8Array): Promise<void> => {
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, content);
  };

  it('三态混合包：一致 / 有差异 / 仅工作区 + 仅游戏目录', async () => {
    const src = path.join(tmp, 'ws', '包');
    const dst = path.join(tmp, 'game', '001 包');
    await write(path.join(src, 'a.ERB'), 'SAME');
    await write(path.join(src, 'b.ERB'), 'OLD');
    await write(path.join(src, 'only-ws.ERB'), 'W');
    await write(path.join(dst, 'a.ERB'), 'SAME');
    await write(path.join(dst, 'b.ERB'), 'NEW');
    await write(path.join(dst, 'stray.ERB'), 'S');

    const r = await collectDeployDiff({ io, srcDir: src, targetDir: dst, compile });
    expect(r.targetMissing).toBe(false);
    expect(r.rows.map((x) => [x.relPath, x.state])).toEqual([
      ['a.ERB', 'identical'],
      ['b.ERB', 'modified'],
      ['only-ws.ERB', 'workspace-only'],
      ['stray.ERB', 'game-only'],
    ]);
    // 原样文件的工作区侧 = 磁盘路径（宿主可现读，含真编码）
    expect(r.rows[0]!.workspace!.path).toContain('a.ERB');
  });

  it('落点目录不存在 → targetMissing，整包 workspace-only（"没部署"是判据不是报错）', async () => {
    const src = path.join(tmp, 'ws', '包');
    await write(path.join(src, 'a.ERB'), 'A');
    const r = await collectDeployDiff({ io, srcDir: src, targetDir: path.join(tmp, 'game', '不存在'), compile });
    expect(r.targetMissing).toBe(true);
    expect(r.rows.every((x) => x.state === 'workspace-only')).toBe(true);
  });

  it('.kojo 源：期望侧文本来自内存转译产物，路径指向 .ERB 产物名', async () => {
    const src = path.join(tmp, 'ws', '包');
    await write(path.join(src, '事件.kojo'), '台词「你好」');
    const r = await collectDeployDiff({ io, srcDir: src, targetDir: path.join(tmp, 'game', 'no'), compile });
    const row = r.rows[0]!;
    expect(row.relPath).toBe('事件.ERB');
    expect(row.workspace!.text).toContain('PRINTL');
    expect(row.workspace!.path).toBeUndefined();
  });

  it('转译失败 fail-closed：原因进 rejection，不产半张比对表', async () => {
    const src = path.join(tmp, 'ws', '包');
    await write(path.join(src, '坏.kojo'), 'x');
    const boom: KojoCompiler = () => {
      throw new Error('转译炸了');
    };
    await expect(collectDeployDiff({ io, srcDir: src, targetDir: path.join(tmp, 'game', 'g'), compile: boom })).rejects.toThrow('「坏.kojo」转译失败');
  });

  it('planArtifacts 的源追踪是比对的数据底座（同基名映射 sourceRel；产物行可反查工作区文件）', () => {
    const plan = planArtifacts([{ relPath: '事件.kojo', bytes: new TextEncoder().encode('src') }], compile);
    expect(plan.entries[0]!.sourceRel).toBe('事件.kojo');
    expect(plan.entries[0]!.text).toContain('@M_KOJO_EVENT_');
    const pt = planArtifacts([{ relPath: 'x.ERB', bytes: new Uint8Array([1]) }], compile);
    expect(pt.entries[0]!.sourceRel).toBe('x.ERB');
    expect(pt.entries[0]!.text).toBeUndefined();
  });
});

describe('rowToDiffPayload', () => {
  it('标题带上包名与文件；两侧 label 原样进事件载荷', () => {
    const rows = compareDeployPlan([entry('a.ERB', new Uint8Array([1]))], [], 'C:/ws/包', 'C:/g/包');
    const p = rowToDiffPayload(rows[0]!, '包A · a.ERB');
    expect(p.title).toBe('包A · a.ERB');
    expect(p.original.label).toContain('工作区');
    expect(p.modified).toEqual({ label: '游戏目录 · （该文件不存在）', text: '' });
  });
});
