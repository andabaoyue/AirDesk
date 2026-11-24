package dev.airdesk.airdesk_app

import android.app.Activity
import android.app.PictureInPictureParams
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.ActivityInfo
import android.media.AudioManager
import android.net.Uri
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.PowerManager
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.provider.Settings
import android.util.Log
import android.util.Rational
import android.view.InputDevice
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.WindowManager
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodChannel
import org.webrtc.NetworkChangeDetector
import org.webrtc.NetworkChangeDetectorFactory
import org.webrtc.NetworkMonitor
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.net.Inet4Address
import java.net.InetAddress
import java.net.NetworkInterface
import java.util.concurrent.Executors

class MainActivity : FlutterActivity() {
    companion object {
        private const val METHOD_CHANNEL = "dev.airdesk.app/native"
        private const val EVENT_CHANNEL = "dev.airdesk.app/input_events"
        private const val REQ_PICK_FILE = 47821
        private const val REQ_SCAN_QR = 47822
        private const val MAX_FILE_TRANSFER_BYTES = 500L * 1024 * 1024
    }

    private var eventSink: EventChannel.EventSink? = null
    private var captureExternalInput = false
    private var pointerCaptureEnabled = false
    private var capturedMouseButtons = 0
    private var pendingFilePickResult: MethodChannel.Result? = null
    private var pendingQrScanResult: MethodChannel.Result? = null
    private val fileIoExecutor = Executors.newSingleThreadExecutor()
    @Volatile
    private var allowAllOverlayTun = false
    @Volatile
    private var lanOnlyNetFilter = false
    private var wifiLock: WifiManager.WifiLock? = null
    private var wakeLock: PowerManager.WakeLock? = null

    private fun isClashFakeIpv4(host: String): Boolean {
        return host.startsWith("198.18.") || host.startsWith("198.19.") || host.startsWith("172.19.")
    }

    private fun isTailscaleIpv4(host: String): Boolean {
        if (!host.startsWith("100.")) return false
        val parts = host.split('.')
        if (parts.size < 2) return false
        val second = parts[1].toIntOrNull() ?: return false
        return second in 64..127
    }

    private fun isTailscaleIpv6(host: String): Boolean {
        return host.lowercase().startsWith("fd7a:115c:a1e0:")
    }

    private fun enumerateOsNetworkInterfaces(): MutableList<NetworkChangeDetector.NetworkInformation> {
        val list = mutableListOf<NetworkChangeDetector.NetworkInformation>()
        var handleCounter = 1001L
        try {
            val interfaces = NetworkInterface.getNetworkInterfaces() ?: return list
            for (iface in interfaces.toList()) {
                val name = iface.name ?: continue
                if (!iface.isUp || iface.isLoopback) continue
                val lower = name.lowercase()
                if (lower == "lo" ||
                    lower.startsWith("ppp") ||
                    lower.startsWith("dummy") ||
                    lower.startsWith("ifb") ||
                    lower.startsWith("sit") ||
                    lower.startsWith("ip6tnl") ||
                    lower.startsWith("gre") ||
                    lower.startsWith("erspan") ||
                    lower.startsWith("ip_vti")
                ) {
                    continue
                }
                if (lanOnlyNetFilter &&
                    (lower.startsWith("rmnet") ||
                        lower.startsWith("ccmni") ||
                        lower.startsWith("pdp") ||
                        lower.startsWith("clat"))
                ) {
                    continue
                }

                val isTun = lower.startsWith("tun")
                val isOverlayIface = isTun ||
                    lower.startsWith("wg") ||
                    lower.startsWith("zt") ||
                    lower.startsWith("tailscale")

                val validIps = mutableListOf<InetAddress>()
                for (addr in iface.inetAddresses.toList()) {
                    if (addr.isLoopbackAddress || addr.isLinkLocalAddress || addr.isMulticastAddress) continue
                    if (lanOnlyNetFilter && !isOverlayIface && addr !is Inet4Address) continue
                    val host = addr.hostAddress?.substringBefore('%') ?: ""
                    if (addr is Inet4Address && isClashFakeIpv4(host)) {
                        continue
                    }
                    if (isTun) {
                        val accept = isTailscaleIpv4(host) || isTailscaleIpv6(host) || allowAllOverlayTun
                        if (!accept) continue
                    }
                    validIps.add(addr)
                }
                if (validIps.isEmpty()) continue

                val connType = when {
                    isOverlayIface || lower.startsWith("eth") || lower.startsWith("rndis") || lower.startsWith("usb") ->
                        NetworkChangeDetector.ConnectionType.CONNECTION_ETHERNET
                    lower.startsWith("rmnet") || lower.startsWith("ccmni") ->
                        NetworkChangeDetector.ConnectionType.CONNECTION_5G
                    else ->
                        NetworkChangeDetector.ConnectionType.CONNECTION_WIFI
                }
                val ipArr = validIps.map { NetworkChangeDetector.IPAddress(it.address) }.toTypedArray()
                val handle = handleCounter++
                list.add(
                    NetworkChangeDetector.NetworkInformation(
                        name,
                        connType,
                        NetworkChangeDetector.ConnectionType.CONNECTION_NONE,
                        handle,
                        ipArr,
                        NetworkChangeDetector.NetworkSlice.NO_SLICE
                    )
                )
                Log.i("AirDeskNet", "iface=$name type=$connType handle=$handle ips=${validIps.map { it.hostAddress }}")
            }
        } catch (e: Exception) {
            Log.w("AirDeskNet", "enumerateOsNetworkInterfaces failed: ${e.message}")
        }
        return list
    }

