; 露米娅 · 性交系指令 60-95 —— 真实语料逆向翻译
; 来源：個人口上/012 Rumia/ルーミア/M_KOJO_K12_性交系コマンド.ERB（1741 行，逐时机对照）
; 原语料本文件无任何 @M_KOJO_SUCCESS_* 函数 → 各时机一律不写 `成否:`，产物不新增成功判定函数（引擎兜底 TFLAG:192=0 与之等价）
; 本文件不写 `口上色:`（@M_KOJO_COLOR_K12 已在同角色セクハラ系语料金样中生成，重复定义会在游戏内撞名）
; LOCAL / LOCAL:1 / FIRSTTIME(SELECTCOM) / PLAYER 等裸标识分派条件、GOTO / $标签、作者色旁白 → 原生直通
; 引号内含「续」字的台词（如「还能继续吗…」）会被 `续` 标记语法误读 → 该行保留原生 PRINTFORMW 直通（随机块的合法候选）
; 空体分支以注释行占位（糖的块体不允许为空，注释进产物、零运行时输出）
角色: 12

; 60,正常位
时机 指令 60：
    ;-------------------------------------------------
    ;立位
    ;記入チェック（=0, 非表示、1, 表示）
    LOCAL = 1
    ;-------------------------------------------------
    IF LOCAL && TFLAG:193
    GOTO _SEIJYOUI15
    ;-------------------------------------------------
    ;小分岐
    ;-------------------------------------------------
    ;初めて
    ;記入チェック
    LOCAL:1 = 0
    ;-------------------------------------------------
    IF LOCAL:1 && FIRSTTIME(SELECTCOM)
    ;処女
    IF TCVAR:破瓜 == 1
    PRINTFORMW
    RETURN 1
    ELSE
    PRINTFORMW
    RETURN 1
    ENDIF
    ENDIF
    ;-------------------------------------------------
    ;挿入継続
    ;記入チェック
    LOCAL:1 = 0
    ;-------------------------------------------------
    IF LOCAL:1 && TCVAR:100 == PLAYER
    ;前回射精した
    IF TCVAR:102
    PRINTFORMW
    RETURN 1
    ELSE
    PRINTFORMW
    RETURN 1
    ENDIF
    ENDIF
    ;基本セット
    ;時姦中
    IF FLAG:70
    PRINTFORMW
    RETURN 1
    ;恋慕
    ELSEIF TALENT:恋慕
    PRINTFORMW
    RETURN 1
    ;屈服3
    ELSEIF MARK:不埒刻印 == 3
    PRINTFORMW
    RETURN 1
    ;それ以外
    ELSE
    PRINTFORMW
    RETURN 1
    ENDIF
    ENDIF
    ;-------------------------------------------------
    ;正常位
    ;記入チェック（=0, 非表示、1, 表示）
    LOCAL = 1
    ;-------------------------------------------------
    IF LOCAL
    $_SEIJYOUI15
    空行 续
    ;-------------------------------------------------
    ;小分岐
    ;-------------------------------------------------
    ;初めて
    ;記入チェック
    LOCAL:1 = 1
    ;-------------------------------------------------
    IF LOCAL:1 && FIRSTTIME(SELECTCOM)
    ;処女
    如果 TCVAR:破瓜 == 1：
        「这种事情我还是第一次所以…　慢一点、做哦」 续
        PRINTFORML 挤开了紧密闭合的秘所、轻轻地把阴茎插入进去…
        ;IF TALENT:恋慕 || TALENT:恋人
        ;	PRINTFORMW
        ;	PRINTFORML 「嗚、咕…　好痛…　嗚嗚…」
        ;	PRINTFORML %CALLNAME:MASTER%的阴茎在狭窄的阴道内挖开，不久後到达了最深处
        ;	PRINTFORML 「全部进去了、还出血了…　第一次给了%CALLNAME:MASTER%。嘿嘿…」
        ;	PRINTFORML 露米亚在破瓜的疼痛中含着泪向%CALLNAME:MASTER%微笑…
        ;	RETURN 1
        ;ELSE
        ;	RETURN 1
        ;ENDIF
        空行
    否则：
        如果 (TALENT:恋慕 || TALENT:恋人) && TCVAR:MASTER:童貞喪失 == 1：
            如果 PALAM:潤滑 > 3000：
                CALL HPH_PRINT(@"「那就把鸡鸡放进这里面吧HPH　黏黏滑滑的很舒服哦HPH」","L")
                PRINTFORMW 露米娅把自己的秘所向两边掰开、一边搅动溢流而出的爱液一边诱邀%CALLNAME:MASTER%…
                空行 续
                CALL HPH_PRINT(@"「处男毕业了、恭喜啊HPH　第一次的性交、感觉舒服吗？」","L")
                如果 NOWEX:MASTER:射精：
                    PRINTFORML 已经接近极限的%CALLNAME:MASTER%、不一会儿就被如同在主动榨取一样的肉壁逼到了绝境
                    「已经要去了吗？　就算是处男、也有些太快了哦…」 续
                    PRINTFORML 露米娅用腿缠住了%CALLNAME:MASTER%的腰、把阴茎迎入了自己的最深处…
                    CALL HPH_PRINT(@"「已经顶到子宮的入口了、能感觉到吗？　就对着这里满满地射出来吧HPH」","W")
                    CFLAG:1003 = 1
                否则：
                    空行
                    BASE:MASTER:射精 += 3000
                    SIF BASE:MASTER:射精 > 30000
                    BASE:MASTER:射精 = 30000
            否则：
                「还太早了啦ー。如果不先再弄湿一些的话…痛痛痛！　不要乱来啊！」
        否则：
            「从正面上、有些羞耻呢ー。嘿嘿嘿…」
    GOTO _SEIJYOUI
    ENDIF
    ;-------------------------------------------------
    ;挿入継続
    ;記入チェック
    LOCAL:1 = 1
    ;-------------------------------------------------
    ;基本セット
    ;時姦中
    IF FLAG:70
    空行
    RETURN 1
    ELSEIF LOCAL:1 && TCVAR:100 == PLAYER
    ;射精1ターン後。射精するときの口上はNOWEX:MASTER:射精
    ;随机块占用槽位 LOCAL / LOCAL:1 会覆写分派变量——本时机所有对 LOCAL、LOCAL:1 的读取
    ;（IF LOCAL、IF/ELSEIF LOCAL:1 && …）都在任何随机候选执行之前求值，覆写无副作用
    如果 TCVAR:102 && !NOWEX:MASTER:射精：
        如果 (TALENT:恋慕 || TALENT:恋人) && CFLAG:允许无套 > 0：
            随机：
                CALL HPH_PRINT(@"「不管射多少次都可以…　肚子里面、满满的都是%CALLNAME:MASTER%的精液呢HPH」","W")
                CALL HPH_PRINT(@"「精液、就像在里面摩擦着一样…　让我感觉很兴奋…HPH」","W")
                CALL HPH_PRINT(@"「精液和肉棒都在里面捣蛋哦HPH　一个劲、咕啾咕啾的HPH」","W")
                「一口气都射了多少发了ー？　精力绝伦呢…　呼呼♪」
                「还想接着款待我吗？　好高兴啊…♪」
        否则如果 CFLAG:既成事實 >= 1：
            随机：
                「今天明明一直在射个不停…　元气过头了啊」
                「刚刚才射进去的精液都溢出来了呢…　真是太H了♪」
                「呀ー嗯、在里面咕啾咕啾地响着…」
                「要一鼓作气、把精子射进最里面哦」
                「还没有射够吗？　大色鬼…」
    否则：
        如果 TALENT:恋慕 || TALENT:恋人：
            随机：
                CALL HPH_PRINT(@"「%CALLNAME:MASTER%HPH　%CALLNAME:MASTER%HPH　继续多顶几下HPH」","L")
                CALL HPH_PRINT(@"「%CALLNAME:MASTER%的鸡鸡HPH　好舒服啊HPH」","L")
                CALL HPH_PRINT(@"「紧紧地抱住彼此HPH　一起舒服起来吧ーHPH」","L")
                CALL HPH_PRINT(@"「看我死死把肉棒缠起来HPH　嘿嘿、不错的反应…HPH」","L")
                CALL HPH_PRINT(@"「那么温柔地对待我的话…　脑袋里面都开始晕乎乎的了HPH」","L")
            PRINTFORMW 露米娅的膣肉紧紧地吸住%CALLNAME:MASTER%不愿松开…
        否则如果 CFLAG:既成事實 >= 1：
            ;首候选引号内含「续」字 → 保留原生 PRINTFORMW 直通（其余候选降糖为台词）
            随机：
                PRINTFORMW 「还能继续吗…　呀唔、声音都要出来了」
                「稍微有点激烈了哟…　温柔一点…」
                「就好像从里面被撑开了一样中。好像也挺舒服…♪」
                「如何？　我的里面、舒服吗？」
                「呀唔、稍微让我休息会儿嘛」
    ELSEIF PALAM:潤滑 < 3000
    「还太早了啦ー。如果不先再弄湿一些的话…痛痛痛！　不要乱来啊！」
    ELSEIF TALENT:恋慕 || TALENT:恋人
    ;候选为台词+分支混排的多结构 SELECTCASE → 原生直通（同级叶子写法，CASE 体内糖块正常降糖）
    SELECTCASE RAND:3
    CASE 1
    「把手、牵住。一起舒服起来吧♪」
    CASE 2
    如果 TALENT:MASTER:形状 > 2：
        「我的体形太小了、没法让%CALLNAME:MASTER%的鸡鸡全部进来啊…」 续
        「会很不满足吧？　抱歉啊…」
    否则：
        「%CALLNAME:MASTER%的鸡鸡、让我很舒服所以我很喜欢哟」 续
        「很小吗？　明明对我来说正好…」
    CASEELSE
    「最喜欢这个姿势了。能够清楚地看见%CALLNAME:MASTER%的脸呢」
    ENDSELECT
    RETURN 1
    ELSEIF CFLAG:既成事實 >= 1
    SELECTCASE RAND:3
    CASE 1
    「做了好多次舒服的事情呢」
    CASE 2
    如果 TALENT:MASTER:形状 > 2：
        「%CALLNAME:MASTER%的那里、稍微有些大了感觉很不舒服呢ー」
    否则：
        「%CALLNAME:MASTER%的那里、感觉形状很可爱呢…　呼呼♪」
    CASEELSE
    「只要平躺着就可以了吗ー？」
    ENDSELECT
    RETURN 1
    ;それ以外
    ELSE
    空行
    RETURN 1
    ENDIF
    ENDIF
    $_SEIJYOUI
    RETURN 1

