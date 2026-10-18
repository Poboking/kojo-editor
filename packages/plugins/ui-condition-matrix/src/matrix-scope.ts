/**
 * 条件矩阵的**口上包作用域**与**剧情线选格**（零 React、零 IO，可单测）。
 *
 * 作者包 = 角色口上目录（`CharaInfo.kojoDir`）下的第一层子目录；直接挂在角色目录
 * 根上的文件归「角色根目录」，不在索引根里的函数归「索引外文件」。这个口径与
 * 工作区部署模型同形（部署落点 = `<kojoDir>/<artifact.dirName>`），因此「我的口上
 * 项目」= 工作区 artifact 的 dirName 与本项目一个包目录同名。
 *
 * 本模块不认识任何游戏名词：只消费 `CharacterEntry` 的函数路径与通用的工作区
 * project/artifact 模型；状态键 → 剧情线的语义由 adapter 经 `stateLinePresets` 提供。
 */

import type { StateLinePreset, WorkspaceProject } from '@kojo/plugin-api';
import { join, pathKey, pathStyle } from '@kojo/plugin-api';
import type { CharacterEntry, ConditionMatrix, MatrixRow } from './matrix-logic';

/** 角色根散文件的包键（直接挂在角色口上目录下，不再分作者包） */
export const ROOT_PACK_KEY = '';
/** 索引根之外的函数（归属角色但路径对不上角色目录）——只浏览，不参与写入 */
export const EXTERNAL_PACK_KEY = '\u0000external';

/** 一个口上包（角色口上目录下的一层子目录） */
export interface AuthorPack {
  /** 包键：目录名原样；'' = 角色根散文件；EXTERNAL_PACK_KEY = 索引外 */
  readonly key: string;
  /** 目录名（根/索引外为空串） */
  readonly dirName: string;
  /** 显示名 */
  readonly label: string;
  /** 包目录绝对路径（根 = 角色目录；索引外 = null） */
  readonly dirPath: string | null;
  readonly functionCount: number;
  /** 唯一文件数（同一文件的多个函数只算一份） */
  readonly fileCount: number;
  readonly isRoot: boolean;
  readonly isExternal: boolean;
}

/** 工作区里与某个包目录同名的一枚 artifact（「我的口上项目」） */
export interface WorkspacePackRef {
  readonly projectId: string;
  readonly projectName: string;
  readonly artifactId: string;
  readonly artifactName: string;
  readonly dirName: string;
  /** artifact 目录绝对路径（= projectDir(projectId)/dirName） */
  readonly rootPath: string;
}

/** 路径分段（去掉空段，保留盘符/中文段原样） */
function segmentsOf(path: string): string[] {
  return path.split(/[\\/]+/).filter((s) => s.length > 0);
}

/**
 * `path` 相对 `root` 的分段（根不匹配 → null）。
 *
 * 判等走 `pathKey`（Windows 折叠大小写），返回的是 **path 的原样分段**——
 * 显示与写盘都要保留作者磁盘上的大小写，不能拿规范化结果当路径用。
 */
export function relativeSegments(path: string, root: string): string[] | null {
  const ps = segmentsOf(path);
  const rs = segmentsOf(root);
  if (rs.length > ps.length) return null;
  // 逐段比较时必须沿用**整条路径**的风格：单看一段（如 `Game`）会被判成 POSIX，
  // 从而漏掉 Windows 的大小写折叠。两条路径只要任一是 win32 就折叠。
  const fold = pathStyle(path) === 'win32' || pathStyle(root) === 'win32';
  const same = (a: string, b: string): boolean =>
    fold ? a.toLowerCase() === b.toLowerCase() : a === b;
  for (let i = 0; i < rs.length; i++) {
    if (!same(ps[i]!, rs[i]!)) return null;
  }
  return ps.slice(rs.length);
}

/**
 * 函数路径 → 口上包键。
 *
 * 优先按角色口上目录取第一层子目录；对不上角色目录时再退到口上索引根
 * （`<root>/<角色目录>/<包>/…`，取第二段）；仍取不到 = 索引外。
 */
export function authorPackKeyOf(
  filePath: string,
  charaDir: string | undefined,
  kojoRoots: readonly string[] = [],
): string {
  if (charaDir) {
    const rel = relativeSegments(filePath, charaDir);
    if (rel) return rel.length <= 1 ? ROOT_PACK_KEY : rel[0]!;
  }
  for (const root of kojoRoots) {
    const rel = relativeSegments(filePath, root);
    if (!rel) continue;
    // 至少 `<角色目录>/<包>/<文件>`；不足两段说明根下直接就是文件，无法认包
    if (rel.length >= 3) return rel[1]!;
    if (rel.length === 2) return ROOT_PACK_KEY;
  }
  return EXTERNAL_PACK_KEY;
}

function labelOfPackKey(key: string): string {
  if (key === ROOT_PACK_KEY) return '（角色根目录）';
  if (key === EXTERNAL_PACK_KEY) return '（索引外文件）';
  return key;
}

/** 非外部的包目录绝对路径；根散文件 = 角色目录本身 */
export function authorPackDirOf(
  key: string,
  charaDir: string | undefined,
): string | null {
  if (key === EXTERNAL_PACK_KEY || !charaDir) return null;
  return key === ROOT_PACK_KEY ? charaDir : join(charaDir, key);
}

/**
 * 聚合当前角色的口上包清单（按目录名排序，根散文件在前、索引外最后）。
 * 空清单 = 该角色没有可归包的函数（通常不该出现：有函数就有路径）。
 */
