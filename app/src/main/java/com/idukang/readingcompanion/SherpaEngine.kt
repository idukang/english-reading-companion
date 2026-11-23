package com.idukang.readingcompanion

import android.content.Context
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.os.SystemClock
import android.util.Log
import com.k2fsa.sherpa.onnx.FeatureConfig
import com.k2fsa.sherpa.onnx.OfflineModelConfig
import com.k2fsa.sherpa.onnx.OfflineRecognizer
import com.k2fsa.sherpa.onnx.OfflineRecognizerConfig
import com.k2fsa.sherpa.onnx.OfflineSenseVoiceModelConfig
import com.k2fsa.sherpa.onnx.SileroVadModelConfig
import com.k2fsa.sherpa.onnx.Vad
import com.k2fsa.sherpa.onnx.VadModelConfig
import java.io.File
import java.util.Locale
import kotlin.math.max
import kotlin.math.sqrt

/**
 * 离线语音识别（Sherpa-ONNX SenseVoiceSmall + Silero VAD v4）。
 *
 * 设计要点：
 *  · 一个模型同时听懂中文、英文和中英混说，不需要两套识别器来回挑结果；
 *  · Silero VAD 判断「一句话」的起止，说完 0.55 秒自动出整句，识别更准；
 *  · 用 AudioRecord 自己读 16kHz PCM，耳机连麦时走 VOICE_COMMUNICATION + 系统回声消除；
 *  · 神经 VAD 每 32ms 判一次有没有人说话，AI 朗读时连续 5 个窗口（约 160ms）
 *    都听到人声就立刻打断 —— 真实可用的 ~150ms 插话；
 *  · 模型文件打包在 assets 里，首次启动解包到 filesDir，之后直接用，全程不联网。
 */
object SherpaEngine {

    const val MODE_AUTO = "auto"
    const val MODE_EN = "en"
    const val MODE_ZH = "zh"

    interface Listener {
        /** state: loading | ready | listening | speech | stopped | error */
        fun onAsrState(state: String, msg: String)
        fun onSpeechFinal(text: String, lang: String)
        /** 用户打断 AI 朗读：ttsText 是被打断的那句 */
        fun onBargeIn(ttsText: String)
    }

    private const val TAG = "SherpaEngine"
    private const val SAMPLE_RATE = 16000
    private const val WINDOW = 512                 // 32ms @16k，Silero VAD 的窗口
    private const val ASSET_DIR = "sense-voice"
    private const val ASSET_MODEL = "sense-voice/model.int8.onnx"
    private const val ASSET_TOKENS = "sense-voice/tokens.txt"
    private const val ASSET_VAD = "silero_vad_v4.onnx"

    private const val BARGE_GUARD_MS = 250L        // AI 刚开始说话时留一点启动余量
    private const val BARGE_WINDOWS = 5            // 连续 5 × 32ms ≈ 160ms 人声才打断
    private const val ECHO_TAIL_MS = 600L          // 朗读结束后残留回声的容忍时间
    private const val MIN_SEGMENT_SAMPLES = 0.22 * SAMPLE_RATE   // 太短的片段不送去识别
    private const val MAX_SEGMENT_SAMPLES = 22 * SAMPLE_RATE     // 兜底：超过 22 秒强行收尾
    private const val ABS_RMS_FLOOR = 0.010f       // 大约相当于 16bit 的 330

    @Volatile var listener: Listener? = null

    // ---------- 模型 ----------
    private val modelLock = Any()
    @Volatile private var recognizer: OfflineRecognizer? = null
    @Volatile private var recognizerLang: String? = null
    @Volatile private var vad: Vad? = null
    @Volatile private var prepared = false
    @Volatile private var preparing = false
    @Volatile private var mode = MODE_AUTO
    @Volatile private var pendingStart = false
    @Volatile private var pendingStartBargeIn = false

    // ---------- 识别循环 ----------
    private var thread: Thread? = null
    private var record: AudioRecord? = null
    private var aec: AcousticEchoCanceler? = null
    private val decodeLock = Any()

