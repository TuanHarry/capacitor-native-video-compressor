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
import java.lang.ref.WeakReference;
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

    /**
     * Instance đang sống, để service gọi ngược khi user bấm "Huỷ" trên
     * notification. WeakReference vì service sống lâu hơn bridge: giữ cứng ở
     * đây là giữ luôn cả WebView sau khi Activity đã chết.
     */
    private static WeakReference<NativeVideoCompressorPlugin> active = new WeakReference<>(null);

    /** The job compressVideo is running right now, for cancel({ jobId }). */
    private String currentJobId = null;

    @Override
    public void load() {
        super.load();
        active = new WeakReference<>(this);
    }

    @Override
    protected void handleOnDestroy() {
        if (active.get() == this) active = new WeakReference<>(null);
        super.handleOnDestroy();
    }

    /**
     * User bấm "Huỷ" trên notification. Phải huỷ được cả hai pha:
     *
     *  - pha nén chạy trong LightCompressor (native) -> cancel() tĩnh, gọi được
     *    kể cả khi bridge đã chết
     *  - pha upload chạy trong JS -> chỉ có thể nhờ JS tự dừng, nên bắn
     *    onCancelRequested; không có event này thì bấm Huỷ lúc đang upload chỉ
     *    tắt được notification còn request vẫn chạy tiếp, và Play coi như
     *    "không dừng được bởi user".
     */
    static void cancelAllFromNotification() {
        try {
            VideoCompressor.cancel();
        } catch (Exception e) {
            Log.w("NativeVideoCompressor", "Could not cancel compression", e);
        }
        NativeVideoCompressorPlugin plugin = active.get();
        if (plugin == null) return;
        synchronized (plugin) {
            plugin.currentJobId = null;
        }
        plugin.notifyListeners("onCancelRequested", new JSObject());
    }

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
        boolean cancelled;

        // The cancel call itself must be INSIDE the lock. Released first, the
        // running job could finish and a new one start in the gap — and
        // VideoCompressor.cancel() being global, it would kill the newcomer.
        // That is exactly what checking the jobId is meant to prevent.
        // The call is non-blocking (it cancels a coroutine job), so holding
        // the lock across it costs nothing.
        synchronized (this) {
            cancelled = currentJobId != null && (requested == null || requested.equals(currentJobId));
            if (cancelled) {
                VideoCompressor.cancel();
            }
        }

        ret.put("cancelled", cancelled);
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
        serviceIntent.setAction(VideoCompressionService.ACTION_START);
        serviceIntent.putExtra(VideoCompressionService.EXTRA_JOB_ID, jobId);
        try {
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                getContext().startForegroundService(serviceIntent);
            } else {
                getContext().startService(serviceIntent);
            }
        } catch (Exception e) {
            synchronized (this) { currentJobId = null; }
            call.reject("Cannot start foreground video processing", e);
            return;
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
                    // Notification phải nhúc nhích theo đúng con số mà UI trong
                    // app đang hiển thị: một notification đứng im là lý do Play
                    // đánh trượt tiêu chí "user perceptible".
                    VideoCompressionService.publishProgress(jobId, Math.round(v));

                    // Gửi % tiến độ về Javascript để vẽ thanh Progress
                    JSObject ret = new JSObject();
                    ret.put("status", "progress");
                    ret.put("percent", v);
                    notifyListeners("onProgress", ret);
                }

                @Override
                public void onFailure(int i, @NonNull String failureMessage) {
                    finishJob(jobId);
                    call.reject("Nén thất bại: " + failureMessage);
                }

                @Override
                public void onSuccess(int i, long l, @Nullable String s) {
                    finishJob(jobId);
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
                    finishJob(jobId);
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
    private void finishJob(String jobId) {
        sendToService(VideoCompressionService.ACTION_FINISH, jobId);
        synchronized (this) {
            currentJobId = null;
        }
    }

    /**
     * Lệnh gửi vào service, nuốt lỗi có chủ đích.
     *
     * startService() từ background bị chặn khi app không còn foreground service
     * nào chạy - đúng tình huống xảy ra khi service đã tự tắt bằng watchdog rồi
     * job mới kết thúc và gửi ACTION_FINISH. Ném ra ở đây sẽ biến một lần dọn dẹp
     * vô hại thành một lần nén báo lỗi cho user.
     */
    private void sendToService(String action, String jobId) {
        try {
            Intent intent = new Intent(getContext(), VideoCompressionService.class);
            intent.setAction(action);
            intent.putExtra(VideoCompressionService.EXTRA_JOB_ID, jobId);
            getContext().startService(intent);
        } catch (Exception e) {
            Log.w("NativeVideoCompressor", "Could not send " + action + " to service", e);
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
