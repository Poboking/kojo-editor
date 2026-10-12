/**
 * 部署到游戏目录（2026-10-12 口上项目批 P-E）。
 *
 * 方向只有一个：工作区（权威）──▶ 游戏目录（部署目标）；反向的「从游戏目录改回
 * 工作区」走导入（P-F），部署永不回写工作区。
 * 落点 = `<角色口上目录>/<包目录名>/`；**目标已存在一律报错不覆盖**——游戏目录里
 * 可能是别人已部署的包，静默覆盖等于毁掉他人的东西。
 *
 * 复制是**字节级**（walkDir + readBytes/writeBytes）：口上库的既有编码经一次
 * 转码就可能毁半库，这里刻意不做任何解码 / 重编码。
 * **例外**（2026-10-12 导出批）：`.kojo` 源必须先转译成 `.ERB` 才能进游戏目录 ——
 * 引擎不认 `.kojo`，原样复制的结果是"装了但不生效"。转译只在内存里发生，
 * 工作区的源文件永不改写。规则与冲突判定见 `artifact.ts`。
 *
 * 写保护不破：写入仍经内核 io（`writeBytes` / `ensureDir` 都过写白名单第一道闸，
 * Rust 侧另有第二道闸）。游戏目录默认只读，故调用前先用 `io.isWritable` 判一次——
 * 让 UI 能把「先授权」讲在按钮上，而不是等用户点下去吃一个越权异常；
 * 也保证失败发生在动盘之前，不给游戏目录留半成品目录。
 */

import type { FileIO, GameProject } from '@kojo/plugin-api';
import { dirname, join } from '@kojo/plugin-api';
import { planArtifacts, readPackageSources, type KojoCompiler } from './artifact';

/** 待部署请求（插件闭包持有；overlay 组件无 props，经 deps 读取） */
export interface PendingDeploy {
  /** 工作区内包目录绝对路径（部署源） */
  absDir: string;
  /** 包目录名（决定游戏侧落点名） */
  dirName: string;
  /** 包显示名（反馈文案用） */
  displayName: string;
  /** 新建向导（P-C）写在制品 meta 里的目标角色号；导入的包没有 → 由用户选 */
  charaNo?: number;
}

/** 解析成功后的部署落点 */
export interface DeployTargetOk {
  ok: true;
  charaNo: number;
  charaName: string;
  /** 落点绝对路径（`<kojoDir>/<dirName>`） */
  targetDir: string;
}

/** 落点解析结果（失败带中文原因——向导直接呈现，不再二次翻译） */
export type DeployTarget =
  | DeployTargetOk
  | { ok: false; reason: string };

/**
 * 解析部署落点。三处不猜测、逐项交代原因：
 * 没选角色 / 角色号在游戏项目里不存在 / 该角色在游戏目录里没有口上目录。
 */
export function resolveDeployTarget(
  project: GameProject | null,
  charaNo: number | null,
  dirName: string,
): DeployTarget {
  if (!project) return { ok: false, reason: '当前没有打开的游戏项目，无处可部署。' };
  if (charaNo === null) return { ok: false, reason: '请先选择目标角色。' };
  // 落点在游戏目录内（应用自有根之外），目录名必须单层——不给 `..` 逃逸的机会
  if (dirName.length === 0 || dirName === '.' || dirName === '..' || /[\\/]/.test(dirName)) {
    return { ok: false, reason: `包目录名不是单层目录名：${dirName}` };
  }
  const info = project.charaIndex.get(charaNo);
  if (!info) return { ok: false, reason: `游戏项目里没有编号 ${charaNo} 的角色。` };
  if (!info.kojoDir) {
    return { ok: false, reason: `角色「${info.name}」在游戏目录中没有个人口上目录，无法部署。` };
  }
  return { ok: true, charaNo, charaName: info.name, targetDir: join(info.kojoDir, dirName) };
}

/**
 * 把包部署到落点。返回写入的文件数。
 *
 * 三道前置判定都在动盘之前：源必须是目录、目标不得已存在、目标必须在写白名单内。
 *
 * **不是原样复制**（2026-10-12 导出批）：工作区里的 `.kojo` 源要先经制品计划转成
 * `.ERB` 再写，因为引擎只读 `.ERB`——原样复制会把"装了但不生效"留给作者。
 * 非 `.kojo` 文件仍由 `planArtifacts` 保证字节级原样。
 * 转译只发生在**内存**里：工作区的 `.kojo` 一个字节都不会被改写（权威源只有一份）。
 */
export async function deployPackage(opts: {
  io: FileIO;
  srcDir: string;
  targetDir: string;
  /** `.kojo` → 产物字节（来自 `SugarTranspileService.compileToBytes`） */
  compile: KojoCompiler;
}): Promise<number> {
  const { io, srcDir, targetDir, compile } = opts;

  const srcStat = await io.stat(srcDir);
  if (!srcStat || !srcStat.isDirectory) {
    throw new Error(`源目录不存在或不是目录：${srcDir}`);
  }
  if (await io.exists(targetDir)) {
    throw new Error(`目标已存在，未覆盖：${targetDir}`);
  }
  if (!io.isWritable(targetDir)) {
    throw new Error(`目标不在写白名单内，请先批准游戏目录的写权限：${targetDir}`);
  }

  const plan = planArtifacts(await readPackageSources(io, srcDir), compile);

  await io.ensureDir(targetDir);
  for (const entry of plan.entries) {
    const to = join(targetDir, entry.relPath);
    await io.ensureDir(dirname(to));
    await io.writeBytes(to, entry.bytes);
  }
  return plan.entries.length;
}
