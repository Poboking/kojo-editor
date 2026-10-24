/**
 * era紅魔館 适配器插件 —— 本包是**唯一**允许知道「era紅魔館 / GameBase 标题 /
 * 口上目录 / K{n} 家族」这些字眼的地方（架构铁律：游戏知识归 adapter，内核零游戏名词）。
 *
 * 交付面（照 eraFL / eraAkumaMaid 的 v1 契约裁剪）：
 * - 工程识别（`detect`）：`CSV/GameBase.csv` 标题 + `ERB/口上` 目录 + `CSV/CFLAG.csv`；
 * - 工程装载（`loadProject`）：Chara CSV → 角色索引、口上目录 → `kojoDir`、
 *   变量字典（43 份 CSV + 5 份 ERH）、指令名表（`CSV/Train.csv`）、输入摘要；
 * - 语义层：家族索引 / 约定规则 / 变量字典 / 指令表 / 时机分野模板；
 * - 展示位：日文名对照、条件矩阵剧情线；
 * - 检索范围：按角色口上目录收窄（与 eraAkumaMaid 同一份共享投影）。
 *
 * 为什么**没有** `kojoCallProtocol` / `kojoLibraryTable` / `kojoMutatorTable`：
 * 本作的口上路由是 `KOJO%RESULTS%_MESSAGE_COM_K{対象}_{SELECTCOM}` 这类**同名前缀 +
 * 目标号**形态，没有 eraTW / eraAkumaMaid 那种「路由表转发实参的槽位语义」可抽；
 * 基础库与增减族也没有经过语料实证的映射表。宁缺毋滥，不拿猜测填槽。
 */

import type {
  CharaInfo,
  FileIO,
  GameAdapter,
  GameProject,
  KojoInstructionTable,
  Plugin,
  VariableSchema,
} from '@kojo/plugin-api';
import { combineDigests, foldDigest, join } from '@kojo/plugin-api';
import { charaSearchScopeOptions } from '@kojo/kojo-project-kit';
import { ERAKOUMAKAN } from './constants';
import {
  charaNameFromFileName,
  parseCharaCsv,
  parseCharaNoFromFileName,
  parseKojoDirName,
} from './chara-csv';
import { createKoumakanFamilyIndex } from './family-index';
import { createKoumakanConventions } from './conventions';
import { loadKoumakanInstructionNames, loadKoumakanVariableSchema } from './variable-schema';
import { ERAKOUMAKAN_NAME_GLOSSARY } from './name-glossary';
import { ERAKOUMAKAN_STATE_LINES } from './state-lines';
import { createKoumakanFaceTable } from './face-templates';

/** 空指令表（未加载 / 缺表时返回它；`hasTable=false`，查啥都 undefined） */
const EMPTY_INSTRUCTION_TABLE: KojoInstructionTable = {
  hasTable: false,
  lookupByName: () => undefined,
  lookupByNo: () => undefined,
  names: () => [],
};