    private fun queryOverlayNetworkInfo(): Map<String, Any?> {
        var tailscaleIp: String? = null
        val overlayIps = mutableListOf<String>()
        try {
            val interfaces = NetworkInterface.getNetworkInterfaces()
            if (interfaces != null) {
                for (iface in interfaces.toList()) {
                    if (!iface.isUp || iface.isLoopback) continue
                    val lower = (iface.name ?: "").lowercase()
                    val isKnownOverlayIface = lower.startsWith("zt") ||
                        lower.startsWith("wg") ||
                        lower.startsWith("tailscale")
                    for (addr in iface.inetAddresses.toList()) {
                        if (addr.isLoopbackAddress || addr.isLinkLocalAddress || addr.isMulticastAddress) continue
                        val host = addr.hostAddress?.substringBefore('%') ?: continue
                        if (addr is Inet4Address && isClashFakeIpv4(host)) continue
                        if (isTailscaleIpv4(host)) {
                            if (tailscaleIp == null) tailscaleIp = host
                            if (!overlayIps.contains(host)) overlayIps.add(host)
                        } else if (isTailscaleIpv6(host) || isKnownOverlayIface) {
                            if (!overlayIps.contains(host)) overlayIps.add(host)
                        }
                    }
                }
            }
        } catch (e: Exception) {
            Log.w("AirDeskNet", "queryOverlayNetworkInfo failed: ${e.message}")
        }
        return mapOf(
            "hasTailscale" to (tailscaleIp != null),
            "tailscaleIp" to tailscaleIp,
            "overlayIps" to overlayIps
        )
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        volumeControlStream = AudioManager.STREAM_MUSIC
    }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        // Android's ConnectivityManager.getAllNetworks() omits SoftAP/hotspot interfaces (wlan2/ap0)
        // and VPNs interfere with NetworkMonitor binding. Enumerate real OS interfaces directly so
        // libwebrtc sees wlan2 / ap0 / wlan0 without ConnectivityManager filtering.
        NetworkMonitor.getInstance().setNetworkChangeDetectorFactory(
            object : NetworkChangeDetectorFactory {
                override fun create(
                    observer: NetworkChangeDetector.Observer,
                    context: Context
                ): NetworkChangeDetector {
                    return object : NetworkChangeDetector {
                        override fun getCurrentConnectionType(): NetworkChangeDetector.ConnectionType =
                            NetworkChangeDetector.ConnectionType.CONNECTION_WIFI

                        override fun supportNetworkCallback(): Boolean = false

                        override fun getActiveNetworkList(): MutableList<NetworkChangeDetector.NetworkInformation> =
                            enumerateOsNetworkInterfaces()

                        override fun destroy() {}
                    }
                }
            }
        )
        super.configureFlutterEngine(flutterEngine)
        fileIoExecutor.execute {
            try {
                cacheDir.listFiles()?.forEach { f ->
                    if (f.isFile && f.name.startsWith("airdesk_upload_")) {
                        f.delete()
                    }
                }
            } catch (_: Exception) {}
        }

