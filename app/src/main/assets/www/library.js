/* ===========================================================
   内置分级书库（全龄段 · 面向中国学习者）
   -----------------------------------------------------------
   · 句子里的 [[双中括号]] 包住的是关键短语，会高亮显示
   · sentences / zh 一一对应；notes 可选，对应同一句的讲解
   · qa 是读后两问：groups 为必答要点（每组任意一个词命中即可），
     zhGroups 用来接受中文作答，answer 为标准参考答案
   =========================================================== */

const TIERS = [
  {
    id: "kids",
    name: "🧸 少儿启蒙",
    sub: "3–8 岁 · 自然拼读短句",
    desc: "家庭、动物、食物三个主题，句子短、重复多，适合跟读起步。"
  },
  {
    id: "teen",
    name: "🎒 校园进阶",
    sub: "中小学 · 四六级预备",
    desc: "校园故事与科普短文，标出考试高频短语，配中文讲解。"
  },
  {
    id: "adult",
    name: "📰 成人实用",
    sub: "职场 · 旅游 · 精读",
    desc: "职场沟通、机场酒店实景长句，逐句拆主谓宾，讲地道表达。"
  }
];

const LIBRARY = {
  kids: [
    {
      id: "k1",
      emoji: "☀️",
      title: "Good Morning, Sun!",
      titleZh: "早上好，太阳！",
      level: "启蒙 · 日常生活",
      minutes: 2,
      goal: "学会 describe 自己早晨做的事：wake up / wash my face / brush my teeth",
      sentences: [
        "The sun is up.",
        "I [[wake up]] at seven.",
        "Mom gives me a big smile.",
        "I [[wash my face]] and [[brush my teeth]].",
        "Dad makes milk and warm bread.",
        "My cat sits on the red mat.",
        "I give my cat a hug.",
        "The sun is warm and I am happy.",
        "[[Good morning]], sun!"
      ],
      zh: [
        "太阳升起来了。",
        "我七点起床。",
        "妈妈冲我大大地笑。",
        "我洗脸、刷牙。",
        "爸爸做好牛奶和热面包。",
        "我的猫坐在红垫子上。",
        "我抱了抱我的猫。",
        "阳光暖暖的，我很开心。",
        "早上好，太阳！"
      ],
      notes: [
        null,
        "wake up 是“醒来、起床”，连读时 k 和 u 会连在一起，跟着音频多念几遍。",
        null,
        "wash my face 洗脸，brush my teeth 刷牙——注意 teeth 是 tooth 的复数。",
        null,
        null,
        "give sb a hug 是“给某人一个拥抱”，比 give a hug to sb 更常用。",
        null,
        null
      ],
      qa: [
        {
          q: "What time does the writer wake up?",
          qZh: "作者几点起床？",
          groups: [["seven", "7"]],
          zhGroups: [["七点", "7点"]],
          answer: "The writer wakes up at seven.",
          answerZh: "作者七点起床。"
        },
        {
          q: "Who sits on the red mat?",
          qZh: "谁坐在红垫子上？",
          groups: [["cat"]],
          zhGroups: [["猫"]],
          answer: "The cat sits on the red mat.",
          answerZh: "猫坐在红垫子上。"
        }
      ]
    },
    {
      id: "k2",
      emoji: "🍦",
      title: "Ice Cream in the Park",
      titleZh: "公园里的冰淇淋",
      level: "启蒙 · 食物与购物",
      minutes: 2,
      goal: "学会点单句式：I would like … / Can I have …",
      sentences: [
        "It is a hot summer day.",
        "Lily and Tom walk to the park.",
        "They see a small [[ice cream shop]].",
        "Lily asks for a [[strawberry ice cream]].",
        "Tom wants chocolate with a little milk.",
        "The ice cream is cold and sweet.",
        "A little dog looks at them and [[wags its tail]].",
        "They give the dog a small piece.",
        "What a happy day in the park!"
      ],
      zh: [
        "这是一个炎热的夏日。",
        "Lily 和 Tom 走到公园。",
        "他们看见一家小小的冰淇淋店。",
        "Lily 要了一个草莓冰淇淋。",
        "Tom 想要巧克力味，加一点牛奶。",
        "冰淇淋又冰又甜。",
        "一只小狗看着他们，摇着尾巴。",
        "他们分给小狗一小块。",
        "公园里多开心的一天！"
      ],
      notes: [
        null,
        null,
        null,
        "ask for sth 是“要某物”，比 I want 更礼貌；点单也可以说 I'd like …",
        null,
        null,
        "wag its tail 摇尾巴，its 是“它的”，不要写成 it's。",
        null,
        "What a … day! 是感叹句，省略了 it is。"
      ],
      qa: [
        {
          q: "What does Lily ask for?",
          qZh: "Lily 要了什么？",
          groups: [["strawberry"]],
          zhGroups: [["草莓"]],
          answer: "She asks for a strawberry ice cream.",
          answerZh: "她要了一个草莓冰淇淋。"
        },
        {
          q: "What does the little dog do?",
          qZh: "小狗做了什么？",
          groups: [["wag", "tail", "looks"]],
          zhGroups: [["摇尾巴", "看"]],
          answer: "It looks at them and wags its tail.",
          answerZh: "它看着他们，摇了摇尾巴。"
        }
      ]
    },
    {
      id: "k3",
      emoji: "🐶",
      title: "My Little Dog Lucky",
      titleZh: "我的小狗 Lucky",
      level: "启蒙 · 动物朋友",
      minutes: 2,
      goal: "学会用 He is … / He has … 描述人或动物",
      sentences: [
        "I have a little dog.",
        "His name is Lucky.",
        "Lucky is brown and white.",
        "He has two big ears and a short tail.",
        "Every morning we run in the garden.",
        "Lucky loves to [[play with]] a red ball.",
        "When I come home, he jumps up and down.",
        "He is my [[best friend]].",
        "I love Lucky very much."
      ],
      zh: [
        "我有一只小狗。",
        "他叫 Lucky。",
        "Lucky 是棕白相间的。",
        "他有两只大耳朵和一条短尾巴。",
        "每天早上我们在花园里跑。",
        "Lucky 最爱玩红皮球。",
        "我一回家，他就上蹿下跳。",
        "他是我最好的朋友。",
        "我很爱 Lucky。"
      ],
      notes: [
        null,
        "His 是 he 的形容词性物主代词，表示“他的”。",
        null,
        "He has… 描述“他有……”；注意 ears、尾巴用复数。",
        null,
        "love to do sth 表示“喜欢做某事”，口语里比 like 更强烈。",
        "When 引导时间状语从句，主句用一般现在时。",
        null,
        null
      ],
      qa: [
        {
          q: "What colour is Lucky?",
          qZh: "Lucky 是什么颜色的？",
          groups: [["brown", "white"]],
          zhGroups: [["棕", "白"]],
          answer: "Lucky is brown and white.",
          answerZh: "Lucky 是棕白相间的。"
        },
        {
          q: "What does Lucky love to play with?",
          qZh: "Lucky 最爱玩什么？",
          groups: [["ball"]],
          zhGroups: [["球"]],
          answer: "He loves to play with a red ball.",
          answerZh: "他最爱玩红皮球。"
        }
      ]
    }
  ],

  teen: [
    {
      id: "t1",
      emoji: "😴",
      title: "The Science of Sleep",
      titleZh: "睡眠的科学",
      level: "进阶 · 科普短文",
      minutes: 4,
      goal: "掌握 however / as a result / pay off 这类考试高频连接与短语",
      sentences: [
        "Many students [[stay up late]] to finish their homework.",
        "However, scientists say that sleep is [[just as important as]] study.",
        "During sleep, the brain [[sorts out]] what we learned during the day.",
        "If you sleep less than seven hours, you may find it hard to focus in class.",
        "A short nap after lunch can also help you remember new words.",
        "So put your phone away before bed and keep your bedroom dark.",
        "Good sleep habits will [[pay off]] in the long run."
      ],
      zh: [
        "很多学生熬夜写完作业。",
        "不过，科学家说睡眠和学习同样重要。",
        "睡觉时，大脑会整理白天学到的东西。",
        "如果睡不到七小时，你可能会发现上课很难集中注意力。",
        "午饭后小睡一会儿，也能帮你记住新单词。",
        "所以睡前把手机放远，让卧室保持黑暗。",
        "好的睡眠习惯，长期来看一定会有回报。"
      ],
      notes: [
        "stay up late 是“熬夜”，后面常接 to do 表示熬夜做什么。",
        "However 表示转折；just as … as 表示“和……一样……”。",
        "sort out 是“整理、理清”；what we learned 是宾语从句。",
        "If 引导条件状语从句；find it hard to do sth 中 it 是形式宾语。",
        null,
        "两个并列祈使句：put … away 收起来，keep … dark 保持黑暗。",
        "pay off 是“得到回报”；in the long run 表示“从长远看”。"
      ],
      qa: [
        {
          q: "What does the brain do during sleep?",
          qZh: "睡觉时大脑做什么？",
          groups: [["sort", "organize", "整理"]],
          zhGroups: [["整理", "梳理"]],
          answer: "It sorts out what we learned during the day.",
          answerZh: "它会整理我们白天学到的东西。"
        },
        {
          q: "What can help you remember new words after lunch?",
          qZh: "午饭后什么能帮你记住新单词？",
          groups: [["nap"]],
          zhGroups: [["午睡", "小睡", "睡一会"]],
          answer: "A short nap after lunch can help.",
          answerZh: "午饭后小睡一会儿有帮助。"
        }
      ]
    },
    {
      id: "t2",
      emoji: "📓",
      title: "The Lost Notebook",
      titleZh: "丢失的笔记本",
      level: "进阶 · 校园故事",
      minutes: 3,
      goal: "熟悉一般过去时与被动语态在叙事里的用法",
      sentences: [
        "On Monday morning, Lin found that her notebook was missing.",
        "She had written all her English notes in it before the exam.",
        "She looked under her desk, but there was nothing there.",
        "Her classmate Wei saw her worry and [[offered to help]].",
        "They searched the classroom together and asked the teacher.",
        "At last, the notebook was found in the reading corner.",
        "Lin smiled and thanked everyone who helped her."
      ],
      zh: [
        "周一早上，Lin 发现笔记本不见了。",
        "考试前她把所有英语笔记都写在了里面。",
        "她看了看桌子底下，但那里什么也没有。",
        "同学 Wei 看她着急，主动提出帮忙。",
        "他们一起找了教室，还问了老师。",
        "最后，笔记本在阅读角被找到了。",
        "Lin 笑了，向每个帮过她的人道谢。"
      ],
      notes: [
        "On Monday morning 是时间状语；found 后接 that 宾语从句；be missing 表示“不见了”。",
        "had written 是过去完成时，表示“过去的过去”。",
        null,
        "saw her worry and offered to help：两个并列谓语；offer to do 是“主动提出做某事”。",
        "search 是及物动词，search the classroom 表示“搜这个教室”。",
        "was found 是被动语态；at last 表示“终于”。",
        "who helped her 是定语从句，修饰 everyone。"
      ],
      qa: [
        {
          q: "What was Lin looking for?",
          qZh: "Lin 在找什么？",
          groups: [["notebook"]],
          zhGroups: [["笔记本"]],
          answer: "She was looking for her notebook.",
          answerZh: "她在找她的笔记本。"
        },
        {
          q: "Where was the notebook found?",
          qZh: "笔记本在哪里找到的？",
          groups: [["reading corner", "corner"]],
          zhGroups: [["阅读角"]],
          answer: "It was found in the reading corner.",
          answerZh: "在阅读角找到的。"
        }
      ]
    },
    {
      id: "t3",
      emoji: "✉️",
      title: "A Letter to the Future",
      titleZh: "写给未来的信",
      level: "进阶 · 议论文",
      minutes: 4,
      goal: "看懂虚拟语气与 instead of 结构，学会写议论文开头",
      sentences: [
        "If you could write a letter to yourself ten years from now, what would you say?",
        "Most people would tell themselves [[not to be afraid of]] making mistakes.",
        "Every mistake teaches us something that success cannot.",
        "[[Instead of]] waiting for the perfect moment, start with a small step today.",
        "[[Keep a record]] of what you try, and look back at it once a month.",
        "In ten years, you may be surprised by how far those small steps have taken you."
      ],
      zh: [
        "如果你能给十年后的自己写封信，你会说什么？",
        "大多数人会告诉自己：不要害怕犯错。",
        "每一个错误都会教给我们成功教不了的东西。",
        "不要等完美时机，今天就先迈出一小步。",
        "把尝试过的事记下来，每个月回看一次。",
        "十年后，你可能会惊讶于这些小步把你带到了多远。"
      ],
      notes: [
        "虚拟语气：If you could …, what would you say? 表示对现在的假设。",
        "tell sb not to do sth 是“告诉某人不要做某事”；be afraid of doing 是“害怕做某事”。",
        "something that success cannot 中 that 引导定语从句，cannot 后面省略了 teach us。",
        "Instead of + 动名词作状语，意为“而不是……”；主句是祈使句。",
        "keep a record of 记录；once a month 表示频率。",
        "be surprised by 对……感到惊讶；how far 引导宾语从句。"
      ],
      qa: [
        {
          q: "What do most people tell themselves?",
          qZh: "大多数人会对自己说什么？",
          groups: [["afraid", "mistake"]],
          zhGroups: [["不要怕", "犯错", "害怕"]],
          answer: "They tell themselves not to be afraid of making mistakes.",
          answerZh: "他们告诉自己不要害怕犯错。"
        },
        {
          q: "How often should you look back at your record?",
          qZh: "你应该多久回看一次记录？",
          groups: [["once a month", "month"]],
          zhGroups: [["一个月", "每月"]],
          answer: "Once a month.",
          answerZh: "每个月一次。"
        }
      ]
    }
  ],

  adult: [
    {
      id: "a1",
      emoji: "💼",
      title: "Your First Day at Work",
      titleZh: "入职第一天",
      level: "实用 · 职场沟通",
      minutes: 5,
      goal: "读懂职场长句的主谓宾结构，学会 5 句第一天就能用的表达",
      sentences: [
        "Before your first day, [[make sure]] you know the office address and the name of the person you will report to.",
        "On the morning of your first day, arrive about ten minutes early and [[introduce yourself]] to the receptionist.",
        "When your manager [[shows you around]], take notes on where the meeting rooms and the printer are.",
        "[[Instead of]] staying quiet at lunch, ask your new colleagues what they are working on.",
        "[[By the end of]] the week, you should have a clear idea of who does what on your team.",
        "Remember that nobody expects you to know everything in the first month."
      ],
      zh: [
        "入职前，先确认好办公地址，以及你要向谁汇报。",
        "第一天早上，提前十分钟到，并向前台介绍自己。",
        "经理带你熟悉环境时，记下会议室和打印机在哪里。",
        "午饭时别一个人闷着，问问新同事在做什么项目。",
        "到周末时，你应该已经清楚团队里谁负责什么。",
        "记住，没人指望你第一个月就什么都懂。"
      ],
      notes: [
        "主干是祈使句 make sure (that) …；you will report to 是定语从句，修饰 the person。",
        "两个并列谓语 arrive … and introduce …；introduce oneself to sb 是“向某人自我介绍”。",
        "When 引导时间状语从句；take notes on 后接 where 引导的宾语从句。",
        "Instead of + 动名词作状语；ask sb what … 是“问某人……”。",
        "By the end of … 表示“到……为止”，常与完成时连用；have a clear idea of 后接宾语从句。",
        "Remember that … 后接宾语从句；expect sb to do sth 是“期望某人做某事”。"
      ],
      qa: [
        {
          q: "What should you do on the morning of your first day?",
          qZh: "第一天早上你应该怎么做？",
          groups: [["early", "ten minutes"]],
          zhGroups: [["提前", "早到", "十分钟"]],
          answer: "Arrive about ten minutes early and introduce yourself.",
          answerZh: "提前十分钟左右到，并向大家介绍自己。"
        },
        {
          q: "What can you ask your new colleagues at lunch?",
          qZh: "午饭时你可以问新同事什么？",
          groups: [["working on", "work on"]],
          zhGroups: [["做什么", "在忙", "项目"]],
          answer: "Ask them what they are working on.",
          answerZh: "问他们正在做什么项目。"
        }
      ]
    },
    {
      id: "a2",
      emoji: "✈️",
      title: "At the Airport",
      titleZh: "机场通关",
      level: "实用 · 出行旅行",
      minutes: 5,
      goal: "把机场流程里的英文长句拆成“什么时候 + 做什么”",
      sentences: [
        "When you arrive at the airport, [[check the departure board]] to find your flight and your gate.",
        "If you are travelling with only a [[carry-on bag]], you can go straight to security.",
        "At the security check, take your laptop and liquids out of your bag and put them in a tray.",
        "[[Keep]] your boarding pass in your hand [[until]] you reach the gate.",
        "[[In case]] your flight is delayed, the airline will usually send a message to your phone.",
        "Boarding normally starts about forty minutes before departure."
      ],
      zh: [
        "到机场后，先看航班信息屏，找到你的航班和登机口。",
        "如果只带登机箱，可以直接去安检。",
        "过安检时，把笔记本电脑和液体从包里拿出来放进托盘。",
        "登机牌拿在手里，一直到登机口。",
        "万一航班延误，航空公司一般会发短信到你手机。",
        "登机通常在起飞前四十分钟左右开始。"
      ],
      notes: [
        "When 引导时间状语从句，主句是祈使句 check …；不定式 to find 表示目的。",
        "If 条件从句；travel with … 表示“带着……出行”；go straight to 是“直接去……”。",
        "两个并列祈使句 take … and put …；take sth out of 是“把某物从……拿出来”。",
        "until 引导时间状语从句，表示“直到……为止”。",
        "In case 引导条件状语从句，意为“万一……”；主句用将来时。",
        "主谓结构清晰：Boarding（主语）starts（谓语）；before departure 是时间状语。"
      ],
      qa: [
        {
          q: "Where can you find your gate number?",
          qZh: "在哪里能找到登机口信息？",
          groups: [["departure board", "board"]],
          zhGroups: [["信息屏", "航班信息", "显示屏"]],
          answer: "On the departure board at the airport.",
          answerZh: "在机场的航班信息屏上。"
        },
        {
          q: "What should you keep in your hand until the gate?",
          qZh: "什么要一直拿在手里直到登机口？",
          groups: [["boarding pass"]],
          zhGroups: [["登机牌"]],
          answer: "Your boarding pass.",
          answerZh: "你的登机牌。"
        }
      ]
    },
    {
      id: "a3",
      emoji: "🏨",
      title: "Checking In at a Hotel",
      titleZh: "酒店入住",
      level: "实用 · 酒店住宿",
      minutes: 5,
      goal: "掌握 check in / deposit / settle the bill 这套入住到退房的表达",
      sentences: [
        "When you reach the front desk, give your name and your [[booking number]] to the receptionist.",
        "If the room is not ready yet, ask [[whether]] they can keep your luggage for a few hours.",
        "Before you go up, check that the room rate includes breakfast and whether there is a deposit.",
        "[[It is worth]] asking for a room away from the street if you are a light sleeper.",
        "If anything in the room does not work, call the front desk instead of waiting until check-out.",
        "On the day you leave, [[settle the bill]] and ask for a receipt for your company."
      ],
      zh: [
        "到前台时，把姓名和预订号交给前台。",
        "如果房间还没准备好，问一下能不能先寄存行李几个小时。",
        "上楼之前，确认房价是否含早餐、是否需要押金。",
        "如果你睡眠浅，值得要一间离街远一点的房间。",
        "房间里有什么不好用，直接打前台电话，别等到退房才说。",
        "退房那天结清账单，并要一张能交给公司的发票。"
      ],
      notes: [
        "When 从句 + 祈使主句；give sb sth 是双宾结构。",
        "ask whether … 是“问是否……”；keep sth for + 时间 表示“保管多久”。",
        "check that … and whether … 是两个并列的宾语从句；room rate 是“房价”。",
        "It is worth doing sth 表示“值得做某事”，it 是形式主语；away from the street 修饰 room。",
        "instead of + 动名词作状语；until check-out 表示“直到退房”。",
        "On the day you leave 中 you leave 是定语从句，修饰 the day；settle the bill 是“结账”。"
      ],
      qa: [
        {
          q: "What can you ask if the room is not ready?",
          qZh: "房间没准备好时，你可以问什么？",
          groups: [["luggage", "keep"]],
          zhGroups: [["行李", "寄存"]],
          answer: "You can ask them to keep your luggage for a few hours.",
          answerZh: "可以请他们帮你寄存几个小时的行李。"
        },
        {
          q: "What should you ask for when you settle the bill?",
          qZh: "结账时你应该要什么？",
          groups: [["receipt"]],
          zhGroups: [["发票", "收据"]],
          answer: "A receipt for your company.",
          answerZh: "一张能交给公司的发票。"
        }
      ]
    }
  ]
};

/* 取某一句里的关键短语数量（用于统计，不影响功能） */
function countKeyPhrases(text) {
  const m = text.match(/\[\[/g);
  return m ? m.length : 0;
}
