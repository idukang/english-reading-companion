package com.idukang.readingcompanion

import android.content.Context
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.os.SystemClock
import android.util.Log
import org.json.JSONObject
import org.vosk.LibVosk
import org.vosk.LogLevel
import org.vosk.Model
import org.vosk.Recognizer
import java.io.File
import java.util.Locale
import kotlin.math.max
import kotlin.math.sqrt

/**
 * 离线语音识别（Vosk）。
 *
 * 设计要点：
 *  · 完全离线：模型文件在 assets 里，首次使用解包到 filesDir，之后直接用；
 *  · 我们自己用 AudioRecord 读 16kHz PCM，不用 SpeechService，这样才能控制
 *    后台生命周期、暂停/恢复、以及“边说边听”（打断）的细节；
 *  · 耳机连麦模式下用 MediaRecorder.AudioSource.VOICE_COMMUNICATION + 系统回声消除（AEC），
 *    这样 AI 自己的 TTS 声音会被当成回声消掉，用户随时可以插话；
 *  · 中英双语：英文模型 + 中文模型可同时监听（auto 模式），按置信度/文字种类挑一个结果。
 */
object VoskEngine {

    const val MODE_AUTO = "auto"
    const val MODE_EN = "en"
    const val MODE_ZH = "zh"

    interface Listener {
        /** state: loading | ready | ready-zh | zh-unavailable | error | listening | stopped */
        fun onVoskState(state: String, msg: String)
        fun onSpeechPartial(text: String, lang: String)
        fun onSpeechFinal(text: String, lang: String)
        /** 用户打断 AI 朗读：ttsText 是被打断的那句 */
        fun onBargeIn(ttsText: String)
    }

    private const val SAMPLE_RATE = 16000
    private const val ASSET_EN = "model-en-us"
    private const val ASSET_ZH = "model-cn"
    private const val VOICE_RMS = 520.0
    private const val GRACE_MS = 700L
    private const val MAX_UTTERANCE_MS = 24000L
    private const val BARGE_GUARD_MS = 300L
    private const val PARTIAL_EVERY_MS = 160L
    private const val TAG = "VoskEngine"

    /** 等中文模型的最长时间；超时先让英文模型顶上，至少不静音 */
    private const val ZH_WAIT_MS = 1200L

    @Volatile var listener: Listener? = null

    // ---------- 模型 ----------
    @Volatile private var modelEn: Model? = null
    @Volatile private var modelZh: Model? = null
    private var modelLock = Any()
    @Volatile private var prepared = false
    @Volatile private var preparing = false
    @Volatile private var zhTried = false
    @Volatile private var zhLoading = false
    @Volatile private var zhFailed = false
    @Volatile private var mode = MODE_AUTO
    @Volatile private var pendingStart = false
    @Volatile private var pendingStartBargeIn = false

    // ---------- 识别循环 ----------
    private var thread: Thread? = null
    private var record: AudioRecord? = null
    private var aec: AcousticEchoCanceler? = null

    /** 每一轮“监听”独占自己的识别器，旧线程收尾时不会把新线程的识别器关掉 */
    private class Session(val en: Recognizer?, val zh: Recognizer?) {
        fun close() {
            try {
                en?.close()
            } catch (t: Throwable) {
            }
            try {
                zh?.close()
            } catch (t: Throwable) {
            }
        }
    }

    private var session: Session? = null
    @Volatile private var loopSeq = 0
    @Volatile private var running = false
    @Volatile private var loopAecSource = false
    @Volatile private var bargeInMode = false
    @Volatile private var quietStop = false

    // ---------- TTS 状态（由 MainActivity 更新，用于打断） ----------
    @Volatile private var ttsSpeaking = false
    @Volatile private var ttsText = ""
    @Volatile private var ttsStartedAt = 0L
    @Volatile private var ttsEndedAt = 0L
    private const val ECHO_TAIL_MS = 500L

