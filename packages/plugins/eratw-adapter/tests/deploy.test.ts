import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import iconv from 'iconv-lite';
import type { CharaInfo, GameProject } from '@kojo/plugin-api';
// 真实链路层：借用内核的 io 实现与 Node 桥做端到端落盘验证
// （与本仓 kojo-sugar/tests/compile.test.ts 同一先例——测试可相对路径引内核，
//   插件正文仍只依赖 @kojo/plugin-api，审计 B 项口径不变）
import { FileIOServiceImpl } from '../../../kernel/src/io';
import { NodeBridge } from '../../../kernel/tests/helpers/node-bridge';
import { deployPackage, resolveDeployTarget, type DeployTarget } from '../src/deploy';

/**
 * 部署（P-E）测试。
 *
 * 两条铁律各有一项钉死的断言：**字节保真**（口上库经一次转码就可能毁半库）与
 * **目标已存在不覆盖 / 未授权不动盘**（游戏目录里可能是别人的东西，半成品目录
 * 会被引擎读进去）。
 */

const PKG = '东方口上-灵梦 v1.0';

function projectWith(chars: Array<{ no: number; name: string; kojoDir?: string }>): GameProject {
  const charaIndex = new Map<number, CharaInfo>();
  for (const c of chars) {
    charaIndex.set(c.no, c.kojoDir === undefined ? { no: c.no, name: c.name } : c);
  }
  return {
    rootDir: 'C:/game',
    adapterId: 'eratw',
    kojoPaths: ['C:/game/scenario/ERB/個人口上'],
    writablePaths: [],
    charaIndex,
  };
}

/* --------------------------- 落点解析（纯函数） --------------------------- */

/** 断言解析失败并取出原因文本（收敛联合类型，避免满屏 ok 判定） */
function failReason(t: DeployTarget): string {
  if (t.ok) throw new Error(`期望解析失败，实际却解析出落点：${t.targetDir}`);
  return t.reason;
}

describe('resolveDeployTarget · 落点解析', () => {
  const p = projectWith([
    { no: 1, name: '灵梦', kojoDir: 'C:/game/kojo/001 灵梦' },
    { no: 2, name: '魔理沙' },
  ]);

  it('拼出 <角色口上目录>/<包目录名>，并带出角色名', () => {
    const t = resolveDeployTarget(p, 1, PKG);
    expect(t).toEqual({
      ok: true,
      charaNo: 1,
      charaName: '灵梦',
      targetDir: path.join('C:/game/kojo/001 灵梦', PKG),
    });
  });

  it('无游戏项目 / 未选角色：各自讲清下一步（不猜落点）', () => {
    expect(failReason(resolveDeployTarget(null, 1, PKG))).toBe('当前没有打开的游戏项目，无处可部署。');
    expect(failReason(resolveDeployTarget(p, null, PKG))).toBe('请先选择目标角色。');
  });

  it('角色号在游戏项目里不存在 / 该角色无口上目录 → 明确原因', () => {
    expect(failReason(resolveDeployTarget(p, 99, PKG))).toContain('编号 99');
    const noDir = failReason(resolveDeployTarget(p, 2, PKG));
    expect(noDir).toContain('魔理沙');
    expect(noDir).toContain('没有个人口上目录');
  });

  it('包目录名必须单层：分隔符与点段一律拒绝（落点在游戏目录内，不给逃逸机会）', () => {
    for (const bad of ['../evil', '..\\evil', 'a/b', 'a\\b', '', '.', '..']) {
      expect(failReason(resolveDeployTarget(p, 1, bad))).toContain('单层目录名');
    }
  });
});

/* --------------------------- 真实落盘（NodeBridge） --------------------------- */

