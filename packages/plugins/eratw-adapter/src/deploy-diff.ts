/**
 * 部署比对（2026-10-15 比对/历史批）：回答「这份工作区口上到底部署进游戏没有、差在哪」。
 *
 * 口径与部署链路**同源**，不发明第二套规则：
 * - 期望侧 = `planArtifacts(readPackageSources(io, srcDir), compile)` 的产物计划
 *   （`.kojo` 先转译——游戏目录里住的是产物，拿源文件和它比是比不上的）；
 * - 实际侧 = 落点目录（`resolveDeployTarget` 的同一函数）下的真文件；目录不存在 =
 *   **尚未部署**，整包按「仅工作区」归类并显式横幅，而不是画一张空白；
 * - 判等 = **字节级**（与部署写盘同一把尺；文本比较会把"只差 BOM/EOL"的误判成相同
 *   或反之）。逐行差异的呈现由宿主通用 diff 视图（`ui.diffView.open`）负责。
 *
 * 全程只读：两侧都只经内核 io 读——比对永不写盘。
 */

import type { DiffViewSide, FileIO } from '@kojo/plugin-api';
import { join } from '@kojo/plugin-api';
import {
  planArtifacts,
  readPackageSources,
  toRelPath,
  type ArtifactEntry,
  type KojoCompiler,
} from './artifact';

/** 待比对请求（插件闭包持有；overlay 组件无 props，经 deps 读取——与 pendingDeploy 同款） */
export interface PendingCompare {
  /** 工作区内包目录绝对路径 */
  absDir: string;
  /** 包目录名（决定游戏侧落点名） */
  dirName: string;
  /** 包显示名（标题与反馈文案用） */
  displayName: string;
  /** 制品 meta 里的目标角色号（导入的包没有 → 由用户在比对窗里挑） */
  charaNo?: number;
}

export type DeployDiffState = 'identical' | 'modified' | 'workspace-only' | 'game-only';

export interface DeployDiffRow {
  relPath: string;
  state: DeployDiffState;
  /** diff 视图左侧（工作区期望产物）；仅游戏目录有的文件为 null */
  workspace: DeployDiffSide | null;
  /** diff 视图右侧（游戏目录真文件）；仅工作区有的文件为 null */
  game: DeployDiffSide | null;
}

/** 一侧的 diff 素材（宿主按 path 现读，或直接吃内存 text——转译产物盘上没有） */
export interface DeployDiffSide {
  label: string;
  text?: string;
  path?: string;
}

/** 落点目录下的一个真文件 */
export interface GameFile {
  relPath: string;
  bytes: Uint8Array;
  absPath: string;
}

/** 归一化比较键：`/` 分隔 + 小写（与 planArtifacts 的 claim 同一口径，Windows 不分大小写） */
function relKey(rel: string): string {
  return toRelPath(rel).toLowerCase();
}

/** 字节级判等（长度短路 + 逐字节） */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * 期望计划 × 实际文件集 → 逐文件归类（纯函数，可单测）。
 *
 * 四条归类全覆盖判据：仅一边存在 = `workspace-only` / `game-only`；两边都有且字节
 * 相同 = `identical`（**显式成行**，UI 才有"无差异"可指）；否则 `modified`。
 */
export function compareDeployPlan(
  plan: readonly ArtifactEntry[],
  actual: readonly GameFile[],
  srcDir: string,
  targetDir: string,
): DeployDiffRow[] {
  const actualByKey = new Map<string, GameFile>();
  for (const f of actual) actualByKey.set(relKey(f.relPath), f);
  const rows: DeployDiffRow[] = [];

  for (const entry of plan) {
    const key = relKey(entry.relPath);
    const hit = actualByKey.get(key);
    actualByKey.delete(key);
    const workspaceSide: DeployDiffSide = {
      label: `工作区 · ${entry.sourceRel}${entry.sourceRel !== entry.relPath ? ` → ${entry.relPath}` : ''}`,
      ...(entry.text !== undefined ? { text: entry.text } : { path: join(srcDir, entry.sourceRel) }),
    };
    if (!hit) {
      rows.push({
        relPath: entry.relPath,
        state: 'workspace-only',
        workspace: workspaceSide,
        game: { label: '游戏目录 · （该文件不存在）', text: '' },
      });
      continue;
    }
    rows.push({
      relPath: entry.relPath,
      state: bytesEqual(entry.bytes, hit.bytes) ? 'identical' : 'modified',
      workspace: workspaceSide,
      game: { label: `游戏目录 · ${entry.relPath}`, path: hit.absPath },
    });
  }

  for (const extra of actualByKey.values()) {
    rows.push({
      relPath: extra.relPath,
      state: 'game-only',
      workspace: { label: '工作区 · （包内没有此文件）', text: '' },
      game: { label: `游戏目录 · ${extra.relPath}`, path: extra.absPath },
    });
  }

  rows.sort((a, b) => a.relPath.localeCompare(b.relPath, 'zh-Hans-CN'));
  return rows;
}