    // ---------- 一句话的累积 ----------
    private val accEn = StringBuilder()
    private val accZh = StringBuilder()
    private var enConfSum = 0.0
    private var enConfN = 0
    private var zhConfSum = 0.0
    private var zhConfN = 0
    private var lastVoiceAt = 0L
    private var lastResultAt = 0L
    private var utteranceStartAt = 0L
    private var voiceSeen = false
    private var lastPartialAt = 0L
    private var lastPartialText = ""
    private var interrupted = false
    @Volatile private var appCtx: Context? = null

    // ==================================================================
    // 资产与模型
    // ==================================================================

    fun attach(ctx: Context) {
        appCtx = ctx.applicationContext
    }

    fun hasEnglishModel(ctx: Context): Boolean = assetsNonEmpty(ctx, ASSET_EN)

    fun hasChineseModel(ctx: Context): Boolean = assetsNonEmpty(ctx, ASSET_ZH)

    fun isReady(): Boolean = prepared && modelEn != null

    fun isZhReady(): Boolean = modelZh != null

    private fun assetsNonEmpty(ctx: Context, path: String): Boolean = try {
        val list = ctx.assets.list(path)
        list != null && list.isNotEmpty()
    } catch (t: Throwable) {
        false
    }

    fun setLanguageMode(m: String) {
        val next = when (m) {
            MODE_EN, "english", "en-US" -> MODE_EN
            MODE_ZH, "chinese", "zh-CN" -> MODE_ZH
            else -> MODE_AUTO
        }
        val prev = mode
        mode = next
        if (next != MODE_EN) ensureChineseModel()
        // 切到“中文优先 / 英文”后立刻按新语言重开识别器，不让旧模型的识别器继续跑：
        // 选中文 = 100% 走中文模型，英文模型一个结果都不收。
        if (next != prev && running) {
            val barge = bargeInMode
            quietStop = true
            stopListeningInternal(true)
            quietStop = false
            startListening(barge)
        }
    }

    fun setCallback(l: Listener?) {
        listener = l
    }

    /** 应用启动时调用：英文 + 中文两套模型一起热起来，进对话页立刻能用中文。 */
    fun warmup(ctx: Context) {
        prepare(ctx)
    }

    /** 在后台把模型准备好（解包 + 载入）。重复调用安全。 */
    fun prepare(ctx: Context) {
        val app = ctx.applicationContext
        appCtx = app
        if (prepared || preparing) {
            if (prepared) {
                emitState("ready", "离线英文语音已就绪")
                ensureChineseModel()
            }
            return
        }
        synchronized(modelLock) {
            if (prepared || preparing) return
            preparing = true
        }
        emitState("loading", "正在准备离线语音…")
        Thread({
            var ok = false
            try {
                LibVosk.setLogLevel(LogLevel.WARNINGS)
                val dir = unpackModel(app, ASSET_EN)
                val m = Model(dir.absolutePath)
                synchronized(modelLock) {
                    modelEn = m
                    prepared = true
                }
                ok = true
                emitState("ready", "离线英文语音已就绪")
            } catch (t: Throwable) {
                emitState("error", "离线语音准备失败：" + (t.message ?: t.javaClass.simpleName))
            } finally {
                preparing = false
            }
            if (ok) {
                // 启动时就顺手把中文模型也载入，别等用户开口时才在后台慢慢解包：
                // 否则 auto 模式第一句话只有英文识别器，中文会被小英文模型听成 “the quick luna”。
                ensureChineseModel()
                startPendingIfQueued()
            }
        }, "vosk-prepare").start()
    }