; 61,後背位
时机 指令 61：
    ;-------------------------------------------------
    ;立位
    ;記入チェック（=0, 非表示、1, 表示）
    LOCAL = 1
    ;-------------------------------------------------
    IF LOCAL && TFLAG:193
    GOTO _KOUHAII17
    ;-------------------------------------------------
    ;小分岐
    ;-------------------------------------------------
    ;初めて
    ;記入チェック
    LOCAL:1 = 0
    ;-------------------------------------------------
    IF LOCAL:1 && FIRSTTIME(SELECTCOM)
    ;処女
    IF TCVAR:破瓜 == 1
    PRINTFORMW
    RETURN 1
    ELSE
    PRINTFORMW
    RETURN 1
    ENDIF
    ENDIF
    ;-------------------------------------------------
    ;挿入継続
    ;記入チェック
    LOCAL:1 = 0
    ;-------------------------------------------------
    IF LOCAL:1 && TCVAR:100 == PLAYER
    ;前回射精した
    IF TCVAR:102
    PRINTFORMW
    RETURN 1
    ELSE
    PRINTFORMW
    RETURN 1
    ENDIF
    ENDIF
    ;基本セット
    ;時姦中
    IF FLAG:70
    PRINTFORMW
    RETURN 1
    ;恋慕
    ELSEIF TALENT:恋慕
    PRINTFORMW
    RETURN 1
    ;屈服3
    ELSEIF MARK:不埒刻印 == 3
    PRINTFORMW
    RETURN 1
    ;それ以外
    ELSE
    PRINTFORMW
    RETURN 1
    ENDIF
    ENDIF
    ;-------------------------------------------------
    ;後背位
    ;記入チェック（=0, 非表示、1, 表示）
    LOCAL = 1
    ;-------------------------------------------------
    IF LOCAL
    $_KOUHAII17
    空行 续
    ;-------------------------------------------------
    ;小分岐
    ;-------------------------------------------------
    ;初めて
    ;記入チェック
    LOCAL:1 = 1
    ;-------------------------------------------------
    IF LOCAL:1 && FIRSTTIME(SELECTCOM)
    ;処女
    如果 TCVAR:破瓜 == 1：
        「要从后面做吗？　总感觉有些害怕呢」 续
        PRINTFORML 一边温柔地抚摸着紧张的露米娅一边把阴茎插了进去…
        ;IF TALENT:恋慕 || TALENT:恋人
        ;	PRINTFORMW
        ;	PRINTFORML 「」
        ;	PRINTFORML
        ;	PRINTFORML 「」
        ;	PRINTFORML
        ;	RETURN 1
        ;ELSE
        ;	RETURN 1
        ;ENDIF
        空行
    否则：
        如果 (TALENT:恋慕 || TALENT:恋人) && TCVAR:MASTER:童貞喪失 == 1：
            如果 PALAM:潤滑 > 3000：
                CALL HPH_PRINT(@"「那就把鸡鸡放进这里面吧HPH　黏黏滑滑的很舒服哦HPH」","L")
                PRINTFORMW 露米娅把自己的秘所向两边掰开、一边搅动溢流而出的爱液一边诱邀%CALLNAME:MASTER%…
                空行 续
                CALL HPH_PRINT(@"「处男毕业了、恭喜啊HPH　第一次的性交、感觉舒服吗？」","L")
                如果 NOWEX:MASTER:射精：
                    PRINTFORML 已经接近极限的%CALLNAME:MASTER%、不一会儿就被如同在主动榨取一样的肉壁逼到了绝境
                    「已经要去了吗？　就算是处男、也有些太快了哦…」 续
                    PRINTFORML 露米娅用腿缠住了%CALLNAME:MASTER%的腰、把阴茎迎入了自己的最深处…
                    CALL HPH_PRINT(@"「已经顶到子宮的入口了、能感觉到吗？　就对着这里满满地射出来吧HPH」","W")
                    CFLAG:1003 = 1
                否则：
                    空行
                    BASE:MASTER:射精 += 3000
                    SIF BASE:MASTER:射精 > 30000
                    BASE:MASTER:射精 = 30000
            否则：
                「还太早了啦ー。如果不先再弄湿一些的话…痛痛痛！　不要乱来啊！」
        否则：
            「要用这种姿势做吗ー？　从后面的话我什么看不见…」
    GOTO _KOUHAII
    ENDIF
    ;-------------------------------------------------
    ;挿入継続
    ;記入チェック
    LOCAL:1 = 1
    ;-------------------------------------------------
    ;基本セット
    ;時姦中
    IF FLAG:70
    空行
    RETURN 1
    ELSEIF LOCAL:1 && TCVAR:100 == PLAYER
    ;射精1ターン後。射精するときの口上はNOWEX:MASTER:射精
    如果 TCVAR:102 && !NOWEX:MASTER:射精：
        如果 (TALENT:恋慕 || TALENT:恋人) && CFLAG:允许无套 > 0：
            随机：
                CALL HPH_PRINT(@"「不管射多少次都可以…　肚子里面、满满的都是%CALLNAME:MASTER%的精液呢HPH」","W")
                CALL HPH_PRINT(@"「精液、就像在里面摩擦着一样…　让我感觉很兴奋…HPH」","W")
                CALL HPH_PRINT(@"「精液和肉棒都在里面捣蛋哦HPH　一个劲、咕啾咕啾的HPH」","W")
                「一口气都射了多少发了ー？　精力绝伦呢…　呼呼♪」
                「还想接着款待我吗？　好高兴啊…♪」
        否则如果 CFLAG:既成事實 >= 1：
            随机：
                「今天明明一直在射个不停…　元气过头了啊」
                「刚刚才射进去的精液都溢出来了呢…　真是太H了♪」
                「呀ー嗯、在里面咕啾咕啾地响着…」
                「要一鼓作气、把精子射进最里面哦」
                「还没有射够吗？　大色鬼…」
    否则：
        如果 TALENT:恋慕 || TALENT:恋人：
            随机：
                CALL HPH_PRINT(@"「%CALLNAME:MASTER%HPH　%CALLNAME:MASTER%HPH　继续多顶几下HPH」","L")
                CALL HPH_PRINT(@"「%CALLNAME:MASTER%的鸡鸡HPH　好舒服啊HPH」","L")
                CALL HPH_PRINT(@"「紧紧地抱住彼此HPH　一起舒服起来吧ーHPH」","L")
                CALL HPH_PRINT(@"「看我死死把肉棒缠起来HPH　嘿嘿、不错的反应…HPH」","L")
                CALL HPH_PRINT(@"「那么温柔地对待我的话…　脑袋里面都开始晕乎乎的了HPH」","L")
            PRINTFORMW 露米娅的膣肉紧紧地吸住%CALLNAME:MASTER%不愿松开…
        否则如果 CFLAG:既成事實 >= 1：
            ;首候选引号内含「续」字 → 保留原生 PRINTFORMW 直通
            随机：
                PRINTFORMW 「还能继续吗…　呀唔、声音都要出来了」
                「稍微有点激烈了哟…　温柔一点…」
                「就好像从里面被撑开了一样中。好像也挺舒服…♪」
                「如何？　我的里面、舒服吗？」
                「呀唔、稍微让我休息会儿嘛」
    ELSEIF PALAM:潤滑 < 3000
    「还太早了啦ー。如果不先再弄湿一些的话…痛痛痛！　不要乱来啊！」
    ELSEIF TALENT:恋慕 || TALENT:恋人
    ;CASEELSE 分支为台词+作者色旁白两行 → 原生 SELECTCASE 直通（同级叶子写法）
    SELECTCASE RAND:3
    CASE 1
    「没法看见你的脸感觉好寂寞啊ー。作为补偿要紧紧ー地、贴住我哦」
    CASE 2
    如果 TALENT:MASTER:形状 > 2：
        「%CALLNAME:MASTER%的大肉棒、一下子就进到最里面了呢」 续
        「肚子里面全部都被%CALLNAME:MASTER%塞满了、虽然有些难受但是也很舒服啊♪」
    否则：
        「%CALLNAME:MASTER%的肉棒、一下子就进到最里面了呢」 续
        「这个姿势的话会比平常插得都深好喜欢啊ー♪」
    CASEELSE
    「诶嘿嘿ー、什么时候插进来都可以哟ー♪」
    PRINTFORMW 露米娅晃着屁股挑逗%CALLNAME:MASTER%…
    ENDSELECT
    RETURN 1
    ELSEIF CFLAG:既成事實 >= 1
    SELECTCASE RAND:3
    CASE 1
    「呀嗯、不要摸我屁股嘛ー。痒痒的ー」
    CASE 2
    如果 TALENT:MASTER:形状 > 2：
        「不要把体重全部压上来哦。%CALLNAME:MASTER%的那个很大、我会被挤坏的…」
    否则：
        「再稍微用力些也可以哦ー。连%CALLNAME:MASTER%的那个也能进到最里面真的很舒服的♪」
    CASEELSE
    「看不见的话会有些不安呢ー。　…还没开始吗？」
    ENDSELECT
    RETURN 1
    ;それ以外
    ELSE
    空行
    RETURN 1
    ENDIF
    ENDIF
    $_KOUHAII
    RETURN 1