/** 归类计数（横幅文案的单一真源） */
export interface DeployDiffSummary {
  total: number;
  identical: number;
  modified: number;
  workspaceOnly: number;
  gameOnly: number;
  /** 落点目录整体不存在（尚未部署） */
  targetMissing: boolean;
}

export function summarizeDeployDiff(rows: readonly DeployDiffRow[], targetMissing: boolean): DeployDiffSummary {
  const s: DeployDiffSummary = {
    total: rows.length,
    identical: 0,
    modified: 0,
    workspaceOnly: 0,
    gameOnly: 0,
    targetMissing,
  };
  for (const r of rows) {
    if (r.state === 'identical') s.identical += 1;
    else if (r.state === 'modified') s.modified += 1;
    else if (r.state === 'workspace-only') s.workspaceOnly += 1;
    else s.gameOnly += 1;
  }
  return s;
}

/** 汇总横幅（"无差异"必须明确说出口，而不是留一块空表） */
export function deployDiffBanner(s: DeployDiffSummary): string {
  if (s.targetMissing) return '落点目录不存在 —— 这个包尚未部署到游戏目录（或落点已不在原位）。';
  if (s.total === 0) return '工作区包内没有任何文件，也没有可比对的内容。';
  if (s.identical === s.total) return `全部 ${s.total} 个文件与游戏目录逐字节一致：这份部署就是当前工作区的内容。`;
  return `共 ${s.total} 个文件：${s.modified} 处有差异、${s.workspaceOnly} 个未部署、${s.gameOnly} 个只在游戏目录。`;
}

export interface CollectResult {
  rows: DeployDiffRow[];
  /** 落点目录不存在（= 尚未部署；此时 rows 全为 workspace-only） */
  targetMissing: boolean;
}

/**
 * 读两侧并归类（唯一碰磁盘的入口；两侧都只读）。
 * 转译失败/读盘失败由调用方捕获——中文原因原样呈现（planArtifacts fail-closed 口径）。
 */
export async function collectDeployDiff(opts: {
  io: FileIO;
  srcDir: string;
  targetDir: string;
  compile: KojoCompiler;
}): Promise<CollectResult> {
  const { io, srcDir, targetDir, compile } = opts;
  const plan = planArtifacts(await readPackageSources(io, srcDir), compile);

  const targetExists = await io.exists(targetDir);
  const actual: GameFile[] = [];
  if (targetExists) {
    const entries = await io.walkDir(targetDir, { includeFiles: true });
    for (const e of entries) {
      if (e.isDirectory) continue;
      const rel = toRelPath(e.path.slice(targetDir.length).replace(/^[\\/]+/, ''));
      if (rel.length === 0) continue;
      actual.push({ relPath: rel, bytes: await io.readBytes(e.path), absPath: e.path });
    }
  }
  return {
    rows: compareDeployPlan(plan.entries, actual, srcDir, targetDir),
    targetMissing: !targetExists,
  };
}

/** 行 → `ui.diffView.open` 载荷（宿主侧判据：两侧至少一有内容——这里恒成立） */
export function rowToDiffPayload(row: DeployDiffRow, title: string): {
  title: string;
  original: DiffViewSide;
  modified: DiffViewSide;
} {
  return {
    title,
    original: sideOf(row.workspace),
    modified: sideOf(row.game),
  };
}

function sideOf(s: DeployDiffSide | null): DiffViewSide {
  if (s === null) return { label: '（无）', text: '' };
  return { label: s.label, ...(s.text !== undefined ? { text: s.text } : {}), ...(s.path !== undefined ? { path: s.path } : {}) };
}