    private fun ensureChineseModel() {
        val app = appCtx ?: return
        if (zhTried || zhLoading) return
        if (!hasChineseModel(app)) {
            zhTried = true
            zhFailed = true
            emitState("zh-unavailable", "没有打包中文语音包")
            startPendingIfQueued()
            return
        }
        zhLoading = true
        zhTried = true
        Thread({
            var ok = false
            try {
                LibVosk.setLogLevel(LogLevel.WARNINGS)
                val dir = unpackModel(app, ASSET_ZH)
                val m = Model(dir.absolutePath)
                synchronized(modelLock) { modelZh = m }
                zhFailed = false
                ok = true
                emitState("ready-zh", "离线中文语音已就绪")
            } catch (t: Throwable) {
                zhFailed = true
                emitState("zh-unavailable", "中文语音包载入失败：" + (t.message ?: ""))
            } finally {
                zhLoading = false
            }
            // 中文模型刚好是在“已经开着英文识别器听”的时候载好的：
            // 如果用户还没开口，安静重启这一轮，把中文识别器无缝接上。
            if (ok) {
                val s = session
                if (running && mode != MODE_EN && s != null && s.zh == null && !voiceSeen) {
                    val barge = bargeInMode
                    quietStop = true
                    stopListeningInternal(true)
                    quietStop = false
                    startListening(barge)
                }
            }
            startPendingIfQueued()
        }, "vosk-prepare-zh").start()
    }

    /** 模型就绪后，把等待中的那一轮接上（由后台线程调用，只让一个调用者真正开工）。 */
    private fun startPendingIfQueued() {
        val go = synchronized(this) {
            val p = pendingStart
            if (p) pendingStart = false
            p
        }
        if (go) startListening(pendingStartBargeIn)
    }

    private fun unpackModel(ctx: Context, assetDir: String): File {
        val dest = File(ctx.filesDir, assetDir)
        val marker = File(dest, ".ready")
        if (marker.exists() && File(dest, "am").isDirectory) return dest
        if (dest.exists()) dest.deleteRecursively()
        dest.mkdirs()
        copyAssetTree(ctx, assetDir, dest)
        if (!File(dest, "am").isDirectory) throw IllegalStateException("模型目录不完整")
        try {
            marker.writeText("ok")
        } catch (ignore: Throwable) {
        }
        return dest
    }

    private fun copyAssetTree(ctx: Context, assetPath: String, dest: File) {
        val am = ctx.assets
        val children = am.list(assetPath) ?: emptyArray()
        if (children.isEmpty()) {
            dest.parentFile?.mkdirs()
            am.open(assetPath).use { input ->
                dest.outputStream().use { out -> input.copyTo(out, 128 * 1024) }
            }
            return
        }
        dest.mkdirs()
        for (c in children) copyAssetTree(ctx, "$assetPath/$c", File(dest, c))
    }

    // ==================================================================
    // TTS 状态
    // ==================================================================

    fun noteTtsStart(text: String) {
        ttsText = text
        ttsStartedAt = SystemClock.elapsedRealtime()
        ttsSpeaking = true
    }

    fun noteTtsEnd() {
        ttsSpeaking = false
        ttsEndedAt = SystemClock.elapsedRealtime()
        // 保留 ttsText 一小段时间：朗读刚停的那半秒里，麦克风里可能还有残响，
        // 用这段文字把“自己的声音”过滤掉；下一句开始时会被覆盖。
    }

    fun isTtsSpeakingNow(): Boolean = ttsSpeaking

    // ==================================================================
    // 开始 / 停止
    // ==================================================================