; 62,正常位肛交（原语料 LOCAL=0 占位空壳，全部分支为空文本 → 空体时机）
时机 指令 62：

; 63,後背位肛交（原语料 LOCAL=0 占位空壳）
时机 指令 63：

; 64,逆強姦（紛らわしいが女你が上に乗るのであり、你が襲われるわけではない／原语料 LOCAL=0 占位空壳）
时机 指令 64：

; 65,騎乗位
时机 指令 65：
    ;-------------------------------------------------
    ;記入チェック（=0, 非表示、1, 表示）
    LOCAL = 1
    ;-------------------------------------------------
    IF LOCAL
    空行 续
    ;-------------------------------------------------
    ;小分岐
    ;-------------------------------------------------
    ;初めて
    ;記入チェック
    LOCAL:1 = 1
    ;-------------------------------------------------
    IF LOCAL:1 && FIRSTTIME(SELECTCOM)
    如果 TALENT:恋慕 || TALENT:恋人：
        ;処女
        如果 TCVAR:破瓜 == 1 && TCVAR:MASTER:童貞喪失 == 1：
            ;	PRINTFORML 「」
            ;	PRINTFORML 「」
            ;	PRINTFORML 「」
            RETURN 1
        否则如果 TCVAR:MASTER:童貞喪失 == 1：
            空行
            RETURN 1
        否则：
            空行
            RETURN 1
    ENDIF
    ;-------------------------------------------------
    ;挿入継続
    ;記入チェック
    LOCAL:1 = 0
    ;-------------------------------------------------
    IF LOCAL:1 && TCVAR:100 == PLAYER
    ;前回射精した
    如果 TCVAR:102：
        空行
        RETURN 1
    否则：
        空行
        RETURN 1
    ENDIF
    ;基本セット
    ;時姦中
    如果 FLAG:70：
        空行
        RETURN 1
    否则如果 TALENT:恋慕：
        空行
        RETURN 1
    否则如果 MARK:不埒刻印 == 3：
        空行
        RETURN 1
    否则：
        空行
        RETURN 1
    ENDIF
    RETURN 1

