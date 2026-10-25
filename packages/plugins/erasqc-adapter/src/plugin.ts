/**
 * eraSQC 适配器插件 —— 本包是**唯一**允许知道「eraSQC / eraSQN / GameBase 标题 /
 * `ERB/EVENT_K` 口上域」这些字眼的地方（架构铁律：游戏知识归 adapter，内核零游戏名词）。
 *
 * 交付面（照 eraAkumaMaid / era紅魔館 的 v1 契约）：
 * - 工程识别（`detect`）：`CSV/GameBase.csv` 标题 + `ERB/EVENT_K/EVENT_K.ERB` + `CSV/Cflag.csv`；
 * - 工程装载（`loadProject`）：Chara CSV → 角色索引、口上文件 → 角色条目（按文件名编号）、
 *   变量字典（21 张名称表）、指令名表（`CSV/Train.csv`）、输入摘要；
 * - 语义层：家族索引 / 约定规则 / 变量字典 / 指令表；
 * - 展示位：条件矩阵剧情线。
 *
 * 为什么**没有** `kojoDir` 绑定 / `search.scope`：
 * 本作口上是 `ERB/EVENT_K` 下的**扁平文件**（`EVENT_K{no}.ERB`），没有每角色目录。
 * 契约里的 `kojoDir` 是**目录**语义，塞一个文件路径或伪造目录会让文件树分组与
 * 条件矩阵的目录过滤给出错误结果 ⇒ 宁可不绑（角色索引仍完整，按函数名归属照常工作）。
 *
 * 为什么**没有** `kojoCallProtocol` / `kojoLibraryTable` / `kojoMutatorTable`：
 * 本作路由是 `TRYCALLFORM {面}_{NO:TARGET}_{CFLAG:209}` 的直接拼名，没有 eraTW 那种
 * 「路由表转发实参」的槽位语义；基础库与增减族也没有经过语料实证的映射表。宁缺毋滥。
 */

import type {
  AdapterDetectResult,
  CharaInfo,
  FileIO,
  GameAdapter,
  GameProject,
  KojoInstructionTable,
  Plugin,
  VariableSchema,
} from '@kojo/plugin-api';
import { combineDigests, foldDigest, join } from '@kojo/plugin-api';
import { ERASQC } from './constants';
import {
  fallbackCharaName,
  parseCharaCsv,
  parseCharaNoFromFileName,
  parseKojoFileName,
} from './chara-csv';
import { createErasqcFamilyIndex } from './family-index';
import { createErasqcConventions } from './conventions';
import { createErasqcFaceTable } from './face-templates';
import { ERASQC_STATE_LINES } from './state-lines';
import {
  loadErasqcInstructionNames,
  loadErasqcVariableSchema,
} from './variable-schema';

/** 空指令表（未加载 / 缺表时返回它；`hasTable=false`，查啥都 undefined） */
const EMPTY_INSTRUCTION_TABLE: KojoInstructionTable = {
  hasTable: false,
  lookupByName: () => undefined,
  lookupByNo: () => undefined,
  names: () => [],
};

/** CSV 根下按大小写不敏感找文件（盘实 `Cflag.csv`，魔改可能 `CFLAG.CSV`） */
async function findCsv(
  io: FileIO,
  csvDir: string,
  pattern: RegExp,
  fallbackName: string,
): Promise<boolean> {
  try {
    const entries = await io.listDir(csvDir);
    return entries.some((e) => !e.isDirectory && pattern.test(e.name));
  } catch {
    return io.exists(join(csvDir, fallbackName));
  }
}

