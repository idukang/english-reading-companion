package com.idukang.readingcompanion

import android.app.Activity
import android.content.ClipData
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.Locale

/**
 * 应用内更新（青鸟 · 英语陪读）。
 *
 * 只用一条固定的官方地址：本仓库的 GitHub Releases 最新版接口。
 *   1. check()                —— 后台查最新 Release，做语义化版本比较，结果交回网页
 *   2. downloadAndInstall()   —— 后台流式下载 APK、回报百分比、核对 SHA-256、唤起系统安装器
 *
 * 安全边界：
 *   · 只接受 https 且主机为 github.com / *.githubusercontent.com 的地址；
 *   · 只下载 .apk，大小有上下限，超过 400MB 立刻中断；
 *   · 同 Release 带 SHA256SUMS.txt 时必须校验通过，否则删包不装；
 *   · 安装前核对 APK 的包名、versionCode 与签名证书和已装应用一致，
 *     即使有人往 Release 里塞了别的安装包也不会被装上（系统安装器也会再拦一次）；
 *   · 不做任何统计上报，检查失败（断网、超时、限流）只静默返回错误，不影响使用。
 */
object AppUpdater {

    const val API_LATEST =
        "https://api.github.com/repos/idukang/english-reading-companion/releases/latest"

    private const val UA = "Qingniao-EnglishReadingCompanion"
    private const val MAX_APK_BYTES = 400L * 1024 * 1024
    private const val MIN_APK_BYTES = 512L * 1024
    private const val MAX_SUMS_BYTES = 64L * 1024
    private const val MAX_NOTES_CHARS = 6000
    private const val UPDATE_DIR = "updates"
    private const val APK_NAME = "update.apk"

    interface Listener {
        /** 检查结果，JSON 字符串：{"status":"update|latest|error",...} */
        fun onUpdateCheck(json: String)

        /** 下载进度：0..100，已下载字节，总字节（未知为 0） */
        fun onUpdateProgress(percent: Int, downloaded: Long, total: Long)

        /** 阶段变化：downloading / verifying / need_permission / installing / error */
        fun onUpdateState(state: String, message: String)
    }

    @Volatile
    private var listener: Listener? = null

    private val main = Handler(Looper.getMainLooper())

    @Volatile
    private var checking = false

    @Volatile
    private var downloading = false

    /** 下载并校验完成、等着用户去开「安装未知应用」权限的那个包 */
    @Volatile
    private var pendingApk: File? = null

    fun attach(l: Listener?) {
        listener = l
    }

    // ================================================================
    // 版本号
    // ================================================================

    /** 把 "v1.6.1" / "1.6" / "1.6.1-beta" 统一成数字段列表 */
    fun parseVersion(v: String?): List<Int> {
        val s = (v ?: "").trim().removePrefix("v").removePrefix("V")
        val core = s.split('-', '+', ' ').firstOrNull() ?: ""
        val parts = ArrayList<Int>(4)
        for (p in core.split('.')) {
            val digits = p.filter { it.isDigit() }
            if (digits.isNotEmpty()) digits.toIntOrNull()?.let { parts.add(it) }
        }
        return if (parts.isEmpty()) listOf(0) else parts
    }

    /** a > b 返回 1，a < b 返回 -1，相同返回 0（缺的段按 0 补齐，1.6 == 1.6.0） */
    fun compareVersions(a: String?, b: String?): Int {
        val pa = parseVersion(a)
        val pb = parseVersion(b)
        val n = maxOf(pa.size, pb.size)
        for (i in 0 until n) {
            val x = if (i < pa.size) pa[i] else 0
            val y = if (i < pb.size) pb[i] else 0
            if (x != y) return if (x > y) 1 else -1
        }
        return 0
    }

    // ================================================================
    // 检查更新
    // ================================================================

    fun check(silent: Boolean) {
        if (checking) return
        checking = true
        Thread(Runnable {
            val result = try {
                fetchLatest()
            } catch (e: Exception) {
                JSONObject().apply {
                    put("status", "error")
                    put("error", friendlyError(e))
                }
            }
            result.put("current", BuildConfig.VERSION_NAME)
            result.put("silent", silent)
            checking = false
            val l = listener ?: return@Runnable
            main.post { l.onUpdateCheck(result.toString()) }
        }, "update-check").start()
    }

