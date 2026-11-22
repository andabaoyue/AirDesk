package dev.airdesk.airdesk_app

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ImageFormat
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.RectF
import android.graphics.SurfaceTexture
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CaptureRequest
import android.media.ImageReader
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.os.VibrationEffect
import android.os.Vibrator
import android.util.Size
import android.view.Gravity
import android.view.Surface
import android.view.TextureView
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.HybridBinarizer
import java.util.EnumMap
import java.util.concurrent.atomic.AtomicBoolean

class QrScanActivity : Activity() {
    companion object {
        const val EXTRA_QR_TEXT = "qr_text"
        private const val REQ_CAMERA = 47823
    }

    private lateinit var textureView: TextureView
    private lateinit var torchButton: Button
    private var previewSize: Size = Size(1280, 720)
    private var cameraId: String? = null
    private var hasFlash = false
    private var torchEnabled = false

    private var cameraDevice: CameraDevice? = null
    private var captureSession: CameraCaptureSession? = null
    private var previewRequestBuilder: CaptureRequest.Builder? = null
    private var previewSurface: Surface? = null
    private var imageReader: ImageReader? = null
    private var bgThread: HandlerThread? = null
    private var bgHandler: Handler? = null

    private val decodedOnce = AtomicBoolean(false)
    private var lastDecodeAtMs = 0L

    private val qrReader: MultiFormatReader by lazy {
        MultiFormatReader().apply {
            val hints = EnumMap<DecodeHintType, Any>(DecodeHintType::class.java)
            hints[DecodeHintType.POSSIBLE_FORMATS] = listOf(BarcodeFormat.QR_CODE)
            hints[DecodeHintType.TRY_HARDER] = true
            setHints(hints)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val root = FrameLayout(this).apply {
            setBackgroundColor(Color.BLACK)
        }

        textureView = TextureView(this)
        root.addView(
            textureView,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        )

        root.addView(
            ScanOverlayView(this),
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        )

        val dp = resources.displayMetrics.density
        val titleView = TextView(this).apply {
            text = "扫描 AirDesk 电脑端二维码"
            setTextColor(Color.WHITE)
            textSize = 17f
            gravity = Gravity.CENTER
            setPadding(0, (44 * dp).toInt(), 0, 0)
        }
        root.addView(
            titleView,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.TOP
            )
        )

        val hintView = TextView(this).apply {
            text = "支持局域网 / 手机热点 / USB / Tailscale / 公网中继二维码"
            setTextColor(Color.parseColor("#CBD5E1"))
            textSize = 12.5f
            gravity = Gravity.CENTER
            setPadding((24 * dp).toInt(), 0, (24 * dp).toInt(), (110 * dp).toInt())
        }
        root.addView(
            hintView,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.BOTTOM
            )
        )

