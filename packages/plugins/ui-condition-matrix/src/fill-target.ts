/**
 * 填格模板的**落盘链路**（工作区 / 游戏目录两条；零 React）。
 *
 * 写安全不新开通道：
 *   - 工作区 = 常驻可写根，写走 `kernel.workspaces` 的项目内相对路径（越界拒绝）；
 *   - 游戏目录 = 仍走 `kernel.io` 第一道闸（目标不在批准的可写域 → 先 `isWritable`
 *     给一句人话，再写，绝不留半成品）。
 *
 * 追加只碰选定的既有文件：先读原文（编码/EOL 由 io 探测并在写回时保持），再在末尾
 * 追加模板；新文件由调用方给文件名（本模块只做单层名合法性与重名检查）。
 */

import type { FileIO, WorkspaceService } from '@kojo/plugin-api';
import { ERB_BODY_EXTENSIONS, isErbBodyPath, isErbDialectPath, join } from '@kojo/plugin-api';
import type { FillLanguage, FillPack } from './matrix-fill';
import type { WorkspacePackRef } from './matrix-scope';
import { relativeSegments } from './matrix-scope';

export type FillPlace = 'workspace' | 'game';
export type FillTargetMode = 'new' | 'append';

/** 追加目标文件（列表项） */
export interface FillFileItem {
  /** 相对包目录的 POSIX 路径（显示与工作区写回都用它） */
  readonly relPath: string;
  readonly absPath: string;
}

/** 追加写入的请求 */
export interface FillWriteRequest {
  readonly io: FileIO;
  readonly workspaces?: WorkspaceService;
  readonly place: FillPlace;
  readonly mode: FillTargetMode;
  readonly language: FillLanguage;
  readonly code: string;
  readonly pack: FillPack;
  readonly workspace?: WorkspacePackRef;
  /** mode='new'：文件名（单层；无扩展名时自动补） */
  readonly fileName: string;
  /** mode='append'：列表选中的文件 */
  readonly file?: FillFileItem;
}

export type FillWriteResult =
  | { readonly ok: true; readonly path: string; readonly line: number }
  | { readonly ok: false; readonly reason: string };

/** 可作为追加目标的源文件（口上正文；.kojo 也算） */
export function isFillSourceName(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower.endsWith('.kojo')) return true;
  return isErbBodyPath(name);
}

/**
 * 列出包目录下可追加的源文件（递归；按相对路径排序）。
 * 读失败原样抛给调用方——面板要把它当可见错误显示，不能当作"没有文件"。
 */
export async function listFillFiles(io: FileIO, rootPath: string): Promise<FillFileItem[]> {
  const entries = await io.walkDir(rootPath, {
    includeFiles: true,
    includeDirs: false,
    filter: (e) => !e.isDirectory && isFillSourceName(e.name),
  });
  const out: FillFileItem[] = [];
  for (const entry of entries) {
    const rel = relativeSegments(entry.path, rootPath);
    if (!rel || rel.length === 0) continue;
    out.push({ relPath: rel.join('/'), absPath: entry.path });
  }
  out.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return out;
}

/** 语言对应的新文件扩展名（ERB 侧从契约层清单派生，不另写一份口径） */
export function fillExtension(language: FillLanguage): string {
  return language === 'kojo' ? '.kojo' : ERB_BODY_EXTENSIONS[0]!.toUpperCase();
}

/** 文件名消毒：单层、去非法字符、空名给兜底 */
export function sanitizeFillFileName(name: string, language: FillLanguage): string {
  let base = name.replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim();
  if (!base || base === '.' || base === '..') base = '条件矩阵填空';
  const lower = base.toLowerCase();
  if (lower.endsWith('.kojo') || isErbDialectPath(base)) {
    base = base.slice(0, base.lastIndexOf('.'));
  }
  // 扩展名按语言统一：内容与扩展名不一致的 `.ERB` 里塞糖语法会直接把游戏脚本写坏
  return `${base}${fillExtension(language)}`;
}

/** 建议的新文件名（取首个时机的标签，过长则截断） */
export function suggestFillFileName(
  charaNo: number,
  firstColumnLabel: string,
  language: FillLanguage,
): string {
  const label = firstColumnLabel.replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 24);
  return sanitizeFillFileName(
    `条件矩阵填空-K${charaNo}${label ? `-${label}` : ''}${fillExtension(language)}`,
    language,
  );
}