    private fun fetchLatest(): JSONObject {
        val conn = (URL(API_LATEST).openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = 8000
            readTimeout = 12000
            instanceFollowRedirects = true
            setRequestProperty("User-Agent", UA)
            setRequestProperty("Accept", "application/vnd.github+json")
        }
        try {
            val code = conn.responseCode
            if (code == 404) {
                return JSONObject().apply {
                    put("status", "error")
                    put("error", "仓库里还没有发布版本")
                }
            }
            if (code == 403 || code == 429) {
                return JSONObject().apply {
                    put("status", "error")
                    put("error", "GitHub 接口访问太频繁，稍后再试")
                }
            }
            if (code !in 200..299) {
                return JSONObject().apply {
                    put("status", "error")
                    put("error", "GitHub 返回 HTTP $code")
                }
            }
            val text = conn.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
            val json = JSONObject(text)
            val tag = json.optString("tag_name", "")
            val body = json.optString("body", "")
            val latest = tag.trim().removePrefix("v").removePrefix("V")

            var apkUrl = ""
            var apkSize = 0L
            var shaUrl = ""
            val assets = json.optJSONArray("assets")
            if (assets != null) {
                for (i in 0 until assets.length()) {
                    val a = assets.optJSONObject(i) ?: continue
                    val name = a.optString("name", "")
                    val url = a.optString("browser_download_url", "")
                    if (name.endsWith(".apk", ignoreCase = true) && apkUrl.isEmpty()) {
                        apkUrl = url
                        apkSize = a.optLong("size", 0L)
                    } else if (name.contains("SHA256SUMS", ignoreCase = true) && shaUrl.isEmpty()) {
                        shaUrl = url
                    }
                }
            }

            val out = JSONObject()
            if (latest.isEmpty() || compareVersions(latest, BuildConfig.VERSION_NAME) <= 0) {
                out.put("status", "latest")
                out.put("latest", if (latest.isEmpty()) BuildConfig.VERSION_NAME else latest)
            } else {
                out.put("status", "update")
                out.put("latest", latest)
                out.put("notes", if (body.length > MAX_NOTES_CHARS) body.substring(0, MAX_NOTES_CHARS) else body)
                out.put("apkUrl", if (isAllowedHttps(apkUrl)) apkUrl else "")
                out.put("shaUrl", if (isAllowedHttps(shaUrl)) shaUrl else "")
                out.put("size", apkSize)
                out.put("publishedAt", json.optString("published_at", ""))
            }
            return out
        } catch (e: Exception) {
            return JSONObject().apply {
                put("status", "error")
                put("error", friendlyError(e))
            }
        } finally {
            try {
                conn.disconnect()
            } catch (e: Exception) {
            }
        }
    }

    private fun friendlyError(e: Exception): String {
        val m = (e.message ?: "").lowercase(Locale.US)
        return when {
            m.contains("timed out") || m.contains("timeout") -> "连接 GitHub 超时，请检查网络"
            m.contains("unable to resolve") || m.contains("unknownhost") || m.contains("no address") ->
                "没有网络，连不上 GitHub"
            m.contains("connect") -> "网络连接失败，请稍后再试"
            else -> "检查更新失败" + if (e.message.isNullOrBlank()) "" else "：${e.message}"
        }
    }

    // ================================================================
    // 下载与安装
    // ================================================================

    fun downloadAndInstall(activity: Activity, apkUrl: String, shaUrl: String) {
        if (downloading) {
            emitState("error", "安装包正在下载，请稍候")
            return
        }
        if (!isAllowedHttps(apkUrl)) {
            emitState("error", "安装包地址不是 GitHub 官方地址，已取消")
            return
        }
        downloading = true
        Thread(Runnable {
            try {
                val dir = File(activity.filesDir, UPDATE_DIR)
                if (!dir.exists() && !dir.mkdirs()) {
                    emitState("error", "无法创建下载目录")
                    return@Runnable
                }
                // 清掉上一次的残留，避免旧包占空间或被误装
                dir.listFiles()?.forEach { it.delete() }
                val part = File(dir, "$APK_NAME.part")
                val apk = File(dir, APK_NAME)
                emitState("downloading", "")

                download(apkUrl, part)
                if (!part.renameTo(apk)) {
                    part.delete()
                    emitState("error", "保存安装包失败")
                    return@Runnable
                }
                if (apk.length() < MIN_APK_BYTES) {
                    apk.delete()
                    emitState("error", "下载的安装包不完整，请重试")
                    return@Runnable
                }

                if (isAllowedHttps(shaUrl)) {
                    emitState("verifying", "")
                    val expected = readExpectedSha(shaUrl)
                    if (expected.isNullOrEmpty()) {
                        emitState("error", "没有拿到校验文件，为安全起见已取消安装")
                        apk.delete()
                        return@Runnable
                    }
                    val actual = sha256(apk)
                    if (!actual.equals(expected, ignoreCase = true)) {
                        apk.delete()
                        emitState("error", "安装包校验不一致（可能下载损坏），已删除，请重试")
                        return@Runnable
                    }
                }

                val pm = activity.packageManager
                val info = archiveInfo(pm, apk)
                if (info == null) {
                    apk.delete()
                    emitState("error", "下载的文件不是有效的安装包，已删除")
                    return@Runnable
                }
                if (info.packageName != activity.packageName) {
                    apk.delete()
                    emitState("error", "安装包的应用名不符，已取消安装")
                    return@Runnable
                }
                val newCode = versionCodeOf(info)
                if (newCode <= BuildConfig.VERSION_CODE) {
                    apk.delete()
                    emitState("error", "这个安装包不比当前版本新，已取消安装")
                    return@Runnable
                }
                val signer = sameSigner(pm, apk, activity.packageName)
                if (signer == false) {
                    apk.delete()
                    emitState("error", "安装包签名与已装应用不一致，已取消安装")
                    return@Runnable
                }

                pendingApk = apk
                if (canInstall(activity)) {
                    pendingApk = null
                    launchInstaller(activity, apk)
                } else {
                    emitState("need_permission", "请在系统设置里允许「青鸟 · 英语陪读」安装应用")
                    openInstallPermissionSettings(activity)
                }
            } catch (e: Exception) {
                emitState("error", friendlyError(e))
            } finally {
                downloading = false
            }
        }, "update-download").start()
    }

