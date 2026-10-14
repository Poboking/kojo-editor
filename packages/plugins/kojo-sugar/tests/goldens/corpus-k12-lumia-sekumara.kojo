; 露米娅 · 性骚扰系指令 310-330 —— 真实语料逆向翻译
; 来源：個人口上/012 Rumia/ルーミア/M_KOJO_K12_セクハラコマンド.ERB（499 行，逐时机对照）
; 空体分支以注释行占位（糖的块体不允许为空，注释进产物、零运行时输出）
角色: 12
口上色: 0xE4FC08

; 310,摸屁股（原语料 LOCAL=0 占位空壳）
时机 指令 310 成否: 游戏判定：

; 311,拥抱
时机 指令 311 成否: 游戏判定：
    如果 FLAG:70：
        ;(FLAG:70 静音分支，原语料空体)
    否则如果 CFLAG:睡眠：
        如果 TCVAR:発情：
            PALAM:12:潤滑 += 1000
            CALL HPH_PRINT(@"「…嗯嗯…。还想做…舒服ー的事…HPH」","L")
            PRINTFORMW 露米娅用手摩擦着%CALLNAME:MASTER%的股间…
        否则如果 TALENT:恋慕：
            「嗯～…有股很好吃的味道…」 续
            PRINTFORMW 露米娅紧紧抱住%CALLNAME:MASTER%的手臂、不断轻咬着…
        否则：
            「唔嗯～…这是米饭吗～？」 续
            PRINTFORMW 露米娅咬着%CALLNAME:MASTER%的手臂…
    否则如果 TFLAG:193 == -1：
        GOTO _DAKITUKI20
    否则如果 TALENT:恋慕 || TALENT:恋人：
        ;候选为多语句（台词+旁白），超出「随机」单行候选能力 → 原生 SELECTCASE 直通
        ;（直通行是叶子：CASE 体内各语句与 CASE 同级书写，ERB 缩进无语义，产出顺序不变）
        SELECTCASE RAND:5
        CASE 1
        「%CALLNAME:MASTER%的心脏猛跳个不停哟。因为我而兴奋起来了吗…？」 续
        PRINTFORMW 露米娅抬头看着%CALLNAME:MASTER%的同时哧哧哧地坏笑起来…
        CASE 2
        CALL HPH_PRINT(@"「欸嘿嘿ー。全身都被%CALLNAME:MASTER%包裹着、很舒服呢…HPH」","L")
        PRINTFORMW 露米娅抱着%CALLNAME:MASTER%、不断地亲吻他的脸…
        CASE 3
        「我也来用胸给你啾～的服务一下…如何？　被胸部顶着舒服吗？」 续
        如果 TALENT:12:胸围 > 0：
            PRINTFORMW 露米娅丰满的胸部压在%CALLNAME:MASTER%身上、软绵绵地变换着形状…
            SIF !TALENT:MASTER:性別 == 1
            BASE:MASTER:勃起 = 1000
        否则如果 TALENT:12:胸围 < 0：
            PRINTFORMW 露米娅成熟的胸部压在%CALLNAME:MASTER%身上、彰显着确切的触感…
            SIF !TALENT:MASTER:性別 == 1
            BASE:MASTER:勃起 += 300
        否则：
            PRINTFORMW 露米娅的胸部压在%CALLNAME:MASTER%身上、少女柔软的触感传了过来…
            SIF !TALENT:MASTER:性別 == 1
            BASE:MASTER:勃起 += 500
        CASE 4
        「%CALLNAME:MASTER%喜欢和我拥抱吗？　那真是太好了…」
        CASEELSE
        「呼嗯。这个气味、好温暖…感觉心情平静下来了」 续
        PRINTFORMW 露米娅一脸幸福地享受着%CALLNAME:MASTER%的拥抱…
        ENDSELECT
    否则如果 TALENT:思慕：
        随机：
            「姆咕。好难受ー、让我放松一下ー」
            「总觉得有些害羞啊ー…差不多可以放开我了吧？」
            「这个会让人心跳加速呢。感觉有点坐立不安…」
            「真是拿你没办法啊ー。既然都说了不喜欢这样做的话那就放开我吧」
            「%CALLNAME:MASTER%闻起来好像很好吃呢。可以再靠过来一点吗？」
    否则如果 ABL:12:親密 >= 5：
        随机：
            「哇、吓了我一跳ー。我差点儿就要咬你了」
            「嗯ー…如果是%CALLNAME:MASTER%的话也不是不行」
            「你觉得抱着我很开心吗？　真是个奇怪的人」
            「这样突然抱住别人是不行的哦ー。会被抓走的哦ー？」
    否则：
        $_DAKITUKI20
        随机：
            「离我远点ー、好烦人ー」
            「这样会让我行动不便的ー、好碍事ー」
            「讨厌ー。放开我ー」
            「唔ー、别这样和我靠在一起啊ー」

