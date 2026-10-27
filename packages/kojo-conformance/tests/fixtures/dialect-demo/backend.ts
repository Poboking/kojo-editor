/**
 * 第三列的**发射面**（`KojoEmitBackend`）：本列自己的机壳 + eraFL 的通用 Emuera 落点。
 *
 * ## 为什么可以复用 eraFL 的 backend
 *
 * "profile"（本批判据面）＝ `GameAdapter` 数据；**发射面是引擎事实**（Emuera 系怎么写
 * `PRINTFORM`/`IF`/`SETCOLOR`），不是某部游戏的知识。第三列要证明的是
 * 「新增一个 **profile 包** ⇒ 多一列」，不是"再写一份 ERB 发射器"——那属 adapter 自己的
 * 交付面（eraFL 的 `backend.ts` 就是它那一列自己写的）。
 *
 * 因此本文件只覆盖三格**本列自己的**事实：
 * 1. `id`（读数不同源会在 kit 的契约自检里红）；
 * 2. `wrapMachine`：`# 机` 落 `@<本列引擎 token>` + `#LATER`（token 来自本列事件表）；
 * 3. `profile`：与本列 adapter 声明的落点逐项相同（`readings 同源` 的判据）。
 *
 * 机壳里其余部分（隐藏槽声明 / 4 空格体缩进）与 eraFL 逐字同形——这是"共享用例的
 * body 能逐字节对齐"的前提，也是"机壳属各方言"的边界所在。
 */
import type {
  KojoEmitBackend,
  KojoHiddenSlot,
  KojoLoweringProfile,
  MachineWrapRequest,
} from '@kojo/kojo-core';
import { createEraflEmitBackend, eraflLoweringProfile } from '../../../../plugins/erafl-adapter/src/kojo2/backend.js';

import { DEMO_EVENT_CATALOG } from './adapter.js';

/** 函数体缩进（与 eraFL / eraTW 同形：1 级 = 4 空格） */
const INDENT = '    ';

/** 隐藏槽 → 函数内变量声明（`int` → `#DIM`；`string` → `#DIMS`，按 core 给的类型事实） */
function slotLine(slot: KojoHiddenSlot): string {
  return `${slot.valueType === 'string' ? '#DIMS' : '#DIM'} ${slot.name}`;
}

/** 本列的机壳：`;kojo2:` 原样 + `@DEMO_FIRST` + `#LATER` + 槽声明 + 体 */
function demoWrapMachine(request: MachineWrapRequest): readonly string[] {
  const spec = DEMO_EVENT_CATALOG.events.find((item) => item.event === request.machine.event);
  if (spec === undefined) return [];
  const argsText = request.machine.args.length === 0 ? '' : ` ${request.machine.args.join(' ')}`;
  return [
    `;kojo2: # 机 ${request.machine.event}${argsText}`,
    `@${spec.engine}`,
    '#LATER',
    ...request.slots.map(slotLine),
    ...request.body.map((line) => (line.length === 0 ? '' : `${INDENT}${line}`)),
  ];
}

/** 本列 profile 的降糖读数（与本列 adapter 声明逐项对齐；字面量与 `adapter.ts` 同源） */
export function demoLoweringProfile(): KojoLoweringProfile {
  return Object.freeze({
    ...eraflLoweringProfile(),
    programFeatures: Object.freeze({
      arrays: true,
      while: true,
      goto: true,
      recursion: false,
      foreach: false,
      repeat: true,
    }),
  });
}

/** 第三列的 `KojoEmitBackend`：通用 Emuera 落点 + 本列机壳 */
export function createDemoEmitBackend(deps: {
  readonly compileExpression: (expr: { readonly text: string }) => string;
}): KojoEmitBackend {
  const base = createEraflEmitBackend(deps);
  return Object.freeze({
    ...base,
    id: 'demo',
    profile: demoLoweringProfile(),
    wrapMachine: demoWrapMachine as KojoEmitBackend['wrapMachine'],
  });
}
