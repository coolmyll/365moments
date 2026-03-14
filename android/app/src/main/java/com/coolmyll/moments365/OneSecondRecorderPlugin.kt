package com.coolmyll.moments365

import android.Manifest
import android.graphics.Outline
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.OrientationEventListener
import android.view.Surface
import android.view.View
import android.view.ViewGroup
import android.view.ViewOutlineProvider
import android.view.Gravity
import android.widget.FrameLayout
import android.widget.TextView
import android.util.TypedValue
import androidx.camera.core.CameraSelector
import androidx.camera.core.MirrorMode
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.video.FileOutputOptions
import androidx.camera.video.PendingRecording
import androidx.camera.video.Quality
import androidx.camera.video.QualitySelector
import androidx.camera.video.Recorder
import androidx.camera.video.Recording
import androidx.camera.video.VideoCapture
import androidx.camera.video.VideoRecordEvent
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.google.common.util.concurrent.ListenableFuture
import java.io.File
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import kotlin.math.roundToInt

@CapacitorPlugin(
    name = "OneSecondRecorder",
    permissions = [
        Permission(strings = [Manifest.permission.CAMERA], alias = "camera"),
        Permission(strings = [Manifest.permission.RECORD_AUDIO], alias = "microphone"),
    ],
)
class OneSecondRecorderPlugin : Plugin() {

    private var cameraExecutor: ExecutorService? = null
    private val mainHandler = Handler(Looper.getMainLooper())
    private var activeRecording: Recording? = null
    private var activeCameraProvider: ProcessCameraProvider? = null
    private var activePreview: Preview? = null
    private var activeVideoCapture: VideoCapture<Recorder>? = null
    private var previewContainer: FrameLayout? = null
    private var previewView: PreviewView? = null
    private var countdownOverlayView: TextView? = null
    private var pendingStopRunnable: Runnable? = null
    private var currentDeviceRotation = Surface.ROTATION_0
    private var previewCornerRadiusPx = 0f
    private var orientationEventListener: OrientationEventListener? = null

    override fun load() {
        cameraExecutor = Executors.newSingleThreadExecutor()
        orientationEventListener = object : OrientationEventListener(context, SENSOR_DELAY_NORMAL) {
            override fun onOrientationChanged(orientation: Int) {
                if (orientation == ORIENTATION_UNKNOWN) return
                currentDeviceRotation = when (orientation) {
                    in 45 until 135 -> Surface.ROTATION_270
                    in 135 until 225 -> Surface.ROTATION_180
                    in 225 until 315 -> Surface.ROTATION_90
                    else -> Surface.ROTATION_0
                }
                activeVideoCapture?.targetRotation = currentDeviceRotation
            }
        }
        orientationEventListener?.enable()
    }

    @PluginMethod
    fun startPreview(call: PluginCall) {
        val activity = activity
        val useFrontCamera = call.getBoolean("useFrontCamera") ?: false

        if (activity == null) {
            call.reject("Activity unavailable")
            return
        }

        activity.runOnUiThread {
            try {
                ensurePreviewContainer()
                updatePreviewLayoutInternal(call)
                bindPreview(useFrontCamera) { error ->
                    if (error != null) {
                        call.reject("Preview failed: ${error.message}")
                    } else {
                        call.resolve(JSObject())
                    }
                }
            } catch (error: Exception) {
                Log.e(TAG, "Failed to start preview", error)
                call.reject("Preview failed: ${error.message}")
            }
        }
    }

    @PluginMethod
    fun updatePreviewLayout(call: PluginCall) {
        val activity = activity
        if (activity == null) {
            call.reject("Activity unavailable")
            return
        }

        activity.runOnUiThread {
            try {
                ensurePreviewContainer()
                updatePreviewLayoutInternal(call)
                call.resolve(JSObject())
            } catch (error: Exception) {
                Log.e(TAG, "Failed to update preview layout", error)
                call.reject("Preview layout update failed: ${error.message}")
            }
        }
    }

    @PluginMethod
    fun stopPreview(call: PluginCall) {
        val activity = activity
        if (activity == null) {
            call.reject("Activity unavailable")
            return
        }

        activity.runOnUiThread {
            stopPreviewInternal("stopPreview")
            call.resolve(JSObject())
        }
    }