; 312,接吻
时机 指令 312 成否: 游戏判定：
    如果 FLAG:70：
        ;(FLAG:70 静音分支，原语料空体)
    否则如果 CFLAG:睡眠：
        ;(原语料空体)
    否则如果 CFLAG:TARGET:陪睡中 && !TFLAG:193 == 99：
        如果 TALENT:恋慕 || TALENT:恋人：
            随机：
                「欸嘿嘿。这样的话说不定可以做个好梦…」
                CALL HPH_PRINT(@"「晚安啦ー、非常感谢你的亲亲ー。我也要给予回礼才行ーHPH」","W")
                「晚安…明天也要一起去玩哦…」
        否则：
            ;(原语料空体)
    否则如果 TFLAG:193 == 99：
        如果 TCVAR:発情：
            CALL HPH_PRINT(@"（现在可不行…不忍耐住的话可能会把%CALLNAME:MASTER%给吃干抹净的…HPH）","W")
        否则如果 TALENT:恋慕 || TALENT:恋人：
            「刚刚吃了肉…不能等漱口完之后再做吗？」
        否则：
            随机：
                「%CALLNAME:MASTER%…脸怎么这么吓人啊？」
                「不要突然把脸凑过来哦ー。吓了我一跳」
                「接吻？　才不要、总感觉有点讨厌ー…」
    否则如果 TALENT:恋慕 || TALENT:恋人：
        随机：
            「最喜欢和%CALLNAME:MASTER%接吻了ー♪　再多亲亲我吧。呐」
            「为了让你更喜欢我、得更多亲亲才行ー」
            CALL HPH_PRINT(@"「今天也要教会我更多关于大人的事情哦…HPH」","W")
            CALL HPH_PRINT(@"「够不着啊ー！　%CALLNAME:MASTER%快点蹲下来ー…啾HPH」","W")
            CALL HPH_PRINT(@"「哇…感觉头晕晕的…这种事情可能会让人上瘾啊HPH」","W")
    否则如果 TALENT:思慕 || ABL:欲望 >= 5：
        随机：
            「有股甜甜的味道…难道是偷偷吃了点心吗ー？　好狡猾ー」
            「还是觉得很害羞啊ー…可以闭上眼睛吗？」
            「脸开始变得烫起来了…请给我些水。要凉的」
            「能看见脸的话就感觉好害羞啊ー。不能藏进黑暗里吗？」
    否则：
        随机：
            「这种事不是和喜欢的人做的吗ー？」
            「并不怎么舒服ー。还是别做了吧？」
            「总感觉痒痒的挺恶心的ー」
            「很讨厌被腻腻歪歪地触碰着ー。明明找其他人做就好ー」
            「…！　突然在干什么啊ー」

; 313,胸爱抚
时机 指令 313 成否: 游戏判定：
    如果 FLAG:70：
        ;(FLAG:70 静音分支，原语料空体)
    否则如果 CFLAG:睡眠：
        ;(原语料空体)
    否则如果 TALENT:恋慕 || TALENT:恋人：
        如果 TALENT:12:胸围 > 0：
            ;RAND:9 分布不均（2,2,2,2,1）且 LOCAL 不可在表达式位引用 → 原生直通（同级叶子写法）
            SELECTCASE RAND:9
            CASE 1, 2
            CALL HPH_PRINT(@"「虽然胸太大很难活动很碍事、但是如果%CALLNAME:MASTER%喜欢的话就好了ーHPH」","W")
            CASE 3, 4
            CALL HPH_PRINT(@"「胸部好像又变大了HPH　已经比%CALLNAME:MASTER%的手还要大了呢…HPH」","W")
            CASE 5, 6
            CALL HPH_PRINT(@"「欸嘿嘿、很大吧。说不定还能夹住%CALLNAME:MASTER%的脸…HPH　要不要试一下？」","W")
            CASE 7, 8
            CALL HPH_PRINT(@"「%CALLNAME:MASTER%真的很喜欢大大的胸部呢ー。呼呼。你想怎么摸就怎么摸吧HPH」","W")
            CASEELSE
            GOTO _MUNEAIBU21
            ENDSELECT
        否则：
            $_MUNEAIBU21
            随机：
                「胸部好像被%CALLNAME:MASTER%揉大了一点儿。没有变化？　什么啊ー、再给我好好观察一下ー」
                CALL HPH_PRINT(@"「别在这种地方揉胸啊HPH　真是变态HPH」","W")
                CALL HPH_PRINT(@"「呀啊HPH　已经忍不住了吗ー？」","W")
                CALL HPH_PRINT(@"「唔ー、%CALLNAME:MASTER%真的很H呢ーHPH」","W")
                CALL HPH_PRINT(@"「衣服都被揉皱了…接下来的事就在床上做吧。呐HPH」","W")
    否则如果 CFLAG:12:既成事實 >= 1：
        随机：
            「感觉变得想要做色色的事情了吗？　真是拿你没办法呐ー、只能稍微碰一碰哦ー」
            「这种事还是在床上做吧ー。会被别人看见的哦ー…」
            「虽然确实说过可以和我做H的事情ー、但并不是什么时候都可以啊ー」
    否则：
        随机：
            「这种事不是和喜欢的人做的吗ー？」
            「并不怎么舒服ー。还是别做了吧？」
            「总感觉痒痒的挺恶心的ー」
            「很讨厌被腻腻歪歪地触碰着ー。明明找其他人做就好ー」
            「…！　突然在干什么啊ー」

; 314-318（原语料 LOCAL=0 占位空壳，无正文）
时机 指令 314 成否: 游戏判定：

时机 指令 315 成否: 游戏判定：

时机 指令 316 成否: 游戏判定：

时机 指令 317 成否: 游戏判定：

时机 指令 318 成否: 游戏判定：

; 320,对方主导正常位（原语料正文只有一条裸 PRINTFORMW 打空行）
时机 指令 320 成否: 游戏判定：
    空行

; 322,对方主导后背位
时机 指令 322 成否: 游戏判定：
    空行

; 330,掀裙子（原语料 LOCAL=0 占位空壳）
时机 指令 330 成否: 游戏判定：
