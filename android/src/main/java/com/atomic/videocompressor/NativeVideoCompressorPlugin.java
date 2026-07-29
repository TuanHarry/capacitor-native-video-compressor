package com.atomic.videocompressor;

import android.content.Intent;
import android.net.Uri;
import android.util.Log;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import com.abedelazizshe.lightcompressorlibrary.CompressionListener;
import com.abedelazizshe.lightcompressorlibrary.VideoCompressor;
import com.abedelazizshe.lightcompressorlibrary.VideoQuality;
import com.abedelazizshe.lightcompressorlibrary.config.AppSpecificStorageConfiguration;
import com.abedelazizshe.lightcompressorlibrary.config.Configuration;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.util.Arrays;
import java.util.Collections;

@CapacitorPlugin(name = "NativeVideoCompressor")
public class NativeVideoCompressorPlugin extends Plugin {

    /**
     * Matches the `CANCELLED` constant the JS side exports, so one
     * `error.code` check covers web, iOS and Android alike.
     */
    private static final String CANCELLED_CODE = "CANCELLED";

    private static final String STORAGE_SUBFOLDER = "compressed_videos";

    /** The job compressVideo is running right now, for cancel({ jobId }). */
    private String currentJobId = null;

    /**
     * Nothing to do natively; LightCompressor needs no warm-up. Answered
     * rather than left unimplemented so a caller can await it unconditionally
     * (the web build does need it, and shares the call site).
     */
    @PluginMethod
    public void initialize(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("success", true);
        ret.put("message", "No initialization needed on Android");
        call.resolve(ret);
    }

    /**
     * Stop the running compress. LightCompressor cancels its coroutine job and
     * fires onCancelled, which is already wired below.
     */
    @PluginMethod
    public void cancel(PluginCall call) {
        String requested = call.getString("jobId");
        JSObject ret = new JSObject();

        synchronized (this) {
            // VideoCompressor.cancel() is global — without the jobId check a
            // cancel from one caller would kill whatever another had running.
            if (currentJobId == null || (requested != null && !requested.equals(currentJobId))) {
                ret.put("cancelled", false);
                call.resolve(ret);
                return;
            }
        }

        VideoCompressor.cancel();
        ret.put("cancelled", true);
        call.resolve(ret);
    }

    @PluginMethod
    public void compressVideo(PluginCall call) {
        String sourcePath = call.getString("sourcePath");

        if (sourcePath == null) {
            call.reject("Missing sourcePath");
            return;
        }

        String jobId = call.getString("jobId", "default");
        synchronized (this) {
            currentJobId = jobId;
        }

        // 1. Chuẩn bị Uri và Tên file xuất ra
        Uri srcUri;
        String fileName = "compressed_" + System.currentTimeMillis() + ".mp4";

        if (sourcePath.startsWith("content://")) {
            srcUri = Uri.parse(sourcePath);
        } else if (sourcePath.startsWith("file://")) {
            srcUri = Uri.parse(sourcePath);
        } else {
            srcUri = Uri.fromFile(new File(sourcePath));
        }

        // Đọc quality từ Javascript (Mặc định là MEDIUM)
        String qualityString = call.getString("quality", "MEDIUM");

        VideoQuality videoQuality = VideoQuality.MEDIUM;
        if (qualityString != null) {
            if (qualityString.equals("360P")) {
                videoQuality = VideoQuality.LOW; // Map 360p to LOW quality on Android
            } else if (qualityString.equals("LOW")) {
                videoQuality = VideoQuality.VERY_LOW; // Adjusting others dynamically if needed
            } else {
                try {
                    videoQuality = VideoQuality.valueOf(qualityString);
                } catch (IllegalArgumentException e) {
                    videoQuality = VideoQuality.MEDIUM;
                }
            }
        }

        Log.d(
            "NativeVideoCompressor",
            "====== VIDEO COMPRESSION QUALITY RECEIVED: " + qualityString + "+ video quality: " + videoQuality + " ======"
        );

        // 2. Cấu hình thông số nén (Dành riêng cho LightCompressor 1.3.2)
        // Lưu ý: Java phải truyền đủ 9 tham số do thư viện gốc viết bằng Kotlin
        Configuration configuration = new Configuration(
            videoQuality, // Chất lượng nén
            false, // tắt tính năng giới hạn Bitrate tối thiểu của file gốc
            null, // videoBitrateInMbps (Ép buộc giá trị Bitrate để đảm bảo file luôn nhẹ đi)
            false, // disableAudio
            false, // keepOriginalResolution
            null, // videoWidth
            null, // videoHeight
            Arrays.asList(fileName) // videoNames
        );

        // 3. Cấu hình nơi lưu (Lưu an toàn vào thư mục nội bộ của App)
        AppSpecificStorageConfiguration storageConfig = new AppSpecificStorageConfiguration(STORAGE_SUBFOLDER);

        // Khởi động Foreground Service để giữ app luôn sống khi chạy ngầm
        Intent serviceIntent = new Intent(getContext(), VideoCompressionService.class);
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
            try {
                getContext().startForegroundService(serviceIntent);
            } catch (Exception e) {
                getContext().startService(serviceIntent);
            }
        } else {
            getContext().startService(serviceIntent);
        }

