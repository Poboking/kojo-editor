/**
 * eratohoReverse（真盘标题 `eratohoЯeverse`）适配器插件 —— 本包是**唯一**允许知道
 * 「本作标题 / `ERB/口上/{NNNN}_{名}` / `CSV/CHARA` / `KOJO_ACT_K{n}_{类别}`」这些字眼的地方
 * （架构铁律：游戏知识归 adapter，内核零游戏名词）。
 *
 * 本批＝ P0 布线 + P1 识别与导航（工程识别、角色索引、口上目录绑定、家族解析、
 * 变量字典、指令名表、角色级检索范围）。
 *
 * 为什么**没有** `conventions` / `kojoFaceTemplates` / `stateLinePresets`：三条都还没有
 * 语料实证（本作路由是 `KOJO_CALL(@"…")` 的**间接转发**，家族面要先由 `family-index` 的
 * 覆盖读数定口径），宁缺毋滥。也**没有** `kojoCallProtocol`：主路由把 FORM 字符串当实参
 * 转发（`CALL KOJO_CALL(@"DIGEST_K{ARG}", TARGET)` → `TRYCALLFORM KOJO_%ARGS%`），
 * 槽位语义不在字面里，拿猜测填槽等于编造。
 *
 * 与最接近的先例 eratohoK 的三处硬差异（2026-10-26 实测，照抄任一条都会静默出错）：
 * ① 标题含**西里尔 Я**，hok 的 `/eratoho\s*K/i` 对本作不成立；
 * ② 口上目录分隔符是**下划线 + 四位零补齐**（`0001_霊夢`），hok 的 `^(\d+)[\s　]+` 实测 0/25 命中；
 * ③ 全树 **100% 纯 LF**（hok 是 CRLF 主导），任何按 CRLF 的读写口径都会整文件重排。
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
import { charaSearchScopeOptions } from '@kojo/kojo-project-kit';
import { ERATOHOREVERSE } from './constants';
import {
  charaNameFromFileName,
  parseCharaCsv,
  parseCharaNoFromFileName,
  parseKojoDirName,
} from './chara-csv';
import { createEratohoreverseFamilyIndex } from './family-index';
import {
  loadEratohoreverseInstructionNames,
  loadEratohoreverseVariableSchema,
} from './variable-schema';

/** 空指令表（未加载 / 缺表时返回它；`hasTable=false`，查啥都 undefined） */
const EMPTY_INSTRUCTION_TABLE: KojoInstructionTable = {
  hasTable: false,
  lookupByName: () => undefined,
  lookupByNo: () => undefined,
  names: () => [],
};

