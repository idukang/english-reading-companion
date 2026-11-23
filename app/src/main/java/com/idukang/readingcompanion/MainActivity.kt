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
 * Kotlin 这层只负责四件本机能力：
 *   1. 系统 TTS 朗读（点读 / 整篇朗读 / 对话台词）
 *   2. 麦克风录音与回放（跟读对比）
 *   3. 系统语音识别（语音回答；没有识别服务的机型自动降级为键盘输入）
 *   4. 状态栏配色
 * 不联网、不上报、无第三方 SDK。
 */
class MainActivity : Activity(), TextToSpeech.OnInitListener {

    companion object {
        private const val REQ_AUDIO = 1001
    }

    private lateinit var webView: WebView
    private val main = Handler(Looper.getMainLooper())

    // ---------- TTS ----------
    private var tts: TextToSpeech? = null
    private var ttsReady = false
    private var ttsLang = "en-US"
    private var ttsRate = 1.0f

    // ---------- 录音 ----------
    private var recorder: MediaRecorder? = null
    private var recordFile: File? = null
    private var recording = false
    private var recordStartAt = 0L
    private var player: MediaPlayer? = null

    // ---------- 语音识别 ----------
    private var recognizer: SpeechRecognizer? = null
    private var listening = false

    private var pendingRecordAfterPermission = false
    private var pendingSpeechAfterPermission = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

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
            // 只允许加载应用内打包页面，任何外部跳转一律拦截
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

        try {
            tts = TextToSpeech(this, this)
        } catch (e: Exception) {
            emit("window.Native && window.Native.onTtsUnavailable && window.Native.onTtsUnavailable()")
        }
    }

    // ---------------- TTS ----------------

    override fun onInit(status: Int) {
        if (status != TextToSpeech.SUCCESS) {
            ttsReady = false
            emit("window.Native && window.Native.onTtsUnavailable && window.Native.onTtsUnavailable()")
            return
        }
        val engine = tts ?: return
        applyTtsParams()
        try {
            engine.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                override fun onStart(utteranceId: String?) {
                    emit("window.Native && window.Native.onSpeakStart && window.Native.onSpeakStart(${jsStr(utteranceId)})")
                }

                override fun onDone(utteranceId: String?) {
                    emit("window.Native && window.Native.onSpeakEnd && window.Native.onSpeakEnd(${jsStr(utteranceId)})")
                }

                override fun onStop(utteranceId: String?, interrupted: Boolean) {
                    emit("window.Native && window.Native.onSpeakEnd && window.Native.onSpeakEnd(${jsStr(utteranceId)})")
                }

                override fun onError(utteranceId: String?) {
                    emit("window.Native && window.Native.onSpeakError && window.Native.onSpeakError(${jsStr(utteranceId)})")
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
            // 忽略：不同语音引擎的参数支持程度不同
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

    // ---------------- 语音识别 ----------------

    private fun speechAvailable(): Boolean = try {
        SpeechRecognizer.isRecognitionAvailable(this)
    } catch (e: Exception) {
        false
    }

    private val recognitionListener = object : RecognitionListener {
        override fun onReadyForSpeech(params: Bundle?) {
            emit("window.Native && window.Native.onSpeechState && window.Native.onSpeechState('ready','')")
        }

        override fun onBeginningOfSpeech() {
            emit("window.Native && window.Native.onSpeechState && window.Native.onSpeechState('speaking','')")
        }

        override fun onRmsChanged(rmsdB: Float) {}

        override fun onBufferReceived(buffer: ByteArray?) {}

        override fun onEndOfSpeech() {
            emit("window.Native && window.Native.onSpeechState && window.Native.onSpeechState('processing','')")
        }

        override fun onError(error: Int) {
            listening = false
            val message = when (error) {
                SpeechRecognizer.ERROR_AUDIO -> "麦克风录音出错"
                SpeechRecognizer.ERROR_CLIENT -> "识别服务被中断"
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
            listening = false
            val text = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull() ?: ""
            emit("window.Native && window.Native.onSpeechResult && window.Native.onSpeechResult(${jsStr(text)},true)")
        }

        override fun onPartialResults(partialResults: Bundle?) {
            val text = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull() ?: ""
            if (text.isNotEmpty()) {
                emit("window.Native && window.Native.onSpeechResult && window.Native.onSpeechResult(${jsStr(text)},false)")
            }
        }

        override fun onEvent(eventType: Int, params: Bundle?) {}
    }

    private fun doStartListening() {
        main.post {
            if (!speechAvailable()) {
                listening = false
                emit("window.Native && window.Native.onSpeechState && window.Native.onSpeechState('unavailable','本机没有可用的语音识别服务，请用键盘输入')")
                return@post
            }
            val granted = checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
            if (!granted) {
                pendingSpeechAfterPermission = true
                emit("window.Native && window.Native.onSpeechState && window.Native.onSpeechState('permission','正在请求麦克风权限…')")
                requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQ_AUDIO)
                return@post
            }
            try {
                if (recognizer == null) {
                    recognizer = SpeechRecognizer.createSpeechRecognizer(this).also {
                        it.setRecognitionListener(recognitionListener)
                    }
                }
                try {
                    tts?.stop()
                } catch (e: Exception) {
                }
                val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                    putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                    putExtra(RecognizerIntent.EXTRA_LANGUAGE, "en-US")
                    putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, "en-US")
                    putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
                    putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3)
                    putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, packageName)
                }
                recognizer?.startListening(intent)
                listening = true
                emit("window.Native && window.Native.onSpeechState && window.Native.onSpeechState('listening','')")
            } catch (e: Exception) {
                listening = false
                emit("window.Native && window.Native.onSpeechState && window.Native.onSpeechState('unavailable',${jsStr(e.message ?: "无法启动语音识别")})")
            }
        }
    }

    private fun doStopListening() {
        main.post {
            try {
                recognizer?.cancel()
            } catch (e: Exception) {
            }
            listening = false
        }
    }

    // ---------------- 权限 ----------------

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQ_AUDIO) return
        val granted = grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED
        if (granted) {
            emit("window.Native && window.Native.onPermissionResult && window.Native.onPermissionResult('RECORD_AUDIO',true)")
            if (pendingRecordAfterPermission) {
                pendingRecordAfterPermission = false
                doStartRecording()
            }
            if (pendingSpeechAfterPermission) {
                pendingSpeechAfterPermission = false
                doStartListening()
            }
        } else {
            pendingRecordAfterPermission = false
            pendingSpeechAfterPermission = false
            emit("window.Native && window.Native.onPermissionResult && window.Native.onPermissionResult('RECORD_AUDIO',false)")
        }
    }

    // ---------------- 与网页通信 ----------------

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
                val params = Bundle()
                params.putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, 1.0f)
                val code = engine.speak(text, TextToSpeech.QUEUE_FLUSH, params, id)
                if (code != TextToSpeech.SUCCESS) {
                    emit("window.Native && window.Native.onSpeakError && window.Native.onSpeakError(${jsStr(id)})")
                }
            }
        }

        @JavascriptInterface
        fun stopSpeak() {
            main.post {
                try {
                    tts?.stop()
                } catch (e: Exception) {
                }
            }
        }

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
                    requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQ_AUDIO)
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
        try {
            tts?.stop()
        } catch (e: Exception) {
        }
        stopPlaybackInternal()
    }

    override fun onDestroy() {
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
