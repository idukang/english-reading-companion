package com.idukang.readingcompanion

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaPlayer
import android.media.MediaRecorder
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.view.View
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import java.io.File
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap

/**
 * 英语陪读 —— 单 Activity + WebView 外壳。
 *
 * 全部界面、书库、词库、对话内容都打包在 app/src/main/assets/www 里，完全离线；
 * Kotlin 这层负责本机能力：
 *   1. 朗读：英文用内置的 Supertonic 离线神经音色（自然），中文用系统 TTS，
 *      中英混排自动分段、无缝衔接；神经音色加载中或出错时自动回退系统英文语音
 *   2. 麦克风录音与回放（跟读对比）
 *   3. 离线语音识别（SenseVoice + Silero VAD，中英混说；可后台、可边说边听、可打断）
 *   4. 耳机后台连麦的前台服务（VoiceCompanionService）
 *   5. 状态栏配色
 * 不联网、不上报、无统计 SDK。
 */
class MainActivity : Activity(), TextToSpeech.OnInitListener, SherpaEngine.Listener {

    companion object {
        private const val REQ_AUDIO = 1001
        private const val REQ_VOICE_INTENT = 1002
        private const val REQ_NOTIF = 1003

        @Volatile
        var instance: MainActivity? = null
            private set
    }

    private lateinit var webView: WebView
    private val main = Handler(Looper.getMainLooper())

    // ---------- TTS ----------
    private var tts: TextToSpeech? = null
    private var ttsReady = false
    private var ttsLang = "en-US"
    private var ttsRate = 1.0f

    // 英文音色：neural = 内置离线神经音色（默认），system = 系统语音
    private var voiceMode = "neural"
    private lateinit var prefs: android.content.SharedPreferences
    private var audioFocusReq: AudioFocusRequest? = null
    private var audioMgr: AudioManager? = null
    private var focusHeld = false

    private data class TtsSegment(val text: String, val zh: Boolean)

    private var ttsSegments: List<TtsSegment> = emptyList()
    private var ttsSegIndex = 0
    private var ttsJobId: String? = null
    private var ttsStartSent = false
    private var ttsCurrentZh = false
    private var ttsJobText = ""
    private var zhVoiceAvailable = true
    private var zhVoiceWarned = false

    // ---------- 录音 ----------
    private var recorder: MediaRecorder? = null
    private var recordFile: File? = null
    private var recording = false
    private var recordStartAt = 0L
    private var player: MediaPlayer? = null

    // ---------- 系统语音识别（内置离线模型不可用时的兜底） ----------
    private var recognizer: SpeechRecognizer? = null
    private var listening = false
    private var pendingListenStart: Runnable? = null
    private var voiceDialogTried = false
    private var voiceDialogPending = false
    private var stopping = false

    private var pendingRecordAfterPermission = false
    private var pendingSpeechAfterPermission = false
    private var pendingAsrAfterPermission = false
    private var pendingAsrBargeIn = false
    private var pendingServiceLang: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        instance = this

        val root = FrameLayout(this)
        webView = WebView(this)
        root.addView(webView, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        setContentView(root)

        webView.setBackgroundColor(0xFFF6F1E7.toInt())
        if (BuildConfig.DEBUG) {
            WebView.setWebContentsDebuggingEnabled(false)
        }

        with(webView.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = true
            allowContentAccess = false
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            javaScriptCanOpenWindowsAutomatically = false
            mediaPlaybackRequiresUserGesture = false
            cacheMode = WebSettings.LOAD_DEFAULT
            textZoom = 100
        }

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val url = request?.url?.toString() ?: return true
                return !(url.startsWith("file:///android_asset/") || url.startsWith("about:"))
            }

