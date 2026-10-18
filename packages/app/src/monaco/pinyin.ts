/**
 * 补全装配核的**中文检索键**表（P2-12：模糊 / 拼音 / 子序列匹配那一批）。
 *
 * ## 覆盖范围（先读这一条，不猜）
 *
 * 内嵌表 = **GB2312 一级字库 3755 字**（行 16–55 的常用字），每字收**一个**常用读音，
 * 无声调、全小写（多音字取最常见读音：`行 xing` / `长 zhang` / `重 zhong` / `觉 jue` /
 * `得 de` / `地 di`；由 pypinyin 默认读音一次性导出）。
 * **表没覆盖的字**（GB2312 二级、罕用字、繁体异体、日文假名等）一律**退化为原字符**：
 * {@link pinyinKeysOf} 把该字符原样放进全拼串与首字母串——**不猜读音、不静默丢弃**，
 * 原字符仍可被子序列档命中（原文匹配面另由 `filterText` 首位承载）。
 *
 * ## 体积与解析成本
 *
 * 单字符串紧凑编码（**无分隔符**：汉字为非 ASCII、拼音为连续 `a–z`，定式可判界），
 * 按拼音首字母分 104 段拼接：raw 15462 字符 / UTF-8 约 22.4 KB。
 * 模块加载时**一次**解析进 `Map`（O(n) 单遍扫描、3755 次 `Map.set`，亚毫秒级）；
 * 按 label 的键结果另有**模块级缓存** ⇒ 补全热路径（`rankKey` / filterText 补键）
 * 不重复解析、不重复分配。
 *
 * ## 零依赖
 *
 * 表**内嵌**在本文件：不引 npm 包、不读外部数据文件、零运行时服务（生成方式记录在
 * 提交信息：pypinyin 一次性导出后去重校验，脚本本身不进仓库）。
 */