    @PluginMethod
    fun showCountdown(call: PluginCall) {
        val activity = activity
        val text = call.getString("text") ?: ""
        if (activity == null) {
            call.reject("Activity unavailable")
            return
        }

        activity.runOnUiThread {
            try {
                ensurePreviewContainer()
                countdownOverlayView?.text = text
                countdownOverlayView?.visibility = View.VISIBLE
                call.resolve(JSObject())
            } catch (error: Exception) {
                call.reject("Countdown failed: ${error.message}")
            }
        }
    }

    @PluginMethod
    fun hideCountdown(call: PluginCall) {
        val activity = activity
        if (activity == null) {
            call.reject("Activity unavailable")
            return
        }

        activity.runOnUiThread {
            countdownOverlayView?.visibility = View.GONE
            call.resolve(JSObject())
        }
    }

    @PluginMethod
    fun record(call: PluginCall) {
        val durationMs = call.getInt("durationMs") ?: DEFAULT_DURATION_MS
        val useFrontCamera = call.getBoolean("useFrontCamera") ?: false

        if (durationMs < MIN_DURATION_MS || durationMs > MAX_DURATION_MS) {
            call.reject("durationMs must be between $MIN_DURATION_MS and $MAX_DURATION_MS")
            return
        }

        val activity = activity
        if (activity == null) {
            call.reject("Activity unavailable")
            return
        }

        activity.runOnUiThread {
            try {
                stopActiveRecording("restart")
                startRecording(call, durationMs, useFrontCamera)
            } catch (error: Exception) {
                Log.e(TAG, "Failed to start recording", error)
                call.reject("Recording failed: ${error.message}")
            }
        }
    }

    @Suppress("MissingPermission")
    private fun bindPreview(
        useFrontCamera: Boolean,
        onComplete: (Exception?) -> Unit,
    ) {
        val context = context
        val activity = activity

        if (context == null || activity == null) {
            onComplete(IllegalStateException("Camera context unavailable"))
            return
        }

        val localPreviewView = previewView
        if (localPreviewView == null) {
            onComplete(IllegalStateException("PreviewView unavailable"))
            return
        }

        localPreviewView.scaleX = if (useFrontCamera) -1f else 1f

        val cameraProviderFuture: ListenableFuture<ProcessCameraProvider> =
            ProcessCameraProvider.getInstance(context)

        cameraProviderFuture.addListener(
            {
                try {
                    val cameraProvider = cameraProviderFuture.get()
                    activeCameraProvider = cameraProvider

                    val preview = Preview.Builder()
                        .setTargetRotation(Surface.ROTATION_0)
                        .build().also {
                            it.setSurfaceProvider(localPreviewView.surfaceProvider)
                        }

                    val cameraSelector = if (useFrontCamera) {
                        CameraSelector.DEFAULT_FRONT_CAMERA
                    } else {
                        CameraSelector.DEFAULT_BACK_CAMERA
                    }

                    cameraProvider.unbindAll()
                    cameraProvider.bindToLifecycle(activity, cameraSelector, preview)

                    activePreview = preview
                    activeVideoCapture = null
                    onComplete(null)
                } catch (error: Exception) {
                    activePreview = null
                    activeVideoCapture = null
                    activeCameraProvider?.unbindAll()
                    activeCameraProvider = null
                    Log.e(TAG, "Preview binding failed", error)
                    onComplete(error)
                }
            },
            ContextCompat.getMainExecutor(context),
        )
    }

