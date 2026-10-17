/**
 * 条件矩阵对**当前适配器**的查询面（从 `index.ts` 的 `activate()` 原样迁出）。
 *
 * 六件事全部经 `game.adapter` 槽位贡献取（按 `adapterId` 精确匹配，多适配器共存
 * 天然正确）：家族规则、变量语义字典、指令表、面标签、状态键标签、单函数状态依赖。
 *
 * 铁律 3：本模块**不认识任何游戏名词**，也不 import 适配器插件——游戏知识只经
 * 槽位贡献流进来；缺贡献时一律回退 `null` / `undefined`，由消费方原样显示 token。
 */

import type {
  ConditionExtractorService,
  FamilyIndexRule,
  GameProject,
  KojoInstructionTable,
  ProjectService,
  SlotRegistry,
  StateDependency,
  VariableSchema,
} from '@kojo/plugin-api';

/** 六件查询的签名口径见下方实现处的逐条注记（判据、缺省回退都写在那里） */
export interface AdapterServices {
  currentFamilyIndex(): FamilyIndexRule | null;
  schemaLookup(): VariableSchema | undefined;
  instructionTable(): KojoInstructionTable | undefined;
  faceLabels(): Readonly<Record<string, string>> | undefined;
  labelOf(key: string): string | null;
  depsOf(normalizedName: string): StateDependency[];
}

export function createAdapterServices(deps: {
  project: ProjectService;
  slots: SlotRegistry;
  conditionExtractor: ConditionExtractorService;
}): AdapterServices {
  const { project, slots, conditionExtractor } = deps;

  /** 当前激活适配器的家族规则（多适配器共存时按 adapterId 精确匹配） */
  const currentFamilyIndex = (): FamilyIndexRule | null => {
    const current: GameProject | null = project.current();
    if (!current) return null;
    for (const contribution of slots.query('game.adapter')) {
      if (contribution.adapter.gameId === current.adapterId && contribution.adapter.functionFamilyIndex) {
        return contribution.adapter.functionFamilyIndex;
      }
    }
    return null;
  };

  /** 当前适配器的变量语义字典（按 adapterId 精确匹配；与注入器同通道） */
  const schemaLookup = (): VariableSchema | undefined => {
    const current = project.current();
    if (!current) return undefined;
    for (const c of slots.query('game.adapter')) {
      if (c.adapter.gameId !== current.adapterId) continue;
      return c.adapter.variableSchema;
    }
    return undefined;
  };

  /** 当前适配器的指令表（编号 ↔ 中文名；按 adapterId 精确匹配；缺省 → undefined） */
  const instructionTable = (): KojoInstructionTable | undefined => {
    const current = project.current();
    if (!current) return undefined;
    for (const c of slots.query('game.adapter')) {
      if (c.adapter.gameId !== current.adapterId) continue;
      return c.adapter.kojoInstructionTable;
    }
    return undefined;
  };

  /** 当前适配器的面 → 中文标签（与家族规则同源；缺省 → 消费方原样显示 token） */
  const faceLabels = (): Readonly<Record<string, string>> | undefined => currentFamilyIndex()?.faceLabels;

  /** 状态键标签：按首个 ':' 切出变量名与首下标，查变量字典 */
  const labelOf = (key: string): string | null => {
    const schema = schemaLookup();
    if (!schema) return null;
    const i = key.indexOf(':');
    const name = i < 0 ? key : key.slice(0, i);
    const firstIndex = i < 0 ? undefined : key.slice(i + 1).split(':')[0];
    return schema.lookup(name, firstIndex)?.description ?? null;
  };

  /** 单函数状态依赖（抽取索引未含该函数时为空数组） */
  const depsOf = (normalizedName: string): StateDependency[] =>
    conditionExtractor.functionConditions(normalizedName)?.dependencies ?? [];

  return { currentFamilyIndex, schemaLookup, instructionTable, faceLabels, labelOf, depsOf };
}