/** 单字符串紧凑编码的拼音表（汉字 + 无声调小写拼音，无分隔符；解析见 {@link parsePinyinTable}） */
const PINYIN_TABLE_RAW =
  '啊a阿a埃ai挨ai哎ai唉ai哀ai皑ai癌ai蔼ai矮ai艾ai碍ai爱ai隘ai鞍an氨an安an俺an按an暗an岸an胺an案an肮ang昂ang盎ang凹ao敖ao熬ao翱ao袄ao傲ao奥ao懊ao澳ao' +
  '芭ba捌ba扒ba叭ba吧ba笆ba八ba疤ba巴ba拔ba跋ba靶ba把ba耙ba坝ba霸ba罢ba爸ba白bai柏bai百bai摆bai佰bai败bai拜bai稗bai斑ban班ban搬ban扳ban般ban颁ban板ban版ban扮ban拌ban伴ban瓣ban半ban办ban' +
  '绊ban邦bang帮bang梆bang榜bang膀bang绑bang棒bang磅bang蚌bang镑bang傍bang谤bang苞bao胞bao包bao褒bao剥bo薄bao雹bao保bao堡bao饱bao宝bao抱bao报bao暴bao豹bao鲍bao爆bao杯bei碑bei悲bei卑bei北bei辈bei背bei贝bei钡bei倍bei' +
  '狈bei备bei惫bei焙bei被bei奔ben苯ben本ben笨ben崩beng绷beng甭beng泵beng蹦beng迸beng逼bi鼻bi比bi鄙bi笔bi彼bi碧bi蓖bi蔽bi毕bi毙bi毖bi币bi庇bi痹bi闭bi敝bi弊bi必bi壁bi臂bi避bi陛bi鞭bian边bian' +
  '编bian贬bian扁bian便bian变bian卞bian辨bian辩bian辫bian遍bian标biao彪biao膘biao表biao鳖bie憋bie别bie瘪bie彬bin斌bin濒bin滨bin宾bin摈bin兵bing冰bing柄bing丙bing秉bing饼bing炳bing病bing并bing玻bo菠bo播bo拨bo钵bo波bo博bo' +
  '勃bo搏bo铂bo箔bo伯bo帛bo舶bo脖bo膊bo渤bo驳bo捕bu卜bo哺bu补bu埠bu不bu布bu步bu簿bu部bu怖bu' +
  '擦ca猜cai裁cai材cai才cai财cai睬cai踩cai采cai彩cai菜cai蔡cai餐can参can蚕can残can惭can惨can灿can苍cang舱cang仓cang沧cang藏cang操cao糙cao槽cao曹cao草cao厕ce策ce侧ce册ce测ce层ceng蹭ceng插cha叉cha茬cha茶cha' +
  '查cha碴cha搽cha察cha岔cha差cha诧cha拆chai柴chai豺chai搀chan掺can蝉chan馋chan谗chan缠chan铲chan产chan阐chan颤chan昌chang猖chang场chang尝chang常chang偿chang肠chang厂chang敞chang畅chang唱chang倡chang超chao抄chao钞chao朝chao嘲chao潮chao巢chao吵chao' +
  '炒chao车che扯che撤che掣che彻che澈che郴chen臣chen辰chen尘chen晨chen忱chen沉chen陈chen趁chen衬chen撑cheng称cheng城cheng橙cheng成cheng呈cheng乘cheng程cheng惩cheng澄cheng诚cheng承cheng逞cheng骋cheng秤cheng吃chi痴chi持chi池chi迟chi弛chi驰chi耻chi' +
  '齿chi侈chi尺chi赤chi翅chi斥chi炽chi充chong冲chong虫chong崇chong宠chong抽chou酬chou畴chou踌chou稠chou愁chou筹chou仇chou绸chou瞅chou丑chou臭chou初chu出chu橱chu厨chu躇chu锄chu雏chu滁chu除chu楚chu础chu储chu矗chu搐chu触chu处chu' +
  '揣chuai川chuan穿chuan椽chuan传chuan船chuan喘chuan串chuan疮chuang窗chuang幢chuang床chuang闯chuang创chuang吹chui炊chui捶chui锤chui垂chui春chun椿chun醇chun唇chun淳chun纯chun蠢chun戳chuo绰chuo疵ci茨ci磁ci雌ci辞ci慈ci瓷ci词ci此ci刺ci赐ci次ci' +
  '聪cong葱cong囱cong匆cong从cong丛cong凑cou粗cu醋cu簇cu促cu蹿cuan篡cuan窜cuan摧cui崔cui催cui脆cui瘁cui粹cui淬cui翠cui村cun存cun寸cun磋cuo撮cuo搓cuo措cuo挫cuo错cuo伺ci畜chu曾ceng椎chui' +
  '搭da达da答da瘩da打da大da呆dai歹dai傣dai戴dai带dai殆dai代dai贷dai袋dai待dai逮dai怠dai耽dan担dan丹dan单dan郸dan掸dan胆dan旦dan氮dan但dan惮dan淡dan诞dan弹dan蛋dan当dang挡dang党dang荡dang档dang刀dao捣dao' +
  '蹈dao倒dao岛dao祷dao导dao到dao稻dao悼dao道dao盗dao德de得de的de蹬deng灯deng登deng等deng瞪deng凳deng邓deng堤di低di滴di迪di敌di笛di狄di涤di翟di嫡di抵di底di地di蒂di第di帝di弟di递di缔di颠dian' +
  '掂dian滇dian碘dian点dian典dian靛dian垫dian电dian佃dian甸dian店dian惦dian奠dian淀dian殿dian碉diao叼diao雕diao凋diao刁diao掉diao吊diao钓diao调diao跌die爹die碟die蝶die迭die谍die叠die丁ding盯ding叮ding钉ding顶ding鼎ding锭ding定ding订ding' +
  '丢diu东dong冬dong董dong懂dong动dong栋dong侗dong恫dong冻dong洞dong兜dou抖dou斗dou陡dou豆dou逗dou痘dou都dou督du毒du犊du独du读du堵du睹du赌du杜du镀du肚du度du渡du妒du端duan短duan锻duan段duan断duan缎duan堆dui' +
  '兑dui队dui对dui墩dun吨dun蹲dun敦dun顿dun囤dun钝dun盾dun遁dun掇duo哆duo多duo夺duo垛duo躲duo朵duo跺duo舵duo剁duo惰duo堕duo' +
  '蛾e峨e鹅e俄e额e讹e娥e恶e厄e扼e遏e鄂e饿e恩en而er儿er耳er尔er饵er洱er二er贰er' +
  '发fa罚fa筏fa伐fa乏fa阀fa法fa珐fa藩fan帆fan番fan翻fan樊fan矾fan钒fan繁fan凡fan烦fan反fan返fan范fan贩fan犯fan饭fan泛fan坊fang芳fang方fang肪fang房fang防fang妨fang仿fang访fang纺fang放fang菲fei非fei啡fei飞fei' +
  '肥fei匪fei诽fei吠fei肺fei废fei沸fei费fei芬fen酚fen吩fen氛fen分fen纷fen坟fen焚fen汾fen粉fen奋fen份fen忿fen愤fen粪fen丰feng封feng枫feng蜂feng峰feng锋feng风feng疯feng烽feng逢feng冯feng缝feng讽feng奉feng凤feng佛fu否fou' +
  '夫fu敷fu肤fu孵fu扶fu拂fu辐fu幅fu氟fu符fu伏fu俘fu服fu浮fu涪fu福fu袱fu弗fu甫fu抚fu辅fu俯fu釜fu斧fu腑fu府fu腐fu赴fu副fu覆fu赋fu复fu傅fu付fu阜fu父fu腹fu负fu富fu讣fu' +
  '附fu妇fu缚fu咐fu' +
  '噶ga嘎ga该gai改gai概gai钙gai盖gai溉gai干gan甘gan杆gan柑gan竿gan肝gan赶gan感gan秆gan敢gan赣gan冈gang刚gang钢gang缸gang肛gang纲gang岗gang港gang杠gang篙gao皋gao高gao膏gao羔gao糕gao搞gao镐gao稿gao告gao哥ge歌ge' +
  '搁ge戈ge鸽ge胳ge疙ge割ge革ge葛ge格ge阁ge隔ge铬ge个ge各ge给gei根gen跟gen耕geng更geng庚geng羹geng埂geng耿geng梗geng工gong攻gong功gong恭gong龚gong供gong躬gong公gong宫gong弓gong巩gong汞gong拱gong贡gong共gong钩gou' +
  '勾gou沟gou苟gou狗gou垢gou构gou购gou够gou辜gu菇gu咕gu箍gu估gu沽gu孤gu姑gu鼓gu古gu蛊gu骨gu谷gu股gu故gu顾gu固gu雇gu刮gua瓜gua剐gua寡gua挂gua褂gua乖guai拐guai怪guai棺guan关guan官guan冠guan观guan' +
  '管guan馆guan罐guan惯guan灌guan贯guan光guang广guang逛guang瑰gui规gui圭gui硅gui归gui龟gui闺gui轨gui鬼gui诡gui癸gui桂gui柜gui跪gui贵gui刽gui辊gun滚gun棍gun锅guo郭guo国guo果guo裹guo过guo咯ge傀gui炔gui' +
  '蛤ha哈ha骸hai孩hai海hai氦hai亥hai害hai骇hai酣han憨han邯han韩han含han涵han寒han函han喊han罕han翰han撼han捍han旱han憾han悍han焊han汗han汉han夯hang杭hang航hang壕hao嚎hao豪hao毫hao郝hao好hao耗hao号hao浩hao' +
  '呵he喝he荷he菏he核he禾he和he何he合he盒he貉hao阂he河he涸he赫he褐he鹤he贺he嘿hei黑hei痕hen很hen狠hen恨hen哼heng亨heng横heng衡heng恒heng轰hong哄hong烘hong虹hong鸿hong洪hong宏hong弘hong红hong喉hou侯hou' +
  '猴hou吼hou厚hou候hou后hou呼hu乎hu忽hu瑚hu壶hu葫hu胡hu蝴hu狐hu糊hu湖hu弧hu虎hu唬hu护hu互hu沪hu户hu花hua哗hua华hua猾hua滑hua画hua划hua化hua话hua槐huai徊huai怀huai淮huai坏huai欢huan环huan桓huan' +
  '还hai缓huan换huan患huan唤huan痪huan豢huan焕huan涣huan宦huan幻huan荒huang慌huang黄huang磺huang蝗huang簧huang皇huang凰huang惶huang煌huang晃huang幌huang恍huang谎huang灰hui挥hui辉hui徽hui恢hui蛔hui回hui毁hui悔hui慧hui卉hui惠hui晦hui贿hui秽hui' +
  '会hui烩hui汇hui讳hui诲hui绘hui荤hun昏hun婚hun魂hun浑hun混hun豁huo活huo伙huo火huo获huo或huo惑huo霍huo货huo祸huo' +
  '击ji圾ji基ji机ji畸ji稽ji积ji箕ji肌ji饥ji迹ji激ji讥ji鸡ji姬ji绩ji缉ji吉ji极ji棘ji辑ji籍ji集ji及ji急ji疾ji汲ji即ji嫉ji级ji挤ji几ji脊ji己ji蓟ji技ji冀ji季ji伎ji祭ji' +
  '剂ji悸ji济ji寄ji寂ji计ji记ji既ji忌ji际ji妓ji继ji纪ji嘉jia枷jia夹jia佳jia家jia加jia荚jia颊jia贾jia甲jia钾jia假jia稼jia价jia架jia驾jia嫁jia歼jian监jian坚jian尖jian笺jian间jian煎jian兼jian肩jian艰jian' +
  '奸jian缄jian茧jian检jian柬jian碱jian硷jian拣jian捡jian简jian俭jian剪jian减jian荐jian鉴jian践jian贱jian见jian键jian箭jian件jian健jian舰jian剑jian饯jian渐jian溅jian涧jian建jian僵jiang姜jiang将jiang浆jiang江jiang疆jiang蒋jiang桨jiang奖jiang讲jiang匠jiang' +
  '酱jiang降jiang蕉jiao椒jiao礁jiao焦jiao胶jiao交jiao郊jiao浇jiao骄jiao娇jiao嚼jue搅jiao铰jiao矫jiao侥jiao脚jiao狡jiao角jiao饺jiao缴jiao绞jiao剿jiao教jiao酵jiao轿jiao较jiao叫jiao窖jiao揭jie接jie皆jie秸jie街jie阶jie截jie劫jie节jie桔ju' +
  '杰jie捷jie睫jie竭jie洁jie结jie解jie姐jie戒jie藉ji芥jie界jie借jie介jie疥jie诫jie届jie巾jin筋jin斤jin金jin今jin津jin襟jin紧jin锦jin仅jin谨jin进jin靳jin晋jin禁jin近jin烬jin浸jin尽jin劲jin荆jing兢jing茎jing' +
  '睛jing晶jing鲸jing京jing惊jing精jing粳jing经jing井jing警jing景jing颈jing静jing境jing敬jing镜jing径jing痉jing靖jing竟jing竞jing净jing炯jiong窘jiong揪jiu究jiu纠jiu玖jiu韭jiu久jiu灸jiu九jiu酒jiu厩jiu救jiu旧jiu臼jiu舅jiu咎jiu就jiu' +
  '疚jiu鞠ju拘ju狙ju疽ju居ju驹ju菊ju局ju咀ju矩ju举ju沮ju聚ju拒ju据ju巨ju具ju距ju踞ju锯ju俱ju句ju惧ju炬ju剧ju捐juan鹃juan娟juan倦juan眷juan卷juan绢juan撅jue攫jue抉jue掘jue倔jue爵jue觉jue' +
  '决jue诀jue绝jue均jun菌jun钧jun军jun君jun峻jun俊jun竣jun浚jun郡jun骏jun茄jia' +
  '槛kan喀ka咖ka卡ka开kai揩kai楷kai凯kai慨kai刊kan堪kan勘kan坎kan砍kan看kan康kang慷kang糠kang扛kang抗kang亢kang炕kang考kao拷kao烤kao靠kao坷ke苛ke柯ke棵ke磕ke颗ke科ke壳ke咳ke可ke渴ke克ke刻ke客ke' +
  '课ke肯ken啃ken垦ken恳ken坑keng吭keng空kong恐kong孔kong控kong抠kou口kou扣kou寇kou枯ku哭ku窟ku苦ku酷ku库ku裤ku夸kua垮kua挎kua跨kua胯kua块kuai筷kuai侩kuai快kuai宽kuan款kuan匡kuang筐kuang狂kuang框kuang矿kuang眶kuang旷kuang' +
  '况kuang亏kui盔kui岿kui窥kui葵kui奎kui魁kui馈kui愧kui溃kui坤kun昆kun捆kun困kun括kuo扩kuo廓kuo阔kuo' +
  '垃la拉la喇la蜡la腊la辣la啦la莱lai来lai赖lai蓝lan婪lan栏lan拦lan篮lan阑lan兰lan澜lan谰lan揽lan览lan懒lan缆lan烂lan滥lan琅lang榔lang狼lang廊lang郎lang朗lang浪lang捞lao劳lao牢lao老lao佬lao姥lao酪lao烙lao' +
  '涝lao勒lei乐le雷lei镭lei蕾lei磊lei累lei儡lei垒lei擂lei肋le类lei泪lei棱leng楞leng冷leng厘li梨li犁li黎li篱li狸li离li漓li理li李li里li鲤li礼li莉li荔li吏li栗li丽li厉li励li砾li历li利li' +
  '傈li例li俐li痢li立li粒li沥li隶li力li璃li哩li俩lia联lian莲lian连lian镰lian廉lian怜lian涟lian帘lian敛lian脸lian链lian恋lian炼lian练lian粮liang凉liang梁liang粱liang良liang两liang辆liang量liang晾liang亮liang谅liang撩liao聊liao僚liao' +
  '疗liao燎liao寥liao辽liao潦lao了le撂liao镣liao廖liao料liao列lie裂lie烈lie劣lie猎lie琳lin林lin磷lin霖lin临lin邻lin鳞lin淋lin凛lin赁lin吝lin拎lin玲ling菱ling零ling龄ling铃ling伶ling羚ling凌ling灵ling陵ling岭ling领ling另ling' +
  '令ling溜liu琉liu榴liu硫liu馏liu留liu刘liu瘤liu流liu柳liu六liu龙long聋long咙long笼long窿long隆long垄long拢long陇long楼lou娄lou搂lou篓lou漏lou陋lou芦lu卢lu颅lu庐lu炉lu掳lu卤lu虏lu鲁lu麓lu碌lu露lu路lu' +
  '赂lu鹿lu潞lu禄lu录lu陆lu戮lu驴lv吕lv铝lv侣lv旅lv履lv屡lv缕lv虑lv氯lv律lv率lv滤lv绿lv峦luan挛luan孪luan滦luan卵luan乱luan掠lve略lve抡lun轮lun伦lun仑lun沦lun纶lun论lun萝luo螺luo罗luo逻luo' +
  '锣luo箩luo骡luo裸luo落luo洛luo骆luo络luo' +
  '妈ma麻ma玛ma码ma蚂ma马ma骂ma嘛ma吗ma埋mai买mai麦mai卖mai迈mai脉mai瞒man馒man蛮man满man蔓man曼man慢man漫man谩man芒mang茫mang盲mang氓mang忙mang莽mang猫mao茅mao锚mao毛mao矛mao铆mao卯mao茂mao冒mao帽mao' +
  '貌mao贸mao么me玫mei枚mei梅mei酶mei霉mei煤mei没mei眉mei媒mei镁mei每mei美mei昧mei寐mei妹mei媚mei门men闷men们men萌meng蒙meng檬meng盟meng锰meng猛meng梦meng孟meng眯mi醚mi靡mi糜mi迷mi谜mi弥mi米mi秘mi觅mi' +
  '泌mi蜜mi密mi幂mi棉mian眠mian绵mian冕mian免mian勉mian娩mian缅mian面mian苗miao描miao瞄miao藐miao秒miao渺miao庙miao妙miao蔑mie灭mie民min抿min皿min敏min悯min闽min明ming螟ming鸣ming铭ming名ming命ming谬miu摸mo摹mo蘑mo模mo' +
  '膜mo磨mo摩mo魔mo抹mo末mo莫mo墨mo默mo沫mo漠mo寞mo陌mo谋mou牟mou某mou拇mu牡mu亩mu姆mu母mu墓mu暮mu幕mu募mu慕mu木mu目mu睦mu牧mu穆mu' +
  '拿na哪na呐na钠na那na娜na纳na氖nai乃nai奶nai耐nai奈nai南nan男nan难nan囊nang挠nao脑nao恼nao闹nao淖nao呢ne馁nei内nei嫩nen能neng妮ni霓ni倪ni泥ni尼ni拟ni你ni匿ni腻ni逆ni溺ni蔫nian拈nian年nian' +
  '碾nian撵nian捻nian念nian娘niang酿niang鸟niao尿niao捏nie聂nie孽nie啮nie镊nie镍nie涅nie您nin柠ning狞ning凝ning宁ning拧ning泞ning牛niu扭niu钮niu纽niu脓nong浓nong农nong弄nong奴nu努nu怒nu女nv暖nuan虐nve疟nve挪nuo懦nuo糯nuo' +
  '诺nuo辗nian' +
  '哦o欧ou鸥ou殴ou藕ou呕ou偶ou沤ou' +
  '辟pi泊po脯pu啪pa趴pa爬pa帕pa怕pa琶pa拍pai排pai牌pai徘pai湃pai派pai攀pan潘pan盘pan磐pan盼pan畔pan判pan叛pan乓pang庞pang旁pang耪pang胖pang抛pao咆pao刨pao炮pao袍pao跑pao泡pao呸pei胚pei培pei裴pei赔pei' +
  '陪pei配pei佩pei沛pei喷pen盆pen砰peng抨peng烹peng澎peng彭peng蓬peng棚peng硼peng篷peng膨peng朋peng鹏peng捧peng碰peng坯pi砒pi霹pi批pi披pi劈pi琵pi毗pi啤pi脾pi疲pi皮pi匹pi痞pi僻pi屁pi譬pi篇pian偏pian片pian' +
  '骗pian飘piao漂piao瓢piao票piao撇pie瞥pie拼pin频pin贫pin品pin聘pin乒ping坪ping苹ping萍ping平ping凭ping瓶ping评ping屏ping坡po泼po颇po婆po破po魄po迫po粕po剖pou扑pu铺pu仆pu莆pu葡pu菩pu蒲pu埔pu朴pu圃pu' +
  '普pu浦pu谱pu曝pu瀑pu' +
  '期qi欺qi栖qi戚qi妻qi七qi凄qi漆qi柒qi沏qi其qi棋qi奇qi歧qi畦qi崎qi脐qi齐qi旗qi祈qi祁qi骑qi起qi岂qi乞qi企qi启qi契qi砌qi器qi气qi迄qi弃qi汽qi泣qi讫qi掐qia恰qia洽qia牵qian' +
  '扦qian钎qian铅qian千qian迁qian签qian仟qian谦qian乾qian黔qian钱qian钳qian前qian潜qian遣qian浅qian谴qian堑qian嵌qian欠qian歉qian枪qiang呛qiang腔qiang羌qiang墙qiang蔷qiang强qiang抢qiang橇qiao锹qiao敲qiao悄qiao桥qiao瞧qiao乔qiao侨qiao巧qiao鞘qiao撬qiao' +
  '翘qiao峭qiao俏qiao窍qiao切qie且qie怯qie窃qie钦qin侵qin亲qin秦qin琴qin勤qin芹qin擒qin禽qin寝qin沁qin青qing轻qing氢qing倾qing卿qing清qing擎qing晴qing氰qing情qing顷qing请qing庆qing琼qiong穷qiong秋qiu丘qiu邱qiu球qiu求qiu囚qiu' +
  '酋qiu泅qiu趋qu区qu蛆qu曲qu躯qu屈qu驱qu渠qu取qu娶qu龋qu趣qu去qu圈quan颧quan权quan醛quan泉quan全quan痊quan拳quan犬quan券quan劝quan缺que瘸que却que鹊que榷que确que雀que裙qun群qun' +
  '然ran燃ran冉ran染ran瓤rang壤rang攘rang嚷rang让rang饶rao扰rao绕rao惹re热re壬ren仁ren人ren忍ren韧ren任ren认ren刃ren妊ren纫ren扔reng仍reng日ri戎rong茸rong蓉rong荣rong融rong熔rong溶rong容rong绒rong冗rong揉rou柔rou肉rou' +
  '茹ru蠕ru儒ru孺ru如ru辱ru乳ru汝ru入ru褥ru软ruan阮ruan蕊rui瑞rui锐rui闰run润run若ruo弱ruo' +
  '匙shi撒sa洒sa萨sa腮sai鳃sai塞sai赛sai三san叁san伞san散san桑sang嗓sang丧sang搔sao骚sao扫sao嫂sao瑟se色se涩se森sen僧seng莎sha砂sha杀sha刹sha沙sha纱sha傻sha啥sha煞sha筛shai晒shai珊shan苫shan杉shan山shan删shan' +
  '煽shan衫shan闪shan陕shan擅shan赡shan膳shan善shan汕shan扇shan缮shan墒shang伤shang商shang赏shang晌shang上shang尚shang裳shang梢shao捎shao稍shao烧shao芍shao勺shao韶shao少shao哨shao邵shao绍shao奢she赊she蛇she舌she舍she赦she摄she射she慑she涉she' +
  '社she设she砷shen申shen呻shen伸shen身shen深shen娠shen绅shen神shen沈shen审shen婶shen甚shen肾shen慎shen渗shen声sheng生sheng甥sheng牲sheng升sheng绳sheng省sheng盛sheng剩sheng胜sheng圣sheng师shi失shi狮shi施shi湿shi诗shi尸shi虱shi十shi石shi拾shi' +
  '时shi什shen食shi蚀shi实shi识shi史shi矢shi使shi屎shi驶shi始shi式shi示shi士shi世shi柿shi事shi拭shi誓shi逝shi势shi是shi嗜shi噬shi适shi仕shi侍shi释shi饰shi氏shi市shi恃shi室shi视shi试shi收shou手shou首shou守shou' +
  '寿shou授shou售shou受shou瘦shou兽shou蔬shu枢shu梳shu殊shu抒shu输shu叔shu舒shu淑shu疏shu书shu赎shu孰shu熟shu薯shu暑shu曙shu署shu蜀shu黍shu鼠shu属shu术shu述shu树shu束shu戍shu竖shu墅shu庶shu数shu漱shu恕shu刷shua' +
  '耍shua摔shuai衰shuai甩shuai帅shuai栓shuan拴shuan霜shuang双shuang爽shuang谁shui水shui睡shui税shui吮shun瞬shun顺shun舜shun说shuo硕shuo朔shuo烁shuo斯si撕si嘶si思si私si司si丝si死si肆si寺si嗣si四si似shi饲si巳si松song耸song怂song' +
  '颂song送song宋song讼song诵song搜sou艘sou擞sou嗽sou苏su酥su俗su素su速su粟su僳su塑su溯su宿su诉su肃su酸suan蒜suan算suan虽sui隋sui随sui绥sui髓sui碎sui岁sui穗sui遂sui隧sui祟sui孙sun损sun笋sun蓑suo梭suo' +
  '唆suo缩suo琐suo索suo锁suo所suo厦sha' +
  '塌ta他ta它ta她ta塔ta獭ta挞ta蹋ta踏ta胎tai苔tai抬tai台tai泰tai酞tai太tai态tai汰tai坍tan摊tan贪tan瘫tan滩tan坛tan檀tan痰tan潭tan谭tan谈tan坦tan毯tan袒tan碳tan探tan叹tan炭tan汤tang塘tang搪tang堂tang' +
  '棠tang膛tang唐tang糖tang倘tang躺tang淌tang趟tang烫tang掏tao涛tao滔tao绦tao萄tao桃tao逃tao淘tao陶tao讨tao套tao特te藤teng腾teng疼teng誊teng梯ti剔ti踢ti锑ti提ti题ti蹄ti啼ti体ti替ti嚏ti惕ti涕ti剃ti屉ti' +
  '天tian添tian填tian田tian甜tian恬tian舔tian腆tian挑tiao条tiao迢tiao眺tiao跳tiao贴tie铁tie帖tie厅ting听ting烃ting汀ting廷ting停ting亭ting庭ting挺ting艇ting通tong桐tong酮tong瞳tong同tong铜tong彤tong童tong桶tong捅tong筒tong统tong痛tong偷tou' +
  '投tou头tou透tou凸tu秃tu突tu图tu徒tu途tu涂tu屠tu土tu吐tu兔tu湍tuan团tuan推tui颓tui腿tui蜕tui褪tui退tui吞tun屯tun臀tun拖tuo托tuo脱tuo鸵tuo陀tuo驮tuo驼tuo椭tuo妥tuo拓tuo唾tuo' +
  '挖wa哇wa蛙wa洼wa娃wa瓦wa袜wa歪wai外wai豌wan弯wan湾wan玩wan顽wan丸wan烷wan完wan碗wan挽wan晚wan皖wan惋wan宛wan婉wan万wan腕wan汪wang王wang亡wang枉wang网wang往wang旺wang望wang忘wang妄wang威wei巍wei微wei危wei' +
  '韦wei违wei桅wei围wei唯wei惟wei为wei潍wei维wei苇wei萎wei委wei伟wei伪wei尾wei纬wei未wei蔚wei味wei畏wei胃wei喂wei魏wei位wei渭wei谓wei尉wei慰wei卫wei瘟wen温wen蚊wen文wen闻wen纹wen吻wen稳wen紊wen问wen嗡weng' +
  '翁weng瓮weng挝wo蜗wo涡wo窝wo我wo斡wo卧wo握wo沃wo巫wu呜wu钨wu乌wu污wu诬wu屋wu无wu芜wu梧wu吾wu吴wu毋wu武wu五wu捂wu午wu舞wu伍wu侮wu坞wu戊wu雾wu晤wu物wu勿wu务wu悟wu误wu' +
  '昔xi熙xi析xi西xi硒xi矽xi晰xi嘻xi吸xi锡xi牺xi稀xi息xi希xi悉xi膝xi夕xi惜xi熄xi烯xi溪xi汐xi犀xi檄xi袭xi席xi习xi媳xi喜xi铣xi洗xi系xi隙xi戏xi细xi瞎xia虾xia匣xia霞xia辖xia' +
  '暇xia峡xia侠xia狭xia下xia夏xia吓xia掀xian锨xian先xian仙xian鲜xian纤xian咸xian贤xian衔xian舷xian闲xian涎xian弦xian嫌xian显xian险xian现xian献xian县xian腺xian馅xian羡xian宪xian陷xian限xian线xian相xiang厢xiang镶xiang香xiang箱xiang襄xiang湘xiang' +
  '乡xiang翔xiang祥xiang详xiang想xiang响xiang享xiang项xiang巷xiang橡xiang像xiang向xiang象xiang萧xiao硝xiao霄xiao削xue哮xiao嚣xiao销xiao消xiao宵xiao淆xiao晓xiao小xiao孝xiao校xiao肖xiao啸xiao笑xiao效xiao楔xie些xie歇xie蝎xie鞋xie协xie挟xie携xie邪xie' +
  '斜xie胁xie谐xie写xie械xie卸xie蟹xie懈xie泄xie泻xie谢xie屑xie薪xin芯xin锌xin欣xin辛xin新xin忻xin心xin信xin衅xin星xing腥xing猩xing惺xing兴xing刑xing型xing形xing邢xing行xing醒xing幸xing杏xing性xing姓xing兄xiong凶xiong胸xiong' +
  '匈xiong汹xiong雄xiong熊xiong休xiu修xiu羞xiu朽xiu嗅xiu锈xiu秀xiu袖xiu绣xiu墟xu戌xu需xu虚xu嘘xu须xu徐xu许xu蓄xu酗xu叙xu旭xu序xu恤xu絮xu婿xu绪xu续xu轩xuan喧xuan宣xuan悬xuan旋xuan玄xuan选xuan癣xuan眩xuan' +
  '绚xuan靴xue薛xue学xue穴xue雪xue血xue勋xun熏xun循xun旬xun询xun寻xun驯xun巡xun殉xun汛xun训xun讯xun逊xun迅xun吁xu' +
  '压ya押ya鸦ya鸭ya呀ya丫ya芽ya牙ya蚜ya崖ya衙ya涯ya雅ya哑ya亚ya讶ya焉yan咽yan阉yan烟yan淹yan盐yan严yan研yan蜒yan岩yan延yan言yan颜yan阎yan炎yan沿yan奄yan掩yan眼yan衍yan演yan艳yan堰yan燕yan' +
  '厌yan砚yan雁yan唁yan彦yan焰yan宴yan谚yan验yan殃yang央yang鸯yang秧yang杨yang扬yang佯yang疡yang羊yang洋yang阳yang氧yang仰yang痒yang养yang样yang漾yang邀yao腰yao妖yao瑶yao摇yao尧yao遥yao窑yao谣yao姚yao咬yao舀yao药yao要yao' +
  '耀yao椰ye噎ye耶ye爷ye野ye冶ye也ye页ye掖ye业ye叶ye曳ye腋ye夜ye液ye一yi壹yi医yi揖yi铱yi依yi伊yi衣yi颐yi夷yi遗yi移yi仪yi胰yi疑yi沂yi宜yi姨yi彝yi椅yi蚁yi倚yi已yi乙yi' +
  '矣yi以yi艺yi抑yi易yi邑yi屹yi亿yi役yi臆yi逸yi肄yi疫yi亦yi裔yi意yi毅yi忆yi义yi益yi溢yi诣yi议yi谊yi译yi异yi翼yi翌yi绎yi茵yin荫yin因yin殷yin音yin阴yin姻yin吟yin银yin淫yin寅yin' +
  '饮yin尹yin引yin隐yin印yin英ying樱ying婴ying鹰ying应ying缨ying莹ying萤ying营ying荧ying蝇ying迎ying赢ying盈ying影ying颖ying硬ying映ying哟yo拥yong佣yong臃yong痈yong庸yong雍yong踊yong蛹yong咏yong泳yong涌yong永yong恿yong勇yong用yong幽you' +
  '优you悠you忧you尤you由you邮you铀you犹you油you游you酉you有you友you右you佑you釉you诱you又you幼you迂yu淤yu于yu盂yu榆yu虞yu愚yu舆yu余yu俞yu逾yu鱼yu愉yu渝yu渔yu隅yu予yu娱yu雨yu与yu屿yu' +
  '禹yu宇yu语yu羽yu玉yu域yu芋yu郁yu遇yu喻yu峪yu御yu愈yu欲yu狱yu育yu誉yu浴yu寓yu裕yu预yu豫yu驭yu鸳yuan渊yuan冤yuan元yuan垣yuan袁yuan原yuan援yuan辕yuan园yuan员yuan圆yuan猿yuan源yuan缘yuan远yuan苑yuan' +
  '愿yuan怨yuan院yuan曰yue约yue越yue跃yue钥yao岳yue粤yue月yue悦yue阅yue耘yun云yun郧yun匀yun陨yun允yun运yun蕴yun酝yun晕yun韵yun孕yun轧ya' +
  '长zhang匝za砸za杂za栽zai哉zai灾zai宰zai载zai再zai在zai咱zan攒zan暂zan赞zan赃zang脏zang葬zang遭zao糟zao凿zao藻zao枣zao早zao澡zao蚤zao躁zao噪zao造zao皂zao灶zao燥zao责ze择ze则ze泽ze贼zei怎zen增zeng憎zeng' +
  '赠zeng扎zha喳zha渣zha札zha铡zha闸zha眨zha栅zha榨zha咋za乍zha炸zha诈zha摘zhai斋zhai宅zhai窄zhai债zhai寨zhai瞻zhan毡zhan詹zhan粘zhan沾zhan盏zhan斩zhan崭zhan展zhan蘸zhan栈zhan占zhan战zhan站zhan湛zhan绽zhan樟zhang章zhang彰zhang漳zhang' +
  '张zhang掌zhang涨zhang杖zhang丈zhang帐zhang账zhang仗zhang胀zhang瘴zhang障zhang招zhao昭zhao找zhao沼zhao赵zhao照zhao罩zhao兆zhao肇zhao召zhao遮zhe折zhe哲zhe蛰zhe辙zhe者zhe锗zhe蔗zhe这zhe浙zhe珍zhen斟zhen真zhen甄zhen砧zhen臻zhen贞zhen针zhen侦zhen' +
  '枕zhen疹zhen诊zhen震zhen振zhen镇zhen阵zhen蒸zheng挣zheng睁zheng征zheng狰zheng争zheng怔zheng整zheng拯zheng正zheng政zheng帧zhen症zheng郑zheng证zheng芝zhi枝zhi支zhi吱zhi蜘zhi知zhi肢zhi脂zhi汁zhi之zhi织zhi职zhi直zhi植zhi殖zhi执zhi值zhi侄zhi' +
  '址zhi指zhi止zhi趾zhi只zhi旨zhi纸zhi志zhi挚zhi掷zhi至zhi致zhi置zhi帜zhi峙zhi制zhi智zhi秩zhi稚zhi质zhi炙zhi痔zhi滞zhi治zhi窒zhi中zhong盅zhong忠zhong钟zhong衷zhong终zhong种zhong肿zhong重zhong仲zhong众zhong舟zhou周zhou州zhou洲zhou' +
  '诌zhou粥zhou轴zhou肘zhou帚zhou咒zhou皱zhou宙zhou昼zhou骤zhou珠zhu株zhu蛛zhu朱zhu猪zhu诸zhu诛zhu逐zhu竹zhu烛zhu煮zhu拄zhu瞩zhu嘱zhu主zhu著zhu柱zhu助zhu蛀zhu贮zhu铸zhu筑zhu住zhu注zhu祝zhu驻zhu抓zhua爪zhao拽zhuai专zhuan' +
  '砖zhuan转zhuan撰zhuan赚zhuan篆zhuan桩zhuang庄zhuang装zhuang妆zhuang撞zhuang壮zhuang状zhuang锥zhui追zhui赘zhui坠zhui缀zhui谆zhun准zhun捉zhuo拙zhuo卓zhuo桌zhuo琢zuo茁zhuo酌zhuo啄zhuo着zhe灼zhuo浊zhuo兹zi咨zi资zi姿zi滋zi淄zi孜zi紫zi仔zai籽zi' +
  '滓zi子zi自zi渍zi字zi鬃zong棕zong踪zong宗zong综zong总zong纵zong邹zou走zou奏zou揍zou租zu足zu卒zu族zu祖zu诅zu阻zu组zu钻zuan纂zuan嘴zui醉zui最zui罪zui尊zun遵zun昨zuo左zuo佐zuo柞zha做zuo作zuo坐zuo座zuo';