    @Volatile private var loopSeq = 0
    @Volatile private var running = false
    @Volatile private var loopAecSource = false
    @Volatile private var bargeInMode = false
    @Volatile private var quietStop = false
    @Volatile private var appCtx: Context? = null

    // ---------- TTS 状态（由 MainActivity 更新，用于打断与回声过滤） ----------
    @Volatile private var ttsSpeaking = false
    @Volatile private var ttsText = ""
    @Volatile private var ttsStartedAt = 0L
    @Volatile private var ttsEndedAt = 0L
    @Volatile private var bargedIn = false

    // ==================================================================
    // 资产与模型
    // ==================================================================

    fun attach(ctx: Context) {
        appCtx = ctx.applicationContext
    }

    /** 安装包里有没有打包好的 SenseVoice 模型（判断能否用离线识别）。 */
    fun hasModel(ctx: Context): Boolean {
        val app = ctx.applicationContext
        return try {
            val list = app.assets.list(ASSET_DIR)
            !list.isNullOrEmpty() && assetExists(app, ASSET_VAD)
        } catch (t: Throwable) {
            false
        }
    }

    private fun assetExists(ctx: Context, path: String): Boolean = try {
        ctx.assets.open(path).use { true }
    } catch (t: Throwable) {
        false
    }

    fun isReady(): Boolean = prepared && recognizer != null

    fun setLanguageMode(m: String) {
        val next = when (m) {
            MODE_EN, "english", "en-US" -> MODE_EN
            MODE_ZH, "chinese", "zh-CN" -> MODE_ZH
            else -> MODE_AUTO
        }
        val changed = next != mode
        mode = next
        if (!changed) return
        // 识别语言变了：正在听的话，静默重开一轮，用新的语言设置重建识别器。
        if (running) {
            quietStop = true
            stopListeningInternal(true)
            quietStop = false
            startListening(bargeInMode)
        }
    }

    fun setCallback(l: Listener?) {
        listener = l
    }

    /** 应用启动时调用：提前把模型解包、载入，进对话页就能直接说。 */
    fun warmup(ctx: Context) {
        prepare(ctx)
    }

    fun prepare(ctx: Context) {
        val app = ctx.applicationContext
        appCtx = app
        if (prepared) {
            emitState("ready", "中英混说语音已就绪")
            startPendingIfQueued()
            return
        }
        synchronized(modelLock) {
            if (prepared || preparing) return
            preparing = true
        }
        emitState("loading", "正在准备中英混说语音…")
        Thread({
            try {
                val dir = File(app.filesDir, ASSET_DIR)
                val modelPath = File(dir, "model.int8.onnx")
                val tokensPath = File(dir, "tokens.txt")
                unpackIfNeeded(app, ASSET_MODEL, modelPath)
                unpackIfNeeded(app, ASSET_TOKENS, tokensPath)
                val vadFile = File(app.filesDir, "silero_vad_v4.onnx")
                unpackIfNeeded(app, ASSET_VAD, vadFile)

                val v = buildVad(vadFile.absolutePath)
                synchronized(modelLock) {
                    vad = v
                    ensureRecognizerLocked(mode)
                    prepared = true
                }
                emitState("ready", "中英混说语音已就绪")
                Log.i(TAG, "SenseVoice + Silero VAD ready")
            } catch (t: Throwable) {
                Log.e(TAG, "prepare failed", t)
                emitState("error", "离线语音准备失败：" + (t.message ?: t.javaClass.simpleName))
            } finally {
                preparing = false
            }
            startPendingIfQueued()
        }, "sherpa-prepare").start()
    }

    private fun buildVad(modelPath: String): Vad {
        val cfg = VadModelConfig(
            sileroVadModelConfig = SileroVadModelConfig(
                model = modelPath,
                threshold = 0.50f,
                minSilenceDuration = 0.55f,
                minSpeechDuration = 0.18f,
                windowSize = WINDOW,
                maxSpeechDuration = 20.0f
            ),
            sampleRate = SAMPLE_RATE,
            numThreads = 1,
            provider = "cpu",
            debug = false
        )
        return Vad(config = cfg)
    }