    /**
     * @param bargeIn true = 边说边听（AI 正在朗读时也能插话）；false = 只听用户这一轮。
     * @return true 表示已经开工或已经排队等待模型就绪
     */
    fun startListening(bargeIn: Boolean): Boolean {
        bargeInMode = bargeIn
        if (!isReady()) {
            pendingStart = true
            pendingStartBargeIn = bargeIn
            appCtx?.let { prepare(it) }
            return true
        }
        // 中文模型还没好时，不要默默只开英文识别器（那正是中文被听成英文的原因）。
        if (mode != MODE_EN && modelZh == null && !zhFailed) {
            if (!zhTried) ensureChineseModel()
            if (zhLoading) {
                pendingStart = true
                pendingStartBargeIn = bargeIn
                emitState("loading", "正在准备中文语音…")
                if (mode == MODE_AUTO) {
                    // 等一小会儿；中文包实在太慢就先让英文模型顶上，至少不会没反应
                    Thread({
                        val deadline = SystemClock.elapsedRealtime() + ZH_WAIT_MS
                        while (zhLoading && modelZh == null &&
                            SystemClock.elapsedRealtime() < deadline
                        ) {
                            try {
                                Thread.sleep(50)
                            } catch (e: InterruptedException) {
                                return@Thread
                            }
                        }
                        if (modelZh == null) startPendingIfQueued()
                    }, "vosk-zh-wait").start()
                }
                return true
            }
        }
        // “中文优先”下中文模型不可用：明确报错，绝不悄悄退回英文识别
        if (mode == MODE_ZH && modelZh == null) {
            emitState("error", "中文语音模型不可用，先打字或把识别方式切到中英自动")
            return false
        }
        val wantAec = bargeIn || VoiceCompanionService.isActive
        if (running) {
            if (loopAecSource == wantAec) return true
            // 声源需要从“普通录制”换成“通话/回声消除”——重启一次采集
            quietStop = true
            stopListeningInternal(true)
            quietStop = false
        }
        val s = synchronized(modelLock) {
            try {
                val mEn = modelEn
                val en = if (mEn != null && mode != MODE_ZH) {
                    Recognizer(mEn, SAMPLE_RATE.toFloat()).apply {
                        setWords(true)
                        setPartialWords(false)
                    }
                } else {
                    null
                }
                val mZh = modelZh
                val zh = if (mZh != null && (mode == MODE_ZH || mode == MODE_AUTO)) {
                    Recognizer(mZh, SAMPLE_RATE.toFloat()).apply {
                        setWords(true)
                        setPartialWords(false)
                    }
                } else {
                    null
                }
                Session(en, zh)
            } catch (t: Throwable) {
                emitState("error", "语音识别初始化失败：" + (t.message ?: ""))
                return false
            }
        }
        if (s.en == null && s.zh == null) {
            s.close()
            if (zhLoading) {
                // 中文模型还在载入，等它好了再自动开始
                pendingStart = true
                pendingStartBargeIn = bargeIn
                return true
            }
            emitState("error", "语音模型还没准备好")
            return false
        }
        session = s
        resetUtterance()
        interrupted = false
        loopAecSource = wantAec
        val myId = ++loopSeq
        running = true
        val t = Thread({ loopBody(wantAec, s, myId) }, "vosk-loop")
        thread = t
        t.start()
        return true
    }

    fun stopListening() {
        stopListeningInternal(false)
    }

    private fun stopListeningInternal(quiet: Boolean) {
        val wasRunning = running
        running = false
        val rec = record
        try {
            if (rec != null && rec.recordingState == AudioRecord.RECORDSTATE_RECORDING) rec.stop()
        } catch (t: Throwable) {
        }
        val t = thread
        if (t != null && t !== Thread.currentThread()) {
            try {
                t.join(800)
            } catch (ignore: InterruptedException) {
                Thread.currentThread().interrupt()
            }
        }
        if (thread === t) thread = null
        if (wasRunning && !quiet) emitState("stopped", "")
    }

    fun shutdown() {
        stopListeningInternal(true)
        synchronized(modelLock) {
            try {
                session?.close()
            } catch (t: Throwable) {
            }
            session = null
            try {
                modelEn?.close()
                modelZh?.close()
            } catch (t: Throwable) {
            }
            modelEn = null
            modelZh = null
            prepared = false
            zhTried = false
            zhLoading = false
            zhFailed = false
            pendingStart = false
        }
    }

    // ==================================================================
    // 识别循环
    // ==================================================================

