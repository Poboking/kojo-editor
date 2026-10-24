/**
 * 2.0 adapter 按项目解析的判据（K2 入口 A：宿主接线）。
 *
 * ## 为什么存在
 *
 * 六条 2.0 语言面（补全 / 悬停 / 签名 / 行内提示 / 转定义 / 文档符号）的 adapter 供给
 * 一度在 `ui/editor-pane/use-monaco-instance.ts` 里写死成 eraTW：开 eraFL 工程时那六条
 * 腿拿到的是 **eraTW 的游戏事实**（事件目录 / 域符号 / profile 全是别家游戏的），而且
 * 错得安静——候选照样出，只是内容不对。入口 A 把供给改成组合根按当前项目解析
 * （`bootstrap.ts` 登记表），本文件钉死判据：
 *
 * 1. 已登记的游戏（eraTW）⇒ 拿到**同一枚**冻结实例（回归：eraTW 工程行为逐字不变）；
 * 2. eraFL 工程 ⇒ 拿到 eraFL 的 2.0 adapter（入口 B 落地后的翻面判据；入口 A 时
 *    此处是 `null` ⇒ 零候选，正是"先把错误事实掐掉"的那个中间态）；
 * 3. 未知 id / 无项目 ⇒ `null`（不猜，也不默认顶别家）；
 * 4. `registerKojo2Adapter` 扩容口子（入口 B 起 eraFL 的 2.0 面经它登记；同 id 覆盖）；
 * 5. 源码形态守门（照 `debug-surface.test.ts` 先例）：`use-monaco-instance.ts` 不再直引
 *    eraTW 的冻结 adapter，getter 改调 `kojo2AdapterForProject(kernel.project.current())`；
 *    `bootstrap.ts` 在项目级装载处登记 eraFL 的 2.0 adapter（入口 B 接线）。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { kojo2AdapterForProject, registerKojo2Adapter } from '../src/bootstrap';
import { ERAFL_GAME_ADAPTER } from '@kojo/plugin-erafl-adapter';
import { ERATW_GAME_ADAPTER } from '@kojo/plugin-eratw-adapter';
import type { GameAdapter } from '@kojo/kojo-core';
import type { GameProject } from '@kojo/plugin-api';

/** 解析器只读 `adapterId` 一个字段 ⇒ 最小夹具（形状不参与判据，cast 即够） */
const proj = (adapterId: string): GameProject => ({ adapterId }) as unknown as GameProject;

/** 同上：登记表只做 Map 存取，冻结数据的内容不参与判据 */
const fakeAdapter = (id: string): GameAdapter => ({ id }) as unknown as GameAdapter;

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const read = (rel: string): string => readFileSync(path.join(repoRoot, rel), 'utf8');

describe('kojo2AdapterForProject（2.0 adapter 按当前项目解析）', () => {
  it('eraTW 工程 ⇒ 拿到登记的那同一枚冻结实例（回归：行为逐字不变）', () => {
    expect(kojo2AdapterForProject(proj('eratw'))).toBe(ERATW_GAME_ADAPTER);
  });

  it('eraFL 工程 ⇒ 拿到 eraFL 的 2.0 adapter（入口 B 翻面；入口 A 时此处是 null）', () => {
    // 生产登记点 = bootstrap.loadProjectPlugins 的模块装载处（下方源码守门钉死）；
    // 本测试用**真包数据**复现那一步登记，验证"真数据 + 真解析"闭环。
    registerKojo2Adapter('erafl', ERAFL_GAME_ADAPTER);
    expect(kojo2AdapterForProject(proj('erafl'))).toBe(ERAFL_GAME_ADAPTER);
  });

  it('未知 id / 无项目 ⇒ null（不猜、不默认顶别家）', () => {
    expect(kojo2AdapterForProject(proj('eraakumamaid'))).toBeNull();
    expect(kojo2AdapterForProject(proj('nope'))).toBeNull();
    expect(kojo2AdapterForProject(null)).toBeNull();
  });
});

describe('registerKojo2Adapter（扩容口子：入口 B 的登记通道）', () => {
  it('登记后该 id 可解析，且不殃及既有登记', () => {
    registerKojo2Adapter('test-fake', fakeAdapter('test-fake'));
    expect(kojo2AdapterForProject(proj('test-fake'))).not.toBeNull();
    expect(kojo2AdapterForProject(proj('test-fake'))?.id).toBe('test-fake');
    // 扩容不许动到常驻那枚（eraTW 回归）
    expect(kojo2AdapterForProject(proj('eratw'))).toBe(ERATW_GAME_ADAPTER);
  });

  it('同 id 重复登记以最后一次为准', () => {
    registerKojo2Adapter('test-fake', fakeAdapter('first'));
    registerKojo2Adapter('test-fake', fakeAdapter('second'));
    expect(kojo2AdapterForProject(proj('test-fake'))?.id).toBe('second');
  });
});

describe('源码形态守门：use-monaco-instance 的 adapter 供给已接线到登记表', () => {
  const src = read('packages/app/src/ui/editor-pane/use-monaco-instance.ts');

  it('不再直引 eraTW 的冻结 adapter（写死别家游戏的旧形态）', () => {
    expect(src).not.toMatch(/ERATW_GAME_ADAPTER/);
  });

  it('getter 按当前项目现取', () => {
    expect(src).toMatch(/kojo2AdapterForProject\(kernel\.project\.current\(\)\)/);
  });

  it('bootstrap 在项目级装载处登记 eraFL 的 2.0 adapter（入口 B 接线，键取 v1 gameId 常量）', () => {
    const boot = read('packages/app/src/bootstrap.ts');
    expect(boot).toMatch(/registerKojo2Adapter\(eraflAdapter\.ERAFL\.gameId, eraflAdapter\.ERAFL_GAME_ADAPTER\)/);
  });
});