        // 4. Bắt đầu nén (Đã cập nhật List Uri và int index)
        VideoCompressor.start(
            getContext(),
            Collections.singletonList(srcUri), // Nhận vào một List chứa đường dẫn
            false, // isStreamable
            null, // sharedStorageConfiguration (Không dùng)
            storageConfig, // Cấu hình lưu trữ
            configuration, // Cấu hình chất lượng
            new CompressionListener() {
                @Override
                public void onProgress(int i, float v) {
                    // Gửi % tiến độ về Javascript để vẽ thanh Progress
                    JSObject ret = new JSObject();
                    ret.put("status", "progress");
                    ret.put("percent", v);
                    notifyListeners("onProgress", ret);
                }

                @Override
                public void onFailure(int i, @NonNull String failureMessage) {
                    finishJob(serviceIntent);
                    call.reject("Nén thất bại: " + failureMessage);
                }

                @Override
                public void onSuccess(int i, long l, @Nullable String s) {
                    finishJob(serviceIntent);
                    // Nén xong, trả kết quả đường dẫn file mới về cho JS
                    JSObject ret = new JSObject();
                    ret.put("success", true);
                    ret.put("destPath", s);
                    call.resolve(ret);
                }

                @Override
                public void onStart(int i) {
                    JSObject ret = new JSObject();
                    ret.put("status", "started");
                    notifyListeners("onProgress", ret);
                }

                @Override
                public void onCancelled(int i) {
                    finishJob(serviceIntent);
                    // LightCompressor leaves whatever it had already written
                    // behind; without this the cache keeps a partial mp4 per
                    // cancel, and nothing ever collects them.
                    deleteOutput(fileName);
                    // Coded so the caller can tell "the user asked for this"
                    // apart from a real failure — same code on every platform.
                    call.reject("Đã hủy nén", CANCELLED_CODE);
                }
            }
        );
    }

    /** Every terminal callback ends here, so neither is ever left running. */
    private void finishJob(Intent serviceIntent) {
        getContext().stopService(serviceIntent);
        synchronized (this) {
            currentJobId = null;
        }
    }

    /** Best-effort: a partial file left in the cache is not worth failing over. */
    private void deleteOutput(String fileName) {
        try {
            File dir = new File(getContext().getExternalFilesDir(null), STORAGE_SUBFOLDER);
            File partial = new File(dir, fileName);
            if (partial.exists()) {
                partial.delete();
            }
        } catch (Exception e) {
            Log.w("NativeVideoCompressor", "Could not delete cancelled output", e);
        }
    }
}