    private fun loopBody(useAecSource: Boolean, s: Session, myId: Int) {
        var finalText = ""
        var finalLang = "en"
        try {
            val minBuf = AudioRecord.getMinBufferSize(
                SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT
            )
            val bufBytes = max(minBuf * 2, SAMPLE_RATE / 5 * 2) // ≈200ms
            val source = if (useAecSource) MediaRecorder.AudioSource.VOICE_COMMUNICATION
            else MediaRecorder.AudioSource.VOICE_RECOGNITION
            val format = AudioFormat.Builder()
                .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                .setSampleRate(SAMPLE_RATE)
                .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
                .build()
            val r = AudioRecord.Builder()
                .setAudioSource(source)
                .setAudioFormat(format)
                .setBufferSizeInBytes(max(bufBytes, 6400))
                .build()
            record = r
            if (r.state != AudioRecord.STATE_INITIALIZED) {
                throw IllegalStateException("麦克风被占用或无法打开")
            }
            if (useAecSource) {
                try {
                    if (AcousticEchoCanceler.isAvailable()) {
                        aec = AcousticEchoCanceler.create(r.audioSessionId)
                        aec?.enabled = true
                    }
                } catch (t: Throwable) {
                    aec = null
                }
            }
            r.startRecording()
            emitState("listening", if (bargeInMode) "边说边听" else "正在听你说")
            val chunk = ShortArray(320) // 20ms
            while (running && loopSeq == myId) {
                val n = r.read(chunk, 0, chunk.size)
                if (n <= 0) {
                    if (n < 0) break
                    continue
                }
                val done = processChunk(chunk, n, s)
                if (done != null) {
                    if (done.text.isNotEmpty()) {
                        finalText = done.text
                        finalLang = done.lang
                    }
                    break
                }
            }
        } catch (t: Throwable) {
            if (running) emitState("error", "麦克风出错：" + (t.message ?: ""))
        } finally {
            if (loopSeq == myId) running = false
            try {
                aec?.release()
            } catch (t: Throwable) {
            }
            aec = null
            try {
                val r = record
                if (r != null) {
                    if (r.recordingState == AudioRecord.RECORDSTATE_RECORDING) r.stop()
                    r.release()
                }
            } catch (t: Throwable) {
            }
            record = null
            try {
                s.close()
            } catch (t: Throwable) {
            }
            if (session === s) session = null
            if (finalText.isNotEmpty()) {
                emitFinal(finalText, finalLang)
            } else if (!quietStop) {
                emitState("stopped", "")
            }
        }
    }