    /** 按语言模式创建识别器；同一时间只保留一个，避免 227MB 的模型被重复载入内存。 */
    private fun ensureRecognizerLocked(forMode: String) {
        val lang = when (forMode) {
            MODE_EN -> "en"
            MODE_ZH -> "zh"
            else -> "auto"
        }
        if (recognizer != null && recognizerLang == lang) return
        val app = appCtx ?: return
        val dir = File(app.filesDir, ASSET_DIR)
        val model = File(dir, "model.int8.onnx")
        val tokens = File(dir, "tokens.txt")
        if (!model.isFile || !tokens.isFile) throw IllegalStateException("语音模型文件缺失")

        val threads = minOf(4, Runtime.getRuntime().availableProcessors()).coerceAtLeast(1)
        val cfg = OfflineRecognizerConfig(
            featConfig = FeatureConfig(sampleRate = SAMPLE_RATE, featureDim = 80),
            modelConfig = OfflineModelConfig(
                senseVoice = OfflineSenseVoiceModelConfig(
                    model = model.absolutePath,
                    language = lang,
                    useInverseTextNormalization = true
                ),
                tokens = tokens.absolutePath,
                numThreads = threads,
                debug = false,
                provider = "cpu"
            )
        )
        // assetManager 传 null：模型在 filesDir 里，走 newFromFile，才不会把绝对路径当 assets 打开。
        val newRec = OfflineRecognizer(config = cfg)
        val old = recognizer
        recognizer = newRec
        recognizerLang = lang
        try {
            old?.release()
        } catch (t: Throwable) {
        }
    }

    private fun unpackIfNeeded(ctx: Context, assetPath: String, dest: File) {
        if (dest.isFile && dest.length() > 1024) return
        dest.parentFile?.mkdirs()
        val tmp = File(dest.parentFile, dest.name + ".part")
        try {
            ctx.assets.open(assetPath).use { input ->
                tmp.outputStream().use { out ->
                    val buf = ByteArray(1 shl 20)
                    while (true) {
                        val n = input.read(buf)
                        if (n <= 0) break
                        out.write(buf, 0, n)
                    }
                }
            }
            if (dest.exists()) dest.delete()
            if (!tmp.renameTo(dest)) {
                tmp.copyTo(dest, overwrite = true)
                tmp.delete()
            }
        } catch (t: Throwable) {
            try {
                tmp.delete()
            } catch (ignore: Throwable) {
            }
            throw t
        }
    }

    private fun startPendingIfQueued() {
        val go = synchronized(this) {
            val p = pendingStart
            if (p) pendingStart = false
            p
        }
        if (go) startListening(pendingStartBargeIn)
    }

    // ==================================================================
    // TTS 状态
    // ==================================================================

    fun noteTtsStart(text: String) {
        ttsText = text
        ttsStartedAt = SystemClock.elapsedRealtime()
        ttsSpeaking = true
        bargedIn = false
    }

    fun noteTtsEnd() {
        ttsSpeaking = false
        ttsEndedAt = SystemClock.elapsedRealtime()
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
        val wantAec = bargeIn || VoiceCompanionService.isActive
        if (running) {
            if (loopAecSource == wantAec) return true
            // 声源需要从“普通录制”换成“通话/回声消除”——重启一次采集
            quietStop = true
            stopListeningInternal(true)
            quietStop = false
        }
        bargedIn = false
        loopAecSource = wantAec
        val myId = ++loopSeq
        running = true
        val t = Thread({ loopBody(wantAec, myId) }, "sherpa-loop")
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
        loopSeq++   // 让旧循环在下一轮检查时自己退出
        val rec = record
        try {
            if (rec != null && rec.recordingState == AudioRecord.RECORDSTATE_RECORDING) rec.stop()
        } catch (t: Throwable) {
        }
        val t = thread
        if (t != null && t !== Thread.currentThread()) {
            try {
                t.join(1200)
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
                vad?.release()
            } catch (t: Throwable) {
            }
            vad = null
            try {
                recognizer?.release()
            } catch (t: Throwable) {
            }
            recognizer = null
            recognizerLang = null
            prepared = false
            pendingStart = false
        }
    }