    /** 流式下载，返回总字节数（未知为 0），每约 1% 或 400ms 回报一次 */
    private fun download(url: String, target: File): Long {
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = 15000
            readTimeout = 45000
            instanceFollowRedirects = true
            setRequestProperty("User-Agent", UA)
            setRequestProperty("Accept", "application/octet-stream")
        }
        try {
            val code = conn.responseCode
            if (code !in 200..299) throw IllegalStateException("下载失败（HTTP $code）")
            val total = conn.contentLengthLong.let { if (it > 0) it else 0L }
            if (total > MAX_APK_BYTES) throw IllegalStateException("安装包体积异常，已取消")
            var written = 0L
            var lastPct = -1
            var lastAt = 0L
            val buf = ByteArray(64 * 1024)
            FileOutputStream(target).use { out ->
                conn.inputStream.use { input ->
                    while (true) {
                        val n = input.read(buf)
                        if (n <= 0) break
                        out.write(buf, 0, n)
                        written += n
                        if (written > MAX_APK_BYTES) throw IllegalStateException("安装包体积异常，已取消")
                        val pct = if (total > 0) ((written * 100) / total).toInt() else -1
                        val now = System.currentTimeMillis()
                        if (pct != lastPct && now - lastAt > 300) {
                            lastPct = pct
                            lastAt = now
                            emitProgress(if (pct < 0) -1 else pct.coerceIn(0, 100), written, total)
                        }
                    }
                }
                out.flush()
            }
            emitProgress(100, written, if (total > 0) total else written)
            return if (total > 0) total else written
        } finally {
            try {
                conn.disconnect()
            } catch (e: Exception) {
            }
        }
    }

    private fun readExpectedSha(shaUrl: String): String? {
        val conn = (URL(shaUrl).openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = 10000
            readTimeout = 15000
            instanceFollowRedirects = true
            setRequestProperty("User-Agent", UA)
        }
        try {
            if (conn.responseCode !in 200..299) return null
            val text = conn.inputStream.bufferedReader(Charsets.UTF_8).use {
                val sb = StringBuilder()
                var line = it.readLine()
                while (line != null && sb.length < MAX_SUMS_BYTES) {
                    sb.append(line).append('\n')
                    line = it.readLine()
                }
                sb.toString()
            }
            val re = Regex("[0-9a-fA-F]{64}")
            return re.find(text)?.value?.lowercase(Locale.US)
        } finally {
            try {
                conn.disconnect()
            } catch (e: Exception) {
            }
        }
    }

    private fun sha256(file: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buf = ByteArray(64 * 1024)
            while (true) {
                val n = input.read(buf)
                if (n <= 0) break
                md.update(buf, 0, n)
            }
        }
        val bytes = md.digest()
        val sb = StringBuilder(bytes.size * 2)
        for (b in bytes) sb.append(String.format(Locale.US, "%02x", b))
        return sb.toString()
    }

    private fun archiveInfo(pm: PackageManager, apk: File): android.content.pm.PackageInfo? {
        return try {
            @Suppress("DEPRECATION")
            pm.getPackageArchiveInfo(apk.absolutePath, PackageManager.GET_SIGNATURES or PackageManager.GET_META_DATA)
        } catch (e: Exception) {
            null
        }
    }

    private fun versionCodeOf(info: android.content.pm.PackageInfo): Long {
        return if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else {
            @Suppress("DEPRECATION")
            info.versionCode.toLong()
        }
    }

    /** true 一致，false 不一致；null 表示读不出来（交给系统安装器去判断，不阻塞） */
    private fun sameSigner(pm: PackageManager, apk: File, pkg: String): Boolean? {
        return try {
            if (Build.VERSION.SDK_INT >= 28) {
                val info = pm.getPackageArchiveInfo(apk.absolutePath, PackageManager.GET_SIGNING_CERTIFICATES)
                    ?: return null
                val apkSigners = info.signingInfo?.apkContentsSigners ?: return null
                val own = pm.getPackageInfo(pkg, PackageManager.GET_SIGNING_CERTIFICATES).signingInfo
                    ?.apkContentsSigners ?: return null
                if (apkSigners.isEmpty() || own.isEmpty()) return null
                apkSigners.any { a -> own.any { b -> a.toByteArray().contentEquals(b.toByteArray()) } }
            } else {
                @Suppress("DEPRECATION")
                val info = pm.getPackageArchiveInfo(apk.absolutePath, PackageManager.GET_SIGNATURES) ?: return null
                @Suppress("DEPRECATION")
                val own = pm.getPackageInfo(pkg, PackageManager.GET_SIGNATURES)
                @Suppress("DEPRECATION")
                val apkSigs = info.signatures ?: return null
                @Suppress("DEPRECATION")
                val ownSigs = own.signatures ?: return null
                apkSigs.any { a -> ownSigs.any { b -> a.toByteArray().contentEquals(b.toByteArray()) } }
            }
        } catch (e: Exception) {
            null
        }
    }

    // ================================================================
    // 安装权限与系统安装器
    // ================================================================

    fun canInstall(activity: Activity): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            try {
                activity.packageManager.canRequestPackageInstalls()
            } catch (e: Exception) {
                false
            }
        } else {
            true
        }
    }

    fun openInstallPermissionSettings(activity: Activity) {
        main.post {
            val pkgUri = Uri.parse("package:${activity.packageName}")
            val tries = listOf(
                Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, pkgUri),
                Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES),
                Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkgUri)
            )
            for (intent in tries) {
                try {
                    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    activity.startActivity(intent)
                    return@post
                } catch (e: Exception) {
                }
            }
            emitState("error", "这台手机没有找到「安装未知应用」的设置页，请到系统设置里手动允许")
        }
    }

    /** 从系统设置回来时调用：权限拿到了就接着装 */
    fun resumePendingInstall(activity: Activity) {
        val apk = pendingApk ?: return
        if (!apk.exists()) {
            pendingApk = null
            return
        }
        if (canInstall(activity)) {
            pendingApk = null
            launchInstaller(activity, apk)
        }
    }

    private fun launchInstaller(activity: Activity, apk: File) {
        try {
            val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", apk)
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "application/vnd.android.package-archive")
                // 部分 ROM 的安装器只认 ClipData 里的授权，两个都给上最稳
                clipData = ClipData.newRawUri("update.apk", uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            activity.startActivity(intent)
            emitState("installing", "已打开系统安装器，按提示确认安装即可")
        } catch (e: Exception) {
            emitState("error", "打不开系统安装器：${e.message ?: "未知错误"}")
        }
    }

    /** 启动时清掉上一次没装成的包，省空间 */
    fun prune(activity: Activity) {
        try {
            val dir = File(activity.filesDir, UPDATE_DIR)
            dir.listFiles()?.forEach { it.delete() }
            pendingApk = null
        } catch (e: Exception) {
        }
    }

    // ================================================================
    // 回调
    // ================================================================

    private fun emitState(state: String, message: String) {
        val l = listener ?: return
        main.post { l.onUpdateState(state, message) }
    }

    private fun emitProgress(percent: Int, downloaded: Long, total: Long) {
        val l = listener ?: return
        main.post { l.onUpdateProgress(percent, downloaded, total) }
    }

    private fun isAllowedHttps(url: String): Boolean {
        if (url.isBlank()) return false
        return try {
            val u = URL(url.trim())
            if (!u.protocol.equals("https", ignoreCase = true)) return false
            val host = (u.host ?: "").lowercase(Locale.US)
            host == "github.com" || host.endsWith(".githubusercontent.com")
        } catch (e: Exception) {
            false
        }
    }
}
