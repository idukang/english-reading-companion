/* ===========================================================
   内置离线情景对话（9 个场景 · 全龄段）
   -----------------------------------------------------------
   每个场景是一组固定轮次：
     · en / zh      对方这一句英文和中文
     · chips        提示用的示范说法（点一下就发出去）
     · tip          中文提示（怎么回）
     · expect       判分要点：二维数组，每个子数组里命中任意一个词即算满足
     · good / mid   点评（全中 / 部分命中）
     · model        标准回答
   =========================================================== */

const SCENARIOS = {

  kids: [
    {
      id: "c-k1",
      emoji: "👋",
      title: "初次见面",
      titleEn: "Greeting & Self-Introduction",
      level: "入门 · 3 句话介绍自己",
      goal: "会在第一次见面时说出名字、年龄和喜好",
      turns: [
        {
          en: "Hi! I'm Amy. What's your name?",
          zh: "嗨！我是 Amy。你叫什么名字？",
          chips: ["My name is Li Ming.", "I'm Li Ming."],
          tip: "说名字用 My name is … ，也可以直接说 I'm …",
          expect: [["name", "i'm", "i am"]],
          good: "很好！My name is … 是最清楚的自我介绍。",
          mid: "你把名字说出来了，可以再完整一点：My name is …",
          model: "My name is Li Ming."
        },
        {
          en: "Nice to meet you! How old are you?",
          zh: "很高兴认识你！你几岁了？",
          chips: ["I'm eight years old.", "I am eight."],
          tip: "说年龄用 I'm … years old.",
          expect: [["old", "year", "i'm", "i am"]],
          good: "答得对！I'm … years old. 一句就够。",
          mid: "意思到了。更自然的是：I'm eight years old.",
          model: "I'm eight years old."
        },
        {
          en: "I'm nine. Do you like English?",
          zh: "我九岁。你喜欢英语吗？",
          chips: ["Yes, I do.", "Yes, I like English very much."],
          tip: "回答 Do you … 用 Yes, I do. 或 No, I don't.",
          expect: [["yes", "like", "do"]],
          good: "对！Yes, I do. 是最省力的简答。",
          mid: "可以再说明确一点：Yes, I do. I like English songs.",
          model: "Yes, I do."
        },
        {
          en: "Great! What do you like to do after school?",
          zh: "太好了！放学后你喜欢做什么？",
          chips: ["I like to play football.", "I like reading books."],
          tip: "我喜欢做某事：I like to + 动词原形。",
          expect: [["like", "play", "read"]],
          good: "很棒！I like to + 动词，说得很自然。",
          mid: "可以这样接：I like to play football with my friends.",
          model: "I like to play football with my friends."
        }
      ],
      closing: {
        en: "That sounds fun. See you tomorrow!",
        zh: "听起来很有意思。明天见！"
      }
    },
    {
      id: "c-k2",
      emoji: "🍦",
      title: "点一份冰淇淋",
      titleEn: "Ordering Ice Cream",
      level: "入门 · 点单用语",
      goal: "会用 please 礼貌地点单、选口味、付钱",
      turns: [
        {
          en: "Welcome! What would you like today?",
          zh: "欢迎光临！今天想要点什么？",
          chips: ["I would like an ice cream, please.", "Can I have a chocolate ice cream?"],
          tip: "点单：I would like … / Can I have …, please?",
          expect: [["like", "have", "want", "ice cream"]],
          good: "很礼貌！Would like 比 want 更客气。",
          mid: "再试一次：I would like an ice cream, please.",
          model: "I would like an ice cream, please."
        },
        {
          en: "Sure! Which flavour would you like, strawberry or chocolate?",
          zh: "好的！你要哪种口味，草莓还是巧克力？",
          chips: ["Strawberry, please.", "Chocolate, please."],
          tip: "选一个口味，后面加 please。",
          expect: [["strawberry", "chocolate"]],
          good: "对，这样说就很清楚。",
          mid: "说出口味就行：Strawberry, please.",
          model: "Strawberry, please."
        },
        {
          en: "One strawberry ice cream. A cup or a cone?",
          zh: "一个草莓冰淇淋。要杯装还是蛋筒？",
          chips: ["A cone, please.", "A cup, please."],
          tip: "cup 是杯装，cone 是蛋筒。",
          expect: [["cup", "cone"]],
          good: "没错！A cone, please. 一句就够。",
          mid: "可以回答：A cone, please.",
          model: "A cone, please."
        },
        {
          en: "Here you are. That's six yuan, please.",
          zh: "给你。一共六元。",
          chips: ["Here you are. Thank you!", "Six yuan. Here it is."],
          tip: "递钱或递东西时说 Here you are.",
          expect: [["thank", "here", "yuan", "six"]],
          good: "很自然！Here you are. 是递东西的固定说法。",
          mid: "付钱时说：Here you are. Thank you!",
          model: "Here you are. Thank you!"
        }
      ],
      closing: {
        en: "Thank you! Enjoy your ice cream.",
        zh: "谢谢！慢慢享用你的冰淇淋。"
      }
    },
    {
      id: "c-k3",
      emoji: "🐰",
      title: "动物朋友",
      titleEn: "Animal Friends",
      level: "入门 · 描述动物",
      goal: "会用 It has … / It likes … 描述一只动物",
      turns: [
        {
          en: "Look! What animal is that?",
          zh: "看！那是什么动物？",
          chips: ["It's a rabbit.", "That is a rabbit."],
          tip: "回答用 It's a + 动物名。",
          expect: [["rabbit", "it's", "that is", "is a"]],
          good: "对！It's a rabbit. 又短又自然。",
          mid: "试着说：It's a rabbit.",
          model: "It's a rabbit."
        },
        {
          en: "Yes! It has long ears. Do you have a pet?",
          zh: "对！它有长耳朵。你养宠物吗？",
          chips: ["Yes, I have a cat.", "No, I don't have a pet."],
          tip: "有就说 Yes, I have a …；没有就说 No, I don't.",
          expect: [["cat", "dog", "have", "yes", "no"]],
          good: "很好！回答宠物用 have。",
          mid: "可以说：Yes, I have a cat.",
          model: "Yes, I have a cat."
        },
        {
          en: "A cat! What colour is it?",
          zh: "一只猫！它是什么颜色的？",
          chips: ["It's white and brown.", "It is black."],
          tip: "颜色：It's + 颜色。",
          expect: [["white", "brown", "black", "it's", "is"]],
          good: "说得很清楚！",
          mid: "可以回答：It's white and brown.",
          model: "It's white and brown."
        },
        {
          en: "How cute! What does your cat like to do?",
          zh: "好可爱！你的猫喜欢做什么？",
          chips: ["It likes to sleep and play.", "She likes to play with a ball."],
          tip: "第三人称单数：It likes to + 动词。",
          expect: [["sleep", "play", "likes", "ball"]],
          good: "对！likes 记得加 s，这个细节很棒。",
          mid: "注意第三人称：It likes to sleep and play.",
          model: "It likes to sleep and play."
        }
      ],
      closing: {
        en: "Your cat sounds lovely. Bye!",
        zh: "你的猫听起来真可爱。再见！"
      }
    }
  ],

  teen: [
    {
      id: "c-t1",
      emoji: "🗺️",
      title: "在街上问路",
      titleEn: "Asking for Directions",
      level: "进阶 · 方位与确认",
      goal: "会问路、重复确认路线、问距离",
      turns: [
        {
          en: "Excuse me, can I help you?",
          zh: "打扰一下，需要帮忙吗？",
          chips: ["Yes, I'm looking for the library.", "Could you tell me how to get to the library?"],
          tip: "我在找……：I'm looking for …",
          expect: [["library", "looking for", "how to get", "find"]],
          good: "很好！I'm looking for … 是最常用的问路开头。",
          mid: "可以说：I'm looking for the library.",
          model: "I'm looking for the library."
        },
        {
          en: "Go straight along this street, then turn left at the bank.",
          zh: "沿这条街一直走，然后在银行那儿左转。",
          chips: ["Turn left at the bank, right?", "So I go straight and turn left at the bank."],
          tip: "确认路线时把对方的话重复一遍，句尾加 right?",
          expect: [["left", "bank", "straight"]],
          good: "非常地道！重复确认是问路的关键技巧。",
          mid: "试着确认：So I go straight and turn left at the bank.",
          model: "Go straight and turn left at the bank, right?"
        },
        {
          en: "Yes, that's right. It's about five minutes on foot.",
          zh: "对，没错。步行大约五分钟。",
          chips: ["Five minutes on foot. Thank you so much.", "How far is it from here?"],
          tip: "on foot 表示“步行”；问距离用 How far is it?",
          expect: [["minute", "far", "thank", "five"]],
          good: "很好！on foot 用得很地道。",
          mid: "可以说：Five minutes on foot. Thank you.",
          model: "Five minutes on foot. Thank you so much."
        },
        {
          en: "Is this your first time here?",
          zh: "这是你第一次来这儿吗？",
          chips: ["Yes, it's my first time here.", "No, I come here every week."],
          tip: "第一次来：It's my first time here.",
          expect: [["first time", "yes", "no", "week"]],
          good: "答得很自然！",
          mid: "可以回答：Yes, it's my first time here.",
          model: "Yes, it's my first time here."
        }
      ],
      closing: {
        en: "Enjoy your visit. Have a nice day!",
        zh: "祝你参观愉快。今天过得开心！"
      }
    },
    {
      id: "c-t2",
      emoji: "📚",
      title: "图书馆借书",
      titleEn: "Borrowing Books at the Library",
      level: "进阶 · 校园场景",
      goal: "会办借书证、找书、问借期和续借",
      turns: [
        {
          en: "Hello! Do you need a library card?",
          zh: "你好！你需要借书证吗？",
          chips: ["Yes, please. How can I get one?", "No, I already have one."],
          tip: "需要就说 Yes, please.；已有就说 I already have one.",
          expect: [["yes", "no", "card", "have", "need"]],
          good: "回答得很干脆！",
          mid: "可以说：Yes, please. How can I get one?",
          model: "Yes, please. How can I get one?"
        },
        {
          en: "You can get one with your student card. Which book are you looking for?",
          zh: "用学生证就可以办。你在找哪本书？",
          chips: ["I'm looking for a book about science.", "Do you have books about space?"],
          tip: "I'm looking for a book about + 主题。",
          expect: [["looking for", "book", "science", "have", "about"]],
          good: "很好！about + 主题，说得很准确。",
          mid: "可以说：I'm looking for a book about science.",
          model: "I'm looking for a book about science."
        },
        {
          en: "It's on the third shelf on the left. You can borrow it for two weeks.",
          zh: "在左边第三个书架。可以借两周。",
          chips: ["Two weeks, got it. Thank you.", "Can I keep it a little longer?"],
          tip: "确认信息：Two weeks, got it.；想多借：Can I keep it longer?",
          expect: [["week", "thank", "longer", "got"]],
          good: "很好，got it 是口语里最常用的“明白了”。",
          mid: "可以说：Two weeks, got it. Thank you.",
          model: "Two weeks, got it. Thank you."
        },
        {
          en: "Yes, you can renew it once online.",
          zh: "可以，你可以在网上续借一次。",
          chips: ["Great, I'll renew it online.", "What if I return it late?"],
          tip: "renew 是续借，return 是归还。",
          expect: [["renew", "online", "late", "return"]],
          good: "用词准确！renew 和 return 都分得清。",
          mid: "可以说：Great, I'll renew it online.",
          model: "Great, I'll renew it online."
        }
      ],
      closing: {
        en: "Perfect. Happy reading!",
        zh: "很好。祝你阅读愉快！"
      }
    },
    {
      id: "c-t3",
      emoji: "🎒",
      title: "周末计划",
      titleEn: "Weekend Plans",
      level: "进阶 · 邀约与约定时间",
      goal: "会发出邀请、接受或婉拒、约定时间地点",
      turns: [
        {
          en: "Hi! Do you have any plans for the weekend?",
          zh: "嗨！你周末有什么计划吗？",
          chips: ["I'm going to visit my grandparents.", "I don't have any plans yet."],
          tip: "打算做某事：I'm going to + 动词。",
          expect: [["plan", "going to", "visit", "weekend", "will"]],
          good: "很好！be going to 表示计划，用得对。",
          mid: "可以说：I'm going to visit my grandparents.",
          model: "I'm going to visit my grandparents."
        },
        {
          en: "Nice! I want to watch a film on Saturday. Would you like to come?",
          zh: "不错！我周六想看电影。你想一起来吗？",
          chips: ["Sure, I'd love to.", "Sorry, I can't. I have to study."],
          tip: "接受：Sure, I'd love to. 婉拒：Sorry, I can't. + 原因。",
          expect: [["yes", "love", "sure", "sorry", "can't", "study"]],
          good: "回答得很得体！",
          mid: "接受邀请可以说：Sure, I'd love to.",
          model: "Sure, I'd love to."
        },
        {
          en: "Great! What time works for you?",
          zh: "太好了！你几点方便？",
          chips: ["Three o'clock works for me.", "How about four in the afternoon?"],
          tip: "提建议：How about + 时间？",
          expect: [["o'clock", "time", "afternoon", "about", "three", "four"]],
          good: "非常自然！works for me 是地道的“我方便”。",
          mid: "可以说：Three o'clock works for me.",
          model: "Three o'clock works for me."
        },
        {
          en: "Three o'clock it is. Let's meet at the cinema gate.",
          zh: "那就三点。我们在电影院门口见。",
          chips: ["See you at the cinema gate.", "OK, I'll be there on time."],
          tip: "约地点：See you at + 地点。",
          expect: [["see you", "meet", "gate", "there", "ok"]],
          good: "很好！See you at … 是约定见面的标准说法。",
          mid: "可以说：See you at the cinema gate.",
          model: "See you at the cinema gate."
        }
      ],
      closing: {
        en: "See you on Saturday. Bye!",
        zh: "周六见。拜拜！"
      }
    }
  ],

  adult: [
    {
      id: "c-a1",
      emoji: "☕",
      title: "咖啡店点单与闲聊",
      titleEn: "Coffee Shop Chat",
      level: "实用 · 点单 + 小聊",
      goal: "会点单、说明堂食/外带、接住对方的闲聊",
      turns: [
        {
          en: "Good morning! What can I get for you today?",
          zh: "早上好！今天想喝点什么？",
          chips: ["A medium latte, please.", "Could I have a flat white and a croissant?"],
          tip: "点单用 Could I have …, please? 最稳。",
          expect: [["latte", "coffee", "have", "like", "get"]],
          good: "很得体！Could I have … 比 I want 礼貌得多。",
          mid: "可以说：A medium latte, please.",
          model: "Could I have a medium latte, please?"
        },
        {
          en: "Sure. Would you like it for here or to go?",
          zh: "好的。在这儿喝还是带走？",
          chips: ["To go, please.", "For here, please."],
          tip: "带走 to go，堂食 for here。",
          expect: [["to go", "here", "take away", "takeaway"]],
          good: "对！To go, please. 一句就够。",
          mid: "可以回答：To go, please.",
          model: "To go, please."
        },
        {
          en: "Anything else? Our banana bread is fresh today.",
          zh: "还要别的吗？今天的香蕉面包是刚烤的。",
          chips: ["No, thanks. That's all.", "Yes, one slice of banana bread, please."],
          tip: "不用了说 That's all, thanks.",
          expect: [["no", "yes", "thanks", "that's all", "bread"]],
          good: "很好！That's all 是收尾点单的固定说法。",
          mid: "可以说：No, thanks. That's all.",
          model: "No, thanks. That's all."
        },
        {
          en: "That'll be thirty-two yuan. Are you working nearby?",
          zh: "一共三十二元。你在附近上班吗？",
          chips: ["Yes, my office is just around the corner.", "No, I'm visiting a friend here."],
          tip: "just around the corner 就在拐角处，很地道。",
          expect: [["office", "yes", "no", "work", "near", "around"]],
          good: "接得很自然！around the corner 用得好。",
          mid: "可以说：Yes, my office is just around the corner.",
          model: "Yes, my office is just around the corner."
        }
      ],
      closing: {
        en: "Nice. Enjoy your coffee — and have a good day!",
        zh: "不错。慢慢喝，今天愉快！"
      }
    },
    {
      id: "c-a2",
      emoji: "🏨",
      title: "酒店入住",
      titleEn: "Hotel Check-in",
      level: "实用 · 出行住宿",
      goal: "会报预订、出示证件、问押金和早餐",
      turns: [
        {
          en: "Good evening, welcome. Do you have a reservation?",
          zh: "晚上好，欢迎光临。您有预订吗？",
          chips: ["Yes, I booked a double room for two nights.", "Yes, under the name Wang."],
          tip: "有预订就说 Yes, I booked … / under the name …。",
          expect: [["yes", "booked", "reservation", "name", "room"]],
          good: "很规范！under the name … 是报预订的常用说法。",
          mid: "可以说：Yes, I booked a double room for two nights.",
          model: "Yes, I booked a double room for two nights."
        },
        {
          en: "May I have your passport and booking number, please?",
          zh: "可以给我您的护照和预订号吗？",
          chips: ["Here you are. My booking number is 8823.", "Sure, here is my passport."],
          tip: "递东西时说 Here you are.",
          expect: [["here", "passport", "number", "sure"]],
          good: "很好！Here you are. 递证件时说最合适。",
          mid: "可以说：Sure, here is my passport.",
          model: "Here you are. My booking number is 8823."
        },
        {
          en: "Thank you. Your room is on the eighth floor. Breakfast is from seven to ten.",
          zh: "谢谢。您的房间在八楼。早餐七点到十点。",
          chips: ["Does the room rate include breakfast?", "Is there a deposit for the room?"],
          tip: "确认押金：Is there a deposit?",
          expect: [["breakfast", "deposit", "include", "rate", "floor"]],
          good: "问得专业！deposit 和 room rate 都用对了。",
          mid: "可以问：Is there a deposit for the room?",
          model: "Does the room rate include breakfast?"
        },
        {
          en: "Breakfast is included. We need a deposit of two hundred yuan.",
          zh: "含早餐。需要两百元押金。",
          chips: ["That's fine. Can I pay by card?", "I see. Here is my card."],
          tip: "问刷卡：Can I pay by card?",
          expect: [["card", "pay", "fine", "see", "cash"]],
          good: "很顺！pay by card 是标准说法。",
          mid: "可以说：That's fine. Can I pay by card?",
          model: "That's fine. Can I pay by card?"
        }
      ],
      closing: {
        en: "Of course. Here is your key. Enjoy your stay!",
        zh: "当然可以。这是您的房卡，祝您入住愉快！"
      }
    },
    {
      id: "c-a3",
      emoji: "💼",
      title: "面试与自我介绍",
      titleEn: "Job Interview & Standup Meeting",
      level: "实用 · 职场表达",
      goal: "用三句话讲清经验、动机和优势，并能谈不足",
      turns: [
        {
          en: "Thanks for coming in. Could you tell me a little about yourself?",
          zh: "感谢你来。能简单介绍一下你自己吗？",
          chips: ["I have three years of experience in marketing.", "I graduated last year and I'm good at data analysis."],
          tip: "结构：经验 + 技能。I have … years of experience in …",
          expect: [["experience", "graduat", "work", "year", "good at"]],
          good: "很完整！经验 + 技能，是自我介绍最有效的结构。",
          mid: "可以这样开头：I have three years of experience in …",
          model: "I have three years of experience in marketing."
        },
        {
          en: "That sounds good. Why do you want to join our team?",
          zh: "听起来不错。你为什么想加入我们团队？",
          chips: ["Because I want to work on products used by many people.", "I admire your products and I want to grow here."],
          tip: "Why 的问题用 Because … 开头最清楚。",
          expect: [["because", "want", "team", "product", "grow", "join"]],
          good: "答得很有说服力！",
          mid: "可以用 Because … 开头，把理由说具体。",
          model: "Because I want to work on products used by many people."
        },
        {
          en: "What would you say is your biggest strength?",
          zh: "你认为你最大的优势是什么？",
          chips: ["I'm good at solving problems under pressure.", "I learn new tools quickly."],
          tip: "I'm good at + 动名词，是最稳的句式。",
          expect: [["strength", "good at", "learn", "problem", "team"]],
          good: "很好！good at + doing 用得很准。",
          mid: "可以说：I'm good at solving problems under pressure.",
          model: "I'm good at solving problems under pressure."
        },
        {
          en: "And what about your weakness?",
          zh: "那你的不足呢？",
          chips: ["I used to speak too fast, so I practise slowing down.", "I sometimes focus too much on details."],
          tip: "说不足时补一句你正在怎么改进。",
          expect: [["weakness", "used to", "sometimes", "improve", "practice", "practise", "working on"]],
          good: "答得很成熟：承认不足 + 说明改进。",
          mid: "可以说：I used to speak too fast, so I practise slowing down.",
          model: "I used to speak too fast, so I practise slowing down."
        }
      ],
      closing: {
        en: "Thank you. We'll get back to you by Friday.",
        zh: "谢谢你。我们会在周五前回复你。"
      }
    }
  ]
};
