/**
 * 测试脚手架：Node 真盘 FileIO + 插件激活取 adapter。
 *
 * 为什么不用内存桩跑真盘用例：detect / loadProject / 家族识别要覆盖 403 份 ERB、
 * 10 个角色目录、43 份 CSV 与 5 份 ERH 的真实形态，桩造出来的目录树只能证明
 * "代码自洽"，证明不了"认得出这盘"。
 *
 * 与 eraFL 的 harness 相比补齐了 `readTexts` / `walkDir` / `readBytes`：本适配器
 * 的变量字典确实要走批量读与递归扫描，缺失这三个方法会让真盘 schema 用例静默降级
 * （loadProject 的 try/catch 会把 TypeError 吞成"没有字典"）。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join as nodeJoin, relative as nodeRelative, sep } from 'node:path';
import type { DirEntry, FileIO, GameAdapter, PluginContext } from '@kojo/plugin-api';
import { createKoumakanAdapterPlugin } from '../src/plugin';

const silentLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function textFile(path: string): {
  path: string;
  text: string;
  encoding: 'utf-8' | 'utf-8-bom';
  eol: 'crlf' | 'lf';
  mtimeMs: number;
} {
  const raw = readFileSync(path, 'utf8');
  const hadBom = raw.charCodeAt(0) === 0xfeff;
  const text = hadBom ? raw.slice(1) : raw;
  return {
    path,
    text,
    encoding: hadBom ? 'utf-8-bom' : 'utf-8',
    eol: text.includes('\r\n') ? 'crlf' : 'lf',
    mtimeMs: statSync(path).mtimeMs,
  };
}

function walkAll(path: string, root: string): DirEntry[] {
  const out: DirEntry[] = [];
  for (const d of readdirSync(path, { withFileTypes: true })) {
    const p = nodeJoin(path, d.name);
    out.push({ name: d.name, path: p, isDirectory: d.isDirectory() });
    if (d.isDirectory()) out.push(...walkAll(p, root));
  }
  return out;
}

/** 只读的 Node 文件系统实现（写方法一律不提供） */
export function nodeIo(): FileIO {
  return {
    exists: async (path: string) => existsSync(path),
    stat: async (path: string) => {
      try {
        const s = statSync(path);
        return { size: s.size, mtimeMs: s.mtimeMs, isDirectory: s.isDirectory() };
      } catch {
        return null;
      }
    },
    listDir: async (path: string) =>
      readdirSync(path, { withFileTypes: true }).map((d) => ({
        name: d.name,
        path: nodeJoin(path, d.name),
        isDirectory: d.isDirectory(),
      })),
    readText: async (path: string) => textFile(path),
    readTexts: async (paths: readonly string[]) =>
      paths.map((p) => {
        try {
          return textFile(p);
        } catch {
          return null;
        }
      }),
    readBytes: async (path: string) => new Uint8Array(readFileSync(path)),
    walkDir: async (path: string) => walkAll(path, path),
  } as unknown as FileIO;
}

/* ------------------------------ 内存盘（合成用例） ------------------------------ */

/**
 * 内存盘：`files` 是「绝对路径 → 正文」，`dirs` 是显式目录（含空目录）。
 * 路径按 `/` 归一后比较（`join()` 在 win32 盘符下产出 `\`）。
 */
