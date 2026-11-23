package com.idukang.readingcompanion

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
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

/**
 * 英语陪读 —— 单 Activity + WebView 外壳。
 *
 * 全部界面、书库、词库、对话内容都打包在 app/src/main/assets/www 里，完全离线；
 * Kotlin 这层负责本机能力：
 *   1. 系统 TTS 朗读（中英混排会自动分段，中文用中文语音、英文用英文语音）
 *   2. 麦克风录音与回放（跟读对比）
 *   3. 离线语音识别（Vosk，中英双语；可后台、可边说边听、可打断）
 *   4. 耳机后台连麦的前台服务（VoiceCompanionService）
 *   5. 状态栏配色
 * 不联网、不上报、无统计 SDK。
 */
class MainActivity : Activity(), TextToSpeech.OnInitListener, VoskEngine.Listener {

    companion object {
        private const val REQ_AUDIO = 1001
        private const val REQ_VOICE_INTENT = 1002

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

    // ---------- 系统语音识别（Vosk 不可用时的兜底） ----------
    private var recognizer: SpeechRecognizer? = null
    private var listening = false
    private var pendingListenStart: Runnable? = null
    private var voiceDialogTried = false
    private var voiceDialogPending = false
    private var stopping = false

    private var pendingRecordAfterPermission = false
    private var pendingSpeechAfterPermission = false
    private var pendingVoskAfterPermission = false
    private var pendingVoskBargeIn = false
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

        // 离线语音：先挂上监听，真正载入模型由网页层按需触发（进对话页时预载）
        VoskEngine.attach(this)
        VoskEngine.setCallback(this)

        try {
            tts = TextToSpeech(this, this)
        } catch (e: Exception) {
            emit("window.Native && window.Native.onTtsUnavailable && window.Native.onTtsUnavailable()")
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
                        VoskEngine.noteTtsStart(currentSegmentText())
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
                    main.post { if (ttsJobId == null) VoskEngine.noteTtsEnd() }
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
        val engine = tts
        if (engine == null) {
            finishTtsJob(error = true)
            return
        }
        val job = ttsJobId ?: return
        while (ttsSegIndex < ttsSegments.size) {
            val seg = ttsSegments[ttsSegIndex]
            if (seg.text.isBlank()) {
                ttsSegIndex++
                continue
            }
            ttsCurrentZh = seg.zh
            if (seg.zh && !zhVoiceAvailable) {
                warnNoChineseVoice()
                ttsSegIndex++
                continue
            }
            try {
                if (seg.zh) {
                    val res = engine.setLanguage(Locale.SIMPLIFIED_CHINESE)
                    if (res == TextToSpeech.LANG_MISSING_DATA || res == TextToSpeech.LANG_NOT_SUPPORTED) {
                        zhVoiceAvailable = false
                        warnNoChineseVoice()
                        ttsSegIndex++
                        continue
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
                engine.speak(seg.text, TextToSpeech.QUEUE_FLUSH, params, "$job#$ttsSegIndex")
            } catch (e: Exception) {
                TextToSpeech.ERROR
            }
            if (code != TextToSpeech.SUCCESS) {
                if (seg.zh) {
                    ttsSegIndex++
                    continue
                }
                finishTtsJob(error = true)
            }
            return
        }
        finishTtsJob(error = false)
    }

    private fun finishTtsJob(error: Boolean) {
        val job = ttsJobId
        ttsJobId = null
        ttsJobText = ""
        ttsSegments = emptyList()
        ttsSegIndex = 0
        ttsStartSent = false
        ttsCurrentZh = false
        VoskEngine.noteTtsEnd()
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
        VoskEngine.noteTtsEnd()
        try {
            tts?.stop()
        } catch (e: Exception) {
        }
    }

    private fun warnNoChineseVoice() {
        if (zhVoiceWarned) return
        zhVoiceWarned = true
        emit("window.Native && window.Native.onTtsNote && window.Native.onTtsNote('no-zh','这台手机没有中文语音包，中文解释会显示成文字')")
    }

    // ================================================================
    // Vosk 回调
    // ================================================================

    override fun onVoskState(state: String, msg: String) {
        emit(
            "window.Native && window.Native.onVoskState && window.Native.onVoskState(" +
                jsStr(state) + "," + jsStr(msg) + ")"
        )
    }

    override fun onSpeechPartial(text: String, lang: String) {
        emit(
            "window.Native && window.Native.onSpeechResult && window.Native.onSpeechResult(" +
                jsStr(text) + ",false," + jsStr(lang) + ")"
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
            if (pendingVoskAfterPermission) {
                pendingVoskAfterPermission = false
                VoskEngine.startListening(pendingVoskBargeIn)
            }
            val lang = pendingServiceLang
            if (lang != null) {
                pendingServiceLang = null
                startVoiceServiceNow(lang)
            }
        } else {
            pendingRecordAfterPermission = false
            pendingSpeechAfterPermission = false
            pendingVoskAfterPermission = false
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
                if (!ttsReady || engine == null) {
                    emit("window.Native && window.Native.onSpeakError && window.Native.onSpeakError(${jsStr(id)})")
                    return@post
                }
                ttsRate = rate
                ttsLang = if (lang.isNullOrBlank()) "en-US" else lang
                applyTtsParams()
                stopPlaybackInternal()
                cancelTtsJob()
                val segs = splitBilingual(text)
                if (segs.isEmpty()) {
                    emit("window.Native && window.Native.onSpeakEnd && window.Native.onSpeakEnd(${jsStr(id)})")
                    return@post
                }
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

        // ---------- 离线语音（Vosk） ----------

        @JavascriptInterface
        fun hasVosk(): Boolean = VoskEngine.hasEnglishModel(this@MainActivity)

        @JavascriptInterface
        fun hasVoskChinese(): Boolean = VoskEngine.hasChineseModel(this@MainActivity)

        @JavascriptInterface
        fun isVoskReady(): Boolean = VoskEngine.isReady()

        @JavascriptInterface
        fun prepareVosk() {
            main.post { VoskEngine.prepare(applicationContext) }
        }

        @JavascriptInterface
        fun setVoskLanguage(mode: String) {
            VoskEngine.setLanguageMode(mode)
        }

        @JavascriptInterface
        fun startVoskListen(bargeIn: Boolean): Boolean {
            val granted = checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
            if (!granted) {
                pendingVoskAfterPermission = true
                pendingVoskBargeIn = bargeIn
                main.post {
                    emit("window.Native && window.Native.onSpeechState && window.Native.onSpeechState('permission','正在请求麦克风权限…')")
                    requestAudioPermissions()
                }
                return true
            }
            return VoskEngine.startListening(bargeIn)
        }

        @JavascriptInterface
        fun stopVoskListen() {
            VoskEngine.stopListening()
        }

        @JavascriptInterface
        fun isVoskListening(): Boolean = false

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
        VoskEngine.setCallback(null)
        VoskEngine.shutdown()
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
            webView.destroy()
        } catch (e: Exception) {
        }
        super.onDestroy()
    }
}