; 66,騎乗位肛交（原语料 LOCAL=0 占位空壳）
时机 指令 66：

; 67,対面座位
时机 指令 67：
    ;-------------------------------------------------
    ;記入チェック（=0, 非表示、1, 表示）
    LOCAL = 1
    ;-------------------------------------------------
    IF LOCAL
    空行 续
    ;-------------------------------------------------
    ;小分岐
    ;-------------------------------------------------
    ;初めて
    ;記入チェック
    LOCAL:1 = 1
    ;-------------------------------------------------
    IF LOCAL:1 && FIRSTTIME(SELECTCOM)
    ;処女
    如果 TCVAR:破瓜 == 1：
        「%CALLNAME:MASTER%也在紧张吗？　心跳声、很剧烈哦」 续
        「呼呼、总感觉安下心了。一起做爱、来吧？」 续
        PRINTFORML 露米娅用手紧紧地环抱住%CALLNAME:PLAYER%的头首…
        ;IF TALENT:恋慕 || TALENT:恋人
        ;	PRINTFORMW
        ;	PRINTFORML 「肚子里有点不安啊…　呜…」
        ;	PRINTFORML 露米亚抓住了%CALLNAME:MASTER%的阴茎，引导到了自己的小穴…
        ;	PRINTFORML 「这里呦…我的第一次，獻給你%CALLNAME:MASTER%」
        ;	PRINTFORML
        ;	RETURN 1
        ;ELSE
        ;	RETURN 1
        ;ENDIF
        空行
    否则：
        如果 PALAM:潤滑 > 3000：
            「离得这么近会很难为情呢ー、诶嘿嘿」
        否则：
            「还太早了啦ー。如果不先再弄湿一些的话…痛痛痛！　不要乱来啊！」
    GOTO _TAIMEN
    ENDIF
    ;-------------------------------------------------
    ;挿入継続
    ;記入チェック
    LOCAL:1 = 1
    ;-------------------------------------------------
    ;基本セット
    ;時姦中
    IF FLAG:70
    空行
    RETURN 1
    ELSEIF LOCAL:1 && TCVAR:100 == PLAYER
    ;射精1ターン後。射精するときの口上はNOWEX:MASTER:射精
    如果 TCVAR:102 && !NOWEX:MASTER:射精：
        如果 (TALENT:恋慕 || TALENT:恋人) && CFLAG:允许无套 > 0：
            随机：
                CALL HPH_PRINT(@"「不管射多少次都可以…　肚子里面、满满的都是%CALLNAME:MASTER%的精液呢HPH」","W")
                CALL HPH_PRINT(@"「精液、就像在里面摩擦着一样…　让我感觉很兴奋…HPH」","W")
                CALL HPH_PRINT(@"「精液和肉棒都在里面捣蛋哦HPH　一个劲、咕啾咕啾的HPH」","W")
                「一口气都射了多少发了ー？　精力绝伦呢…　呼呼♪」
                「还想接着款待我吗？　好高兴啊…♪」
        否则如果 CFLAG:既成事實 >= 1：
            随机：
                「今天明明一直在射个不停…　元气过头了啊」
                「刚刚才射进去的精液都溢出来了呢…　真是太H了♪」
                「呀ー嗯、在里面咕啾咕啾地响着…」
                「要一鼓作气、把精子射进最里面哦」
                「还没有射够吗？　大色鬼…」
    否则：
        如果 TALENT:恋慕 || TALENT:恋人：
            随机：
                CALL HPH_PRINT(@"「%CALLNAME:MASTER%HPH　%CALLNAME:MASTER%HPH　继续多顶几下HPH」","L")
                CALL HPH_PRINT(@"「%CALLNAME:MASTER%的鸡鸡HPH　好舒服啊HPH」","L")
                CALL HPH_PRINT(@"「紧紧地抱住彼此HPH　一起舒服起来吧ーHPH」","L")
                CALL HPH_PRINT(@"「看我死死把肉棒缠起来HPH　嘿嘿、不错的反应…HPH」","L")
                CALL HPH_PRINT(@"「那么温柔地对待我的话…　脑袋里面都开始晕乎乎的了HPH」","L")
            PRINTFORMW 露米娅的膣肉紧紧地吸住%CALLNAME:MASTER%不愿松开…
        否则如果 CFLAG:既成事實 >= 1：
            ;首候选引号内含「续」字 → 保留原生 PRINTFORMW 直通
            随机：
                PRINTFORMW 「还能继续吗…　呀唔、声音都要出来了」
                「稍微有点激烈了哟…　温柔一点…」
                「就好像从里面被撑开了一样中。好像也挺舒服…♪」
                「如何？　我的里面、舒服吗？」
                「呀唔、稍微让我休息会儿嘛」
    ELSEIF PALAM:潤滑 < 3000
    「还太早了啦ー。如果不先再弄湿一些的话…痛痛痛！　不要乱来啊！」
    ELSEIF TALENT:恋慕 || TALENT:恋人
    ;CASE2/CASEELSE 为台词+分支/旁白混排 → 原生 SELECTCASE 直通（同级叶子写法）
    SELECTCASE RAND:3
    CASE 1
    「%CALLNAME:MASTER%来感觉时候的脸、看到了很多次呢。…呼呼呼、脸都通红了哟ー」
    CASE 2
    ;主人公が露米娅より2尺寸以上大きい
    如果 (TALENT:MASTER:体型 - TALENT:12:体型) > 1：
        「嗯～…　再把头弯下来一些。够不到ー」 续
        「啾♪　呼呼、我实在太娇小了所以连亲嘴都很费劲呢」
    否则：
        「这个姿势、可以同时上面和下面一起品尝%CALLNAME:MASTER%呢ー」 续
        「太高兴导致连口水都流出来了…　咻噜」
    CASEELSE
    「再多多抱紧你一些…　身体也是、鸡鸡也是…♪」 续
    PRINTFORMW 露米娅四肢并用紧紧缠住了%CALLNAME:MASTER%…
    ENDSELECT
    RETURN 1
    ELSEIF CFLAG:既成事實 >= 1
    SELECTCASE RAND:3
    CASE 1
    「都不怎么能看见脸呢…　好害羞啊…」
    CASE 2
    ;原语料此处 IF 被整段注释，只留两行正文 → 注释原样保留
    ;IF (TALENT:MASTER:体型 - TALENT:12:体型) > 1
    「想和像我一样娇小的孩子彼此拥抱什么的…」 续
    「…不就是变态吗？」
    ;ELSE
    ;	PRINTFORMW 「」
    ;ENDIF
    CASEELSE
    「可以抱得再紧一些吗？　那样会感觉很安心」
    ENDSELECT
    RETURN 1
    ;それ以外
    ELSE
    空行
    RETURN 1
    ENDIF
    ENDIF
    $_TAIMEN
    RETURN 1