            @Deprecated("Deprecated in Java")
            override fun shouldOverrideUrlLoading(view: WebView?, url: String?): Boolean {
                val u = url ?: return true
                return !(u.startsWith("file:///android_asset/") || u.startsWith("about:"))
            }
        }

        webView.addJavascriptInterface(Bridge(), "AndroidBridge")
        webView.loadUrl("file:///android_asset/www/index.html")

        // 离线语音：先挂上监听，并在启动时就把中英两套模型一起热起来。
        // 之前只在进对话页时才载入，用户第一句话常常只有英文识别器在工作，中文会被听成英文。
        SherpaEngine.attach(this)
        SherpaEngine.setCallback(this)
        SherpaEngine.warmup(applicationContext)

        try {
            tts = TextToSpeech(this, this)
        } catch (e: Exception) {
            emit("window.Native && window.Native.onTtsUnavailable && window.Native.onTtsUnavailable()")
        }

        // 离线神经音色：默认开启，启动后台加载模型（不阻塞界面）；加载失败就继续用系统语音
        prefs = getSharedPreferences("erc_native", MODE_PRIVATE)
        voiceMode = if (prefs.getString("voice_engine", "neural") == "system") "system" else "neural"
        NeuralTtsEngine.observe { st ->
            main.post {
                emit(
                    "window.Native && window.Native.onVoiceEngine && window.Native.onVoiceEngine(" +
                        jsStr(NeuralTtsEngine.statusName()) + ")"
                )
            }
        }
        if (voiceMode == "neural" && !isLowRamDevice()) NeuralTtsEngine.prepare(applicationContext)
    }

    /** 1GB 级低内存机型：不预先加载神经音色，等真正要英文朗读时再加载，避免开机就把内存吃满。 */
    private fun isLowRamDevice(): Boolean {
        return try {
            val am = getSystemService(ACTIVITY_SERVICE) as android.app.ActivityManager
            am.isLowRamDevice || am.memoryClass <= 192
        } catch (e: Exception) {
            false
        }
    }

    // ================================================================
    // TTS（中英混排分段）
    // ================================================================

    override fun onInit(status: Int) {
        if (status != TextToSpeech.SUCCESS) {
            ttsReady = false
            emit("window.Native && window.Native.onTtsUnavailable && window.Native.onTtsUnavailable()")
            return
        }
        val engine = tts ?: return
        try {
            val r = engine.isLanguageAvailable(Locale.SIMPLIFIED_CHINESE)
            zhVoiceAvailable = r == TextToSpeech.LANG_AVAILABLE ||
                r == TextToSpeech.LANG_COUNTRY_AVAILABLE ||
                r == TextToSpeech.LANG_COUNTRY_VAR_AVAILABLE
        } catch (e: Exception) {
            zhVoiceAvailable = false
        }
        applyTtsParams()
        try {
            engine.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                override fun onStart(utteranceId: String?) {
                    val id = utteranceId ?: return
                    main.post {
                        val job = ttsJobId ?: return@post
                        if (!id.startsWith("$job#")) return@post
                        SherpaEngine.noteTtsStart(currentSegmentText())
                        if (!ttsStartSent) {
                            ttsStartSent = true
                            emit("window.Native && window.Native.onSpeakStart && window.Native.onSpeakStart(${jsStr(job)})")
                        }
                    }
                }

                override fun onDone(utteranceId: String?) {
                    val id = utteranceId ?: return
                    main.post {
                        val job = ttsJobId ?: return@post
                        if (!id.startsWith("$job#")) return@post
                        val idx = id.substringAfterLast('#').toIntOrNull() ?: return@post
                        if (idx != ttsSegIndex) return@post
                        ttsSegIndex++
                        speakNextSegment()
                    }
                }

                override fun onStop(utteranceId: String?, interrupted: Boolean) {
                    // 主动 stop 时 ttsJobId 已经被清空；这里只兜底清理状态
                    main.post { if (ttsJobId == null) SherpaEngine.noteTtsEnd() }
                }

                override fun onError(utteranceId: String?) {
                    val id = utteranceId ?: return
                    main.post {
                        val job = ttsJobId ?: return@post
                        if (!id.startsWith("$job#")) return@post
                        // 中文段落遇到引擎不支持：跳过这一段，别让整句都不出声
                        if (ttsCurrentZh) {
                            zhVoiceAvailable = false
                            warnNoChineseVoice()
                            ttsSegIndex++
                            speakNextSegment()
                            return@post
                        }
                        val idx = id.substringAfterLast('#').toIntOrNull() ?: return@post
                        if (idx != ttsSegIndex) return@post
                        finishTtsJob(error = true)
                    }
                }
            })
        } catch (e: Exception) {
            // 某些机型自带的语音引擎实现不完整，忽略即可，朗读失败会走 onSpeakError
        }
        ttsReady = true
        emit("window.Native && window.Native.onTtsReady && window.Native.onTtsReady()")
    }

    private fun applyTtsParams() {
        val engine = tts ?: return
        try {
            val locale = Locale.forLanguageTag(ttsLang)
            val res = engine.setLanguage(locale)
            if (res == TextToSpeech.LANG_MISSING_DATA || res == TextToSpeech.LANG_NOT_SUPPORTED) {
                engine.setLanguage(Locale.US)
            }
            engine.setSpeechRate(ttsRate.coerceIn(0.3f, 2.5f))
            engine.setPitch(1.0f)
        } catch (e: Exception) {
        }
    }

    private fun isChineseChar(c: Char): Boolean {
        val code = c.code
        return (code in 0x4E00..0x9FFF) || (code in 0x3400..0x4DBF) ||
            (code in 0xF900..0xFAFF) || (code in 0x3000..0x303F) ||
            (code in 0xFF00..0xFFEF) ||
            c == '，' || c == '。' || c == '、' || c == '；' || c == '：' || c == '？' ||
            c == '！' || c == '“' || c == '”' || c == '‘' || c == '’' || c == '…' ||
            c == '—' || c == '《' || c == '》' || c == '（' || c == '）' || c == '「' ||
            c == '」' || c == '·'
    }

    /** 把一段文本切成「中文段 / 英文段」，各自用对应的语音读。 */
    private fun splitBilingual(text: String): List<TtsSegment> {
        val out = ArrayList<TtsSegment>()
        val sb = StringBuilder()
        var curZh = false
        var started = false
        for (c in text) {
            val zh = isChineseChar(c)
            if (!started) {
                curZh = zh
                started = true
            } else if (zh != curZh) {
                val t = sb.toString().trim()
                if (t.isNotEmpty() && t.any { it.isLetterOrDigit() || isChineseChar(it) }) {
                    out.add(TtsSegment(t, curZh))
                }
                sb.setLength(0)
                curZh = zh
            }
            sb.append(c)
        }
        val last = sb.toString().trim()
        if (last.isNotEmpty() && last.any { it.isLetterOrDigit() || isChineseChar(it) }) {
            out.add(TtsSegment(last, curZh))
        }
        if (out.isEmpty()) {
            val t = text.trim()
            if (t.isNotEmpty()) out.add(TtsSegment(t, false))
        }
        return out
    }

    private fun currentSegmentText(): String {
        val i = ttsSegIndex
        return if (i in ttsSegments.indices) ttsSegments[i].text else ""
    }

    private fun speakNextSegment() {
        val job = ttsJobId ?: return
        while (ttsSegIndex < ttsSegments.size) {
            val idx = ttsSegIndex
            val seg = ttsSegments[idx]
            if (seg.text.isBlank()) {
                ttsSegIndex = idx + 1
                continue
            }
            ttsCurrentZh = seg.zh
            if (seg.zh && !zhVoiceAvailable) {
                warnNoChineseVoice()
                ttsSegIndex = idx + 1
                continue
            }
            // 英文片段优先走内置神经音色；模型还没热好/加载失败时自然落到系统语音
            if (!seg.zh && voiceMode == "neural" && NeuralTtsEngine.isReady()) {
                speakNeuralSegment(job, idx, seg.text)
                return
            }
            if (speakSystemSegment(job, idx, seg)) return
            // 这句系统语音也发不出去：中文跳过，英文按失败收尾（与 v1.3.0 一致）
            if (!seg.zh) {
                finishTtsJob(error = true)
                return
            }
            ttsSegIndex = idx + 1
        }
        finishTtsJob(error = false)
    }

    /** 把某一段交给系统 TTS；返回 false 表示这段发不出去（需要调用方决定跳过还是收尾） */
    private fun speakSystemSegment(job: String, idx: Int, seg: TtsSegment): Boolean {
        val engine = tts ?: return false
        ttsCurrentZh = seg.zh
        try {
            if (seg.zh) {
                val res = engine.setLanguage(Locale.SIMPLIFIED_CHINESE)
                if (res == TextToSpeech.LANG_MISSING_DATA || res == TextToSpeech.LANG_NOT_SUPPORTED) {
                    zhVoiceAvailable = false
                    warnNoChineseVoice()
                    return false
                }
            } else {
                val res = engine.setLanguage(Locale.forLanguageTag(ttsLang))
                if (res == TextToSpeech.LANG_MISSING_DATA || res == TextToSpeech.LANG_NOT_SUPPORTED) {
                    engine.setLanguage(Locale.US)
                }
            }
            engine.setSpeechRate(ttsRate.coerceIn(0.3f, 2.5f))
            engine.setPitch(1.0f)
        } catch (e: Exception) {
        }
        val params = Bundle()
        params.putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, 1.0f)
        val code = try {
            engine.speak(seg.text, TextToSpeech.QUEUE_FLUSH, params, "$job#$idx")
        } catch (e: Exception) {
            TextToSpeech.ERROR
        }
        return code == TextToSpeech.SUCCESS
    }

    /** 神经音色念一句英文；播放、打断、回调顺序与系统 TTS 保持一致 */
    private fun speakNeuralSegment(job: String, idx: Int, text: String) {
        NeuralTtsEngine.speak(
            text = text,
            rate = ttsRate,
            onStart = {
                main.post {
                    if (ttsJobId != job || ttsSegIndex != idx) return@post
                    SherpaEngine.noteTtsStart(text)
                    if (!ttsStartSent) {
                        ttsStartSent = true
                        emit("window.Native && window.Native.onSpeakStart && window.Native.onSpeakStart(${jsStr(job)})")
                    }
                }
            },
            onDone = {
                main.post {
                    if (ttsJobId != job || ttsSegIndex != idx) return@post
                    ttsSegIndex = idx + 1
                    speakNextSegment()
                }
            },
            onError = {
                main.post {
                    if (ttsJobId != job || ttsSegIndex != idx) return@post
                    // 神经音色这一句没出来：任何时候都不能哑火，立刻换系统英文语音补上
                    val seg = ttsSegments.getOrNull(idx) ?: TtsSegment(text, false)
                    if (speakSystemSegment(job, idx, seg)) return@post
                    ttsSegIndex = idx + 1
                    if (ttsSegIndex >= ttsSegments.size) finishTtsJob(error = false) else speakNextSegment()
                }
            }
        )
    }

    private fun finishTtsJob(error: Boolean) {
        val job = ttsJobId
        ttsJobId = null
        ttsJobText = ""
        ttsSegments = emptyList()
        ttsSegIndex = 0
        ttsStartSent = false
        ttsCurrentZh = false
        releaseAudioFocus()
        SherpaEngine.noteTtsEnd()
        if (job != null) {
            if (error) {
                emit("window.Native && window.Native.onSpeakError && window.Native.onSpeakError(${jsStr(job)})")
            } else {
                emit("window.Native && window.Native.onSpeakEnd && window.Native.onSpeakEnd(${jsStr(job)})")
            }
        }
    }

    /** 打断 / 手动停止：立刻清空队列，别再往下读。 */
    private fun cancelTtsJob() {
        ttsJobId = null
        ttsJobText = ""
        ttsSegments = emptyList()
        ttsSegIndex = 0
        ttsStartSent = false
        ttsCurrentZh = false
        releaseAudioFocus()
        SherpaEngine.noteTtsEnd()
        NeuralTtsEngine.stop()
        try {
            tts?.stop()
        } catch (e: Exception) {
        }
    }

    // ---------------- 音频焦点（耳机连麦、后台播放时不被音乐/通知抢走） ----------------

    private fun acquireAudioFocus() {
        if (focusHeld) return
        val mgr = try {
            getSystemService(AUDIO_SERVICE) as? AudioManager
        } catch (e: Exception) {
            null
        } ?: return
        audioMgr = mgr
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val req = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
                    .setAudioAttributes(
                        AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_MEDIA)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                            .build()
                    )
                    .setOnAudioFocusChangeListener { change ->
                        if (change == AudioManager.AUDIOFOCUS_LOSS) main.post { cancelTtsJob() }
                    }
                    .build()
                audioFocusReq = req
                focusHeld = mgr.requestAudioFocus(req) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
            } else {
                @Suppress("DEPRECATION")
                val ok = mgr.requestAudioFocus(
                    { change -> if (change == AudioManager.AUDIOFOCUS_LOSS) main.post { cancelTtsJob() } },
                    AudioManager.STREAM_MUSIC,
                    AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK
                ) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
                focusHeld = ok
            }
        } catch (e: Exception) {
            focusHeld = false
        }
    }

    private fun releaseAudioFocus() {
        if (!focusHeld) return
        focusHeld = false
        val mgr = audioMgr ?: return
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                audioFocusReq?.let { mgr.abandonAudioFocusRequest(it) }
            } else {
                @Suppress("DEPRECATION")
                mgr.abandonAudioFocus(null)
            }
        } catch (e: Exception) {
        }
        audioFocusReq = null
    }

    private fun warnNoChineseVoice() {
        if (zhVoiceWarned) return
        zhVoiceWarned = true
        emit("window.Native && window.Native.onTtsNote && window.Native.onTtsNote('no-zh','这台手机没有中文语音包，中文解释会显示成文字')")
    }

    // ================================================================
    // Sherpa-ONNX 离线语音回调
    // ================================================================

    override fun onAsrState(state: String, msg: String) {
        emit(
            "window.Native && window.Native.onAsrState && window.Native.onAsrState(" +
                jsStr(state) + "," + jsStr(msg) + ")"
        )
    }


    override fun onSpeechFinal(text: String, lang: String) {
        emit(
            "window.Native && window.Native.onSpeechResult && window.Native.onSpeechResult(" +
                jsStr(text) + ",true," + jsStr(lang) + ")"
        )
    }

    override fun onBargeIn(ttsText: String) {
        main.post {
            val full = if (ttsJobText.isNotBlank()) ttsJobText else ttsText
            val cut = if (full.length > 240) full.take(240) + "…" else full
            cancelTtsJob()
            emit(
                "window.Native && window.Native.onBargeIn && window.Native.onBargeIn(" +
                    jsStr(cut) + ")"
            )
        }
    }

    // ---------------- 录音 / 回放 ----------------

    private fun doStartRecording() {
        main.post {
            try {
                stopPlaybackInternal()
                try {
                    tts?.stop()
                } catch (e: Exception) {
                }
                cancelTtsJob()
                val file = File(cacheDir, "shadow.m4a")
                if (file.exists()) file.delete()
                val r = MediaRecorder()
                r.setAudioSource(MediaRecorder.AudioSource.MIC)
                r.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
                r.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
                r.setAudioSamplingRate(44100)
                r.setAudioEncodingBitRate(96000)
                r.setOutputFile(file.absolutePath)
                r.prepare()
                r.start()
                recorder = r
                recordFile = file
                recording = true
                recordStartAt = System.currentTimeMillis()
                emit("window.Native && window.Native.onRecordState && window.Native.onRecordState('recording','0')")
            } catch (e: Exception) {
                recording = false
                recorder = null
                emit("window.Native && window.Native.onRecordState && window.Native.onRecordState('error',${jsStr(e.message ?: "record_failed")})")
            }
        }
    }

    private fun doStopRecording() {
        main.post {
            val r = recorder
            if (r == null) {
                recording = false
                emit("window.Native && window.Native.onRecordState && window.Native.onRecordState('idle','0')")
                return@post
            }
            val duration = System.currentTimeMillis() - recordStartAt
            var ok = true
            try {
                r.stop()
            } catch (e: Exception) {
                ok = false
            }
            try {
                r.release()
            } catch (e: Exception) {
            }
            recorder = null
            recording = false
            val len = recordFile?.length() ?: 0L
            if (ok && len > 0L) {
                emit("window.Native && window.Native.onRecordState && window.Native.onRecordState('recorded','$duration')")
            } else {
                emit("window.Native && window.Native.onRecordState && window.Native.onRecordState('error','empty')")
            }
        }
    }

    private fun doPlayRecording() {
        main.post {
            val file = recordFile
            if (file == null || !file.exists() || file.length() == 0L) {
                emit("window.Native && window.Native.onRecordState && window.Native.onRecordState('error','no_recording')")
                return@post
            }
            stopPlaybackInternal()
            try {
                try {
                    tts?.stop()
                } catch (e: Exception) {
                }
                cancelTtsJob()
                val p = MediaPlayer()
                p.setDataSource(file.absolutePath)
                p.setOnCompletionListener { mp ->
                    try {
                        mp.release()
                    } catch (e: Exception) {
                    }
                    player = null
                    emit("window.Native && window.Native.onPlaybackEnd && window.Native.onPlaybackEnd()")
                }
                p.setOnErrorListener { mp, _, _ ->
                    try {
                        mp.release()
                    } catch (e: Exception) {
                    }
                    player = null
                    emit("window.Native && window.Native.onPlaybackEnd && window.Native.onPlaybackEnd()")
                    true
                }
                p.prepare()
                p.start()
                player = p
                emit("window.Native && window.Native.onRecordState && window.Native.onRecordState('playing','0')")
            } catch (e: Exception) {
                emit("window.Native && window.Native.onRecordState && window.Native.onRecordState('error',${jsStr(e.message ?: "play_failed")})")
            }
        }
    }

    private fun stopPlaybackInternal() {
        val p = player
        player = null
        if (p != null) {
            try {
                p.stop()
            } catch (e: Exception) {
            }
            try {
                p.release()
            } catch (e: Exception) {
            }
        }
    }

    // ---------------- 系统语音识别（兜底） ----------------

    private fun speechAvailable(): Boolean = try {
        SpeechRecognizer.isRecognitionAvailable(this)
    } catch (e: Exception) {
        false
    }

    private fun createRecognitionListener(r: SpeechRecognizer): RecognitionListener = object : RecognitionListener {
        private fun stale(): Boolean = recognizer !== r

        override fun onReadyForSpeech(params: Bundle?) {
            if (stale()) return
            emit("window.Native && window.Native.onSpeechState && window.Native.onSpeechState('ready','')")
        }

        override fun onBeginningOfSpeech() {
            if (stale()) return
            emit("window.Native && window.Native.onSpeechState && window.Native.onSpeechState('speaking','')")
        }

        override fun onRmsChanged(rmsdB: Float) {}

        override fun onBufferReceived(buffer: ByteArray?) {}

        override fun onEndOfSpeech() {
            if (stale()) return
            emit("window.Native && window.Native.onSpeechState && window.Native.onSpeechState('processing','')")
        }

        override fun onError(error: Int) {
            if (stale()) return
            if (stopping) return
            listening = false
            if (shouldFallbackToVoiceDialog(error) && launchVoiceIntent()) return
            val message = when (error) {
                SpeechRecognizer.ERROR_AUDIO -> "麦克风录音出错"
                SpeechRecognizer.ERROR_CLIENT -> "内置语音识别没能启动"
                SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "没有麦克风权限"
                SpeechRecognizer.ERROR_NETWORK -> "网络不佳，识别未完成"
                SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "网络超时，识别未完成"
                SpeechRecognizer.ERROR_NO_MATCH -> "没有听清，请再说一次"
                SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "识别忙，请稍后再试"
                SpeechRecognizer.ERROR_SERVER -> "本机识别服务出错"
                SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "没有听到声音"
                else -> "语音识别不可用（代码 $error）"
            }
            emit("window.Native && window.Native.onSpeechError && window.Native.onSpeechError($error,${jsStr(message)})")
        }

        override fun onResults(results: Bundle?) {
            if (stale()) return
            listening = false
            val text = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull() ?: ""
            emit("window.Native && window.Native.onSpeechResult && window.Native.onSpeechResult(${jsStr(text)},true,'en')")
        }

        override fun onPartialResults(partialResults: Bundle?) {
            if (stale()) return
            val text = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull() ?: ""
            if (text.isNotEmpty()) {
                emit("window.Native && window.Native.onSpeechResult && window.Native.onSpeechResult(${jsStr(text)},false,'en')")
            }
        }

        override fun onEvent(eventType: Int, params: Bundle?) {}
    }

    private fun shouldFallbackToVoiceDialog(error: Int): Boolean {
        if (voiceDialogTried || voiceDialogPending) return false
        return error == SpeechRecognizer.ERROR_CLIENT ||
            error == SpeechRecognizer.ERROR_SERVER ||
            error == SpeechRecognizer.ERROR_NETWORK ||
            error == SpeechRecognizer.ERROR_RECOGNIZER_BUSY
    }

    private fun buildSpeechIntent(): Intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
        putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
        putExtra(RecognizerIntent.EXTRA_LANGUAGE, "en-US")
        putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, "en-US")
        putExtra(RecognizerIntent.EXTRA_PROMPT, "Speak in English")
        putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3)
        putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, packageName)
    }

    private fun canUseVoiceIntent(): Boolean = try {
        buildSpeechIntent().resolveActivity(packageManager) != null
    } catch (e: Exception) {
        false
    }

    private fun launchVoiceIntent(): Boolean {
        if (voiceDialogPending) return true
        if (!canUseVoiceIntent()) return false
        return try {
            try {
                recognizer?.cancel()
            } catch (e: Exception) {
            }
            cancelTtsJob()
            listening = false
            voiceDialogTried = true
            voiceDialogPending = true
            markStopping()
            emit("window.Native && window.Native.onSpeechState && window.Native.onSpeechState('dialog','请在弹出的系统语音窗口里说英文')")
            startActivityForResult(buildSpeechIntent(), REQ_VOICE_INTENT)
            true
        } catch (e: Exception) {
            voiceDialogPending = false
            false
        }
    }

    private fun destroyRecognizer() {
        val r = recognizer
        recognizer = null
        listening = false
        if (r != null) {
            try {
                r.cancel()
            } catch (e: Exception) {
            }
            try {
                r.destroy()
            } catch (e: Exception) {
            }
        }
    }

    private fun markStopping() {
        stopping = true
        main.postDelayed({ stopping = false }, 900)
    }

    private fun doStartListening() {
        main.post {
            if (listening || voiceDialogPending) {
                doStopListening()
                return@post
            }
            if (!speechAvailable()) {
                if (launchVoiceIntent()) return@post
                listening = false
                emit("window.Native && window.Native.onSpeechState && window.Native.onSpeechState('unavailable','这台手机没有可用的语音识别，请用键盘输入或录音跟读')")
                return@post
            }
            val granted = checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
            if (!granted) {
                pendingSpeechAfterPermission = true
                emit("window.Native && window.Native.onSpeechState && window.Native.onSpeechState('permission','正在请求麦克风权限…')")
                requestAudioPermissions()
                return@post
            }
            prepareThenOpenMic()
        }
    }

    private fun prepareThenOpenMic() {
        voiceDialogTried = false
        destroyRecognizer()
        cancelTtsJob()
        pendingListenStart?.let { main.removeCallbacks(it) }
        val task = Runnable {
            pendingListenStart = null
            openMic()
        }
        pendingListenStart = task
        main.postDelayed(task, 160)
    }

    private fun openMic() {
        if (!speechAvailable()) {
            if (!launchVoiceIntent()) {
                emit("window.Native && window.Native.onSpeechState && window.Native.onSpeechState('unavailable','这台手机没有可用的语音识别，请用键盘输入或录音跟读')")
            }
            return
        }
        val r = try {
            SpeechRecognizer.createSpeechRecognizer(this)
        } catch (e: Exception) {
            listening = false
            if (!launchVoiceIntent()) {
                emit("window.Native && window.Native.onSpeechState && window.Native.onSpeechState('unavailable',${jsStr(e.message ?: "无法启动语音识别")})")
            }
            return
        }
        recognizer = r
        r.setRecognitionListener(createRecognitionListener(r))
        try {
            r.startListening(buildSpeechIntent())
            listening = true
            emit("window.Native && window.Native.onSpeechState && window.Native.onSpeechState('listening','')")
        } catch (e: Exception) {
            listening = false
            destroyRecognizer()
            if (!launchVoiceIntent()) {
                emit("window.Native && window.Native.onSpeechState && window.Native.onSpeechState('unavailable',${jsStr(e.message ?: "无法启动语音识别")})")
            }
        }
    }

    private fun doStopListening() {
        main.post {
            pendingListenStart?.let { main.removeCallbacks(it) }
            pendingListenStart = null
            val r = recognizer
            if (r != null) markStopping()
            try {
                r?.cancel()
            } catch (e: Exception) {
            }
            listening = false
            voiceDialogPending = false
        }
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQ_VOICE_INTENT) return
        voiceDialogPending = false
        listening = false
        if (resultCode == RESULT_OK && data != null) {
            val list = data.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)
            val text = list?.firstOrNull()?.trim() ?: ""
            if (text.isNotEmpty()) {
                emit("window.Native && window.Native.onSpeechResult && window.Native.onSpeechResult(${jsStr(text)},true,'en')")
                return
            }
        }
        emit("window.Native && window.Native.onSpeechState && window.Native.onSpeechState('cancelled','系统语音输入没有返回结果')")
    }

    // ---------------- 权限 ----------------

    private fun requestAudioPermissions() {
        val perms = ArrayList<String>()
        perms.add(Manifest.permission.RECORD_AUDIO)
        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            perms.add(Manifest.permission.POST_NOTIFICATIONS)
        }
        requestPermissions(perms.toTypedArray(), REQ_AUDIO)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQ_NOTIF) {
            // 通知权限给不给都继续：只是看不到那条常驻通知而已
            val lang = pendingServiceLang
            pendingServiceLang = null
            if (lang != null) startVoiceServiceNow(lang)
            return
        }
        if (requestCode != REQ_AUDIO) return
        var micGranted = false
        for (i in permissions.indices) {
            if (permissions[i] == Manifest.permission.RECORD_AUDIO) {
                micGranted = i < grantResults.size && grantResults[i] == PackageManager.PERMISSION_GRANTED
            }
        }
        if (micGranted) {
            emit("window.Native && window.Native.onPermissionResult && window.Native.onPermissionResult('RECORD_AUDIO',true)")
            if (pendingRecordAfterPermission) {
                pendingRecordAfterPermission = false
                doStartRecording()
            }
            if (pendingSpeechAfterPermission) {
                pendingSpeechAfterPermission = false
                doStartListening()
            }
            if (pendingAsrAfterPermission) {
                pendingAsrAfterPermission = false
                SherpaEngine.startListening(pendingAsrBargeIn)
            }
            val lang = pendingServiceLang
            if (lang != null) {
                pendingServiceLang = null
                startVoiceServiceNow(lang)
            }
        } else {
            pendingRecordAfterPermission = false
            pendingSpeechAfterPermission = false
            pendingAsrAfterPermission = false
            pendingServiceLang = null
            emit("window.Native && window.Native.onPermissionResult && window.Native.onPermissionResult('RECORD_AUDIO',false)")
            emit("window.Native && window.Native.onVoiceService && window.Native.onVoiceService('error','没有麦克风权限，耳机模式用不了')")
        }
    }

    // ================================================================
    // 与网页通信
    // ================================================================

    fun emitJs(js: String) {
        emit(js)
    }

    private fun emit(js: String) {
        main.post {
            try {
                webView.evaluateJavascript(js, null)
            } catch (e: Exception) {
            }
        }
    }

    private fun jsStr(value: String?): String {
        if (value == null) return "null"
        val sb = StringBuilder("\"")
        for (c in value) {
            when {
                c == '\\' -> sb.append("\\\\")
                c == '"' -> sb.append("\\\"")
                c == '\n' -> sb.append("\\n")
                c == '\r' -> sb.append("\\r")
                c == '\t' -> sb.append("\\t")
                c < ' ' -> sb.append(String.format(Locale.US, "\\u%04x", c.code))
                else -> sb.append(c)
            }
        }
        sb.append("\"")
        return sb.toString()
    }

    private fun startVoiceServiceNow(langMode: String) {
        try {
            val intent = Intent(this, VoiceCompanionService::class.java).apply {
                action = VoiceCompanionService.ACTION_START
                putExtra(VoiceCompanionService.EXTRA_LANG, langMode)
            }
            if (Build.VERSION.SDK_INT >= 26) startForegroundService(intent) else startService(intent)
            try {
                webView.resumeTimers()
            } catch (e: Exception) {
            }
            emit("window.Native && window.Native.onVoiceService && window.Native.onVoiceService('starting','')")
        } catch (e: Exception) {
            emit(
                "window.Native && window.Native.onVoiceService && window.Native.onVoiceService('error'," +
                    jsStr(e.message ?: "无法启动后台语音服务") + ")"
            )
        }
    }

    inner class Bridge {

        @JavascriptInterface
        fun appVersion(): String = com.idukang.readingcompanion.BuildConfig.VERSION_NAME

        @JavascriptInterface
        fun isTtsReady(): Boolean = ttsReady

        @JavascriptInterface
        fun speak(id: String, text: String, rate: Float, lang: String) {
            main.post {
                val engine = tts
                // 系统 TTS 不可用但内置神经音色就绪时，英文照样能读，不能整句报错
                val neuralUsable = voiceMode == "neural" &&
                    (NeuralTtsEngine.isReady() || NeuralTtsEngine.isLoading())
                if ((!ttsReady || engine == null) && !neuralUsable) {
                    emit("window.Native && window.Native.onSpeakError && window.Native.onSpeakError(${jsStr(id)})")
                    return@post
                }
                ttsRate = rate
                ttsLang = if (lang.isNullOrBlank()) "en-US" else lang
                applyTtsParams()
                stopPlaybackInternal()
                cancelTtsJob()
                // 神经音色还没热好就请求一下，这一句先用系统语音顶上
                if (voiceMode == "neural" && !NeuralTtsEngine.isReady()) {
                    NeuralTtsEngine.prepare(applicationContext)
                }
                val segs = splitBilingual(text)
                if (segs.isEmpty()) {
                    emit("window.Native && window.Native.onSpeakEnd && window.Native.onSpeakEnd(${jsStr(id)})")
                    return@post
                }
                acquireAudioFocus()
                ttsJobId = id
                ttsJobText = text
                ttsSegments = segs
                ttsSegIndex = 0
                ttsStartSent = false
                speakNextSegment()
            }
        }

        @JavascriptInterface
        fun stopSpeak() {
            main.post { cancelTtsJob() }
        }

        // ---------- 英文音色（离线神经音色 / 系统语音） ----------

        @JavascriptInterface
        fun setEnglishVoice(mode: String) {
            val m = if (mode == "system") "system" else "neural"
            main.post {
                voiceMode = m
                prefs.edit().putString("voice_engine", m).apply()
                if (m == "neural") NeuralTtsEngine.prepare(applicationContext)
                emit(
                    "window.Native && window.Native.onVoiceEngine && window.Native.onVoiceEngine(" +
                        jsStr(NeuralTtsEngine.statusName()) + ")"
                )
            }
        }

        @JavascriptInterface
        fun englishVoice(): String = voiceMode

        @JavascriptInterface
        fun voiceEngineState(): String = NeuralTtsEngine.statusName()

        @JavascriptInterface
        fun hasNeuralVoice(): Boolean = NeuralTtsEngine.hasModel(this@MainActivity)

        // ---------- 离线语音（SenseVoice + Silero VAD） ----------

        @JavascriptInterface
        fun hasAsr(): Boolean = SherpaEngine.hasModel(this@MainActivity)

        @JavascriptInterface
        fun hasAsrChinese(): Boolean = SherpaEngine.hasModel(this@MainActivity)

        @JavascriptInterface
        fun isAsrReady(): Boolean = SherpaEngine.isReady()

        @JavascriptInterface
        fun prepareAsr() {
            main.post { SherpaEngine.prepare(applicationContext) }
        }

        @JavascriptInterface
        fun setAsrLanguage(mode: String) {
            SherpaEngine.setLanguageMode(mode)
        }

        @JavascriptInterface
        fun startAsrListen(bargeIn: Boolean): Boolean {
            val granted = checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
            if (!granted) {
                pendingAsrAfterPermission = true
                pendingAsrBargeIn = bargeIn
                main.post {
                    emit("window.Native && window.Native.onSpeechState && window.Native.onSpeechState('permission','正在请求麦克风权限…')")
                    requestAudioPermissions()
                }
                return true
            }
            return SherpaEngine.startListening(bargeIn)
        }

        @JavascriptInterface
        fun stopAsrListen() {
            SherpaEngine.stopListening()
        }

        @JavascriptInterface
        fun isAsrListening(): Boolean = false

        // ---------- 耳机后台连麦服务 ----------

        @JavascriptInterface
        fun startVoiceService(langMode: String) {
            main.post {
                val granted = checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
                if (!granted) {
                    pendingServiceLang = langMode
                    emit("window.Native && window.Native.onVoiceService && window.Native.onVoiceService('permission','正在请求麦克风权限…')")
                    requestAudioPermissions()
                    return@post
                }
                // 麦克风早就给过了：单独请求通知权限，好让她能看到“结束对话”的通知
                if (Build.VERSION.SDK_INT >= 33 &&
                    checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
                ) {
                    pendingServiceLang = langMode
                    try {
                        requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_NOTIF)
                    } catch (e: Exception) {
                        pendingServiceLang = null
                        startVoiceServiceNow(langMode)
                    }
                    return@post
                }
                startVoiceServiceNow(langMode)
            }
        }

        @JavascriptInterface
        fun stopVoiceService() {
            main.post {
                try {
                    stopService(Intent(this@MainActivity, VoiceCompanionService::class.java))
                } catch (e: Exception) {
                }
            }
        }

        @JavascriptInterface
        fun isVoiceServiceActive(): Boolean = VoiceCompanionService.isActive

        // ---------- 录音 ----------

        @JavascriptInterface
        fun hasRecording(): Boolean {
            val f = recordFile
            return f != null && f.exists() && f.length() > 0L
        }

        @JavascriptInterface
        fun startRecording() {
            val granted = checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
            if (!granted) {
                pendingRecordAfterPermission = true
                main.post {
                    emit("window.Native && window.Native.onRecordState && window.Native.onRecordState('permission','正在请求麦克风权限…')")
                    requestAudioPermissions()
                }
                return
            }
            doStartRecording()
        }

        @JavascriptInterface
        fun stopRecording() = doStopRecording()

        @JavascriptInterface
        fun playRecording() = doPlayRecording()

        @JavascriptInterface
        fun stopPlayback() {
            main.post {
                stopPlaybackInternal()
                emit("window.Native && window.Native.onPlaybackEnd && window.Native.onPlaybackEnd()")
            }
        }

        @JavascriptInterface
        fun deleteRecording() {
            main.post {
                stopPlaybackInternal()
                try {
                    recordFile?.delete()
                } catch (e: Exception) {
                }
                recordFile = null
                emit("window.Native && window.Native.onRecordState && window.Native.onRecordState('deleted','0')")
            }
        }

        @JavascriptInterface
        fun isRecording(): Boolean = recording

        @JavascriptInterface
        fun isSpeechAvailable(): Boolean = speechAvailable()

        @JavascriptInterface
        fun canUseVoiceDialog(): Boolean = canUseVoiceIntent()

        @JavascriptInterface
        fun startVoiceDialog() {
            main.post {
                if (!launchVoiceIntent()) {
                    emit("window.Native && window.Native.onSpeechState && window.Native.onSpeechState('unavailable','这台手机没有可用的语音识别，请用键盘输入或录音跟读')")
                }
            }
        }

        @JavascriptInterface
        fun startListening() = doStartListening()

        @JavascriptInterface
        fun stopListening() = doStopListening()

        /**
         * 代网页发起 HTTPS 请求（WebView 里直接 fetch 会受跨域限制）。
         * 只在用户主动点“联网查词”或自己配置了 AI 接口时才会被调用。
         */
        @JavascriptInterface
        fun httpRequest(reqId: String, method: String, url: String, headersJson: String, body: String) {
            val target = url.trim()
            if (!target.startsWith("https://", ignoreCase = true)) {
                emit(
                    "window.Native && window.Native.onHttpResponse && window.Native.onHttpResponse(" +
                        jsStr(reqId) + ",0," + jsStr("{\"error\":\"只允许访问 https 地址\"}") + ")"
                )
                return
            }
            Thread(Runnable {
                var conn: HttpURLConnection? = null
                try {
                    val u = URL(target)
                    val c = u.openConnection() as HttpURLConnection
                    conn = c
                    c.requestMethod = if (method.isBlank()) "POST" else method.uppercase(Locale.US)
                    c.connectTimeout = 20000
                    c.readTimeout = 40000
                    c.instanceFollowRedirects = true
                    try {
                        val obj = JSONObject(if (headersJson.isBlank()) "{}" else headersJson)
                        val keys = obj.keys()
                        while (keys.hasNext()) {
                            val k = keys.next()
                            val v = obj.optString(k, "")
                            if (v.isNotEmpty()) c.setRequestProperty(k, v)
                        }
                    } catch (e: Exception) {
                    }
                    if (c.requestMethod != "GET" && body.isNotEmpty()) {
                        val bytes = body.toByteArray(Charsets.UTF_8)
                        c.doOutput = true
                        c.setRequestProperty("Content-Length", bytes.size.toString())
                        val os = c.outputStream
                        os.write(bytes)
                        os.flush()
                        os.close()
                    }
                    val code = c.responseCode
                    val stream = if (code in 200..299) c.inputStream else (c.errorStream ?: c.inputStream)
                    val text = try {
                        stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
                    } catch (e: Exception) {
                        ""
                    }
                    emit(
                        "window.Native && window.Native.onHttpResponse && window.Native.onHttpResponse(" +
                            jsStr(reqId) + "," + code + "," + jsStr(text) + ")"
                    )
                } catch (e: Exception) {
                    val msg = (e.message ?: "网络请求失败").replace("\"", "'")
                    emit(
                        "window.Native && window.Native.onHttpResponse && window.Native.onHttpResponse(" +
                            jsStr(reqId) + ",0," + jsStr("{\"error\":\"" + msg + "\"}") + ")"
                    )
                } finally {
                    try {
                        conn?.disconnect()
                    } catch (e: Exception) {
                    }
                }
            }).start()
        }

        private val activeStreams = ConcurrentHashMap<String, HttpURLConnection>()

        @JavascriptInterface
        fun cancelHttp(reqId: String) {
            val c = activeStreams.remove(reqId) ?: return
            Thread(Runnable {
                try {
                    c.disconnect()
                } catch (e: Exception) {
                }
            }).start()
        }

        @JavascriptInterface
        fun httpStream(reqId: String, method: String, url: String, headersJson: String, body: String) {
            val target = url.trim()
            if (!target.startsWith("https://", ignoreCase = true)) {
                emit(
                    "window.Native && window.Native.onHttpStreamError && window.Native.onHttpStreamError(" +
                        jsStr(reqId) + ",0," + jsStr("只允许访问 https 地址") + ")"
                )
                return
            }
            Thread(Runnable {
                var conn: HttpURLConnection? = null
                try {
                    val u = URL(target)
                    val c = u.openConnection() as HttpURLConnection
                    conn = c
                    activeStreams[reqId] = c
                    c.requestMethod = if (method.isBlank()) "POST" else method.uppercase(Locale.US)
                    c.connectTimeout = 15000
                    c.readTimeout = 45000
                    c.instanceFollowRedirects = true
                    try {
                        val obj = JSONObject(if (headersJson.isBlank()) "{}" else headersJson)
                        val keys = obj.keys()
                        while (keys.hasNext()) {
                            val k = keys.next()
                            val v = obj.optString(k, "")
                            if (v.isNotEmpty()) c.setRequestProperty(k, v)
                        }
                    } catch (e: Exception) {
                    }
                    if (c.requestMethod != "GET" && body.isNotEmpty()) {
                        val bytes = body.toByteArray(Charsets.UTF_8)
                        c.doOutput = true
                        c.setRequestProperty("Content-Length", bytes.size.toString())
                        val os = c.outputStream
                        os.write(bytes)
                        os.flush()
                        os.close()
                    }
                    val code = c.responseCode
                    if (code !in 200..299) {
                        val err = try {
                            (c.errorStream ?: c.inputStream)?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
                        } catch (e: Exception) {
                            ""
                        }
                        emit(
                            "window.Native && window.Native.onHttpStreamError && window.Native.onHttpStreamError(" +
                                jsStr(reqId) + "," + code + "," + jsStr(err) + ")"
                        )
                        return@Runnable
                    }
                    val ct = (c.contentType ?: "").lowercase(Locale.US)
                    val reader = c.inputStream.bufferedReader(Charsets.UTF_8)
                    val full = StringBuilder()
                    if (!ct.contains("text/event-stream")) {
                        val raw = reader.readText()
                        val parsed = try {
                            val j = JSONObject(raw)
                            j.optJSONArray("choices")?.optJSONObject(0)?.optJSONObject("message")?.optString("content", "") ?: ""
                        } catch (e: Exception) {
                            ""
                        }
                        if (parsed.isNotEmpty()) {
                            full.append(parsed)
                            emit(
                                "window.Native && window.Native.onHttpStreamChunk && window.Native.onHttpStreamChunk(" +
                                    jsStr(reqId) + "," + jsStr(parsed) + "," + jsStr(full.toString()) + ")"
                            )
                        }
                        emit(
                            "window.Native && window.Native.onHttpStreamDone && window.Native.onHttpStreamDone(" +
                                jsStr(reqId) + "," + jsStr(full.toString()) + ")"
                        )
                        return@Runnable
                    }
                    var line: String?
                    while (reader.readLine().also { line = it } != null) {
                        if (!activeStreams.containsKey(reqId)) break
                        val l = line?.trim() ?: continue
                        if (!l.startsWith("data:")) continue
                        val payload = l.removePrefix("data:").trim()
                        if (payload == "[DONE]") break
                        val delta = try {
                            val j = JSONObject(payload)
                            val choices = j.optJSONArray("choices")
                            val c0 = choices?.optJSONObject(0)
                            c0?.optJSONObject("delta")?.optString("content", "")
                                ?: c0?.optJSONObject("message")?.optString("content", "")
                                ?: ""
                        } catch (e: Exception) {
                            ""
                        }
                        if (delta.isNotEmpty()) {
                            full.append(delta)
                            emit(
                                "window.Native && window.Native.onHttpStreamChunk && window.Native.onHttpStreamChunk(" +
                                    jsStr(reqId) + "," + jsStr(delta) + "," + jsStr(full.toString()) + ")"
                            )
                        }
                    }
                    if (activeStreams.containsKey(reqId)) {
                        emit(
                            "window.Native && window.Native.onHttpStreamDone && window.Native.onHttpStreamDone(" +
                                jsStr(reqId) + "," + jsStr(full.toString()) + ")"
                        )
                    }
                } catch (e: Exception) {
                    if (activeStreams.containsKey(reqId)) {
                        val msg = (e.message ?: "网络请求失败").replace("\"", "'")
                        emit(
                            "window.Native && window.Native.onHttpStreamError && window.Native.onHttpStreamError(" +
                                jsStr(reqId) + ",0," + jsStr(msg) + ")"
                        )
                    }
                } finally {
                    activeStreams.remove(reqId)
                    try {
                        conn?.disconnect()
                    } catch (e: Exception) {
                    }
                }
            }).start()
        }

        @JavascriptInterface
        fun setSystemBars(dark: Boolean) {
            main.post {
                val color = if (dark) 0xFF14161A.toInt() else 0xFFF6F1E7.toInt()
                try {
                    window.statusBarColor = color
                    window.navigationBarColor = color
                } catch (e: Exception) {
                }
                var flags = window.decorView.systemUiVisibility
                flags = if (dark) {
                    flags and View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR.inv()
                } else {
                    flags or View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR
                }
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    flags = if (dark) {
                        flags and View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR.inv()
                    } else {
                        flags or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
                    }
                }
                window.decorView.systemUiVisibility = flags
            }
        }

        @JavascriptInterface
        fun exitApp() {
            main.post { finish() }
        }
    }

    // ---------------- 生命周期 ----------------

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        var handled = false
        webView.evaluateJavascript(
            "(function(){try{return (window.App && window.App.handleBack) ? String(window.App.handleBack()) : 'exit';}catch(e){return 'exit';}})()"
        ) { result ->
            handled = result != null && !result.contains("exit")
            if (!handled) finish()
        }
    }

    override fun onPause() {
        super.onPause()
        // 耳机后台连麦时，熄屏/切后台不能停朗读和麦克风
        if (VoiceCompanionService.isActive) return
        try {
            tts?.stop()
        } catch (e: Exception) {
        }
        cancelTtsJob()
        stopPlaybackInternal()
    }

    override fun onDestroy() {
        if (instance === this) instance = null
        try {
            if (VoiceCompanionService.isActive) {
                stopService(Intent(this, VoiceCompanionService::class.java))
            }
        } catch (e: Exception) {
        }
        SherpaEngine.setCallback(null)
        SherpaEngine.shutdown()
        try {
            if (recording) {
                recorder?.release()
                recorder = null
                recording = false
            }
        } catch (e: Exception) {
        }
        stopPlaybackInternal()
        try {
            recognizer?.destroy()
            recognizer = null
        } catch (e: Exception) {
        }
        try {
            tts?.stop()
            tts?.shutdown()
            tts = null
        } catch (e: Exception) {
        }
        try {
            releaseAudioFocus()
            NeuralTtsEngine.release()
        } catch (e: Exception) {
        }
        try {
            webView.destroy()
        } catch (e: Exception) {
        }
        super.onDestroy()
    }
}