/** 创建 eratohoReverse 适配器插件（供 app 组合根 bootstrap.ts 装配） */
export function createEratohoreverseAdapterPlugin(): Plugin {
  return {
    id: 'eratohoreverse-adapter',
    version: '0.1.0',
    requires: ['kernel.io'],
    activate(ctx) {
      const io = ctx.inject<FileIO>('kernel.io');
      /** 变量字典（每次 `loadProject` 按当前工程 CSV/ERH 重建） */
      let currentSchema: VariableSchema | undefined;
      /** 指令名表（同上；未加载 = 空表实例） */
      let currentInstructionTable: KojoInstructionTable = EMPTY_INSTRUCTION_TABLE;

      const adapter: GameAdapter = {
        gameId: ERATOHOREVERSE.gameId,
        displayName: ERATOHOREVERSE.displayName,
        functionFamilyIndex: createEratohoreverseFamilyIndex(),
        get variableSchema() {
          return currentSchema;
        },
        get kojoInstructionTable() {
          return currentInstructionTable;
        },

        async detect(rootDir: string): Promise<AdapterDetectResult> {
          // 1) 自述表标题是唯一强特征：`ERB/口上` 这个目录名 eraFL / era紅魔館 / eratohoK
          //    都有，只看目录会把四个游戏认混；而本作标题写作 `eratohoЯeverse`（Я＝西里尔）。
          const gameBase = join(rootDir, ...ERATOHOREVERSE.detect.gameBaseCsv);
          if (!(await io.exists(gameBase))) return { matched: false };
          try {
            const tf = await io.readText(gameBase);
            if (!ERATOHOREVERSE.detect.titlePattern.test(tf.text)) return { matched: false };
          } catch (err) {
            ctx.log.debug(`GameBase 读取失败（按不命中处理）：${gameBase} — ${String(err)}`);
            return { matched: false };
          }
          // 2) 口上域必须是**目录**（半截工程不算成局）。
          const kojoStat = await io.stat(join(rootDir, ...ERATOHOREVERSE.detect.kojoDir));
          if (kojoStat?.isDirectory !== true) return { matched: false };
          // 3) 根层主路由必须是**文件**：本作 `EVENT_K.ERB` 住在 `ERB/口上/`，
          //    eraAV 的同名文件住在 `ERB/EVENT/` ⇒ 连父目录一起钉才不会互相顶。
          if (!(await io.exists(join(rootDir, ...ERATOHOREVERSE.detect.routerErb)))) {
            return { matched: false };
          }
          // evidence 是「多命中时报错说不出是谁撞的」的唯一解药（内核把它带上屏）
          return {
            matched: true,
            evidence: [
              `GameBase 标题匹配 ${ERATOHOREVERSE.detect.titlePattern.source}（真盘含西里尔 Я）`,
              'ERB/口上 是目录',
              'ERB/口上/EVENT_K.ERB 在位（父目录与 eraAV 的 ERB/EVENT 互斥）',
            ],
          };
        },

        async loadProject(rootDir: string): Promise<GameProject> {
          const charaDir = join(rootDir, ...ERATOHOREVERSE.paths.charaCsvDir);
          const kojoRoot = join(rootDir, ...ERATOHOREVERSE.paths.kojoRoot);
          const csvDir = join(rootDir, ...ERATOHOREVERSE.paths.csvDir);
          const erbRoot = join(rootDir, ...ERATOHOREVERSE.paths.erbRoot);

          const charaIndex = new Map<number, CharaInfo>();
          // 非 ERB 输入的摘要素材（Chara CSV 正文 + 口上目录名）：派生缓存依赖它们，
          // ERB 体量指纹覆盖不到 ⇒ 必须折进 inputDigest。
          const inputParts: string[] = [];

          // ---- 1. CSV/CHARA/Chara{no}_{名前}.csv → 编号 / 名前 / 呼び名（实测 108 份）----
          let csvEntries: Awaited<ReturnType<FileIO['listDir']>>;
          try {
            csvEntries = await io.listDir(charaDir);
          } catch (err) {
            csvEntries = [];
            ctx.log.warn(`角色 CSV 目录不可读（角色索引为空）：${charaDir} — ${String(err)}`);
          }
          for (const entry of csvEntries) {
            if (entry.isDirectory) continue;
            if (!ERATOHOREVERSE.charaCsvPattern.test(entry.name)) continue;
            const noFromName = parseCharaNoFromFileName(entry.name);
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
              name: parsed.name ?? charaNameFromFileName(entry.name) ?? `Chara${no}`,
            };
            if (parsed.callName) info.callName = parsed.callName;
            charaIndex.set(no, info);
          }

          // ---- 2. ERB/口上/{NNNN}_{名称} → 绑定 kojoDir / 补 CSV 里没有的条目 ----
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
              // 根层的 `KOJO_PROFILE.ERB` 一类不是目录；真有奇怪目录时显式说明，不猜编号
              ctx.log.info(`口上目录无角色编号（原样保留，不建角色条目）：${entry.name}`);
              continue;
            }
            const info = charaIndex.get(parsed.no);
            if (info) {
              info.kojoDir = entry.path;
            } else {
              charaIndex.set(parsed.no, { no: parsed.no, name: parsed.label, kojoDir: entry.path });
            }
            bound++;
          }

          // ---- 3. 变量字典（CSV 主表 + .ERH 作者自定名表；失败不阻断开工程）----
          try {
            currentSchema = await loadEratohoreverseVariableSchema({
              io,
              csvDir,
              erbDir: erbRoot,
              log: ctx.log,
            });
          } catch (err) {
            currentSchema = undefined;
            ctx.log.warn(`变量字典加载失败（本次不带字典，工程照常打开）：${String(err)}`);
          }

          // ---- 4. 指令名表（`CSV/Train.csv` 实测只有 67 行：本作血统是 eraKanon 改変）----
          try {
            currentInstructionTable = await loadEratohoreverseInstructionNames({
              io,
              csvDir,
              log: ctx.log,
            });
          } catch (err) {
            currentInstructionTable = EMPTY_INSTRUCTION_TABLE;
            ctx.log.warn(`指令名表加载失败（本次不带指令表，工程照常打开）：${String(err)}`);
          }

          ctx.log.info(
            `eratohoReverse 工程加载完成：${charaIndex.size} 个角色（${bound} 个有口上目录，` +
              `实测 25 个角色目录 + 108 份角色 CSV），口上根：${kojoRoot}`,
          );

          return {
            rootDir,
            adapterId: ERATOHOREVERSE.gameId,
            // 索引吃整棵 ERB：`ERB/口上` 之外还有 SYSTEM / TRAIN / FUNCTION 三族公共函数
            kojoPaths: [erbRoot],
            // 可写面 = 口上域（含根层路由与 25 个角色目录）；`口上テンプレ/` 的第二棵树天然在外
            writablePaths: [kojoRoot],
            charaIndex,
            inputDigest:
              combineDigests([
                foldDigest(inputParts),
                ...(currentSchema?.inputDigest ? [currentSchema.inputDigest] : []),
              ]) ?? undefined,
          };
        },
      };

      ctx.slots.register('game.adapter', { id: `${ERATOHOREVERSE.gameId}-adapter`, adapter });

      /**
       * 检索范围：角色级收窄（与 eraAkumaMaid / era紅魔館 / eratohoK 共用同一份投影
       * `charaSearchScopeOptions`）。只认本项目；`order: 10` 与其它 adapter 同值——
       * 同时在场时按项目归属过滤，不靠 order 分胜负。
       */
      ctx.slots.register('search.scope', {
        id: `${ERATOHOREVERSE.gameId}-chara-scope`,
        order: 10,
        provide: (project) =>
          project !== null && project.adapterId === ERATOHOREVERSE.gameId
            ? charaSearchScopeOptions(project.charaIndex.values())
            : [],
      });
    },
  };
}