/** 汉字类字符判据（CJK 统一表意 + 扩展 A + 兼容 + 假名）；用于"未覆盖字退化为原字符"的归类 */
const CJK_CHAR_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/** 一个中文标签的可检索键：全拼串（逐字拼接，可跨字界匹配）+ 首字母串 */
export interface PinyinKeys {
  readonly full: string;
  readonly initials: string;
}

/**
 * 解析紧凑编码表：汉字（非 ASCII）后跟连续 `a–z` 即一条「字 → 拼音」。
 * 防御：拼音为空 / 重复字一律跳过（先注册者胜），绝不写坏条目。
 */
function parsePinyinTable(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i]!;
    if (ch >= 'a' && ch <= 'z') {
      i += 1; // 游离拼音字母（表恒不该出现）⇒ 跳过
      continue;
    }
    let j = i + 1;
    while (j < raw.length) {
      const c = raw[j]!;
      if (c >= 'a' && c <= 'z') j += 1;
      else break;
    }
    const py = raw.slice(i + 1, j);
    if (py.length > 0 && !map.has(ch)) map.set(ch, py);
    i = j;
  }
  return map;
}

/** 汉字 → 无声调拼音（模块加载时一次解析；进程内不变） */
const TABLE: ReadonlyMap<string, string> = parsePinyinTable(PINYIN_TABLE_RAW);

