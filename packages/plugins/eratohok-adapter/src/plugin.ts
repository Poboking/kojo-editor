/**
 * eratohoK 适配器插件 —— 本包是**唯一**允许知道「eratohoK / GameBase 标题 /
 * `ERB/口上` 口上域 / `CSV/Chara` 角色表 / `KOJO_*_K{n}` 家族」这些字眼的地方
 * （架构铁律：游戏知识归 adapter，内核零游戏名词）。
 *
 * 交付面（照 era紅魔館 / eraSQC 的 v1 契约裁剪）：
 * - 工程识别（`detect`）：`CSV/GameBase.csv` 标题 + `ERB/口上` 目录 + `CSV/CFLAG.CSV`；
 * - 工程装载（`loadProject`）：Chara CSV → 角色索引、口上目录 → `kojoDir` 绑定、
 *   变量字典（20 张 CSV + 145 份 `.ERH` 里的 13 份声明）、指令名表（`CSV/Train.csv`）、
 *   输入摘要；
 * - 语义层：家族索引 / 约定规则 / 变量字典 / 指令表 / 时机分野模板；
 * - 展示位：条件矩阵剧情线；
 * - 检索范围：按角色口上目录收窄（与 eraAkumaMaid / era紅魔館 同一份共享投影）。
 *
 * 为什么**没有** `kojoCallProtocol` / `kojoLibraryTable` / `kojoMutatorTable`：
 * 本作的路由是 `TRYCALLFORM KOJO_*_K{LOCAL:5}` 的**直接拼名 + `%KOJO_STATE()%`
 * 运行时状态段 + `CFLAG:2999` 口上号尾段**，没有 eraTW 那种「路由表转发实参」的槽位
 * 语义；基础库与增减族也没有经过语料实证的映射表。宁缺毋滥，不拿猜测填槽。
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
import { ERATOHOK } from './constants';
import {
  charaNameFromFileName,
  parseCharaCsv,
  parseCharaNoFromFileName,
  parseKojoDirName,
} from './chara-csv';
import { createTohokFamilyIndex } from './family-index';
import { createTohokConventions } from './conventions';
import { createTohokFaceTable } from './face-templates';
import { ERATOHOK_STATE_LINES } from './state-lines';
import { loadTohokInstructionNames, loadTohokVariableSchema } from './variable-schema';

/** 空指令表（未加载 / 缺表时返回它；`hasTable=false`，查啥都 undefined） */
const EMPTY_INSTRUCTION_TABLE: KojoInstructionTable = {
  hasTable: false,
  lookupByName: () => undefined,
  lookupByNo: () => undefined,
  names: () => [],
};