/**
 * 追加后的文本与「第一行新内容」的行号。
 * 与既有内容之间留一行空行（原文为空则直接从第 1 行开始）。
 */
export function appendFillText(
  original: string,
  code: string,
): { text: string; line: number } {
  if (original.length === 0) return { text: `${code}\n`, line: 1 };
  const endsNl = original.endsWith('\n');
  const prefix = endsNl ? '\n' : '\n\n';
  const line = original.split('\n').length + (endsNl ? 1 : 2);
  return { text: `${original}${prefix}${code}\n`, line };
}

function extOf(path: string): string {
  return path.slice(path.lastIndexOf('.')).toLowerCase();
}

/** 追加目标的扩展名与语言是否兼容（.kojo 接受两种；.ERB 只接受原生） */
export function appendLanguageConflict(path: string, language: FillLanguage): string | null {
  const ext = extOf(path);
  if (ext === '.kojo') return null;
  if (language === 'kojo') {
    return `目标文件是 ${ext}：只能追加原生 ERB 写法。请把语言切换为「ERB」，或选择一个 .kojo 文件。`;
  }
  return null;
}

/**
 * 执行写入。四类前置判定都在动盘之前：目标可写 / 同名不覆盖 / 追加文件存在 /
 * 语言与扩展名兼容。失败一律返回人话原因（不抛给 UI 猜）。
 */
export async function writeFill(req: FillWriteRequest): Promise<FillWriteResult> {
  const { io, workspaces, place, mode, language, code, pack, workspace, file } = req;
  if (code.trim().length === 0) return { ok: false, reason: '生成内容为空——先选几格空缺。' };

  if (place === 'workspace') {
    if (!workspaces) return { ok: false, reason: '内核工作区服务不可用，无法写入口上项目。' };
    if (!workspace) return { ok: false, reason: '这个口上包没有匹配到工作区项目，无法写源文件。' };
    if (mode === 'new') {
      const name = sanitizeFillFileName(req.fileName, language);
      const absPath = join(workspace.rootPath, name);
      if (await io.exists(absPath)) {
        return { ok: false, reason: `同名文件已存在，未覆盖：${name}` };
      }
      try {
        await workspaces.writeText(workspace.projectId, `${workspace.dirName}/${name}`, `${code}\n`);
        return { ok: true, path: absPath, line: 1 };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    }
    if (!file) return { ok: false, reason: '请选择要追加的文件。' };
    const conflict = appendLanguageConflict(file.relPath, language);
    if (conflict) return { ok: false, reason: conflict };
    const relInProject = `${workspace.dirName}/${file.relPath}`;
    try {
      const text = await workspaces.readText(workspace.projectId, relInProject);
      const next = appendFillText(text.text, code);
      await workspaces.writeText(workspace.projectId, relInProject, next.text);
      return { ok: true, path: file.absPath, line: next.line };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  // ---- 游戏目录 ----
  if (!pack.dirPath) {
    return { ok: false, reason: '这个口上包没有可写的目录（索引外文件）。' };
  }
  if (mode === 'new') {
    const name = sanitizeFillFileName(req.fileName, language);
    const target = join(pack.dirPath, name);
    if (!io.isWritable(target)) {
      return {
        ok: false,
        reason: '目标不在写允许域内：请先批准游戏目录的写权限，或改写到「我的口上项目」。',
      };
    }
    if (await io.exists(target)) {
      return { ok: false, reason: `同名文件已存在，未覆盖：${name}` };
    }
    try {
      await io.writeText(target, `${code}\n`);
      return { ok: true, path: target, line: 1 };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }
  if (!file) return { ok: false, reason: '请选择要追加的文件。' };
  const conflict = appendLanguageConflict(file.absPath, language);
  if (conflict) return { ok: false, reason: conflict };
  if (!io.isWritable(file.absPath)) {
    return {
      ok: false,
      reason: '目标文件不在写允许域内：请先批准游戏目录的写权限，或改写到「我的口上项目」。',
    };
  }
  try {
    const text = await io.readText(file.absPath);
    const next = appendFillText(text.text, code);
    await io.writeText(file.absPath, next.text);
    return { ok: true, path: file.absPath, line: next.line };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