    /** @return 非 null 表示这一句结束（null = 继续听） */
    private fun processChunk(buf: ShortArray, n: Int, s: Session): Cand? {
        val now = SystemClock.elapsedRealtime()
        val loud = rms(buf, n) > VOICE_RMS
        if (loud) {
            lastVoiceAt = now
            if (!voiceSeen) {
                voiceSeen = true
                utteranceStartAt = now
            }
        }

        var sawFinal = false
        var echoOnly = false

        val en = s.en
        if (en != null) {
            val finished = try {
                en.acceptWaveForm(buf, n)
            } catch (t: Throwable) {
                false
            }
            if (finished) {
                sawFinal = true
                val r = readResult(en, "en")
                if (r.text.isNotEmpty()) {
                    if (isEchoNow(r.text, now)) {
                        echoOnly = true
                    } else {
                        appendEn(r.text, r.conf)
                    }
                }
            }
        }

        val zh = s.zh
        if (zh != null) {
            val finished = try {
                zh.acceptWaveForm(buf, n)
            } catch (t: Throwable) {
                false
            }
            if (finished) {
                sawFinal = true
                val r = readResult(zh, "zh")
                if (r.text.isNotEmpty()) {
                    if (isEchoNow(r.text, now)) {
                        echoOnly = true
                    } else {
                        appendZh(r.text, r.conf)
                    }
                }
            }
        }

        if (echoOnly && accEn.isEmpty() && accZh.isEmpty()) {
            // 全是自己的回声：把识别器内部残留也清干净
            try {
                s.en?.getFinalResult()
                s.zh?.getFinalResult()
            } catch (t: Throwable) {
            }
        }

        if (sawFinal && (accEn.isNotEmpty() || accZh.isNotEmpty())) lastResultAt = now

        // 部分结果：显示实时字幕 + 判断是否打断
        if (now - lastPartialAt >= PARTIAL_EVERY_MS) {
            lastPartialAt = now
            val pEn = s.en?.let { partialOf(it) } ?: ""
            val pZh = s.zh?.let { partialOf(it) } ?: ""
            val show = if (pZh.count { isCjk(it) } >= 2) pZh else pEn
            if (show.isNotEmpty() && show != lastPartialText) {
                lastPartialText = show
                emitPartial(show, if (show == pZh) "zh" else "en")
            }
            if (bargeInMode && ttsSpeaking && !interrupted &&
                now - ttsStartedAt > BARGE_GUARD_MS && bargeInEvidence(pEn, pZh)
            ) {
                interrupted = true
                ttsSpeaking = false
                lastVoiceAt = now
                if (utteranceStartAt == 0L) utteranceStartAt = now
                val cut = ttsText
                try {
                    listener?.onBargeIn(cut)
                } catch (t: Throwable) {
                }
            }
        }

        // 一句话什么时候算说完：说完后安静了 GRACE_MS
        if (!ttsSpeaking && (accEn.isNotEmpty() || accZh.isNotEmpty())) {
            val quietSince = max(lastVoiceAt, lastResultAt)
            val silentFor = now - quietSince
            val tooLong = utteranceStartAt > 0 && now - utteranceStartAt > MAX_UTTERANCE_MS
            if (silentFor >= GRACE_MS || tooLong) {
                return flushUtterance(s)
            }
        }
        return null
    }

    private fun flushUtterance(s: Session): Cand {
        // 把解码器里还没吐出来的尾巴也收进来
        val now = SystemClock.elapsedRealtime()
        s.en?.let { r ->
            val tail = readFinal(r, "en")
            if (tail.text.isNotEmpty() && !isEchoNow(tail.text, now)) {
                appendEn(tail.text, tail.conf)
            }
        }
        s.zh?.let { r ->
            val tail = readFinal(r, "zh")
            if (tail.text.isNotEmpty() && !isEchoNow(tail.text, now)) {
                appendZh(tail.text, tail.conf)
            }
        }
        val cand = choose()
        resetUtterance()
        return cand
    }