    @Suppress("MissingPermission")
    private fun startRecording(
        call: PluginCall,
        durationMs: Int,
        useFrontCamera: Boolean,
    ) {
        val context = context
        val activity = activity

        if (context == null || activity == null) {
            call.reject("Camera context unavailable")
            return
        }

        val localPreviewView = previewView
        if (localPreviewView == null) {
            call.reject("PreviewView unavailable")
            return
        }

        localPreviewView.scaleX = if (useFrontCamera) -1f else 1f

        val cameraProviderFuture: ListenableFuture<ProcessCameraProvider> =
            ProcessCameraProvider.getInstance(context)

        cameraProviderFuture.addListener(
            {
                try {
                    val cameraProvider = cameraProviderFuture.get()
                    activeCameraProvider = cameraProvider

                    val qualitySelector = QualitySelector.fromOrderedList(
                        listOf(Quality.FHD, Quality.HD, Quality.SD),
                    )

                    val recorder = Recorder.Builder()
                        .setQualitySelector(qualitySelector)
                        .build()

                    val videoCapture = VideoCapture.Builder(recorder)
                        .setMirrorMode(
                            if (useFrontCamera) {
                                MirrorMode.MIRROR_MODE_ON
                            } else {
                                MirrorMode.MIRROR_MODE_OFF
                            },
                        )
                        .build()

                    val preview = Preview.Builder()
                        .setTargetRotation(Surface.ROTATION_0)
                        .build().also {
                            it.setSurfaceProvider(localPreviewView.surfaceProvider)
                        }

                    activePreview = preview
                    activeVideoCapture = videoCapture
                    videoCapture.targetRotation = currentDeviceRotation

                    val cameraSelector = if (useFrontCamera) {
                        CameraSelector.DEFAULT_FRONT_CAMERA
                    } else {
                        CameraSelector.DEFAULT_BACK_CAMERA
                    }

                    cameraProvider.unbindAll()
                    cameraProvider.bindToLifecycle(
                        activity,
                        cameraSelector,
                        preview,
                        videoCapture,
                    )

                    val outputDir = File(context.cacheDir, "recordings")
                    if (!outputDir.exists()) {
                        outputDir.mkdirs()
                    }

                    val outputFile = File(outputDir, "clip_${System.currentTimeMillis()}.mp4")
                    val outputOptions = FileOutputOptions.Builder(outputFile).build()
                    val recordingHolder = arrayOfNulls<Recording>(1)

                    var pendingRecording: PendingRecording =
                        videoCapture.output.prepareRecording(context, outputOptions)

                    if (getPermissionState("microphone") == PermissionState.GRANTED) {
                        pendingRecording = pendingRecording.withAudioEnabled()
                    } else {
                        Log.w(TAG, "Microphone permission not granted; recording without audio")
                    }

                    recordingHolder[0] = pendingRecording.start(
                        ContextCompat.getMainExecutor(context),
                    ) { videoRecordEvent ->
                        when (videoRecordEvent) {
                            is VideoRecordEvent.Start -> {
                                activeRecording = recordingHolder[0]
                                val effectiveDuration = durationMs + ENCODER_WARMUP_MS
                                pendingStopRunnable = Runnable {
                                    try {
                                        recordingHolder[0]?.stop()
                                    } catch (error: Exception) {
                                        Log.w(TAG, "Error stopping recording", error)
                                    }
                                }
                                mainHandler.postDelayed(pendingStopRunnable!!, effectiveDuration.toLong())
                            }

                            is VideoRecordEvent.Finalize -> {
                                clearPendingStop()
                                activeRecording = null
                                activeVideoCapture = null
                                activePreview = null
                                activeCameraProvider?.unbindAll()
                                activeCameraProvider = null

                                if (videoRecordEvent.hasError()) {
                                    Log.e(TAG, "Recording error: ${videoRecordEvent.cause}")
                                    call.reject("Recording failed: ${videoRecordEvent.cause}")
                                    return@start
                                }

                                if (!outputFile.exists() || outputFile.length() == 0L) {
                                    call.reject("Recording failed: output file was empty")
                                    return@start
                                }

                                val result = JSObject().apply {
                                    put("filePath", outputFile.absolutePath)
                                    put("mimeType", "video/mp4")
                                    put("durationMs", durationMs)
                                }
                                call.resolve(result)
                            }
                        }
                    }
                } catch (error: Exception) {
                    clearPendingStop()
                    activeRecording = null
                    activeVideoCapture = null
                    activePreview = null
                    activeCameraProvider?.unbindAll()
                    activeCameraProvider = null
                    Log.e(TAG, "Camera setup failed", error)
                    call.reject("Camera setup failed: ${error.message}")
                }
            },
            ContextCompat.getMainExecutor(context),
        )
    }