        val bottomBar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
            setPadding(0, 0, 0, (42 * dp).toInt())
        }

        torchButton = Button(this).apply {
            text = "手电筒"
            setTextColor(Color.WHITE)
            setBackgroundColor(Color.parseColor("#CC1E293B"))
            setPadding((18 * dp).toInt(), (10 * dp).toInt(), (18 * dp).toInt(), (10 * dp).toInt())
            setOnClickListener { toggleTorch() }
        }
        val cancelButton = Button(this).apply {
            text = "取消"
            setTextColor(Color.WHITE)
            setBackgroundColor(Color.parseColor("#CCDC2626"))
            setPadding((22 * dp).toInt(), (10 * dp).toInt(), (22 * dp).toInt(), (10 * dp).toInt())
            setOnClickListener {
                setResult(RESULT_CANCELED)
                finish()
            }
        }

        bottomBar.addView(torchButton)
        val spacer = View(this)
        bottomBar.addView(spacer, LinearLayout.LayoutParams((16 * dp).toInt(), 1))
        bottomBar.addView(cancelButton)

        root.addView(
            bottomBar,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.BOTTOM
            )
        )

        setContentView(root)
    }

    override fun onResume() {
        super.onResume()
        startBgThread()
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.CAMERA), REQ_CAMERA)
            return
        }
        openWhenSurfaceReady()
    }

    override fun onPause() {
        closeCamera()
        stopBgThread()
        super.onPause()
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQ_CAMERA) {
            if (grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                openWhenSurfaceReady()
            } else {
                Toast.makeText(this, "需要相机权限才可扫描二维码", Toast.LENGTH_SHORT).show()
                setResult(RESULT_CANCELED)
                finish()
            }
        }
    }

    private fun openWhenSurfaceReady() {
        if (textureView.isAvailable) {
            openCamera(textureView.width, textureView.height)
        } else {
            textureView.surfaceTextureListener = object : TextureView.SurfaceTextureListener {
                override fun onSurfaceTextureAvailable(surface: SurfaceTexture, width: Int, height: Int) {
                    openCamera(width, height)
                }
                override fun onSurfaceTextureSizeChanged(surface: SurfaceTexture, width: Int, height: Int) {
                    configurePreviewTransform(width, height)
                }
                override fun onSurfaceTextureDestroyed(surface: SurfaceTexture): Boolean = true
                override fun onSurfaceTextureUpdated(surface: SurfaceTexture) {}
            }
        }
    }

    private fun startBgThread() {
        if (bgThread != null) return
        bgThread = HandlerThread("AirDeskQrCam").apply { start() }
        bgHandler = Handler(bgThread!!.looper)
    }

    private fun stopBgThread() {
        bgThread?.quitSafely()
        try {
            bgThread?.join(500)
        } catch (_: InterruptedException) {}
        bgThread = null
        bgHandler = null
    }

    private fun selectBackCamera(manager: CameraManager): String? {
        for (id in manager.cameraIdList) {
            val chars = manager.getCameraCharacteristics(id)
            val facing = chars.get(CameraCharacteristics.LENS_FACING)
            if (facing == CameraCharacteristics.LENS_FACING_BACK) {
                hasFlash = chars.get(CameraCharacteristics.FLASH_INFO_AVAILABLE) == true
                val map = chars.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
                val choices = map?.getOutputSizes(ImageFormat.YUV_420_888) ?: emptyArray()
                previewSize = chooseOptimalSize(choices)
                return id
            }
        }
        return manager.cameraIdList.firstOrNull()
    }

    private fun chooseOptimalSize(choices: Array<Size>): Size {
        val candidates = choices.filter {
            it.width in 960..1920 && it.height in 540..1280
        }
        if (candidates.isNotEmpty()) {
            return candidates.minByOrNull { kotlin.math.abs(it.width - 1280) + kotlin.math.abs(it.height - 720) }
                ?: candidates.first()
        }
        return choices.firstOrNull { it.width >= 640 && it.height >= 480 } ?: Size(1280, 720)
    }

    private fun openCamera(viewWidth: Int, viewHeight: Int) {
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) return
        val manager = getSystemService(Context.CAMERA_SERVICE) as CameraManager
        try {
            val id = selectBackCamera(manager) ?: return
            cameraId = id
            runOnUiThread {
                torchButton.visibility = if (hasFlash) View.VISIBLE else View.GONE
            }
            configurePreviewTransform(viewWidth, viewHeight)

            imageReader = ImageReader.newInstance(
                previewSize.width,
                previewSize.height,
                ImageFormat.YUV_420_888,
                2
            ).apply {
                setOnImageAvailableListener({ reader ->
                    val image = reader.acquireLatestImage() ?: return@setOnImageAvailableListener
                    try {
                        if (decodedOnce.get()) return@setOnImageAvailableListener
                        val now = System.currentTimeMillis()
                        if (now - lastDecodeAtMs < 75L) return@setOnImageAvailableListener
                        lastDecodeAtMs = now

                        val plane = image.planes[0]
                        val width = image.width
                        val height = image.height
                        val rowStride = plane.rowStride
                        val buffer = plane.buffer
                        buffer.rewind()
                        val yBytes = ByteArray(width * height)
                        if (rowStride == width) {
                            buffer.get(yBytes, 0, width * height)
                        } else {
                            val rowBuf = ByteArray(rowStride)
                            for (row in 0 until height) {
                                val remaining = buffer.remaining()
                                if (remaining <= 0) break
                                val toRead = minOf(rowStride, remaining)
                                buffer.get(rowBuf, 0, toRead)
                                System.arraycopy(rowBuf, 0, yBytes, row * width, minOf(width, toRead))
                            }
                        }

                        val source = PlanarYUVLuminanceSource(
                            yBytes, width, height, 0, 0, width, height, false
                        )
                        val bitmap = BinaryBitmap(HybridBinarizer(source))
                        try {
                            val res = qrReader.decodeWithState(bitmap)
                            val text = res?.text?.trim() ?: ""
                            if (text.isNotEmpty() && decodedOnce.compareAndSet(false, true)) {
                                runOnUiThread { onQrDecoded(text) }
                            }
                        } catch (_: Exception) {
                        } finally {
                            qrReader.reset()
                        }
                    } finally {
                        image.close()
                    }
                }, bgHandler)
            }

            manager.openCamera(id, object : CameraDevice.StateCallback() {
                override fun onOpened(camera: CameraDevice) {
                    cameraDevice = camera
                    startPreviewSession()
                }
                override fun onDisconnected(camera: CameraDevice) {
                    camera.close()
                    cameraDevice = null
                }
                override fun onError(camera: CameraDevice, error: Int) {
                    camera.close()
                    cameraDevice = null
                }
            }, bgHandler)
        } catch (e: Exception) {
            Toast.makeText(this, "打开相机失败：${e.message}", Toast.LENGTH_SHORT).show()
        }
    }

    private fun startPreviewSession() {
        val cam = cameraDevice ?: return
        val st = textureView.surfaceTexture ?: return
        val readerSurface = imageReader?.surface ?: return
        st.setDefaultBufferSize(previewSize.width, previewSize.height)
        try { previewSurface?.release() } catch (_: Exception) {}
        val surface = Surface(st)
        previewSurface = surface
        try {
            val builder = cam.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW).apply {
                addTarget(surface)
                addTarget(readerSurface)
                set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE)
                set(CaptureRequest.CONTROL_AE_MODE, CaptureRequest.CONTROL_AE_MODE_ON)
            }
            previewRequestBuilder = builder

            @Suppress("DEPRECATION")
            cam.createCaptureSession(
                listOf(surface, readerSurface),
                object : CameraCaptureSession.StateCallback() {
                    override fun onConfigured(session: CameraCaptureSession) {
                        if (cameraDevice == null) return
                        captureSession = session
                        try {
                            session.setRepeatingRequest(builder.build(), null, bgHandler)
                        } catch (_: Exception) {}
                    }
                    override fun onConfigureFailed(session: CameraCaptureSession) {}
                },
                bgHandler
            )
        } catch (_: Exception) {}
    }

    private fun configurePreviewTransform(viewWidth: Int, viewHeight: Int) {
        if (viewWidth <= 0 || viewHeight <= 0) return
        val matrix = Matrix()
        val viewRect = RectF(0f, 0f, viewWidth.toFloat(), viewHeight.toFloat())
        // Camera sensor in portrait has previewSize width/height swapped relative to view
        val bufW = previewSize.height.toFloat()
        val bufH = previewSize.width.toFloat()
        val scale = maxOf(viewWidth / bufW, viewHeight / bufH)
        val scaledW = bufW * scale
        val scaledH = bufH * scale
        matrix.setScale(scaledW / viewWidth, scaledH / viewHeight, viewRect.centerX(), viewRect.centerY())
        runOnUiThread { textureView.setTransform(matrix) }
    }

    private fun toggleTorch() {
        val session = captureSession ?: return
        val builder = previewRequestBuilder ?: return
        if (!hasFlash) return
        torchEnabled = !torchEnabled
        torchButton.text = if (torchEnabled) "关闭手电" else "手电筒"
        try {
            builder.set(
                CaptureRequest.FLASH_MODE,
                if (torchEnabled) CaptureRequest.FLASH_MODE_TORCH else CaptureRequest.FLASH_MODE_OFF
            )
            session.setRepeatingRequest(builder.build(), null, bgHandler)
        } catch (_: Exception) {}
    }

    private fun onQrDecoded(text: String) {
        try {
            @Suppress("DEPRECATION")
            val vib = getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
            if (vib != null && vib.hasVibrator()) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    vib.vibrate(VibrationEffect.createOneShot(45, VibrationEffect.DEFAULT_AMPLITUDE))
                } else {
                    @Suppress("DEPRECATION")
                    vib.vibrate(45)
                }
            }
        } catch (_: Exception) {}

        val out = Intent().apply {
            putExtra(EXTRA_QR_TEXT, text)
        }
        setResult(RESULT_OK, out)
        finish()
    }

    private fun closeCamera() {
        try { imageReader?.setOnImageAvailableListener(null, null) } catch (_: Exception) {}
        try { captureSession?.close() } catch (_: Exception) {}
        captureSession = null
        try { cameraDevice?.close() } catch (_: Exception) {}
        cameraDevice = null
        try { imageReader?.close() } catch (_: Exception) {}
        imageReader = null
        try { previewSurface?.release() } catch (_: Exception) {}
        previewSurface = null
    }

    private class ScanOverlayView(context: Context) : View(context) {
        private val dimPaint = Paint().apply {
            color = Color.parseColor("#8805070A")
        }
        private val clearPaint = Paint().apply {
            xfermode = PorterDuffXfermode(PorterDuff.Mode.CLEAR)
        }
        private val borderPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.parseColor("#60A5FA")
            style = Paint.Style.STROKE
            strokeWidth = 3f * resources.displayMetrics.density
        }

        init {
            setLayerType(LAYER_TYPE_SOFTWARE, null)
        }

        override fun onDraw(canvas: Canvas) {
            super.onDraw(canvas)
            val w = width.toFloat()
            val h = height.toFloat()
            canvas.drawRect(0f, 0f, w, h, dimPaint)

            val boxSize = minOf(w, h) * 0.64f
            val left = (w - boxSize) / 2f
            val top = (h - boxSize) / 2f - h * 0.04f
            val rect = RectF(left, top, left + boxSize, top + boxSize)
            val r = 16f * resources.displayMetrics.density
            canvas.drawRoundRect(rect, r, r, clearPaint)
            canvas.drawRoundRect(rect, r, r, borderPaint)
        }
    }
}