    private fun choose(): Cand {
        val en = Cand(accEn.toString().trim(), avg(enConfSum, enConfN), "en")
        val zh = Cand(cleanZh(accZh.toString()), avg(zhConfSum, zhConfN), "zh")
        val enOk = en.text.isNotEmpty() && en.text.any { it.isLetter() }
        val zhOk = zh.text.isNotEmpty() && zh.text.any { isCjk(it) }
        if (!enOk && !zhOk) return Cand("", 1f, "en")
        // 中文优先：只要中文模型听见了字，就用中文结果（英文模型在 zh 模式下本来就不该开）
        if (mode == MODE_ZH) return if (zhOk) zh else Cand("", 1f, "zh")
        if (!zhOk) return en
        if (!enOk) return zh
        // 英文模式：有英文结果就用英文（中文识别器本来就不该开，这里再兜一层）
        if (mode == MODE_EN) return en
        val enWords = normalizeWords(en.text).size
        val zhChars = zh.text.count { isCjk(it) }

        // 明显的中文短句：英文小模型常凭空编出 the / a / oh / luna 这种词
        if (zhChars >= 2 && enWords <= 1) return zh
        // 明显是完整、流利的英文（4 个词以上且置信度够）：让英文干净地赢，不要被中文偏置压住
        if (enWords >= 4 && zhChars <= 2 && en.conf >= 0.60f) return en
        if (enWords >= 2 && zhChars <= 1) return en
        if (zhChars >= 3 && enWords <= 2) return zh

        // auto 模式：两个都像话。先处理最典型的“中文被英文抢走”：
        // vosk-model-small-en-us 对幻觉短词给的 conf 虚高（0.85+），
        // 所以中文有 3 个字以上、置信度不离谱时，优先中文。
        if (zhChars >= 2 && zh.conf >= 0.55f && enWords <= 3 &&
            zhChars >= 3 && zh.conf >= en.conf - 0.15f
        ) {
            Log.d(TAG, "choose -> zh (short-zh rule) en='${en.text}' conf=$en.conf words=$enWords zh='${zh.text}' conf=${zh.conf} chars=$zhChars")
            return zh
        }

        // 中英双语打分：给中文一个自然偏置（汉字信息密度高），
        // 英文按词数加分，词越多、conf 越高越可信。
        val enScore = en.conf * (0.50f + 0.08f * minOf(enWords, 5))
        val zhScore = zh.conf * (0.62f + 0.09f * minOf(zhChars, 5))
        val pick = if (zhScore > enScore) zh else en
        Log.d(
            TAG,
            "choose -> ${pick.lang} en='${en.text}' conf=$en.conf words=$enWords score=$enScore | " +
                "zh='${zh.text}' conf=${zh.conf} chars=$zhChars score=$zhScore | mode=$mode"
        )
        return pick
    }

    private fun appendEn(text: String, conf: Float) {
        if (accEn.isNotEmpty()) accEn.append(' ')
        accEn.append(text)
        enConfSum += conf
        enConfN++
    }

    private fun appendZh(text: String, conf: Float) {
        val t = cleanZh(text)
        if (t.isEmpty()) return
        accZh.append(t)
        zhConfSum += conf
        zhConfN++
    }

    private fun resetUtterance() {
        accEn.setLength(0)
        accZh.setLength(0)
        enConfSum = 0.0
        enConfN = 0
        zhConfSum = 0.0
        zhConfN = 0
        lastVoiceAt = 0L
        lastResultAt = 0L
        utteranceStartAt = 0L
        voiceSeen = false
        lastPartialText = ""
        interrupted = false
    }

    // ==================================================================
    // 小工具
    // ==================================================================

    private data class Cand(val text: String, val conf: Float, val lang: String)

    private fun rms(buf: ShortArray, n: Int): Double {
        if (n <= 0) return 0.0
        var sum = 0.0
        var i = 0
        while (i < n) {
            val v = buf[i].toDouble()
            sum += v * v
            i++
        }
        return sqrt(sum / n)
    }

    private fun readResult(r: Recognizer, lang: String): Cand = parseJson(
        try {
            r.result
        } catch (t: Throwable) {
            ""
        }, lang
    )

    private fun readFinal(r: Recognizer, lang: String): Cand = parseJson(
        try {
            r.finalResult
        } catch (t: Throwable) {
            ""
        }, lang
    )

    private fun partialOf(r: Recognizer): String = try {
        val o = JSONObject(r.partialResult)
        o.optString("partial", "").trim()
    } catch (t: Throwable) {
        ""
    }

    private fun parseJson(json: String, lang: String): Cand {
        if (json.isBlank()) return Cand("", 0f, lang)
        return try {
            val o = JSONObject(json)
            val text = o.optString("text", "").trim()
            var sum = 0.0
            var count = 0
            val arr = o.optJSONArray("result")
            if (arr != null) {
                for (i in 0 until arr.length()) {
                    val w = arr.optJSONObject(i) ?: continue
                    sum += w.optDouble("conf", 0.0)
                    count++
                }
            }
            val conf = if (count > 0) (sum / count).toFloat() else if (text.isNotEmpty()) 0.9f else 0f
            Cand(text, conf, lang)
        } catch (t: Throwable) {
            Cand("", 0f, lang)
        }
    }

