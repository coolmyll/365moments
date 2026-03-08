package com.coolmyll.moments365;

import android.Manifest;
import android.content.ContentValues;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.util.Log;
import android.util.Size;

import androidx.annotation.NonNull;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.Preview;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.video.FileOutputOptions;
import androidx.camera.video.MediaStoreOutputOptions;
import androidx.camera.video.Quality;
import androidx.camera.video.QualitySelector;
import androidx.camera.video.Recorder;
import androidx.camera.video.Recording;
import androidx.camera.video.VideoCapture;
import androidx.camera.video.VideoRecordEvent;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;

import java.io.File;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(
    name = "OneSecondRecorder",
    permissions = {
        @Permission(strings = { Manifest.permission.CAMERA }, alias = "camera"),
        @Permission(strings = { Manifest.permission.RECORD_AUDIO }, alias = "microphone")
    }
)
public class OneSecondRecorderPlugin extends Plugin {

    private static final String TAG = "OneSecondRecorder";
    private static final int DEFAULT_DURATION_MS = 1500; // slightly over 1s for safety
    private ExecutorService cameraExecutor;

    @Override
    public void load() {
        cameraExecutor = Executors.newSingleThreadExecutor();
    }

    @PluginMethod()
    public void record(PluginCall call) {
        int durationMs = call.getInt("durationMs", DEFAULT_DURATION_MS);
        boolean useFrontCamera = call.getBoolean("useFrontCamera", false);

        getActivity().runOnUiThread(() -> {
            try {
                startRecording(call, durationMs, useFrontCamera);
            } catch (Exception e) {
                Log.e(TAG, "Failed to start recording", e);
                call.reject("Recording failed: " + e.getMessage());
            }
        });
    }

    @SuppressWarnings("MissingPermission")
    private void startRecording(PluginCall call, int durationMs, boolean useFrontCamera) {
        var cameraProviderFuture = ProcessCameraProvider.getInstance(getContext());

        cameraProviderFuture.addListener(() -> {
            try {
                ProcessCameraProvider cameraProvider = cameraProviderFuture.get();

                // Quality selector — prefer FHD, fall back to HD
                QualitySelector qualitySelector = QualitySelector.fromOrderedList(
                    java.util.Arrays.asList(Quality.FHD, Quality.HD, Quality.SD)
                );

                Recorder recorder = new Recorder.Builder()
                    .setQualitySelector(qualitySelector)
                    .build();

                VideoCapture<Recorder> videoCapture = VideoCapture.withOutput(recorder);

                CameraSelector cameraSelector = useFrontCamera
                    ? CameraSelector.DEFAULT_FRONT_CAMERA
                    : CameraSelector.DEFAULT_BACK_CAMERA;

                // Unbind all and bind video capture
                cameraProvider.unbindAll();
                cameraProvider.bindToLifecycle(
                    getActivity(),
                    cameraSelector,
                    videoCapture
                );

                // Output file
                File outputDir = new File(getContext().getCacheDir(), "recordings");
                if (!outputDir.exists()) outputDir.mkdirs();
                File outputFile = new File(outputDir, "clip_" + System.currentTimeMillis() + ".mp4");

                FileOutputOptions outputOptions = new FileOutputOptions.Builder(outputFile).build();

                // Start recording
                Recording recording = videoCapture.getOutput()
                    .prepareRecording(getContext(), outputOptions)
                    .withAudioEnabled()
                    .start(ContextCompat.getMainExecutor(getContext()), videoRecordEvent -> {
                        if (videoRecordEvent instanceof VideoRecordEvent.Finalize) {
                            VideoRecordEvent.Finalize finalize = (VideoRecordEvent.Finalize) videoRecordEvent;
                            cameraProvider.unbindAll();

                            if (finalize.hasError()) {
                                Log.e(TAG, "Recording error: " + finalize.getCause());
                                call.reject("Recording failed: " + finalize.getCause());
                            } else {
                                JSObject result = new JSObject();
                                result.put("filePath", outputFile.getAbsolutePath());
                                result.put("mimeType", "video/mp4");
                                result.put("durationMs", durationMs);
                                Log.i(TAG, "Recording saved: " + outputFile.getAbsolutePath()
                                    + " size=" + outputFile.length());
                                call.resolve(result);
                            }
                        }
                    });

                // Auto-stop after the requested duration
                new Handler(Looper.getMainLooper()).postDelayed(() -> {
                    try {
                        recording.stop();
                        Log.i(TAG, "Recording auto-stopped after " + durationMs + "ms");
                    } catch (Exception e) {
                        Log.w(TAG, "Error stopping recording", e);
                    }
                }, durationMs);

            } catch (Exception e) {
                Log.e(TAG, "Camera setup failed", e);
                call.reject("Camera setup failed: " + e.getMessage());
            }
        }, ContextCompat.getMainExecutor(getContext()));
    }

    @Override
    protected void handleOnDestroy() {
        if (cameraExecutor != null) {
            cameraExecutor.shutdown();
        }
    }
}