let tmpDir: string;
let appData: string;
let pkgDir: string;
let gameKojoDir: string;
let targetDir: string;
let io: FileIOServiceImpl;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kojo-deploy-'));
  appData = path.join(tmpDir, 'appdata');
  io = new FileIOServiceImpl(new NodeBridge(appData));
  io.setAppWritableRoots([appData]);

  // 工作区里的包（源，常驻可写根内）
  pkgDir = path.join(appData, 'workspaces', 'p1', PKG);
  await fs.mkdir(path.join(pkgDir, '子目录'), { recursive: true });
  // 「主人」的 Shift-JIS 字节（非合法 UTF-8）——复制必须逐字节不动
  await fs.writeFile(path.join(pkgDir, '01 事件.ERB'), iconv.encode('@M_KOJO_K1\nPRINTL 主人\n', 'shift_jis'));
  await fs.writeFile(path.join(pkgDir, '子目录', '02 日常.ERB'), '@M_KOJO_K1_A\n');

  // 游戏目录（域外，只有显式批准才可写）
  gameKojoDir = path.join(tmpDir, 'game', 'kojo', '001 灵梦');
  await fs.mkdir(gameKojoDir, { recursive: true });
  targetDir = path.join(gameKojoDir, PKG);
});

describe('deployPackage · 部署落盘', () => {
  it('嵌套结构整份复制，Shift-JIS 字节逐字节保真（不做任何转码）', async () => {
    io.setWritableRoots([gameKojoDir]);
    const n = await deployPackage({ io, srcDir: pkgDir, targetDir });
    expect(n).toBe(2);

    const srcFile = path.join(pkgDir, '01 事件.ERB');
    const dstFile = path.join(targetDir, '01 事件.ERB');
    expect(Buffer.compare(await fs.readFile(dstFile), await fs.readFile(srcFile))).toBe(0);
    // 落盘后仍被探测为 shift_jis 且内容完好——引擎侧读得到的还是原来那份
    const tf = await io.readText(dstFile);
    expect(tf.encoding).toBe('shift_jis');
    expect(tf.text).toContain('主人');
    expect(await fs.readFile(path.join(targetDir, '子目录', '02 日常.ERB'), 'utf8')).toContain(
      '@M_KOJO_K1_A',
    );
    // 源目录一个字节都没被改动
    expect((await fs.readdir(pkgDir)).sort()).toEqual(['01 事件.ERB', '子目录'].sort());
  });

  it('目标已存在 → 报错不覆盖，既有内容原样保留', async () => {
    io.setWritableRoots([gameKojoDir]);
    await fs.mkdir(targetDir, { recursive: true });
    const mine = path.join(targetDir, '别人已部署.ERB');
    await fs.writeFile(mine, '原样');

    await expect(deployPackage({ io, srcDir: pkgDir, targetDir })).rejects.toThrow(/目标已存在，未覆盖/);

    expect(await fs.readFile(mine, 'utf8')).toBe('原样');
    expect(await fs.readdir(targetDir)).toEqual(['别人已部署.ERB']);
  });

  it('游戏目录未批准写权限 → 抛错且**不落任何目录**（不给引擎留半成品）', async () => {
    io.setWritableRoots([]);
    await expect(deployPackage({ io, srcDir: pkgDir, targetDir })).rejects.toThrow(/写白名单/);
    expect(await io.exists(targetDir)).toBe(false);
  });

  it('空包 → 建出空落点目录，回报 0 个文件', async () => {
    io.setWritableRoots([gameKojoDir]);
    const empty = path.join(appData, 'empty-pkg');
    await fs.mkdir(empty, { recursive: true });

    expect(await deployPackage({ io, srcDir: empty, targetDir })).toBe(0);
    expect((await io.stat(targetDir))?.isDirectory).toBe(true);
  });

  it('源不存在或不是目录 → 先报错，不碰游戏目录', async () => {
    io.setWritableRoots([gameKojoDir]);
    await expect(
      deployPackage({ io, srcDir: path.join(appData, '没有这个包'), targetDir }),
    ).rejects.toThrow(/源目录不存在或不是目录/);
    expect(await io.exists(targetDir)).toBe(false);
  });

  it('子目录里的文件不被拍平：根级与子级同名各自落地', async () => {
    io.setWritableRoots([gameKojoDir]);
    await fs.writeFile(path.join(pkgDir, '同名.ERB'), '根级');
    await fs.writeFile(path.join(pkgDir, '子目录', '同名.ERB'), '子级');

    await deployPackage({ io, srcDir: pkgDir, targetDir });

    expect(await fs.readFile(path.join(targetDir, '同名.ERB'), 'utf8')).toBe('根级');
    expect(await fs.readFile(path.join(targetDir, '子目录', '同名.ERB'), 'utf8')).toBe('子级');
  });
});
