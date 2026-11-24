package com.idukang.readingcompanion

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.SystemClock
import android.util.Log
import com.k2fsa.sherpa.onnx.GeneratedAudio
import com.k2fsa.sherpa.onnx.OfflineTts
import com.k2fsa.sherpa.onnx.OfflineTtsConfig
import com.k2fsa.sherpa.onnx.OfflineTtsModelConfig
import com.k2fsa.sherpa.onnx.OfflineTtsSupertonicModelConfig
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.max
import kotlin.math.min

/**
 * 离线神经英文音色（Sherpa-ONNX + Supertonic）。
 *
 * 为什么不是 Piper：sherpa-onnx 从 v2.0.0 起移除了 espeak-ng / piper-phonemize
 * 音素前端，Piper 的 VITS 模型在没有音素字典时无法把英文文本转成 token；
 * 而本项目用的正是 2.0.3。Supertonic 是 sherpa-onnx 2.0 官方支持的端上神经
 * TTS（66M 参数、int8 四件套、44.1kHz、10 个音色），同样离线、同样零外联，
 * 模型文件打包在 assets/tts/ 里。
 *
 * 只负责「英文片段 → PCM → AudioTrack」这一段；分段、系统中文语音、回退、
 * 打断等都还在 MainActivity 里统一调度。
 */
object NeuralTtsEngine {

    private const val TAG = "NeuralTts"
    private const val DIR = "tts"
    private const val DEFAULT_SID = 0          // F1：女声，最自然的一个

    enum class State { IDLE, LOADING, READY, FAILED }

    @Volatile
    var state: State = State.IDLE
        private set

    private var tts: OfflineTts? = null
    private var loadThread: Thread? = null

    private val stopFlag = AtomicBoolean(true)
    // 每次 speak 递增：旧任务生成完后发现已经不是最新一句，就安静退出，
    // 不会把上一句念到新的一句前面。
    private val speakSeq = java.util.concurrent.atomic.AtomicLong(0)
    private val worker = Executors.newSingleThreadExecutor { r ->
        Thread(r, "neural-tts").apply { priority = Thread.NORM_PRIORITY }
    }

    @Volatile
    private var track: AudioTrack? = null

    /** 状态变化（loading / ready / failed）回调，用来告诉界面。 */
    var listener: ((State) -> Unit)? = null
        private set

    fun observe(l: ((State) -> Unit)?) {
        listener = l
    }

    private fun setState(s: State) {
        state = s
        try {
            listener?.invoke(s)
        } catch (t: Throwable) {
        }
    }

    fun isReady(): Boolean = state == State.READY && tts != null

    fun isLoading(): Boolean = state == State.LOADING

    fun statusName(): String = when (state) {
        State.IDLE -> "idle"
        State.LOADING -> "loading"
        State.READY -> "ready"
        State.FAILED -> "failed"
    }

    fun sampleRate(): Int = try {
        tts?.sampleRate() ?: 0
    } catch (t: Throwable) {
        0
    }

    /** assets/tts 里是否带了完整模型（没带就永远走系统语音，不报错）。 */
    fun hasModel(ctx: Context): Boolean {
        return try {
            val am = ctx.applicationContext.assets
            val list = am.list(DIR) ?: return false
            val need = listOf(
                "duration_predictor.int8.onnx",
                "text_encoder.int8.onnx",
                "vector_estimator.int8.onnx",
                "vocoder.int8.onnx",
                "tts.json",
                "unicode_indexer.bin",
                "voice.bin"
            )
            need.all { list.contains(it) }
        } catch (t: Throwable) {
            false
        }
    }

    /** 后台加载模型；重复调用安全，失败后不再重试（同一进程里模型坏了重试也没用）。 */
    fun prepare(ctx: Context) {
        if (state == State.READY || state == State.LOADING || state == State.FAILED) return
        synchronized(this) {
            if (state == State.READY || state == State.LOADING || state == State.FAILED) return
            val app = ctx.applicationContext
            if (!hasModel(app)) {
                setState(State.FAILED)
                return
            }
            setState(State.LOADING)
            val t = Thread({
                val startedAt = SystemClock.elapsedRealtime()
                try {
                    val cfg = OfflineTtsConfig(
                        model = OfflineTtsModelConfig(
                            supertonic = OfflineTtsSupertonicModelConfig(
                                durationPredictor = "$DIR/duration_predictor.int8.onnx",
                                textEncoder = "$DIR/text_encoder.int8.onnx",
                                vectorEstimator = "$DIR/vector_estimator.int8.onnx",
                                vocoder = "$DIR/vocoder.int8.onnx",
                                ttsJson = "$DIR/tts.json",
                                unicodeIndexer = "$DIR/unicode_indexer.bin",
                                voiceStyle = "$DIR/voice.bin"
                            ),
                            numThreads = 2,
                            debug = false,
                            provider = "cpu"
                        ),
                        maxNumSentences = 1,
                        silenceScale = 0.2f
                    )
                    val engine = OfflineTts(app.assets, cfg)
                    tts = engine
                    Log.i(
                        TAG,
                        "neural voice ready in ${SystemClock.elapsedRealtime() - startedAt} ms, " +
                            "sr=${engine.sampleRate()} speakers=${engine.numSpeakers()}"
                    )
                    setState(State.READY)
                } catch (t: Throwable) {
                    Log.w(TAG, "neural voice load failed: " + (t.message ?: t.javaClass.simpleName))
                    tts = null
                    setState(State.FAILED)
                }
            }, "neural-tts-load")
            loadThread = t
            t.start()
        }
    }