/** 按 label 的键缓存（候选 label 集合有界；热路径不重复解析同一标签） */
const KEYS_CACHE = new Map<string, PinyinKeys | undefined>();

/** 单字查拼音；表未覆盖 ⇒ `undefined`（调用方按"退化为原字符"处理，不猜） */
export function pinyinOf(ch: string): string | undefined {
  return TABLE.get(ch);
}

/** 内嵌表覆盖的汉字条数（测试钉覆盖范围；恒等于 GB2312 一级字库 3755） */
export function pinyinTableSize(): number {
  return TABLE.size;
}

/**
 * 一个 label 的可检索键（**纯函数**，结果按 label 缓存）。
 *
 * - 表覆盖的字 ⇒ 全拼进 `full`、首字母进 `initials`；
 * - **未覆盖的字类字符** ⇒ 原字符进两个串（退化，不猜读音）；
 * - 非字类字符（ASCII / 数字 / 标点 / 空格）⇒ 跳过（原文匹配面由 `filterText` 首位承载）；
 * - 全程没有任何字类字符 ⇒ `undefined`（纯 ASCII 标签无可拼音键，调用方不该补键）。
 */
export function pinyinKeysOf(label: string): PinyinKeys | undefined {
  const cached = KEYS_CACHE.get(label);
  if (cached !== undefined) return cached;
  const keys = buildKeys(label);
  KEYS_CACHE.set(label, keys);
  return keys;
}

function buildKeys(label: string): PinyinKeys | undefined {
  let full = '';
  let initials = '';
  for (const ch of label) {
    const py = TABLE.get(ch);
    if (py !== undefined) {
      full += py;
      initials += py[0]!;
      continue;
    }
    // 未覆盖的字类字符：退化为原字符（不猜、不静默——覆盖范围见模块头注）
    if (CJK_CHAR_RE.test(ch)) {
      full += ch;
      initials += ch;
    }
  }
  return full.length === 0 ? undefined : { full, initials };
}
