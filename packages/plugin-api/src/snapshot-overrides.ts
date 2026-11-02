/**
 * 存档覆盖集 → 读模型预演（v0.3 口上调试统一批；游戏无关纯函数）。
 *
 * ## 为什么单独成文件（而不是住在 `snapshot.ts` 里）
 *
 * PS-10 开机图纪律：`plugin-api/src/index.ts` 是开机即解析的桶，桶里多一个**值**
 * 导出就把整个模块拽进开机图。`snapshot.ts` 有 16 KB（几乎全是契约类型），而本
 * 函数的消费者只有 `state-replay` / `ui-state-replay` 两个**动态加载**的插件——
 * 为一段调试期才跑的逻辑让开机多解析 16 KB 不划算。拆成叶子模块后进图的只有这
 * 一份（~4 KB），`snapshot.ts` 仍只以 `import type` 身份被引用（类型擦除，不入图）。
 *
 * 纪律出处：`docs/PITFALLS.md` 314（包 exports 叶子是「五处齐」的活）与
 * `packages/app/tests/ps10-eager-graph.test.ts`（闸 + 逐文件点名）。
 */

import type {
  ArchiveArrayVariable,
  ArchiveOverrideValue,
  ArchiveOverrides,
  ArchiveVariable,
  SnapshotArchive,
} from './snapshot';

/**
 * 把覆盖集应用到解析产物（v0.3 口上调试统一批；additive 纯函数）。
 *
 * 职责：**读模型预演**——注入确认前在内存里回答"这些值改掉之后回放会变成什么"，
 * 不写盘（写盘走 `SnapshotWriteService.inject`，带备份 + 回读验证）。
 *
 * 语义（与写侧 serializePayload 的覆盖语义同源）：
 * - `vars`：按 key 在 主变量区 → 全局区 → EM 区 找**首个**命中（与写侧
 *   "key 冲突时各区按流序首个命中"一致）；
 * - `chars`：块 `index`（= 角色注册号，state-view 同一寻址）→ 块内首个命中；
 * - 数组覆盖 = 单元级补丁（同下标替换、新下标插入，其余单元原样保留）；
 * - **类型不匹配的覆盖跳过**（int 变量给字符串等）——预演不伪造写侧会拒绝的
 *   改动（写侧 Int64 守卫 / 类型检查会抛，这里跳过并保持原值）；
 * - 不可覆盖的变量类型（map / xml / datatable）跳过（写侧独有能力）。
 *
 * 不可变性：**不改入参**（viewCache 按对象身份判失效，改了会把缓存一起污染）；
 * 只浅拷贝被触及的变量与容器。无一条命中 → 原对象原样返回。
 */
export function applyArchiveOverrides(archive: SnapshotArchive, overrides: ArchiveOverrides): SnapshotArchive {
  const sameIndex = (a: readonly number[], b: readonly number[]): boolean =>
    a.length === b.length && a.every((x, i) => x === b[i]);

  const patchVariable = (v: ArchiveVariable, value: ArchiveOverrideValue): ArchiveVariable | null => {
    if (v.type === 'int' || v.type === 'str') {
      if (v.type === 'int' && typeof value === 'number') return { ...v, value };
      if (v.type === 'str' && typeof value === 'string') return { ...v, value };
      return null; // 类型不匹配：跳过（不伪造写侧会拒绝的改动）
    }
    if (v.type === 'map' || v.type === 'xml' || v.type === 'datatable') return null;
    // 余下即数组族（标量已在上方处理）；窄化后 cells 可用
    if (!Array.isArray(value)) return null;
    const arr = v as ArchiveArrayVariable;
    const cells = [...arr.cells];
    for (const p of value) {
      const i = cells.findIndex((c) => sameIndex(c.index, p.index));
      if (i >= 0) cells[i] = { index: [...p.index], value: p.value };
      else cells.push({ index: [...p.index], value: p.value });
    }
    const nonEmpty = cells.filter((c) => c.value !== 0 && c.value !== '').length;
    return { ...arr, cells, nonEmpty };
  };

  let changed = false;
  let next: SnapshotArchive = archive;

  // ---- vars：主变量区 → 全局区 → EM 区，每 key 首个命中 ----
  if (overrides.vars && overrides.vars.size > 0) {
    const areas: (readonly ArchiveVariable[] | undefined)[] = [archive.vars, archive.globalVars, archive.emVars];
    const patched: ArchiveVariable[][] = [[...(archive.vars ?? [])], [...(archive.globalVars ?? [])], [...(archive.emVars ?? [])]];
    for (const [key, value] of overrides.vars) {
      for (let a = 0; a < areas.length; a++) {
        const list = areas[a];
        if (!list) continue;
        const i = list.findIndex((v) => v.key === key);
        if (i < 0) continue;
        const hit = patchVariable(list[i]!, value);
        if (hit) {
          patched[a]![i] = hit;
          changed = true;
        }
        break; // 每 key 只命中一处（与写侧"首个命中"一致）
      }
    }
    if (changed) {
      next = { ...archive, vars: patched[0], globalVars: patched[1], emVars: patched[2] };
    }
  }

  // ---- chars：块 index → 块内每 key 首个命中（vars 与 chars 可同时给，叠加生效） ----
  if (overrides.chars && overrides.chars.size > 0 && next.chars) {
    let charsChanged = false;
    const blocks = [...next.chars];
    for (const [blockIdx, vars] of overrides.chars) {
      const bi = blocks.findIndex((b) => b.index === blockIdx);
      if (bi < 0) continue;
      const block = blocks[bi]!;
      const newVars = [...block.vars];
      let blockChanged = false;
      for (const [key, value] of vars) {
        const vi = block.vars.findIndex((v) => v.key === key);
        if (vi < 0) continue;
        const hit = patchVariable(block.vars[vi]!, value);
        if (hit) {
          newVars[vi] = hit;
          blockChanged = true;
        }
      }
      if (blockChanged) {
        blocks[bi] = { ...block, vars: newVars };
        charsChanged = true;
      }
    }
    if (charsChanged) next = { ...next, chars: blocks };
  }

  return next;
}
