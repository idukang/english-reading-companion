package com.idukang.readingcompanion

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

/**
 * 耳机后台连麦服务。
 *
 * 作用只有一个：让「像打电话一样聊」在熄屏、切到别的应用时还能继续。
 *  · 前台服务 + 常驻通知（可一键结束对话）
 *  · PARTIAL_WAKE_LOCK：熄屏后 CPU 继续跑 Vosk 和 TTS
 *  · 音频焦点：像通话一样占用媒体焦点，别的 App 不会突然出声打断
 * 识别和朗读本身分别在 SherpaEngine 与 MainActivity 里，这里只负责“别被系统收走”。
 */
class VoiceCompanionService : Service() {

    companion object {
        const val ACTION_START = "com.idukang.readingcompanion.action.VOICE_START"
        const val ACTION_STOP = "com.idukang.readingcompanion.action.VOICE_STOP"
        const val EXTRA_LANG = "lang"
        private const val CHANNEL_ID = "voice_companion"
        private const val NOTIF_ID = 4101

        @Volatile var isActive: Boolean = false
            private set
    }

    private var wakeLock: PowerManager.WakeLock? = null
    private var audioManager: AudioManager? = null
    private var focusRequest: AudioFocusRequest? = null
    private var haveFocus = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        audioManager = getSystemService(Context.AUDIO_SERVICE) as? AudioManager
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            notifyJs("stopped", "已结束耳机对话")
            stopSelf()
            return START_NOT_STICKY
        }

        val notif = buildNotification()
        try {
            if (Build.VERSION.SDK_INT >= 30) {
                startForeground(
                    NOTIF_ID,
                    notif,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
                )
            } else if (Build.VERSION.SDK_INT >= 29) {
                startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
            } else {
                startForeground(NOTIF_ID, notif)
            }
        } catch (t: Throwable) {
            // 极少数 ROM 会拒绝带 microphone 类型的前台服务：退回普通前台通知，别让对话直接挂掉
            try {
                startForeground(NOTIF_ID, notif)
            } catch (t2: Throwable) {
                notifyJs("error", "无法在后台保持麦克风：" + (t2.message ?: ""))
                stopSelf()
                return START_NOT_STICKY
            }
        }

        isActive = true
        acquireWakeLock()
        acquireFocus()

        val lang = intent?.getStringExtra(EXTRA_LANG) ?: SherpaEngine.MODE_AUTO
        SherpaEngine.setLanguageMode(lang)
        notifyJs("active", "")
        return START_NOT_STICKY
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        notifyJs("stopped", "应用被关闭，耳机对话已结束")
        stopSelf()
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        isActive = false
        releaseFocus()
        releaseWakeLock()
        SherpaEngine.stopListening()
        notifyJs("stopped", "")
        super.onDestroy()
    }

    // ---------------- 唤醒锁 ----------------

    private fun acquireWakeLock() {
        if (wakeLock != null) return
        try {
            val pm = getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return
            val wl = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "english-reading-companion:voice")
            wl.setReferenceCounted(false)
            wl.acquire()
            wakeLock = wl
        } catch (t: Throwable) {
            wakeLock = null
        }
    }

    private fun releaseWakeLock() {
        try {
            wakeLock?.release()
        } catch (t: Throwable) {
        }
        wakeLock = null
    }

    // ---------------- 音频焦点 ----------------

    private fun acquireFocus() {
        val am = audioManager ?: return
        try {
            if (Build.VERSION.SDK_INT >= 26) {
                val attrs = AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build()
                val req = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                    .setAudioAttributes(attrs)
                    .setWillPauseWhenDucked(false)
                    .setOnAudioFocusChangeListener { change -> onFocusChange(change) }
                    .build()
                focusRequest = req
                haveFocus = am.requestAudioFocus(req) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
            } else {
                @Suppress("DEPRECATION")
                haveFocus = am.requestAudioFocus(
                    { change -> onFocusChange(change) },
                    AudioManager.STREAM_MUSIC,
                    AudioManager.AUDIOFOCUS_GAIN
                ) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
            }
        } catch (t: Throwable) {
            haveFocus = false
        }
    }

    private fun releaseFocus() {
        val am = audioManager ?: return
        try {
            if (Build.VERSION.SDK_INT >= 26) {
                focusRequest?.let { am.abandonAudioFocusRequest(it) }
            } else {
                @Suppress("DEPRECATION")
                am.abandonAudioFocus { }
            }
        } catch (t: Throwable) {
        }
        focusRequest = null
        haveFocus = false
    }

    private fun onFocusChange(change: Int) {
        when (change) {
            AudioManager.AUDIOFOCUS_LOSS -> {
                SherpaEngine.stopListening()
                notifyJs("focus-lost", "别的应用抢走了声音，对话已暂停")
            }
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> {
                SherpaEngine.stopListening()
                notifyJs("paused", "有来电或别的应用在播放，先暂停听你说")
            }
            AudioManager.AUDIOFOCUS_GAIN -> notifyJs("focus-gain", "")
        }
    }

    // ---------------- 通知 ----------------

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < 26) return
        try {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (nm.getNotificationChannel(CHANNEL_ID) != null) return
            val ch = NotificationChannel(
                CHANNEL_ID,
                "耳机语音对话",
                NotificationManager.IMPORTANCE_LOW
            )
            ch.description = "熄屏后继续用耳机和 AI 陪练对话"
            ch.setShowBadge(false)
            nm.createNotificationChannel(ch)
        } catch (t: Throwable) {
        }
    }

    private fun buildNotification(): Notification {
        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val stop = PendingIntent.getService(
            this,
            1,
            Intent(this, VoiceCompanionService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val builder = if (Build.VERSION.SDK_INT >= 26) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        return builder
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle("青鸟 · 英语陪读 · 耳机语音对话中")
            .setContentText("像打电话一样聊：随时打断，说中文提问也听得懂")
            .setOngoing(true)
            .setShowWhen(false)
            .setContentIntent(open)
            .addAction(
                Notification.Action.Builder(
                    android.R.drawable.ic_menu_close_clear_cancel, "结束对话", stop
                ).build()
            )
            .build()
    }

    private fun notifyJs(state: String, msg: String) {
        val activity = MainActivity.instance ?: return
        activity.emitJs(
            "window.Native && window.Native.onVoiceService && window.Native.onVoiceService(" +
                jsQuoted(state) + "," + jsQuoted(msg) + ")"
        )
    }

    private fun jsQuoted(value: String): String {
        val sb = StringBuilder("\"")
        for (c in value) {
            when {
                c == '\\' -> sb.append("\\\\")
                c == '"' -> sb.append("\\\"")
                c == '\n' -> sb.append("\\n")
                c == '\r' -> sb.append("\\r")
                c < ' ' -> sb.append(String.format("\\u%04x", c.code))
                else -> sb.append(c)
            }
        }
        sb.append('"')
        return sb.toString()
    }
}