/** 创建 eraSQC 适配器插件（供 app 组合根 bootstrap.ts 装配） */
export function createErasqcAdapterPlugin(): Plugin {
  return {
    id: 'erasqc-adapter',
    version: '0.1.0',
    requires: ['kernel.io'],
    activate(ctx) {
      const io = ctx.inject<FileIO>('kernel.io');

      /** 变量字典（每次 `loadProject` 按当前游戏 CSV 重建） */
      let currentSchema: VariableSchema | undefined;
      /** 指令名表（同上；未加载 = 空表实例） */
      let currentInstructionTable: KojoInstructionTable = EMPTY_INSTRUCTION_TABLE;

      const adapter: GameAdapter = {
        gameId: ERASQC.gameId,
        displayName: ERASQC.displayName,
        functionFamilyIndex: createErasqcFamilyIndex(),
        conventions: createErasqcConventions(),
        // 本作每个角色的 EVENT_K 文件都各写一份同名分发器 EVENTTRAIN / EVENTEND，
        // 函数体内按目标角色分派 —— 逐角色重复是结构，不是作者写错。
        conventionPolicy: [
          {
            ruleId: 'erb.duplicate-function',
            names: ['EVENTTRAIN', 'EVENTEND'],
            reason: '每个角色的 EVENT_K 文件各写一份同名分发器（体内按目标角色分派）',
          },
        ],
        get variableSchema() {
          return currentSchema;
        },
        get kojoInstructionTable() {
          return currentInstructionTable;
        },
        // 时机分野模板：纯数据、无 IO；未登记的面在糖层 fail-closed
        kojoFaceTemplates: createErasqcFaceTable(),
        // 条件矩阵剧情线预设（键按真盘原文）
        stateLinePresets: ERASQC_STATE_LINES,

        async detect(rootDir: string): Promise<AdapterDetectResult> {
          // 1) 游戏自述表必须在位且标题对得上——本作唯一强特征；eraAkumaMaid 也有
          //    `ERB/EVENT_K` 目录，只看目录会把两个游戏认混。
          const gameBase = join(rootDir, ...ERASQC.detect.gameBaseCsv);
          if (!(await io.exists(gameBase))) return { matched: false };
          try {
            const tf = await io.readText(gameBase);
            if (!ERASQC.detect.titlePattern.test(tf.text)) return { matched: false };
          } catch (err) {
            ctx.log.debug(`GameBase 读取失败（按不命中处理）：${gameBase} — ${String(err)}`);
            return { matched: false };
          }
          // 2) 口上主路由必须是文件（半截工程只剩目录不算成局）
          if (!(await io.exists(join(rootDir, ...ERASQC.detect.kojoRouteFile)))) return { matched: false };
          // 3) 引擎变量字典主表在位：证明这是可玩的 Emuera 工程，不是只有标题的空壳
          const hasCflag = await findCsv(
            io,
            join(rootDir, ...ERASQC.paths.csvDir),
            /^cflag\.csv$/i,
            ERASQC.detect.charaFlagCsv[1],
          );
          if (!hasCflag) return { matched: false };
          return {
            matched: true,
            evidence: [
              `GameBase 标题匹配 ${ERASQC.detect.titlePattern.source}`,
              `${ERASQC.detect.kojoRouteFile.join('/')} 在位`,
              `${ERASQC.detect.charaFlagCsv.join('/')} 在位`,
            ],
          };
        },

        async loadProject(rootDir: string): Promise<GameProject> {
          const charaDir = join(rootDir, ...ERASQC.paths.charaCsvDir);
          const kojoRoot = join(rootDir, ...ERASQC.paths.kojoRoot);

          const charaIndex = new Map<number, CharaInfo>();
          /**
           * 非 ERB 输入的摘要素材（Chara CSV 正文 + 口上文件名）。
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
            if (!ERASQC.charaCsvPattern.test(entry.name)) continue;
            const noFromName = parseCharaNoFromFileName(entry.name, ERASQC.charaCsvPattern);
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
            const info: CharaInfo = {
              no,
              name: parsed.name ?? fallbackCharaName(no),
            };
            if (parsed.callName) info.callName = parsed.callName;
            charaIndex.set(no, info);
          }

          // ---- 2. ERB/EVENT_K 的口上文件 → 按文件名编号补角色条目 ----
          // 文件名编号是引擎路由的地址（`KOJO_MESSAGE_COM_{no}_…`），比 CSV 更权威地
          // 证明「这个角色有口上」；CSV 里没有的编号也补最小条目（不猜更漂亮的显示名）。
          let kojoEntries: Awaited<ReturnType<FileIO['listDir']>>;
          try {
            kojoEntries = await io.listDir(kojoRoot);
          } catch (err) {
            kojoEntries = [];
            ctx.log.warn(`口上目录不可读（口上索引为空）：${kojoRoot} — ${String(err)}`);
          }
          let kojoFiles = 0;
          for (const entry of kojoEntries) {
            if (entry.isDirectory) continue;
            const parsed = parseKojoFileName(entry.name, ERASQC.kojoFilePattern);
            if (parsed === null) continue;
            kojoFiles++;
            inputParts.push(`kojoFile\u0000${entry.name}`);
            if (!charaIndex.has(parsed.no)) {
              charaIndex.set(parsed.no, { no: parsed.no, name: fallbackCharaName(parsed.no) });
            }
          }

          // ---- 3. 变量字典（CSV 主表 + 市场追加 + .ERH 作者自定名表）----
          // 字典失败**不阻断**工程加载：没有字典只是补全少了名字，口上照常能读能改。
          try {
            currentSchema = await loadErasqcVariableSchema({
              io,
              csvDir: join(rootDir, ...ERASQC.paths.csvDir),
              erbDir: join(rootDir, ...ERASQC.paths.erbRoot),
              log: ctx.log,
            });
          } catch (err) {
            currentSchema = undefined;
            ctx.log.warn(`变量字典加载失败（本次不带字典，工程照常打开）：${String(err)}`);
          }

          // ---- 4. 指令名表（CSV/Train.csv → 中文名 ↔ 编号）----
          try {
            currentInstructionTable = await loadErasqcInstructionNames({
              io,
              csvDir: join(rootDir, ...ERASQC.paths.csvDir),
              log: ctx.log,
            });
          } catch (err) {
            currentInstructionTable = EMPTY_INSTRUCTION_TABLE;
            ctx.log.warn(`指令名表加载失败（本次不带指令表，工程照常打开）：${String(err)}`);
          }

          ctx.log.info(
            `eraSQC 工程加载完成：${charaIndex.size} 个角色，${kojoFiles} 份口上文件，` +
              `口上根：${kojoRoot}`,
          );

          return {
            rootDir,
            adapterId: ERASQC.gameId,
            // 索引吃整棵 ERB：口上路由（EVENT_K.ERB）与公共函数都在根层
            kojoPaths: [join(rootDir, ...ERASQC.paths.erbRoot)],
            // 可写面 = 口上域（`ERB/EVENT_K`）；游戏其余部分只读
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

      ctx.slots.register('game.adapter', { id: `${ERASQC.gameId}-adapter`, adapter });
    },
  };
}
