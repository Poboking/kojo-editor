/**
 * 测试脚手架：Node 真盘 FileIO + 插件激活取 adapter。
 *
 * 为什么不用内存桩跑真盘用例：detect / loadProject 要覆盖 2,013 份 ERB 与 144 个
 * 口上条目的真实形态，桩造出来的目录树只能证明"代码自洽"，证明不了"认得出这盘"。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join as nodeJoin } from 'node:path';
import type { FileIO, GameAdapter, PluginContext } from '@kojo/plugin-api';
import { createEraflAdapterPlugin } from '../src/plugin';

/** 只读的 Node 文件系统实现（够 detect / loadProject 用；写方法一律不提供） */
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
    readText: async (path: string) => {
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
    },
  } as unknown as FileIO;
}

const silentLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/** 激活插件并从 `game.adapter` 槽位取回 adapter（与组合根同一条接线路径） */
export function activateAdapter(io: FileIO): GameAdapter {
  let adapter: GameAdapter | undefined;
  /** 本插件 provide 出去的服务（口上 XML 索引），测试可断言"确实注册了" */
  const provided = new Map<string, unknown>();
  const ctx = {
    pluginId: 'erafl-adapter',
    log: silentLog,
    onDispose: () => {},
    provide: (key: string, value: unknown) => {
      provided.set(key, value);
    },
    bus: { emit: () => {}, on: () => () => {} },
    tryInject: () => undefined,
    inject: <T,>(key: string): T => {
      if (key === 'kernel.io') return io as unknown as T;
      throw new Error(`unexpected inject: ${key}`);
    },
    slots: {
      register: (_slot: string, item: unknown) => {
        adapter = (item as { adapter: GameAdapter }).adapter;
        return () => {};
      },
    },
  } as unknown as PluginContext;

  createEraflAdapterPlugin().activate(ctx);
  if (!adapter) throw new Error('插件没有注册 game.adapter 槽位');
  return adapter;
}

/** 取插件 provide 的服务（未注册 = undefined） */
export function serviceOf(io: FileIO, key: string): unknown {
  const provided = new Map<string, unknown>();
  const ctx = {
    pluginId: 'erafl-adapter',
    log: silentLog,
    onDispose: () => {},
    provide: (k: string, v: unknown) => {
      provided.set(k, v);
    },
    bus: { emit: () => {}, on: () => () => {} },
    tryInject: () => undefined,
    inject: <T,>(k: string): T => {
      if (k === 'kernel.io') return io as unknown as T;
      throw new Error(`unexpected inject: ${k}`);
    },
    slots: { register: () => () => {} },
  } as unknown as PluginContext;
  createEraflAdapterPlugin().activate(ctx);
  return provided.get(key);
}
