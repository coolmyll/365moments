package com.coolmyll.moments365

import android.Manifest
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.OrientationEventListener
import android.view.Surface
import androidx.camera.core.CameraSelector
import androidx.camera.core.MirrorMode
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.video.FileOutputOptions
import androidx.camera.video.PendingRecording
import androidx.camera.video.Quality
import androidx.camera.video.QualitySelector
import androidx.camera.video.Recorder
import androidx.camera.video.Recording
import androidx.camera.video.VideoCapture
import androidx.camera.video.VideoRecordEvent
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
    private var activeVideoCapture: VideoCapture<Recorder>? = null
    private var pendingStopRunnable: Runnable? = null
    private var currentDeviceRotation = Surface.ROTATION_0
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
                        .setMirrorMode(MirrorMode.MIRROR_MODE_OFF)
                        .build()
                    activeVideoCapture = videoCapture
                    videoCapture.targetRotation = currentDeviceRotation
                    val cameraSelector = if (useFrontCamera) {
                        CameraSelector.DEFAULT_FRONT_CAMERA
                    } else {
                        CameraSelector.DEFAULT_BACK_CAMERA
                    }

                    cameraProvider.unbindAll()
                    cameraProvider.bindToLifecycle(activity, cameraSelector, videoCapture)

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
                                Log.i(TAG, "Recording actually started, scheduling stop in ${effectiveDuration}ms (${durationMs}ms + ${ENCODER_WARMUP_MS}ms warmup)")
                                pendingStopRunnable = Runnable {
                                    try {
                                        recordingHolder[0]?.stop()
                                        Log.i(TAG, "Recording auto-stopped after ${effectiveDuration}ms of actual recording")
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
                                Log.i(
                                    TAG,
                                    "Recording saved: ${outputFile.absolutePath} size=${outputFile.length()}",
                                )
                                call.resolve(result)
                            }
                        }
                    }
                } catch (error: Exception) {
                    clearPendingStop()
                    activeRecording = null
                    activeVideoCapture = null
                    activeCameraProvider?.unbindAll()
                    activeCameraProvider = null
                    Log.e(TAG, "Camera setup failed", error)
                    call.reject("Camera setup failed: ${error.message}")
                }
            },
            ContextCompat.getMainExecutor(context),
        )
    }

    private fun clearPendingStop() {
        pendingStopRunnable?.let { runnable ->
            mainHandler.removeCallbacks(runnable)
        }
        pendingStopRunnable = null
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
        stopActiveRecording("pause")
    }

    override fun handleOnResume() {
        orientationEventListener?.enable()
    }

    override fun handleOnDestroy() {
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