    private fun ensurePreviewContainer() {
        val activity = activity ?: return
        val rootView = activity.findViewById<ViewGroup>(android.R.id.content) ?: return

        if (previewContainer == null) {
            previewContainer = FrameLayout(activity).apply {
                clipToOutline = true
                outlineProvider = object : ViewOutlineProvider() {
                    override fun getOutline(view: View, outline: Outline) {
                        outline.setRoundRect(0, 0, view.width, view.height, previewCornerRadiusPx)
                    }
                }
                visibility = View.VISIBLE
                isClickable = false
            }
        }

        if (previewView == null) {
            previewView = PreviewView(activity).apply {
                layoutParams = FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT,
                    FrameLayout.LayoutParams.MATCH_PARENT,
                )
                scaleType = PreviewView.ScaleType.FILL_CENTER
                implementationMode = PreviewView.ImplementationMode.COMPATIBLE
                isClickable = false
            }
            previewContainer?.addView(previewView)
        }

        if (countdownOverlayView == null) {
            countdownOverlayView = TextView(activity).apply {
                layoutParams = FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.WRAP_CONTENT,
                    FrameLayout.LayoutParams.WRAP_CONTENT,
                    Gravity.CENTER,
                )
                setTextColor(0xFFFFFFFF.toInt())
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 64f)
                setShadowLayer(20f, 0f, 0f, 0xCC000000.toInt())
                visibility = View.GONE
            }
            previewContainer?.addView(countdownOverlayView)
        }

        if (previewContainer?.parent == null) {
            rootView.addView(previewContainer)
        }

        previewContainer?.bringToFront()
        previewContainer?.visibility = View.VISIBLE
    }

    private fun updatePreviewLayoutInternal(call: PluginCall) {
        val container = previewContainer ?: return
        val pixelRatio = (call.getDouble("pixelRatio") ?: 1.0).toFloat().coerceAtLeast(1f)
        val widthPx = ((call.getDouble("width") ?: 0.0).toFloat() * pixelRatio).roundToInt()
        val heightPx = ((call.getDouble("height") ?: 0.0).toFloat() * pixelRatio).roundToInt()
        val leftPx = ((call.getDouble("x") ?: 0.0).toFloat() * pixelRatio).roundToInt()
        val topPx = ((call.getDouble("y") ?: 0.0).toFloat() * pixelRatio).roundToInt()
        previewCornerRadiusPx = ((call.getDouble("borderRadius") ?: 16.0).toFloat() * pixelRatio)

        val layoutParams = FrameLayout.LayoutParams(widthPx, heightPx)
        layoutParams.leftMargin = leftPx
        layoutParams.topMargin = topPx
        container.layoutParams = layoutParams
        container.invalidateOutline()
    }

    private fun clearPendingStop() {
        pendingStopRunnable?.let { runnable ->
            mainHandler.removeCallbacks(runnable)
        }
        pendingStopRunnable = null
    }

    private fun stopPreviewInternal(reason: String) {
        try {
            activeCameraProvider?.unbindAll()
        } catch (error: Exception) {
            Log.w(TAG, "Failed to stop preview due to $reason", error)
        } finally {
            activePreview = null
            activeVideoCapture = null
            activeCameraProvider = null
        }

        countdownOverlayView?.visibility = View.GONE

        (previewContainer?.parent as? ViewGroup)?.removeView(previewContainer)
    }

    private fun stopActiveRecording(reason: String) {
        clearPendingStop()

        try {
            if (activeRecording != null) {
                Log.i(TAG, "Stopping active recording due to $reason")
                activeRecording?.stop()
            }
        } catch (error: Exception) {
            Log.w(TAG, "Failed to stop active recording", error)
        } finally {
            activeRecording = null
        }

        activeVideoCapture = null

        try {
            activeCameraProvider?.unbindAll()
        } catch (error: Exception) {
            Log.w(TAG, "Failed to unbind camera provider", error)
        } finally {
            activeCameraProvider = null
        }
    }

    override fun handleOnPause() {
        orientationEventListener?.disable()
        stopPreviewInternal("pause")
        stopActiveRecording("pause")
    }

    override fun handleOnResume() {
        orientationEventListener?.enable()
    }

    override fun handleOnDestroy() {
        stopPreviewInternal("destroy")
        stopActiveRecording("destroy")
        orientationEventListener?.disable()
        orientationEventListener = null
        cameraExecutor?.shutdown()
        cameraExecutor = null
    }

    private companion object {
        private const val TAG = "OneSecondRecorder"
        private const val DEFAULT_DURATION_MS = 1000
        private const val MIN_DURATION_MS = 700
        private const val MAX_DURATION_MS = 5000
        private const val ENCODER_WARMUP_MS = 300
        private const val SENSOR_DELAY_NORMAL = 3
    }
}