    /**
     * 合成并播放一句英文。回调都在调用线程之外触发，调用方自己 post 回主线程。
     *
     * @param rate 1.0 = 正常语速，越大越快（对应前端 0.6x–1.4x）
     */
    fun speak(
        text: String,
        rate: Float,
        onStart: () -> Unit,
        onDone: () -> Unit,
        onError: (String) -> Unit
    ) {
        val engine = tts
        if (engine == null || state != State.READY) {
            onError("not_ready")
            return
        }
        val body = text.trim()
        if (body.isEmpty()) {
            onDone()
            return
        }
        stopFlag.set(false)
        val mySeq = speakSeq.incrementAndGet()
        worker.execute {
            if (stopFlag.get() || speakSeq.get() != mySeq) return@execute
            val startedAt = SystemClock.elapsedRealtime()
            val audio: GeneratedAudio = try {
                engine.generate(body, DEFAULT_SID, rate.coerceIn(0.5f, 2.0f))
            } catch (t: Throwable) {
                Log.w(TAG, "generate failed: " + (t.message ?: t.javaClass.simpleName))
                onError("generate_failed")
                return@execute
            }
            if (stopFlag.get()) return@execute
            if (audio.samples.isEmpty() || audio.sampleRate <= 0) {
                onError("empty_audio")
                return@execute
            }
            val genMs = SystemClock.elapsedRealtime() - startedAt
            val durMs = audio.samples.size * 1000L / audio.sampleRate
            Log.i(TAG, "generated ${durMs}ms audio in ${genMs}ms (${body.take(24)}…)")
            val ok = try {
                play(audio.samples, audio.sampleRate, onStart)
            } catch (t: Throwable) {
                Log.w(TAG, "playback failed: " + (t.message ?: t.javaClass.simpleName))
                false
            }
            releaseTrack()
            if (stopFlag.get()) return@execute
            if (ok) onDone() else onError("play_failed")
        }
    }

    /** 立刻停声（打断 / 手动停止）：毫秒级，不等当前句子读完。 */
    fun stop() {
        stopFlag.set(true)
        val t = track
        track = null
        if (t != null) {
            try {
                if (t.playState == AudioTrack.PLAYSTATE_PLAYING) t.pause()
            } catch (e: Throwable) {
            }
            try {
                t.flush()
            } catch (e: Throwable) {
            }
            try {
                t.stop()
            } catch (e: Throwable) {
            }
            try {
                t.release()
            } catch (e: Throwable) {
            }
        }
    }

    private fun releaseTrack() {
        val t = track
        track = null
        if (t != null) {
            try {
                t.stop()
            } catch (e: Throwable) {
            }
            try {
                t.release()
            } catch (e: Throwable) {
            }
        }
    }

    fun release() {
        stop()
        try {
            tts?.release()
        } catch (e: Throwable) {
        }
        tts = null
        state = State.IDLE
        listener = null
    }

    /** 返回 true 表示这句完整播完（被打断返回 false）。 */
    private fun play(samples: FloatArray, sampleRate: Int, onStart: () -> Unit): Boolean {
        val sr = if (sampleRate > 0) sampleRate else 44100
        val aec = SherpaEngine.isAecPlaybackActive()
        val usage = if (aec) AudioAttributes.USAGE_VOICE_COMMUNICATION else AudioAttributes.USAGE_MEDIA
        val attrs = AudioAttributes.Builder()
            .setUsage(usage)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build()
        val format = AudioFormat.Builder()
            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
            .setSampleRate(sr)
            .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
            .build()
        val minBuf = AudioTrack.getMinBufferSize(
            sr, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT
        )
        val bufBytes = max(minBuf * 2, sr / 4 * 2 * 2)   // 至少约 0.25 秒
        val builder = AudioTrack.Builder()
            .setAudioAttributes(attrs)
            .setAudioFormat(format)
            .setTransferMode(AudioTrack.MODE_STREAM)
            .setBufferSizeInBytes(bufBytes)
        if (aec) {
            val session = SherpaEngine.playbackAudioSessionId()
            if (session > 0) {
                try {
                    builder.setSessionId(session)
                } catch (e: Throwable) {
                }
            }
        }
        val at = builder.build()
        if (at.state != AudioTrack.STATE_INITIALIZED) {
            try {
                at.release()
            } catch (e: Throwable) {
            }
            return false
        }
        track = at
        var started = false
        var written = 0
        try {
            at.play()
            val chunk = 2048
            var i = 0
            val shorts = ShortArray(chunk)
            while (i < samples.size) {
                if (stopFlag.get()) break
                val n = min(chunk, samples.size - i)
                for (k in 0 until n) {
                    val v = (samples[i + k] * 32767f).toInt()
                    shorts[k] = (if (v > 32767) 32767 else if (v < -32768) -32768 else v).toShort()
                }
                val w = at.write(shorts, 0, n)
                if (w <= 0) break
                i += w
                written += w
                if (!started && written > 0) {
                    started = true
                    try {
                        onStart()
                    } catch (e: Throwable) {
                    }
                }
            }
            if (started && !stopFlag.get()) {
                // 等缓冲区里剩下的声音放完，再释放，避免尾音被截掉
                val deadline = SystemClock.elapsedRealtime() + 2000L + (written * 1000L / sr)
                while (!stopFlag.get() &&
                    at.playbackHeadPosition < written &&
                    SystemClock.elapsedRealtime() < deadline
                ) {
                    Thread.sleep(8)
                }
            }
        } catch (t: Throwable) {
            // stop() 会在别的线程 release 掉 AudioTrack，这里当作被打断处理
            return false
        }
        return started && !stopFlag.get()
    }
}