/** CSV 根下按大小写不敏感找文件（盘实 `CFLAG.CSV`，魔改可能 `Cflag.csv`） */
async function findCsvCaseInsensitive(
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

/** 创建 eratohoK 适配器插件（供 app 组合根 bootstrap.ts 装配） */
export function createTohokAdapterPlugin(): Plugin {
  return {
    id: 'eratohok-adapter',
    version: '0.1.0',
    requires: ['kernel.io'],
    activate(ctx) {
      const io = ctx.inject<FileIO>('kernel.io');

      /** 变量字典（每次 `loadProject` 按当前游戏 CSV 重建） */
      let currentSchema: VariableSchema | undefined;
      /** 指令名表（同上；未加载 = 空表实例） */
      let currentInstructionTable: KojoInstructionTable = EMPTY_INSTRUCTION_TABLE;

      const adapter: GameAdapter = {
        gameId: ERATOHOK.gameId,
        displayName: ERATOHOK.displayName,
        functionFamilyIndex: createTohokFamilyIndex(),
        // 唯一约定规则只吃索引（不读盘、不依赖工程状态）⇒ 装配时一次成型
        conventions: createTohokConventions(),
        get variableSchema() {
          return currentSchema;
        },
        get kojoInstructionTable() {
          return currentInstructionTable;
        },
        // 时机分野模板：纯数据、无 IO；未登记的面在糖层 fail-closed
        kojoFaceTemplates: createTohokFaceTable(),
        // 条件矩阵剧情线预设（键按真盘原文）
        stateLinePresets: ERATOHOK_STATE_LINES,

        async detect(rootDir: string): Promise<boolean> {
          // 1) 游戏自述表必须在位且标题对得上——本作唯一强特征；eraFL / era紅魔館
          //    也有 `ERB/口上` 目录，只看目录会把三个游戏认混。
          const gameBase = join(rootDir, ...ERATOHOK.detect.gameBaseCsv);
          if (!(await io.exists(gameBase))) return false;
          try {
            const tf = await io.readText(gameBase);
            if (!ERATOHOK.detect.titlePattern.test(tf.text)) return false;
          } catch (err) {
            ctx.log.debug(`GameBase 读取失败（按不命中处理）：${gameBase} — ${String(err)}`);
            return false;
          }
          // 2) 口上域必须是**目录**：只留了一个同名散文件的半截工程不算成局
          const kojoStat = await io.stat(join(rootDir, ...ERATOHOK.detect.kojoDir));
          if (kojoStat?.isDirectory !== true) return false;
          // 3) 引擎变量字典主表在位：证明这是可玩的 Emuera 工程，不是只有标题的空壳
          return findCsvCaseInsensitive(
            io,
            join(rootDir, ...ERATOHOK.paths.csvDir),
            /^cflag\.csv$/i,
            ERATOHOK.detect.charaFlagCsv[1],
          );
        },

        async loadProject(rootDir: string): Promise<GameProject> {
          const charaDir = join(rootDir, ...ERATOHOK.paths.charaCsvDir);
          const kojoRoot = join(rootDir, ...ERATOHOK.paths.kojoRoot);

          const charaIndex = new Map<number, CharaInfo>();
          /**
           * 非 ERB 输入的摘要素材（Chara CSV 正文 + 口上目录名）。
           * 下游派生缓存（条件抽取 / 约定校验）的产出依赖它们，而 ERB 体量指纹
           * 覆盖不到 ⇒ 必须折进 `GameProject.inputDigest`。
           */
          const inputParts: string[] = [];

          // ---- 1. CSV/Chara/Chara{no} {名前}.csv → 编号 / 名前 / 呼び名 ----
          let csvEntries: Awaited<ReturnType<FileIO['listDir']>>;
          try {
            csvEntries = await io.listDir(charaDir);
          } catch (err) {
            csvEntries = [];
            ctx.log.warn(`角色 CSV 目录不可读（角色索引为空）：${charaDir} — ${String(err)}`);
          }
          for (const entry of csvEntries) {
            if (entry.isDirectory) continue;
            if (!ERATOHOK.charaCsvPattern.test(entry.name)) continue;
            const noFromName = parseCharaNoFromFileName(entry.name, ERATOHOK.charaCsvPattern);
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
            // 名称回退链：名前 行 → 文件名名称段 → `Chara{no}`
            const info: CharaInfo = {
              no,
              name: parsed.name ?? charaNameFromFileName(entry.name) ?? `Chara${no}`,
            };
            if (parsed.callName) info.callName = parsed.callName;
            charaIndex.set(no, info);
          }

          // ---- 2. ERB/口上/{编号} {名称}口上 → 绑定 kojoDir / 补 CSV 里没有的条目 ----
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
              // 根层的公共文件不是目录，走不到这里；真有奇怪目录时显式说明，不猜编号
              ctx.log.info(`口上目录无角色编号（原样保留，不建角色条目）：${entry.name}`);
              continue;
            }
            const info = charaIndex.get(parsed.no);
            if (info) {
              info.kojoDir = entry.path;
            } else {
              // 口上目录存在但 CSV 里没有该编号（1204–1206 随机角色一类）：补最小条目
              charaIndex.set(parsed.no, { no: parsed.no, name: parsed.label, kojoDir: entry.path });
            }
            bound++;
          }

          // ---- 3. 变量字典（CSV 主表 + .ERH 作者自定名表）----
          // 字典失败**不阻断**工程加载：没有字典只是补全少了名字，口上照常能读能改。
          try {
            currentSchema = await loadTohokVariableSchema({
              io,
              csvDir: join(rootDir, ...ERATOHOK.paths.csvDir),
              erbDir: join(rootDir, ...ERATOHOK.paths.erbRoot),
              log: ctx.log,
            });
          } catch (err) {
            currentSchema = undefined;
            ctx.log.warn(`变量字典加载失败（本次不带字典，工程照常打开）：${String(err)}`);
          }

          // ---- 4. 指令名表（CSV/Train.csv → 中文名 ↔ 编号）----
          try {
            currentInstructionTable = await loadTohokInstructionNames({
              io,
              csvDir: join(rootDir, ...ERATOHOK.paths.csvDir),
              log: ctx.log,
            });
          } catch (err) {
            currentInstructionTable = EMPTY_INSTRUCTION_TABLE;
            ctx.log.warn(`指令名表加载失败（本次不带指令表，工程照常打开）：${String(err)}`);
          }

          ctx.log.info(
            `eratohoK 工程加载完成：${charaIndex.size} 个角色（${bound} 个有口上目录），` +
              `口上根：${kojoRoot}`,
          );

          return {
            rootDir,
            adapterId: ERATOHOK.gameId,
            // 索引吃整棵 ERB：口上路由（_KOJO_SYSTEM.ERB）与公共函数都在根层
            kojoPaths: [join(rootDir, ...ERATOHOK.paths.erbRoot)],
            // 可写面 = 口上域（`ERB/口上`，含根层公共文件与 118 个角色目录）；其余只读
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

      ctx.slots.register('game.adapter', { id: `${ERATOHOK.gameId}-adapter`, adapter });

      /**
       * 检索范围：角色级收窄（与 eraAkumaMaid / era紅魔館 共用同一份投影
       * `charaSearchScopeOptions`）。只认本项目；`order: 10` 与另两个 adapter 同值
       * ——同时在场时按项目归属过滤，不靠 order 分胜负。
       */
      ctx.slots.register('search.scope', {
        id: `${ERATOHOK.gameId}-chara-scope`,
        order: 10,
        provide: (project) =>
          project !== null && project.adapterId === ERATOHOK.gameId
            ? charaSearchScopeOptions(project.charaIndex.values())
            : [],
      });
    },
  };
}