export function memIo(files: Record<string, string>, dirs: readonly string[]): FileIO {
  const norm = (p: string) => p.replace(/\\/g, '/');
  const fileMap = new Map(Object.entries(files).map(([k, v]) => [norm(k), v]));
  const dirSet = new Set(dirs.map(norm));

  /** 由文件路径补出所有父目录 */
  for (const p of fileMap.keys()) {
    let i = p.lastIndexOf('/');
    while (i > 0) {
      dirSet.add(p.slice(0, i));
      i = p.lastIndexOf('/', i - 1);
    }
  }

  const directChildren = (path: string): DirEntry[] => {
    const prefix = `${norm(path).replace(/\/+$/, '')}/`;
    const found = new Map<string, boolean>();
    for (const p of fileMap.keys()) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      if (rest.length === 0 || rest.includes('/')) continue;
      found.set(rest, false);
    }
    for (const d of dirSet) {
      if (!d.startsWith(prefix)) continue;
      const rest = d.slice(prefix.length);
      if (rest.length === 0 || rest.includes('/')) continue;
      found.set(rest, true);
    }
    return [...found].map(([name, isDirectory]) => ({
      name,
      path: `${prefix}${name}`,
      isDirectory,
    }));
  };

  const allEntries = (path: string): DirEntry[] => {
    const prefix = `${norm(path).replace(/\/+$/, '')}/`;
    const out: DirEntry[] = [];
    for (const [p] of fileMap) {
      if (p.startsWith(prefix)) {
        out.push({ name: p.slice(p.lastIndexOf('/') + 1), path: p, isDirectory: false });
      }
    }
    for (const d of dirSet) {
      if (d.startsWith(prefix)) {
        out.push({ name: d.slice(d.lastIndexOf('/') + 1), path: d, isDirectory: true });
      }
    }
    return out;
  };

  return {
    exists: async (path: string) => fileMap.has(norm(path)) || dirSet.has(norm(path)),
    stat: async (path: string) =>
      dirSet.has(norm(path))
        ? { size: 0, mtimeMs: 0, isDirectory: true }
        : fileMap.has(norm(path))
          ? { size: 1, mtimeMs: 0, isDirectory: false }
          : null,
    listDir: async (path: string) => directChildren(path),
    readText: async (path: string) => {
      const text = fileMap.get(norm(path));
      if (text === undefined) throw new Error(`ENOENT: ${path}`);
      return { path, text, encoding: 'utf-8', eol: 'lf', mtimeMs: 0 };
    },
    readTexts: async (paths: readonly string[]) =>
      paths.map((path) => {
        const text = fileMap.get(norm(path));
        return text === undefined
          ? null
          : { path, text, encoding: 'utf-8' as const, eol: 'lf' as const, mtimeMs: 0 };
      }),
    readBytes: async (path: string) => {
      const text = fileMap.get(norm(path));
      if (text === undefined) throw new Error(`ENOENT: ${path}`);
      return new TextEncoder().encode(text);
    },
    walkDir: async (path: string) => allEntries(path),
  } as unknown as FileIO;
}

/* ------------------------------ 插件激活 ------------------------------ */

export interface ActivatedAdapter {
  readonly adapter: GameAdapter;
  /** 本插件注册过的全部槽位（`game.adapter` / `search.scope`） */
  readonly slots: ReadonlyArray<{ slot: string; item: unknown }>;
}

/** 激活插件并按槽位取回 adapter + 槽位清单（与组合根同一条接线路径） */
export function activateAdapter(io: FileIO): ActivatedAdapter {
  let adapter: GameAdapter | undefined;
  const slots: Array<{ slot: string; item: unknown }> = [];
  const ctx = {
    pluginId: 'erakoumakan-adapter',
    log: silentLog,
    onDispose: () => {},
    provide: () => {},
    bus: { emit: () => {}, on: () => () => {} },
    tryInject: () => undefined,
    inject: <T,>(key: string): T => {
      if (key === 'kernel.io') return io as unknown as T;
      throw new Error(`unexpected inject: ${key}`);
    },
    slots: {
      register: (slot: string, item: unknown) => {
        slots.push({ slot, item });
        if (slot === 'game.adapter') {
          adapter = (item as { adapter: GameAdapter }).adapter;
        }
        return () => {};
      },
    },
  } as unknown as PluginContext;

  createKoumakanAdapterPlugin().activate(ctx);
  if (!adapter) throw new Error('插件没有注册 game.adapter 槽位');
  return { adapter, slots };
}

/** 只要 adapter 的便捷入口（大多数用例不需要槽位清单） */
export function adapterOf(io: FileIO): GameAdapter {
  return activateAdapter(io).adapter;
}

/* ------------------------------ 真盘小工具 ------------------------------ */

/** 真盘根（注意：盘上是 `D:/Game/...`，Windows 大小写不敏感） */
export const GAME_ROOT = 'D:/Game/eraKoumakan';

/** 递归列出真盘某目录下指定扩展名的文件（绝对路径） */
export function listFilesRecursive(root: string, ext: RegExp): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      const p = nodeJoin(dir, d.name);
      if (d.isDirectory()) walk(p);
      else if (ext.test(d.name)) out.push(p);
    }
  };
  walk(root);
  return out;
}

/** 真盘文件相对某个根的路径（正斜杠，便于断言） */
export function relOf(root: string, path: string): string {
  return nodeRelative(root, path).split(sep).join('/');
}
