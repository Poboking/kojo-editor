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

/* --------------------------- 我的口上项目（按角色归属） --------------------------- */

/** ws 包键前缀（矩阵 matrixKey / option value 共用；projectId/artifactId 为内核生成 id） */
export const WORKSPACE_PACK_PREFIX = 'ws:';

/** 「我的口上项目」里归属当前角色的一枚 artifact（下拉 / 工作区矩阵的选项） */
export interface WorkspaceMatrixPack {
  /** `${WORKSPACE_PACK_PREFIX}${projectId}:${artifactId}` */
  readonly key: string;
  readonly ref: WorkspacePackRef;
  /** 例：`我的：${artifactName}`（项目名放 title，由 UI 负责） */
  readonly label: string;
  /** 归属判据（优先级 meta > source > dirName，命中的那一条） */
  readonly attribution: 'meta' | 'source' | 'dirName';
}

/** 工作区 artifact 的矩阵包键（projectId/artifactId 由内核生成，形如 UUID，不含冒号） */
export function workspacePackKey(projectId: string, artifactId: string): string {
  return `${WORKSPACE_PACK_PREFIX}${projectId}:${artifactId}`;
}

/** 制品 meta 里的角色号（number 或纯数字字符串；其余形态一律视为「没有」） */
function metaCharaNoOf(meta: Record<string, unknown>): number | null {
  const raw = meta.charaNo;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (!/^[0-9]+$/.test(text)) return null;
    return Number(text);
  }
  return null;
}

/** 制品 meta 里的导入来源目录（只认非空字符串；是否位于角色目录下另判） */
function importedFromOf(meta: Record<string, unknown>): string | null {
  const raw = meta.importedFrom;
  return typeof raw === 'string' && raw.trim().length > 0 ? raw : null;
}

/**
 * 目录名判等键（大小写折叠）。
 *
 * `dirName` 是单层名，不含盘符/分隔符——单给 `pathKey` 会被判成 POSIX 而**不折**
 * 大小写（`MyPack` ≠ `mypack`），可部署落点在 Windows 游戏目录里，两者是同一个包。
 * 因此先过 `pathKey`（归一化 + Windows 折叠），再统一小写补齐单层名这一档。
 */
function dirNameKey(name: string): string {
  return pathKey(name).toLowerCase();
}

/**
 * 「我的口上项目」→ 归属当前角色的 artifact 清单。
 *
 * 与 `matchWorkspacePacks`（按 dirName 匹配本项目包目录）互补：这里从工作区一侧
 * 出发，让**还没有同名包目录**的 artifact（新建项目 / 刚导入）也能进条件矩阵——
 * 否则作者建完项目先得写文件、等索引出包，才能在矩阵里选到它。
 *
 * 归属判据按优先级命中即停：
 * 1. `meta`：`artifact.meta.charaNo` 与 charaNo 数值相等（number 或数字字符串）；
 * 2. `source`：`artifact.meta.importedFrom` 位于 charaDir 之下（`relativeSegments`
 *    已折叠大小写；charaDir 缺省则跳过）——导入来源就是该角色口上目录的包；
 * 3. `dirName`：与当前角色某个口上包的目录名大小写折叠相等（`pathKey`）。
 *
 * 输出按 projectName / artifactName 稳定排序（同键保持输入顺序）；同一 artifact
 * 只出现一次（`ws:` 键去重）；空 dirName、projectDir 解析不到的一律跳过。
 * 纯逻辑零 IO：`importedFrom` 只做路径判定，不检查磁盘上是否真有这个目录。
 */
export function collectWorkspaceMatrixPacks(opts: {
  charaNo: number;
  charaDir: string | undefined;
  gamePacks: readonly AuthorPack[];
  projects: readonly WorkspaceProject[];
  projectDir: (projectId: string) => string | null;
}): WorkspaceMatrixPack[] {
  const { charaNo, charaDir, gamePacks, projects, projectDir } = opts;
  const packDirs = new Set<string>();
  for (const pack of gamePacks) {
    if (pack.dirName) packDirs.add(dirNameKey(pack.dirName));
  }
  const out = new Map<string, WorkspaceMatrixPack>();
  for (const project of projects) {
    for (const artifact of project.artifacts) {
      // 制品目录名是部署落点与 rootPath 的组成部分；空名无从定位，直接跳过
      if (!artifact.dirName) continue;
      // manifest 可能被手改：meta 缺失按「没有元数据」处理，不影响目录名归属
      const meta = artifact.meta ?? {};
      let attribution: WorkspaceMatrixPack['attribution'] | null = null;
      if (metaCharaNoOf(meta) === charaNo) {
        attribution = 'meta';
      } else if (charaDir) {
        const source = importedFromOf(meta);
        if (source && relativeSegments(source, charaDir) !== null) attribution = 'source';
      }
      if (!attribution && packDirs.has(dirNameKey(artifact.dirName))) attribution = 'dirName';
      if (!attribution) continue;

      let dir: string | null;
      try {
        dir = projectDir(project.id);
      } catch {
        dir = null;
      }
      if (!dir) continue;

      const key = workspacePackKey(project.id, artifact.id);
      if (out.has(key)) continue;
      out.set(key, {
        key,
        ref: {
          projectId: project.id,
          projectName: project.name,
          artifactId: artifact.id,
          artifactName: artifact.name,
          dirName: artifact.dirName,
          rootPath: join(dir, artifact.dirName),
        },
        label: `我的：${artifact.name}`,
        attribution,
      });
    }
  }
  return [...out.values()].sort(
    (a, b) =>
      a.ref.projectName.localeCompare(b.ref.projectName) ||
      a.ref.artifactName.localeCompare(b.ref.artifactName),
  );
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