; 68,背面座位
时机 指令 68：
    ;-------------------------------------------------
    ;記入チェック（=0, 非表示、1, 表示）
    LOCAL = 1
    ;-------------------------------------------------
    IF LOCAL
    空行 续
    ;-------------------------------------------------
    ;小分岐
    ;-------------------------------------------------
    ;初めて
    ;記入チェック
    LOCAL:1 = 1
    ;-------------------------------------------------
    IF LOCAL:1 && FIRSTTIME(SELECTCOM)
    ;処女
    如果 TCVAR:破瓜 == 1：
        「要用这个姿势插进来吗？　好可怕啊ー…　让我慢点下去哦」 续
        PRINTFORML 阴茎顶着露米娅的秘部、手臂慢慢开始用力…
        ;IF TALENT:恋慕 || TALENT:恋人
        ;	PRINTFORMW
        ;	PRINTFORML 「」
        ;	PRINTFORML
        ;	PRINTFORML 「」
        ;	PRINTFORML
        ;	RETURN 1
        ;ELSE
        ;	RETURN 1
        ;ENDIF
        空行
    否则：
        如果 PALAM:潤滑 > 3000：
            「坐到腿上…　能好好支撑住吗？　不会断掉吧？」
        否则：
            「还太早了啦ー。如果不先再弄湿一些的话…痛痛痛！　不要乱来啊！」
    GOTO _HAIMEN
    ENDIF
    ;-------------------------------------------------
    ;挿入継続
    ;記入チェック
    LOCAL:1 = 1
    ;-------------------------------------------------
    ;基本セット
    ;時姦中
    IF FLAG:70
    空行
    RETURN 1
    ELSEIF LOCAL:1 && TCVAR:100 == PLAYER
    ;射精1ターン後。射精するときの口上はNOWEX:MASTER:射精
    如果 TCVAR:102 && !NOWEX:MASTER:射精：
        如果 (TALENT:恋慕 || TALENT:恋人) && CFLAG:允许无套 > 0：
            随机：
                CALL HPH_PRINT(@"「不管射多少次都可以…　肚子里面、满满的都是%CALLNAME:MASTER%的精液呢HPH」","W")
                CALL HPH_PRINT(@"「精液、就像在里面摩擦着一样…　让我感觉很兴奋…HPH」","W")
                CALL HPH_PRINT(@"「精液和肉棒都在里面捣蛋哦HPH　一个劲、咕啾咕啾的HPH」","W")
                「一口气都射了多少发了ー？　精力绝伦呢…　呼呼♪」
                「还想接着款待我吗？　好高兴啊…♪」
        否则如果 CFLAG:既成事實 >= 1：
            随机：
                「今天明明一直在射个不停…　元气过头了啊」
                「刚刚才射进去的精液都溢出来了呢…　真是太H了♪」
                「呀ー嗯、在里面咕啾咕啾地响着…」
                「要一鼓作气、把精子射进最里面哦」
                「还没有射够吗？　大色鬼…」
    否则：
        如果 TALENT:恋慕 || TALENT:恋人：
            随机：
                CALL HPH_PRINT(@"「%CALLNAME:MASTER%HPH　%CALLNAME:MASTER%HPH　继续多顶几下HPH」","L")
                CALL HPH_PRINT(@"「%CALLNAME:MASTER%的鸡鸡HPH　好舒服啊HPH」","L")
                CALL HPH_PRINT(@"「紧紧地抱住彼此HPH　一起舒服起来吧ーHPH」","L")
                CALL HPH_PRINT(@"「看我死死把肉棒缠起来HPH　嘿嘿、不错的反应…HPH」","L")
                CALL HPH_PRINT(@"「那么温柔地对待我的话…　脑袋里面都开始晕乎乎的了HPH」","L")
            PRINTFORMW 露米娅的膣肉紧紧地吸住%CALLNAME:MASTER%不愿松开…
        否则如果 CFLAG:既成事實 >= 1：
            ;首候选引号内含「续」字 → 保留原生 PRINTFORMW 直通
            随机：
                PRINTFORMW 「还能继续吗…　呀唔、声音都要出来了」
                「稍微有点激烈了哟…　温柔一点…」
                「就好像从里面被撑开了一样中。好像也挺舒服…♪」
                「如何？　我的里面、舒服吗？」
                「呀唔、稍微让我休息会儿嘛」
    ELSEIF PALAM:潤滑 < 3000
    「还太早了啦ー。如果不先再弄湿一些的话…痛痛痛！　不要乱来啊！」
    ELSEIF TALENT:恋慕 || TALENT:恋人
    ;CASE2 为作者色旁白+分支混排 → 原生 SELECTCASE 直通（同级叶子写法）
    SELECTCASE RAND:3
    CASE 1
    「把%CALLNAME:MASTER%整个包裹着的性爱、真的好幸福…」
    CASE 2
    PRINTFORML 从后面用力揉弄着在膝上晃着腰的露米娅的胸…
    如果 TALENT:胸围 >= 0：
        CALL HPH_PRINT(@"「胸也好那里也好全部都是属于%CALLNAME:MASTER%的东西、随意使用就好HPH」","W")
    否则：
        「这么小的胸还揉得那么拼命…　真ー下流♪」
    CASEELSE
    「这样子扭腰的话…　呼呼、效果立竿见影…♪」
    ENDSELECT
    RETURN 1
    ELSEIF CFLAG:既成事實 >= 1
    SELECTCASE RAND:3
    CASE 1
    「可以再靠近一些吗？　背上暖烘烘的我很喜欢」
    CASE 2
    PRINTFORML 从后面用力揉弄着坐在腿上的露米娅的胸…
    如果 TALENT:胸围 >= 0：
        「一边顶一边揉胸可是…　犯规、哟！」
    否则：
        「呀ー嗯、不要揪我的胸ー」
    CASEELSE
    「可不要让我掉下去了哟、可要好好支撑住啊ー」
    ENDSELECT
    RETURN 1
    ;それ以外
    ELSE
    空行
    RETURN 1
    ENDIF
    ENDIF
    $_HAIMEN
    RETURN 1