    // ==================================================================
    // 识别循环
    // ==================================================================

    private fun loopBody(useAecSource: Boolean, myId: Int) {
        val v = synchronized(modelLock) {
            try {
                ensureRecognizerLocked(mode)
                vad
            } catch (t: Throwable) {
                if (running) emitState("error", "语音识别初始化失败：" + (t.message ?: ""))
                null
            }
        }
        if (v == null) {
            running = false
            return
        }
        var finalText = ""
        var finalLang = "auto"
        try {
            // 上一轮留下的半句不要带进来
            try {
                v.clear()
                v.reset()
            } catch (t: Throwable) {
            }

            val minBuf = AudioRecord.getMinBufferSize(
                SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT
            )
            val bufBytes = max(minBuf * 2, WINDOW * 2 * 8)
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
                .setBufferSizeInBytes(max(bufBytes, 8192))
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

            val shorts = ShortArray(WINDOW)
            val floats = FloatArray(WINDOW)
            var speechWindows = 0
            var echoFloor = 0.0f
            var voiceAnnounced = false

            while (running && loopSeq == myId) {
                val n = r.read(shorts, 0, shorts.size)
                if (n <= 0) {
                    if (n < 0) break
                    continue
                }
                for (i in 0 until n) floats[i] = shorts[i] / 32768.0f
                val rms = rms(floats, n)

                v.acceptWaveform(if (n == WINDOW) floats else floats.copyOf(n))

                // ---------- 神经 VAD 打断 ----------
                val speakingNow = ttsSpeaking
                if (speakingNow) {
                    val detected = try {
                        v.isSpeechDetected()
                    } catch (t: Throwable) {
                        false
                    }
                    val aboveFloor = rms > max(ABS_RMS_FLOOR, echoFloor * 1.8f)
                    if (detected && aboveFloor) {
                        speechWindows++
                    } else {
                        speechWindows = 0
                        if (!detected) {
                            // 只在“没人说话”的窗口更新回声底噪，慢慢跟随机型音量
                            echoFloor = if (echoFloor <= 0f) rms else echoFloor * 0.9f + rms * 0.1f
                        }
                    }
                    if (!bargedIn && speechWindows >= BARGE_WINDOWS &&
                        SystemClock.elapsedRealtime() - ttsStartedAt >= BARGE_GUARD_MS
                    ) {
                        bargedIn = true
                        ttsSpeaking = false
                        val cut = ttsText
                        Log.i(TAG, "barge-in after ${speechWindows} windows, rms=$rms floor=$echoFloor")
                        try {
                            listener?.onBargeIn(cut)
                        } catch (t: Throwable) {
                        }
                    }
                } else {
                    speechWindows = 0
                }

                // ---------- 用户开口提示（给界面一个“在听你说”） ----------
                if (!voiceAnnounced) {
                    val detected = try {
                        v.isSpeechDetected()
                    } catch (t: Throwable) {
                        false
                    }
                    if (detected) {
                        voiceAnnounced = true
                        emitState("speech", "")
                    }
                }

                // ---------- 一句话说完：整段送去识别 ----------
                while (!v.empty()) {
                    val seg = v.front()
                    v.pop()
                    val samples = seg.samples
                    if (samples.size < MIN_SEGMENT_SAMPLES) continue
                    val clipped = if (samples.size > MAX_SEGMENT_SAMPLES) {
                        samples.copyOfRange(0, MAX_SEGMENT_SAMPLES)
                    } else {
                        samples
                    }
                    // AI 正在朗读、又没被打断：这段几乎肯定是自己的回声，不必花 CPU 识别
                    if (ttsSpeaking && !bargedIn) continue
                    val segRms = rms(clipped, clipped.size)
                    if (segRms < ABS_RMS_FLOOR) continue

                    val res = decode(clipped) ?: continue
                    val text = res.first
                    if (text.isEmpty()) continue
                    val now = SystemClock.elapsedRealtime()
                    if (!bargedIn && looksLikeEcho(text, ttsText) &&
                        (ttsSpeaking || now - ttsEndedAt < ECHO_TAIL_MS)
                    ) {
                        Log.d(TAG, "drop echo: $text")
                        continue
                    }
                    finalText = text
                    finalLang = res.second
                    break
                }
                if (finalText.isNotEmpty()) break
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
            if (finalText.isNotEmpty()) {
                emitFinal(finalText, finalLang)
            } else if (!quietStop && loopSeq == myId) {
                emitState("stopped", "")
            }
        }
    }

    /** @return 清理后的文字 + 识别出的语言（zh / en / …） */
    private fun decode(samples: FloatArray): Pair<String, String>? {
        synchronized(decodeLock) {
            val rec = recognizer ?: return null
            val stream = try {
                rec.createStream()
            } catch (t: Throwable) {
                return null
            }
            return try {
                stream.acceptWaveform(samples, SAMPLE_RATE)
                rec.decode(stream)
                val result = rec.getResult(stream)
                val text = cleanText(result.text)
                val rawLang = result.lang.replace("<|", "").replace("|>", "").trim()
                val lang = when {
                    rawLang.startsWith("zh") || rawLang == "yue" -> "zh"
                    rawLang.startsWith("en") -> "en"
                    rawLang.isNotEmpty() -> rawLang
                    text.any { isCjk(it) } -> "zh"
                    else -> "en"
                }
                text to lang
            } catch (t: Throwable) {
                Log.w(TAG, "decode failed: " + t.message)
                null
            } finally {
                try {
                    stream.release()
                } catch (t: Throwable) {
                }
            }
        }
    }

    // ==================================================================
    // 小工具
    // ==================================================================

    /** 去掉 SenseVoice 的 <|zh|><|NEUTRAL|><|Speech|> 这类元数据标签和 [MUSIC] 之类的事件。 */
    private fun cleanText(raw: String): String {
        var s = raw.replace(Regex("<\\|[^|]*\\|>"), " ")
        s = s.replace(Regex("\\[[^\\]]{0,24}\\]"), " ")
        s = s.replace(Regex("\\s+"), " ").trim()
        // 只剩标点/符号的片段丢掉
        if (s.none { it.isLetterOrDigit() || isCjk(it) }) return ""
        // 单个字母（多是噪声误识别）丢掉
        if (s.length == 1 && s[0].isLetter() && s[0].code < 0x3000) return ""
        return s
    }

    private fun rms(buf: FloatArray, n: Int): Float {
        if (n <= 0) return 0f
        var sum = 0.0
        var i = 0
        while (i < n) {
            val v = buf[i].toDouble()
            sum += v * v
            i++
        }
        return sqrt(sum / n).toFloat()
    }

    private fun isCjk(c: Char): Boolean {
        val code = c.code
        return (code in 0x4E00..0x9FFF) || (code in 0x3400..0x4DBF) ||
            (code in 0xF900..0xFAFF) || (code in 0x3000..0x303F)
    }

    private fun normalizeWords(s: String): List<String> =
        s.lowercase(Locale.US).replace(Regex("[^a-z0-9']+"), " ").trim()
            .split(' ').filter { it.isNotEmpty() }

    /** 刚识别出的文字，会不会只是自己朗读的声音。 */
    private fun looksLikeEcho(text: String, spoken: String): Boolean {
        if (spoken.isBlank() || text.isBlank()) return false
        val cjkText = text.filter { isCjk(it) }
        if (cjkText.length >= 2) {
            val spokenCjk = spoken.filter { isCjk(it) }
            if (spokenCjk.length >= 2) {
                val probe = if (cjkText.length >= 4) cjkText.take(4) else cjkText.take(2)
                if (spokenCjk.contains(probe)) return true
            }
        }
        val w = normalizeWords(text)
        if (w.size < 2) return false
        val spokenWords = normalizeWords(spoken)
        if (spokenWords.size < 2) return false
        for (i in 0..w.size - 2) {
            for (j in 0..spokenWords.size - 2) {
                if (spokenWords[j] == w[i] && spokenWords[j + 1] == w[i + 1]) return true
            }
        }
        return false
    }

    private fun emitState(state: String, msg: String) {
        try {
            listener?.onAsrState(state, msg)
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