    private fun avg(sum: Double, n: Int): Float = if (n > 0) (sum / n).toFloat() else 0.85f

    /** 中文结果清理：Vosk 会在汉字之间插空格，这里只去掉多余的空白，汉字、数字、标点照原样保留。 */
    private fun cleanZh(s: String): String = s
        .replace(Regex("(?<=[\\u3400-\\u9fff])\\s+(?=[\\u3400-\\u9fff])"), "")
        .replace(Regex("(?<=[\\u3400-\\u9fff])\\s+(?=[0-9０-９])"), "")
        .replace(Regex("(?<=[0-9０-９])\\s+(?=[\\u3400-\\u9fff])"), "")
        .replace(Regex("(?<=[0-9０-９])\\s+(?=[0-9０-９])"), "")
        .replace(Regex("\\s+(?=[，。！？、；：,.!?;:])"), "")
        .replace(Regex("\\s{2,}"), " ")
        .trim()

    private fun isCjk(c: Char): Boolean {
        val code = c.code
        return (code in 0x4E00..0x9FFF) || (code in 0x3400..0x4DBF) ||
            (code in 0xF900..0xFAFF) || (code in 0x3000..0x303F)
    }

    private fun normalizeWords(s: String): List<String> =
        s.lowercase(Locale.US).replace(Regex("[^a-z0-9']+"), " ").trim()
            .split(' ').filter { it.isNotEmpty() }

    private fun looksLikeEcho(text: String, tts: String): Boolean {
        if (tts.isBlank() || text.isBlank()) return false
        val cjkText = text.filter { isCjk(it) }
        if (cjkText.length >= 2) {
            val ttsCjk = tts.filter { isCjk(it) }
            if (ttsCjk.length >= 2) {
                val probe = if (cjkText.length >= 4) cjkText.take(4) else cjkText.take(2)
                if (ttsCjk.contains(probe)) return true
            }
        }
        val w = normalizeWords(text)
        if (w.size < 2) return false
        val t = normalizeWords(tts)
        if (t.size < 2) return false
        var i = 0
        while (i <= w.size - 2) {
            var j = 0
            while (j <= t.size - 2) {
                if (t[j] == w[i] && t[j + 1] == w[i + 1]) return true
                j++
            }
            i++
        }
        return false
    }

    /** 现在这一刻听到的内容，会不会只是自己刚朗读出来的声音 */
    private fun isEchoNow(text: String, now: Long): Boolean {
        if (ttsText.isEmpty()) return false
        if (!ttsSpeaking && now - ttsEndedAt > ECHO_TAIL_MS) return false
        return looksLikeEcho(text, ttsText)
    }

    private fun bargeInEvidence(enPartial: String, zhPartial: String): Boolean {
        if (enPartial.isNotEmpty() && !looksLikeEcho(enPartial, ttsText)) {
            val w = normalizeWords(enPartial)
            if (w.size >= 2) return true
            if (enPartial.trim().length >= 6 && w.isNotEmpty()) return true
        }
        if (zhPartial.isNotEmpty() && !looksLikeEcho(zhPartial, ttsText)) {
            if (zhPartial.count { isCjk(it) } >= 2) return true
        }
        return false
    }

    private fun emitState(state: String, msg: String) {
        try {
            listener?.onVoskState(state, msg)
        } catch (t: Throwable) {
        }
    }

    private fun emitPartial(text: String, lang: String) {
        try {
            listener?.onSpeechPartial(text, lang)
        } catch (t: Throwable) {
        }
    }

    private fun emitFinal(text: String, lang: String) {
        try {
            listener?.onSpeechFinal(text, lang)
        } catch (t: Throwable) {
        }
    }
}