export function collectAuthorPacks(
  entry: CharacterEntry,
  charaDir: string | undefined,
  kojoRoots: readonly string[] = [],
): AuthorPack[] {
  const acc = new Map<string, { count: number; files: Set<string> }>();
  for (const fn of entry.functions) {
    const key = authorPackKeyOf(fn.filePath, charaDir, kojoRoots);
    let rec = acc.get(key);
    if (!rec) {
      rec = { count: 0, files: new Set<string>() };
      acc.set(key, rec);
    }
    rec.count++;
    rec.files.add(pathKey(fn.filePath));
  }
  const packs: AuthorPack[] = [...acc.entries()].map(([key, rec]) => ({
    key,
    dirName: key === ROOT_PACK_KEY || key === EXTERNAL_PACK_KEY ? '' : key,
    label: labelOfPackKey(key),
    dirPath: authorPackDirOf(key, charaDir),
    functionCount: rec.count,
    fileCount: rec.files.size,
    isRoot: key === ROOT_PACK_KEY,
    isExternal: key === EXTERNAL_PACK_KEY,
  }));
  packs.sort((a, b) => {
    const rank = (p: AuthorPack): number => (p.isRoot ? 0 : p.isExternal ? 2 : 1);
    const dr = rank(a) - rank(b);
    return dr !== 0 ? dr : a.label.localeCompare(b.label);
  });
  return packs;
}

/** 只保留指定口上包的函数（faces 随之收窄；其余字段逐字保留） */
export function filterEntryByPack(
  entry: CharacterEntry,
  packKey: string,
  charaDir: string | undefined,
  kojoRoots: readonly string[] = [],
): CharacterEntry {
  const functions = entry.functions.filter(
    (fn) => authorPackKeyOf(fn.filePath, charaDir, kojoRoots) === packKey,
  );
  const present = new Set(functions.map((fn) => fn.face));
  return {
    no: entry.no,
    faces: entry.faces.filter((face) => present.has(face)),
    functions,
  };
}

/**
 * 工作区 artifact → 本项目包目录的匹配（按 dirName 判等，大小写折叠）。
 * 同一目录名命中多个 artifact 时按「项目 id + artifact id」取第一个（确定性）；
 * 面板会把这个选择原样显示（项目名/包名），不静默。
 */
export function matchWorkspacePacks(
  packs: readonly AuthorPack[],
  projects: readonly WorkspaceProject[],
  projectDir: (projectId: string) => string | null,
): Map<string, WorkspacePackRef> {
  const byDir = new Map<string, WorkspacePackRef>();
  const candidates: WorkspacePackRef[] = [];
  for (const project of projects) {
    for (const artifact of project.artifacts) {
      if (!artifact.dirName) continue;
      let rootPath: string;
      try {
        const dir = projectDir(project.id);
        if (!dir) continue;
        rootPath = join(dir, artifact.dirName);
      } catch {
        continue;
      }
      candidates.push({
        projectId: project.id,
        projectName: project.name,
        artifactId: artifact.id,
        artifactName: artifact.name,
        dirName: artifact.dirName,
        rootPath,
      });
    }
  }
  candidates.sort(
    (a, b) =>
      a.projectId.localeCompare(b.projectId) || a.artifactId.localeCompare(b.artifactId),
  );
  for (const pack of packs) {
    if (!pack.dirName) continue;
    const target = pathKey(pack.dirName);
    const hit = candidates.find((c) => pathKey(c.dirName) === target);
    if (hit) byDir.set(pack.key, hit);
  }
  return byDir;
}

/* ------------------------------ 剧情线选格 ------------------------------ */

/** 一格引用（行键 + 列键） */
export interface CellRef {
  readonly rowKey: string;
  readonly columnKey: string;
}

/** 键判等：变量名大小写不敏感（`CFLAG` / `cflag`），下标原样 */
function normStateKey(key: string): string {
  return key.replace(/^([^:]+)/, (m) => m.toUpperCase());
}

/**
 * 状态键的扩展等价形态：具名下标与纯数字下标在真实口上都存在，adapter 的
 * 预设可能只给了其中一种。这里**只做大小写与全半角无关的精确归一**，
 * 不猜「好感度 = 2」——编号与名字的对应是游戏知识，由 adapter 预设自行列全。
 */
function sameStateKey(a: string, b: string): boolean {
  return normStateKey(a) === normStateKey(b);
}

/** 剧情线命中的行（保持矩阵行序） */
export function storyLineRows(
  matrix: ConditionMatrix,
  preset: Pick<StateLinePreset, 'keys'>,
): MatrixRow[] {
  const keys = preset.keys.filter((k) => k.length > 0);
  if (keys.length === 0) return [];
  return matrix.rows.filter((row) => keys.some((k) => sameStateKey(row.key, k)));
}

/**
 * 指定行在**当前可见列**上的空格集合（列折叠时不选——作者看不见的格子不该被
 * 静默塞进草稿）。行不存在 / 列不存在都不猜，跳过即可。
 */
export function gapCellsOfRows(
  matrix: ConditionMatrix,
  rowKeys: ReadonlySet<string>,
  visibleColumnKeys: readonly string[],
): CellRef[] {
  const out: CellRef[] = [];
  for (const row of matrix.rows) {
    if (!rowKeys.has(row.key)) continue;
    for (const colKey of visibleColumnKeys) {
      if (!row.cells[colKey]?.present) out.push({ rowKey: row.key, columnKey: colKey });
    }
  }
  return out;
}

/** 覆盖率的展示口径：0 格时给 0，避免 0/0 变成 NaN */
export function coveragePercent(filled: number, total: number): number {
  if (!(total > 0)) return 0;
  return Math.round((filled / total) * 100);
}