; 69,対面座位肛交（原语料 LOCAL=0 占位空壳）
时机 指令 69：

; 70,背面座位肛交（原语料 LOCAL=0 占位空壳）
时机 指令 70：

; 71,二穴挿入（原语料 LOCAL=0 占位空壳，多手分派链全为空文本）
时机 指令 71：

; 72,挿入Ｇ點玩弄（原语料 LOCAL=0 占位空壳）
时机 指令 72：

; 73,挿入子宮口玩弄（LOCAL=1 生效：空体 FIRSTTIME 块有首次记录副作用，必须保留）
时机 指令 73：
    ;-------------------------------------------------
    ;記入チェック（=0, 非表示、1, 表示）
    LOCAL = 1
    ;-------------------------------------------------
    IF LOCAL
    ;-------------------------------------------------
    ;小分岐
    ;-------------------------------------------------
    ;初めて
    ;記入チェック
    LOCAL:1 = 1
    ;-------------------------------------------------
    ;空体 IF/ENDIF 对：FIRSTTIME(SELECTCOM) 的「记录首次」副作用必须保留 → 原生直通
    IF LOCAL:1 && FIRSTTIME(SELECTCOM)
    ENDIF
    ;-------------------------------------------------
    ;挿入継続
    ;記入チェック
    LOCAL:1 = 0
    ;-------------------------------------------------
    IF LOCAL:1 && TCVAR:101 == PLAYER
    ;前回射精した
    如果 TCVAR:104：
        空行
        RETURN 1
    否则：
        空行
        RETURN 1
    ENDIF
    ;基本セット
    ;恋慕
    如果 TALENT:恋慕：
        空行
        RETURN 1
    否则如果 MARK:不埒刻印 == 3：
        空行
        RETURN 1
    否则：
        空行
        RETURN 1
    ENDIF
    RETURN 1

; 74,玩弄Ｓ状結腸（原语料 LOCAL=0 占位空壳）
时机 指令 74：

; 75,隔着刺激阴道（原语料 LOCAL=0 占位空壳）
时机 指令 75：

; 77,小人飛機杯(針妙丸用？（原语料 LOCAL=0 占位空壳）
时机 指令 77：

; 95,疑似挿入（原语料 LOCAL=0 占位空壳）
时机 指令 95：