/** 创建 era紅魔館 适配器插件（供 app 组合根 bootstrap.ts 装配） */
export function createKoumakanAdapterPlugin(): Plugin {
  return {
    id: 'erakoumakan-adapter',
    version: '0.1.0',
    requires: ['kernel.io'],
    activate(ctx) {
      const io = ctx.inject<FileIO>('kernel.io');

      /** 变量字典（每次 `loadProject` 按当前游戏 CSV 重建） */
      let currentSchema: VariableSchema | undefined;
      /** 指令名表（同上；未加载 = 空表实例） */
      let currentInstructionTable: KojoInstructionTable = EMPTY_INSTRUCTION_TABLE;

      const adapter: GameAdapter = {
        gameId: ERAKOUMAKAN.gameId,
        displayName: ERAKOUMAKAN.displayName,
        functionFamilyIndex: createKoumakanFamilyIndex(),
        // 两条约定规则只吃索引（不读盘、不依赖工程状态）⇒ 装配时一次成型
        conventions: createKoumakanConventions(),
        get variableSchema() {
          return currentSchema;
        },
        get kojoInstructionTable() {
          return currentInstructionTable;
        },
        // 时机分野模板：纯数据、无 IO；未登记的面在糖层 fail-closed
        kojoFaceTemplates: createKoumakanFaceTable(),
        // 日文名 → 中文名对照（只加显示备注，不改任何实际目录/文件名）
        nameGlossary: ERAKOUMAKAN_NAME_GLOSSARY,
        // 条件矩阵剧情线预设（键按真盘原文，含作用域 / 无作用域两形）
        stateLinePresets: ERAKOUMAKAN_STATE_LINES,

        async detect(rootDir: string): Promise<boolean> {
          // 1) 游戏自述表必须在位且标题对得上——本作唯一强特征；eraFL 也有
          //    `ERB/口上`，只看目录会把两个游戏认混。
          const gameBase = join(rootDir, ...ERAKOUMAKAN.detect.gameBaseCsv);
          if (!(await io.exists(gameBase))) return false;
          try {
            const tf = await io.readText(gameBase);
            if (!ERAKOUMAKAN.detect.titlePattern.test(tf.text)) return false;
          } catch (err) {
            ctx.log.debug(`GameBase 读取失败（按不命中处理）：${gameBase} — ${String(err)}`);
            return false;
          }
          // 2) 口上域必须是**目录**：只留了一个同名散文件的半截工程不算成局
          const kojoStat = await io.stat(join(rootDir, ...ERAKOUMAKAN.detect.kojoDir));
          if (kojoStat?.isDirectory !== true) return false;
          // 3) 引擎变量字典主表在位：证明这是可玩的工程而不是只有标题的空壳
          return io.exists(join(rootDir, ...ERAKOUMAKAN.detect.charaFlagCsv));
        },

        async loadProject(rootDir: string): Promise<GameProject> {
          const charaDir = join(rootDir, ...ERAKOUMAKAN.paths.charaCsvDir);
          const kojoRoot = join(rootDir, ...ERAKOUMAKAN.paths.kojoRoot);

          const charaIndex = new Map<number, CharaInfo>();
          /**
           * 非 ERB 输入的摘要素材（Chara CSV 正文 + 口上目录名）。
           * 下游派生缓存（条件抽取 / 约定校验）的产出依赖它们，而 ERB 体量指纹
           * 覆盖不到 ⇒ 必须折进 `GameProject.inputDigest`。
           */
          const inputParts: string[] = [];

          // ---- 1. CSV/Chara{no}.csv → 编号 / 名前 / 呼び名 ----
          let csvEntries: Awaited<ReturnType<FileIO['listDir']>>;
          try {
            csvEntries = await io.listDir(charaDir);
          } catch (err) {
            csvEntries = [];
            ctx.log.warn(`角色 CSV 目录不可读（角色索引为空）：${charaDir} — ${String(err)}`);
          }
          for (const entry of csvEntries) {
            if (entry.isDirectory) continue;
            if (!ERAKOUMAKAN.charaCsvPattern.test(entry.name)) continue;
            const noFromName = parseCharaNoFromFileName(entry.name, ERAKOUMAKAN.charaCsvPattern);
            let parsed: ReturnType<typeof parseCharaCsv> = { no: null, name: null, callName: null };
            try {
              const tf = await io.readText(entry.path);
              parsed = parseCharaCsv(tf.text);
              inputParts.push(`chara\u0000${entry.path}\u0000${tf.text}`);
            } catch (err) {
              inputParts.push(`chara\u0000${entry.path}\u0000!unreadable`);
              ctx.log.warn(`Chara CSV 读取失败（跳过该文件）：${entry.path} — ${String(err)}`);
            }
            const no = parsed.no ?? noFromName;
            if (no === null) {
              ctx.log.warn(`无法确定角色编号（跳过）：${entry.name}`);
              continue;
            }
            // 名称回退链：名前 行 → 文件名名称段（魔改版可能有）→ `Chara{no}`
            const info: CharaInfo = {
              no,
              name: parsed.name ?? charaNameFromFileName(entry.name) ?? `Chara${no}`,
            };
            if (parsed.callName) info.callName = parsed.callName;
            charaIndex.set(no, info);
          }

          // ---- 2. ERB/口上/{编号}_{名称} → 绑定 kojoDir / 补 CSV 里没有的条目 ----
          let kojoEntries: Awaited<ReturnType<FileIO['listDir']>>;
          try {
            kojoEntries = await io.listDir(kojoRoot);
          } catch (err) {
            kojoEntries = [];
            ctx.log.warn(`口上目录不可读（口上索引为空）：${kojoRoot} — ${String(err)}`);
          }
          let bound = 0;
          for (const entry of kojoEntries) {
            if (!entry.isDirectory) continue;
            inputParts.push(`kojoDir\u0000${entry.name}`);
            const parsed = parseKojoDirName(entry.name);
            if (parsed === null) {
              // `U_汎用` 是**泛用口上**目录（函数名用 `_KU_`），不是角色目录 ⇒ 显式说明，
              // 不猜编号。它仍在 `writablePaths` 内，作者照常能改。
              ctx.log.info(`口上目录无角色编号（按泛用口上处理，不建角色条目）：${entry.name}`);
              continue;
            }
            const info = charaIndex.get(parsed.no);
            if (info) {
              info.kojoDir = entry.path;
            } else {
              // 口上目录存在但 CSV 中没有该编号：补最小条目（不猜更漂亮的显示名）
              charaIndex.set(parsed.no, { no: parsed.no, name: parsed.label, kojoDir: entry.path });
            }
            bound++;
          }

          // ---- 3. 变量字典（CSV 主表 + .ERH 作者自定名表）----
          // 字典失败**不阻断**工程加载：没有字典只是补全少了名字，口上照常能读能改。
          try {
            currentSchema = await loadKoumakanVariableSchema({
              io,
              csvDir: join(rootDir, ...ERAKOUMAKAN.paths.csvDir),
              erbDir: join(rootDir, ...ERAKOUMAKAN.paths.erbRoot),
              log: ctx.log,
            });
          } catch (err) {
            currentSchema = undefined;
            ctx.log.warn(`变量字典加载失败（本次不带字典，工程照常打开）：${String(err)}`);
          }

          // ---- 4. 指令名表（CSV/Train.csv → 中文名 ↔ 编号）----
          try {
            currentInstructionTable = await loadKoumakanInstructionNames({
              io,
              csvDir: join(rootDir, ...ERAKOUMAKAN.paths.csvDir),
              log: ctx.log,
            });
          } catch (err) {
            currentInstructionTable = EMPTY_INSTRUCTION_TABLE;
            ctx.log.warn(`指令名表加载失败（本次不带指令表，工程照常打开）：${String(err)}`);
          }

          ctx.log.info(
            `era紅魔館 工程加载完成：${charaIndex.size} 个角色（${bound} 个有口上目录），` +
              `口上根：${kojoRoot}`,
          );

          return {
            rootDir,
            adapterId: ERAKOUMAKAN.gameId,
            // 索引吃整棵 ERB：口上路由（EVENT_KOJO.ERB 等）与公共函数都在根层
            kojoPaths: [join(rootDir, ...ERAKOUMAKAN.paths.erbRoot)],
            // 可写面 = 口上域（含 U_汎用）；游戏其余部分只读
            writablePaths: [kojoRoot],
            charaIndex,
            // 派生缓存判据的一部分：本次加载实际吃进的非 ERB 输入
            inputDigest:
              combineDigests([
                foldDigest(inputParts),
                ...(currentSchema?.inputDigest ? [currentSchema.inputDigest] : []),
              ]) ?? undefined,
          };
        },
      };

      ctx.slots.register('game.adapter', { id: `${ERAKOUMAKAN.gameId}-adapter`, adapter });

      /**
       * 检索范围：角色级收窄（与 eraAkumaMaid 共用同一份投影 `charaSearchScopeOptions`）。
       * 只认本项目；`order: 10` 与另两个 adapter 同值——同时在场时按项目归属过滤，
       * 不靠 order 分胜负。
       */
      ctx.slots.register('search.scope', {
        id: `${ERAKOUMAKAN.gameId}-chara-scope`,
        order: 10,
        provide: (project) =>
          project !== null && project.adapterId === ERAKOUMAKAN.gameId
            ? charaSearchScopeOptions(project.charaIndex.values())
            : [],
      });
    },
  };
}