        EventChannel(flutterEngine.dartExecutor.binaryMessenger, EVENT_CHANNEL)
            .setStreamHandler(object : EventChannel.StreamHandler {
                override fun onListen(arguments: Any?, events: EventChannel.EventSink?) {
                    eventSink = events
                }

                override fun onCancel(arguments: Any?) {
                    eventSink = null
                }
            })

        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, METHOD_CHANNEL)
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "getDeviceModel" -> {
                        val brand = Build.MANUFACTURER?.trim() ?: ""
                        val model = Build.MODEL?.trim() ?: "Android"
                        val label = if (model.lowercase().startsWith(brand.lowercase())) {
                            model
                        } else {
                            "$brand $model".trim()
                        }
                        result.success(label)
                    }
                    "enterStreamFullscreen" -> {
                        runOnUiThread { enterFullscreenMode() }
                        result.success(true)
                    }
                    "exitStreamFullscreen" -> {
                        runOnUiThread { exitFullscreenMode() }
                        result.success(true)
                    }
                    "setLowLatencyLocks" -> {
                        val enabled = call.argument<Boolean>("enabled") ?: false
                        setLowLatencyLocks(enabled)
                        result.success(true)
                    }
                    "ensureMediaAudioMode" -> {
                        runOnUiThread { ensureMediaAudioMode() }
                        result.success(true)
                    }
                    "setCaptureExternalInput" -> {
                        captureExternalInput = call.argument<Boolean>("enabled") ?: false
                        runOnUiThread { applyPointerCaptureState() }
                        result.success(true)
                    }
                    "setPointerCapture" -> {
                        pointerCaptureEnabled = call.argument<Boolean>("enabled") ?: false
                        runOnUiThread { applyPointerCaptureState() }
                        result.success(true)
                    }
                    "enterPipMode" -> {
                        val w = (call.argument<Int>("width") ?: 16).coerceAtLeast(1)
                        val h = (call.argument<Int>("height") ?: 9).coerceAtLeast(1)
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                            try {
                                val params = PictureInPictureParams.Builder()
                                    .setAspectRatio(Rational(w, h))
                                    .build()
                                val ok = enterPictureInPictureMode(params)
                                result.success(ok)
                            } catch (_: Exception) {
                                result.success(false)
                            }
                        } else {
                            result.success(false)
                        }
                    }
                    "isIgnoringBatteryOptimizations" -> {
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
                            result.success(pm.isIgnoringBatteryOptimizations(packageName))
                        } else {
                            result.success(true)
                        }
                    }
                    "requestIgnoreBatteryOptimizations" -> {
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                            try {
                                val intent = Intent(
                                    Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                                    Uri.parse("package:$packageName")
                                )
                                startActivity(intent)
                            } catch (_: Exception) {
                            }
                        }
                        result.success(true)
                    }
                    "setAllowOverlayTun" -> {
                        allowAllOverlayTun = call.argument<Boolean>("enabled") ?: false
                        result.success(true)
                    }
                    "setLanOnlyNetFilter" -> {
                        lanOnlyNetFilter = call.argument<Boolean>("enabled") ?: false
                        result.success(true)
                    }
                    "getOverlayNetworkInfo" -> {
                        result.success(queryOverlayNetworkInfo())
                    }
                    "pickFileForTransfer" -> {
                        if (pendingFilePickResult != null) {
                            result.error("BUSY", "File picker already open", null)
                            return@setMethodCallHandler
                        }
                        pendingFilePickResult = result
                        try {
                            val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                                addCategory(Intent.CATEGORY_OPENABLE)
                                type = "*/*"
                            }
                            @Suppress("DEPRECATION")
                            startActivityForResult(intent, REQ_PICK_FILE)
                        } catch (e: Exception) {
                            pendingFilePickResult = null
                            result.error("PICK_FAILED", e.message, null)
                        }
                    }
                    "saveFileToDownloads" -> {
                        val tempPath = call.argument<String>("tempPath") ?: ""
                        val fileName = call.argument<String>("fileName") ?: "airdesk-file.bin"
                        val mimeType = call.argument<String>("mimeType") ?: "application/octet-stream"
                        saveTempFileToDownloadsAsync(tempPath, fileName, mimeType, result)
                    }
                    "scanQrCode" -> {
                        if (pendingQrScanResult != null) {
                            result.error("BUSY", "QR scanner already open", null)
                            return@setMethodCallHandler
                        }
                        pendingQrScanResult = result
                        try {
                            val intent = Intent(this@MainActivity, QrScanActivity::class.java)
                            @Suppress("DEPRECATION")
                            startActivityForResult(intent, REQ_SCAN_QR)
                        } catch (e: Exception) {
                            pendingQrScanResult = null
                            result.error("SCAN_FAILED", e.message, null)
                        }
                    }
                    else -> result.notImplemented()
                }
            }
    }

    private fun enterFullscreenMode() {
        requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
        WindowCompat.setDecorFitsSystemWindows(window, false)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            val lp = window.attributes
            lp.layoutInDisplayCutoutMode =
                WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
            window.attributes = lp
        }
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        val controller = WindowInsetsControllerCompat(window, window.decorView)
        controller.systemBarsBehavior =
            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        controller.hide(WindowInsetsCompat.Type.systemBars())
    }

    private fun exitFullscreenMode() {
        requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        val controller = WindowInsetsControllerCompat(window, window.decorView)
        controller.show(WindowInsetsCompat.Type.systemBars())
    }

    private fun ensureMediaAudioMode() {
        try {
            val am = getSystemService(Context.AUDIO_SERVICE) as? AudioManager
            if (am != null) {
                am.mode = AudioManager.MODE_NORMAL
                @Suppress("DEPRECATION")
                am.isSpeakerphoneOn = false
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    try {
                        am.clearCommunicationDevice()
                    } catch (_: Exception) {}
                }
            }
        } catch (e: Exception) {
            Log.w("AirDeskAudio", "ensureMediaAudioMode failed: ${e.message}")
        }
        volumeControlStream = AudioManager.STREAM_MUSIC
    }

    private fun setLowLatencyLocks(enabled: Boolean) {
        if (enabled) {
            if (wifiLock == null) {
                val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
                if (wm != null) {
                    val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                        WifiManager.WIFI_MODE_FULL_LOW_LATENCY
                    } else {
                        @Suppress("DEPRECATION")
                        WifiManager.WIFI_MODE_FULL_HIGH_PERF
                    }
                    wifiLock = wm.createWifiLock(mode, "AirDesk:LowLatencyWifi").apply {
                        setReferenceCounted(false)
                        if (!isHeld) acquire()
                    }
                }
            } else if (wifiLock?.isHeld == false) {
                wifiLock?.acquire()
            }

            if (wakeLock == null) {
                val pm = getSystemService(Context.POWER_SERVICE) as? PowerManager
                if (pm != null) {
                    wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "AirDesk:StreamWake").apply {
                        setReferenceCounted(false)
                        if (!isHeld) acquire(4 * 60 * 60 * 1000L)
                    }
                }
            }
        } else {
            try {
                if (wifiLock?.isHeld == true) wifiLock?.release()
            } catch (_: Exception) {}
            try {
                if (wakeLock?.isHeld == true) wakeLock?.release()
            } catch (_: Exception) {}
        }
    }

    @Suppress("DEPRECATION")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode == REQ_SCAN_QR) {
            val cb = pendingQrScanResult
            pendingQrScanResult = null
            if (cb == null) return
            if (resultCode == Activity.RESULT_OK) {
                cb.success(data?.getStringExtra(QrScanActivity.EXTRA_QR_TEXT))
            } else {
                cb.success(null)
            }
            return
        }
        if (requestCode == REQ_PICK_FILE) {
            val cb = pendingFilePickResult
            pendingFilePickResult = null
            if (cb == null) return
            val uri = data?.data
            if (resultCode != Activity.RESULT_OK || uri == null) {
                cb.success(null)
                return
            }
            fileIoExecutor.execute {
                var outFile: File? = null
                try {
                    var displayName = "airdesk-file.bin"
                    var declaredSize = -1L
                    contentResolver.query(uri, null, null, null, null)?.use { cursor ->
                        if (cursor.moveToFirst()) {
                            val nameIdx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                            if (nameIdx >= 0) {
                                val rawName = cursor.getString(nameIdx)
                                if (!rawName.isNullOrBlank()) displayName = rawName
                            }
                            val sizeIdx = cursor.getColumnIndex(OpenableColumns.SIZE)
                            if (sizeIdx >= 0 && !cursor.isNull(sizeIdx)) {
                                declaredSize = cursor.getLong(sizeIdx)
                            }
                        }
                    }
                    if (declaredSize > MAX_FILE_TRANSFER_BYTES) {
                        throw IllegalArgumentException("文件超过 500MB 上限")
                    }
                    val safeName = sanitizeLocalFileName(displayName)
                    val targetFile = File(cacheDir, "airdesk_upload_${System.currentTimeMillis()}_$safeName")
                    outFile = targetFile
                    var copiedBytes = 0L
                    contentResolver.openInputStream(uri)?.use { input ->
                        FileOutputStream(targetFile).use { output ->
                            val buf = ByteArray(16384)
                            while (true) {
                                val n = input.read(buf)
                                if (n <= 0) break
                                copiedBytes += n
                                if (copiedBytes > MAX_FILE_TRANSFER_BYTES) {
                                    throw IllegalArgumentException("文件超过 500MB 上限")
                                }
                                output.write(buf, 0, n)
                            }
                            output.flush()
                        }
                    } ?: throw IllegalStateException("Cannot open selected file")
                    val finalSize = if (copiedBytes > 0) copiedBytes else declaredSize.coerceAtLeast(0L)
                    val mime = contentResolver.getType(uri) ?: "application/octet-stream"
                    runOnUiThread {
                        cb.success(
                            mapOf(
                                "path" to targetFile.absolutePath,
                                "name" to safeName,
                                "size" to finalSize,
                                "mime" to mime
                            )
                        )
                    }
                } catch (e: Exception) {
                    try {
                        outFile?.let { if (it.exists()) it.delete() }
                    } catch (_: Exception) {}
                    runOnUiThread {
                        cb.error("COPY_FAILED", e.message ?: "Failed to read file", null)
                    }
                }
            }
            return
        }
        super.onActivityResult(requestCode, resultCode, data)
    }

    private fun sanitizeLocalFileName(name: String): String {
        val cleaned = name
            .replace(Regex("[<>:\"/\\\\|?*\\x00-\\x1f]"), "_")
            .trimStart('.')
            .trim()
        val limited = if (cleaned.length > 160) cleaned.substring(0, 160) else cleaned
        return limited.ifEmpty { "airdesk-file.bin" }
    }

    private fun saveTempFileToDownloadsAsync(
        tempPath: String,
        rawName: String,
        mimeType: String,
        result: MethodChannel.Result
    ) {
        fileIoExecutor.execute {
            val src = File(tempPath)
            if (!src.exists()) {
                runOnUiThread {
                    result.success(mapOf("ok" to false, "error" to "Temp file missing"))
                }
                return@execute
            }
            val safeName = sanitizeLocalFileName(rawName)
            val effectiveMime = mimeType.ifBlank { "application/octet-stream" }
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    val values = ContentValues().apply {
                        put(MediaStore.Downloads.DISPLAY_NAME, safeName)
                        put(MediaStore.Downloads.MIME_TYPE, effectiveMime)
                        put(MediaStore.Downloads.RELATIVE_PATH, "${Environment.DIRECTORY_DOWNLOADS}/AirDesk")
                        put(MediaStore.Downloads.IS_PENDING, 1)
                    }
                    val uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                        ?: throw IllegalStateException("MediaStore insert returned null")
                    try {
                        contentResolver.openOutputStream(uri)?.use { out ->
                            FileInputStream(src).use { inp ->
                                val buf = ByteArray(16384)
                                while (true) {
                                    val n = inp.read(buf)
                                    if (n <= 0) break
                                    out.write(buf, 0, n)
                                }
                                out.flush()
                            }
                        } ?: throw IllegalStateException("Failed to open MediaStore output stream")
                        val doneValues = ContentValues().apply {
                            put(MediaStore.Downloads.IS_PENDING, 0)
                        }
                        contentResolver.update(uri, doneValues, null, null)
                        var actualName = safeName
                        contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
                            ?.use { c ->
                                if (c.moveToFirst()) {
                                    val idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                                    if (idx >= 0) {
                                        val qn = c.getString(idx)
                                        if (!qn.isNullOrBlank()) actualName = qn
                                    }
                                }
                            }
                        src.delete()
                        runOnUiThread {
                            result.success(
                                mapOf(
                                    "ok" to true,
                                    "savedName" to actualName,
                                    "displayPath" to "Download/AirDesk/$actualName"
                                )
                            )
                        }
                    } catch (inner: Exception) {
                        try {
                            contentResolver.delete(uri, null, null)
                        } catch (_: Exception) {}
                        throw inner
                    }
                } else {
                    @Suppress("DEPRECATION")
                    val downloadsDir = File(
                        Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS),
                        "AirDesk"
                    )
                    if (!downloadsDir.exists()) downloadsDir.mkdirs()
                    var dest = File(downloadsDir, safeName)
                    var idx = 1
                    val dot = safeName.lastIndexOf('.')
                    val stem = if (dot > 0) safeName.substring(0, dot) else safeName
                    val ext = if (dot > 0) safeName.substring(dot) else ""
                    while (dest.exists()) {
                        dest = File(downloadsDir, "$stem ($idx)$ext")
                        idx++
                    }
                    FileInputStream(src).use { inp ->
                        FileOutputStream(dest).use { out ->
                            val buf = ByteArray(16384)
                            while (true) {
                                val n = inp.read(buf)
                                if (n <= 0) break
                                out.write(buf, 0, n)
                            }
                            out.flush()
                        }
                    }
                    src.delete()
                    runOnUiThread {
                        result.success(
                            mapOf(
                                "ok" to true,
                                "savedName" to dest.name,
                                "displayPath" to dest.absolutePath
                            )
                        )
                    }
                }
            } catch (e: Exception) {
                runOnUiThread {
                    result.success(mapOf("ok" to false, "error" to (e.message ?: "Save failed")))
                }
            }
        }
    }

    override fun onDestroy() {
        fileIoExecutor.shutdownNow()
        setLowLatencyLocks(false)
        super.onDestroy()
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (captureExternalInput && eventSink != null) {
            val isExternal = (event.source and InputDevice.SOURCE_KEYBOARD) == InputDevice.SOURCE_KEYBOARD &&
                event.deviceId > 0 &&
                event.device?.isVirtual == false
            // Intercept hardware Back/Escape/Tab/Win/Function keys and physical mouse secondary button
            if (event.keyCode == KeyEvent.KEYCODE_BACK &&
                (event.source and InputDevice.SOURCE_MOUSE) == InputDevice.SOURCE_MOUSE
            ) {
                val state = if (event.action == KeyEvent.ACTION_DOWN) "down" else "up"
                eventSink?.success(mapOf("t" to "m:btn", "button" to "right", "state" to state))
                return true
            }
            if (isExternal) {
                val code = mapKeyCodeToWebCode(event.keyCode)
                if (code != null && (event.action == KeyEvent.ACTION_DOWN || event.action == KeyEvent.ACTION_UP)) {
                    if (event.repeatCount == 0 || event.action == KeyEvent.ACTION_DOWN) {
                        eventSink?.success(
                            mapOf(
                                "t" to if (event.action == KeyEvent.ACTION_DOWN) "k:down" else "k:up",
                                "code" to code
                            )
                        )
                    }
                    return true
                }
            }
        }
        return super.dispatchKeyEvent(event)
    }

    private fun releaseCapturedMouseButtons() {
        val prev = capturedMouseButtons
        if (prev == 0) return
        capturedMouseButtons = 0
        if ((prev and MotionEvent.BUTTON_PRIMARY) != 0) {
            eventSink?.success(mapOf("t" to "m:btn", "button" to "left", "state" to "up"))
        }
        if ((prev and (MotionEvent.BUTTON_SECONDARY or MotionEvent.BUTTON_BACK)) != 0) {
            eventSink?.success(mapOf("t" to "m:btn", "button" to "right", "state" to "up"))
        }
        if ((prev and MotionEvent.BUTTON_TERTIARY) != 0) {
            eventSink?.success(mapOf("t" to "m:btn", "button" to "middle", "state" to "up"))
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (!hasFocus) {
            releaseCapturedMouseButtons()
        }
    }

    private fun applyPointerCaptureState() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val decor = window?.decorView ?: return
        if (captureExternalInput && pointerCaptureEnabled) {
            decor.isFocusable = true
            decor.isFocusableInTouchMode = true
            decor.setOnCapturedPointerListener { _, event ->
                handleCapturedPointerEvent(event)
            }
            decor.requestFocus()
            if (!decor.hasPointerCapture()) {
                decor.requestPointerCapture()
            }
        } else {
            releaseCapturedMouseButtons()
            decor.setOnCapturedPointerListener(null)
            if (decor.hasPointerCapture()) {
                decor.releasePointerCapture()
            }
        }
    }

    private fun handleCapturedPointerEvent(event: MotionEvent): Boolean {
        if (!captureExternalInput || eventSink == null) return false

        val buttons = event.buttonState
        if (buttons != capturedMouseButtons) {
            val prev = capturedMouseButtons
            capturedMouseButtons = buttons

            val primaryNow = (buttons and MotionEvent.BUTTON_PRIMARY) != 0
            val primaryPrev = (prev and MotionEvent.BUTTON_PRIMARY) != 0
            if (primaryNow != primaryPrev) {
                eventSink?.success(
                    mapOf("t" to "m:btn", "button" to "left", "state" to if (primaryNow) "down" else "up")
                )
            }

            val secondaryNow = (buttons and (MotionEvent.BUTTON_SECONDARY or MotionEvent.BUTTON_BACK)) != 0
            val secondaryPrev = (prev and (MotionEvent.BUTTON_SECONDARY or MotionEvent.BUTTON_BACK)) != 0
            if (secondaryNow != secondaryPrev) {
                eventSink?.success(
                    mapOf("t" to "m:btn", "button" to "right", "state" to if (secondaryNow) "down" else "up")
                )
            }

            val middleNow = (buttons and MotionEvent.BUTTON_TERTIARY) != 0
            val middlePrev = (prev and MotionEvent.BUTTON_TERTIARY) != 0
            if (middleNow != middlePrev) {
                eventSink?.success(
                    mapOf("t" to "m:btn", "button" to "middle", "state" to if (middleNow) "down" else "up")
                )
            }
        }

        when (event.actionMasked) {
            MotionEvent.ACTION_MOVE -> {
                val dx = event.getAxisValue(MotionEvent.AXIS_X)
                val dy = event.getAxisValue(MotionEvent.AXIS_Y)
                if (dx != 0f || dy != 0f) {
                    eventSink?.success(mapOf("t" to "m:rel", "dx" to dx.toDouble(), "dy" to dy.toDouble()))
                }
            }
            MotionEvent.ACTION_SCROLL -> {
                val vScroll = event.getAxisValue(MotionEvent.AXIS_VSCROLL)
                if (vScroll != 0f) {
                    eventSink?.success(mapOf("t" to "m:whl", "dy" to (-vScroll).toDouble()))
                }
            }
        }
        return true
    }

    override fun dispatchGenericMotionEvent(event: MotionEvent): Boolean {
        if (captureExternalInput && eventSink != null) {
            val isMouse = (event.source and InputDevice.SOURCE_MOUSE) == InputDevice.SOURCE_MOUSE
            if (isMouse && pointerCaptureEnabled && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val decor = window?.decorView
                if (decor != null && !decor.hasPointerCapture()) {
                    applyPointerCaptureState()
                }
            }
            if (isMouse && event.action == MotionEvent.ACTION_SCROLL) {
                val vScroll = event.getAxisValue(MotionEvent.AXIS_VSCROLL)
                if (vScroll != 0f) {
                    eventSink?.success(mapOf("t" to "m:whl", "dy" to (-vScroll).toDouble()))
                    return true
                }
            }
        }
        return super.dispatchGenericMotionEvent(event)
    }

    private fun mapKeyCodeToWebCode(keyCode: Int): String? {
        return when (keyCode) {
            KeyEvent.KEYCODE_ESCAPE -> "Escape"
            KeyEvent.KEYCODE_TAB -> "Tab"
            KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> "Enter"
            KeyEvent.KEYCODE_DEL -> "Backspace"
            KeyEvent.KEYCODE_FORWARD_DEL -> "Delete"
            KeyEvent.KEYCODE_SPACE -> "Space"
            KeyEvent.KEYCODE_CAPS_LOCK -> "CapsLock"
            KeyEvent.KEYCODE_INSERT -> "Insert"
            KeyEvent.KEYCODE_SYSRQ -> "PrintScreen"
            KeyEvent.KEYCODE_NUMPAD_ADD -> "NumpadAdd"
            KeyEvent.KEYCODE_NUMPAD_SUBTRACT -> "NumpadSubtract"
            KeyEvent.KEYCODE_NUMPAD_MULTIPLY -> "NumpadMultiply"
            KeyEvent.KEYCODE_NUMPAD_DIVIDE -> "NumpadDivide"
            KeyEvent.KEYCODE_NUMPAD_DOT -> "NumpadDecimal"
            in KeyEvent.KEYCODE_NUMPAD_0..KeyEvent.KEYCODE_NUMPAD_9 -> {
                val d = keyCode - KeyEvent.KEYCODE_NUMPAD_0
                "Numpad$d"
            }
            KeyEvent.KEYCODE_CTRL_LEFT -> "ControlLeft"
            KeyEvent.KEYCODE_CTRL_RIGHT -> "ControlRight"
            KeyEvent.KEYCODE_ALT_LEFT -> "AltLeft"
            KeyEvent.KEYCODE_ALT_RIGHT -> "AltRight"
            KeyEvent.KEYCODE_SHIFT_LEFT -> "ShiftLeft"
            KeyEvent.KEYCODE_SHIFT_RIGHT -> "ShiftRight"
            KeyEvent.KEYCODE_META_LEFT -> "MetaLeft"
            KeyEvent.KEYCODE_META_RIGHT -> "MetaRight"
            KeyEvent.KEYCODE_DPAD_UP -> "ArrowUp"
            KeyEvent.KEYCODE_DPAD_DOWN -> "ArrowDown"
            KeyEvent.KEYCODE_DPAD_LEFT -> "ArrowLeft"
            KeyEvent.KEYCODE_DPAD_RIGHT -> "ArrowRight"
            KeyEvent.KEYCODE_HOME -> "Home"
            KeyEvent.KEYCODE_MOVE_END -> "End"
            KeyEvent.KEYCODE_PAGE_UP -> "PageUp"
            KeyEvent.KEYCODE_PAGE_DOWN -> "PageDown"
            KeyEvent.KEYCODE_MINUS -> "Minus"
            KeyEvent.KEYCODE_EQUALS -> "Equal"
            KeyEvent.KEYCODE_LEFT_BRACKET -> "BracketLeft"
            KeyEvent.KEYCODE_RIGHT_BRACKET -> "BracketRight"
            KeyEvent.KEYCODE_BACKSLASH -> "Backslash"
            KeyEvent.KEYCODE_SEMICOLON -> "Semicolon"
            KeyEvent.KEYCODE_APOSTROPHE -> "Quote"
            KeyEvent.KEYCODE_COMMA -> "Comma"
            KeyEvent.KEYCODE_PERIOD -> "Period"
            KeyEvent.KEYCODE_SLASH -> "Slash"
            KeyEvent.KEYCODE_GRAVE -> "Backquote"
            in KeyEvent.KEYCODE_A..KeyEvent.KEYCODE_Z -> {
                val ch = ('A'.code + (keyCode - KeyEvent.KEYCODE_A)).toChar()
                "Key$ch"
            }
            in KeyEvent.KEYCODE_0..KeyEvent.KEYCODE_9 -> {
                val d = keyCode - KeyEvent.KEYCODE_0
                "Digit$d"
            }
            in KeyEvent.KEYCODE_F1..KeyEvent.KEYCODE_F12 -> {
                val f = 1 + (keyCode - KeyEvent.KEYCODE_F1)
                "F$f"
            }
            else -> null
        }
    }
}
