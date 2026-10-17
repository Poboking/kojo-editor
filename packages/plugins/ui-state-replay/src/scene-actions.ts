/**
 * 回放面板的**场景预设 CRUD**（从 `index.ts` 的 `ReplayPanel` 原样迁出，语义逐字不变）。
 *
 * 场景 = 调用上下文（ARG/ARGS 槽位）的一组命名输入。判据与数据结构全在
 * `panel-logic.ts`（`applyScene` / `captureSceneSlots` / `upsertSceneByName` …），
 * 本模块只做「三个按钮 → 写哪些状态 + 报哪句话」的搬运：
 *   - **应用**：协议可用 → 填结构化槽位；不可用 → 降级写裸上下文文本（绝不抛错）；
 *   - **保存**：同名覆盖并保留原 id；空值 = 未提供，不入场景；
 *   - **删除**：内置默认场景不可删。
 *
 * 三条路径的提示语都进 `setSceneMsg`（铁律 4：冲突与降级必须可见，不静默）。
 * 状态仍由面板持有——本模块不建第二份真源，也不碰存储（`persistScenes` 由调用方注入）。
 */

import type { KojoCallSlot } from '@kojo/plugin-api';
import type { ReplayScene, SceneSlotValue } from './panel-logic';
import {
  DEFAULT_SCENE_ID,
  MAX_SCENES,
  MAX_SCENE_NAME,
  applyScene,
  captureSceneSlots,
  contextTextToSceneSlots,
  newSceneId,
  removeScene,
  sceneSlotsToContextText,
  upsertSceneByName,
} from './panel-logic';

export interface SceneActionDeps {
  /** 协议槽位（null / 空 = 协议不可用 → 走裸上下文文本那一路） */
  callSlots: readonly KojoCallSlot[] | null;
  slotTexts: Record<string, string>;
  contextText: string;
  scenes: ReplayScene[];
  selectedScene: ReplayScene;
  sceneNameInput: string;
  sceneSuggestion: string;
  setSlotTexts: (next: Record<string, string>) => void;
  setSlotEdited: (next: Record<string, boolean>) => void;
  setContextText: (next: string) => void;
  setSelectedSceneId: (id: string) => void;
  setSceneNameInput: (next: string) => void;
  /** 提示 / 冲突上报（不静默） */
  setSceneMsg: (msg: string | null) => void;
  /** 落库（存储域 = 本插件 id；由面板持有，本模块不越界写） */
  persistScenes: (next: ReplayScene[]) => void;
}

export interface SceneActions {
  /** 「应用」按钮 */
  apply(): void;
  /** 「保存场景」按钮 */
  save(): void;
  /** 「删除」按钮 */
  remove(): void;
}

export function createSceneActions(deps: SceneActionDeps): SceneActions {
  const {
    callSlots,
    slotTexts,
    contextText,
    scenes,
    selectedScene,
    sceneNameInput,
    sceneSuggestion,
    setSlotTexts,
    setSlotEdited,
    setContextText,
    setSelectedSceneId,
    setSceneNameInput,
    setSceneMsg,
    persistScenes,
  } = deps;

    /** 一键应用场景：协议可用 → 填结构化槽位；协议不可用 → 降级写裸上下文文本（绝不抛错） */
    const doApplyScene = (): void => {
      if (callSlots && callSlots.length > 0) {
        const app = applyScene(selectedScene, callSlots, slotTexts);
        setSlotTexts(app.texts);
        setSlotEdited(app.edited); // 场景覆盖的槽 → manual（作者假设，非引擎事实）
        const parts: string[] = [
          selectedScene.id === DEFAULT_SCENE_ID
            ? '已应用默认场景（int 全 0 = 假设 / str 空 = 未提供）'
            : `已应用「${selectedScene.name}」（${app.applied.length} 槽；场景值按作者假设对待，非引擎事实）`,
        ];
        if (app.dropped.length > 0) parts.push(`${app.dropped.length} 个场景槽位不在当前函数签名内，已忽略`);
        if (app.reset.length > 0) parts.push(`${app.reset.length} 个已填槽位被重置为默认`);
        setSceneMsg(parts.join(' · '));
        return;
      }
      setContextText(selectedScene.id === DEFAULT_SCENE_ID ? '' : sceneSlotsToContextText(selectedScene.slots));
      setSceneMsg(
        selectedScene.id === DEFAULT_SCENE_ID
          ? '已清空调用上下文'
          : `已应用「${selectedScene.name}」到调用上下文文本（作者假设，非引擎事实）`,
      );
    };

    /** 保存当前输入为场景（同名 = 覆盖，保留原 id） */
    const doSaveScene = (): void => {
      let slotsToSave: Record<string, SceneSlotValue>;
      if (callSlots && callSlots.length > 0) {
        slotsToSave = captureSceneSlots(callSlots, slotTexts);
      } else {
        const converted = contextTextToSceneSlots(contextText);
        if (converted === null) {
          setSceneMsg('调用上下文无法解析为槽位（语法：槽位=值，如 0=36, 1="文本"），未保存');
          return;
        }
        slotsToSave = converted;
      }
      const count = Object.keys(slotsToSave).length;
      if (count === 0) {
        setSceneMsg('当前没有可保存的槽位值（空 = 未提供，不入场景）');
        return;
      }
      const name = (sceneNameInput.trim() || sceneSuggestion).slice(0, MAX_SCENE_NAME);
      if (name.length === 0) {
        setSceneMsg('请输入场景名（协议不可用时无建议名）');
        return;
      }
      const sameName = scenes.some((s) => s.name === name);
      if (!sameName && scenes.length >= MAX_SCENES) {
        setSceneMsg(`场景数量已达上限（${MAX_SCENES}）`);
        return;
      }
      const { scenes: next, scene, overwritten } = upsertSceneByName(scenes, name, slotsToSave, () =>
        newSceneId(scenes.map((s) => s.id)),
      );
      persistScenes(next);
      setSelectedSceneId(scene.id);
      setSceneNameInput('');
      setSceneMsg(
        overwritten ? `已覆盖同名场景「${scene.name}」（${count} 槽）` : `已保存场景「${scene.name}」（${count} 槽）`,
      );
    };

    /** 删除选中场景（内置默认场景不可删） */
    const doDeleteScene = (): void => {
      if (selectedScene.id === DEFAULT_SCENE_ID) {
        setSceneMsg('内置默认场景不可删除');
        return;
      }
      persistScenes(removeScene(scenes, selectedScene.id));
      setSelectedSceneId(DEFAULT_SCENE_ID);
      setSceneMsg(`已删除场景「${selectedScene.name}」`);
    };

  return { apply: doApplyScene, save: doSaveScene, remove: doDeleteScene };
}
