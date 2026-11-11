package com.atomic.videocompressor;

import android.media.MediaMetadataRetriever;
import android.net.Uri;
import android.util.Log;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.work.Data;
import androidx.work.ExistingWorkPolicy;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;
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
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

@CapacitorPlugin(name = "NativeVideoCompressor")
public class NativeVideoCompressorPlugin extends Plugin {

    private static final String TAG = "NativeVideoCompressor";

    /**
     * Matches the `CANCELLED` constant the JS side exports, so one
     * `error.code` check covers web, iOS and Android alike.
     */
    private static final String CANCELLED_CODE = "CANCELLED";

    private static final String STORAGE_SUBFOLDER = "compressed_videos";

    /** Gắn lên mọi work của plugin để dọn được job mồ côi của phiên WebView trước. */
    private static final String WORK_TAG = "native-video-compressor";

    /** Thứ tự khớp NativeVideoCompressor.SOURCE_FACTORS. */
    private static final VideoQuality[] QUALITY_BY_SOURCE_FACTOR = {
        VideoQuality.VERY_LOW,
        VideoQuality.LOW,
        VideoQuality.MEDIUM,
        VideoQuality.HIGH,
        VideoQuality.VERY_HIGH
    };

    /**
     * Trần cho pha giữ-chờ-upload. Ngắn hơn mốc 10 phút mà WorkManager tự cắt,
     * để một caller chết giữa chừng không chiếm quota job tới tận phút cuối.
     */
    private static final long HOLD_FOR_UPLOAD_TIMEOUT_MINUTES = 8;

    /**
     * Mốc process này nạp plugin - trước mọi lần nén của nó. Bản sao nguồn cũ
     * hơn mốc này là của một process đã chết.
     */
    private static final long PROCESS_START_MS = System.currentTimeMillis();

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

    /** Bridge mới (Activity dựng lại): mọi job còn chạy thuộc phiên cũ. */
    @Override
    public void load() {
        cancelOrphans(PROCESS_START_MS);
    }

    /**
     * Bridge gọi hàm này ở onPageStarted (Bridge.reset), tức mỗi lần WebView
     * tải lại trang - load() thì không chạy lại. JS cũ đã chết nên không còn
     * ai nhận kết quả các job đang chạy.
     *
     * Mốc dọn là "bây giờ": JS mới chưa chạy nên mọi bản sao nguồn đều mồ
     * côi, kể cả bản một job huỷ giữa pha chép vẫn đang ghi tiếp sau claim().
     */
    @Override
    public void removeAllListeners() {
        super.removeAllListeners();
        cancelOrphans(System.currentTimeMillis());
    }

    /**
     * Dừng job trong process trước, đồng bộ, rồi mới huỷ work. Huỷ work là bất
     * đồng bộ: onStopped tới muộn sẽ gọi VideoCompressor.cancel() - vốn global
     * - và giết luôn job đầu tiên của phiên mới. Dừng trước thì onStopped gặp
     * job đã stopped và không làm gì.
     *
     * ponytail: cờ isRunning của LightCompressor là global; nếu phiên mới gọi
     * start trước khi vòng nén cũ kịp đọc cờ (mỗi ~100 µs) thì job cũ chạy
     * tiếp. JS boot mất cả giây nên gần như không xảy ra; cần chặt hơn thì
     * phải bỏ LightCompressor.
     */
    private void cancelOrphans(long copiesOlderThan) {
        VideoCompressionWorker.stopAll();
        try {
            WorkManager.getInstance(getContext()).cancelAllWorkByTag(WORK_TAG);
        } catch (Exception e) {
            Log.w(TAG, "Could not cancel orphaned work", e);
        }
        // Process bị kill giữa chừng thì không job nào kịp dọn bản sao của nó.
        for (File copy : sourceCopies()) {
            if (NativeVideoCompressor.isStaleSourceCopy(copy.getName(), copy.lastModified(), copiesOlderThan)) {
                deleteQuietly(copy);
            }
        }
    }

    /** File thường ở gốc dataDir mang tên đúng 13 chữ số - xem NativeVideoCompressor.isSourceCopyName. */
    private File[] sourceCopies() {
        try {
            File[] files = new File(getContext().getApplicationInfo().dataDir).listFiles(
                (File f) -> f.isFile() && NativeVideoCompressor.isSourceCopyName(f.getName())
            );
            if (files != null) return files;
        } catch (Exception e) {
            Log.w(TAG, "Could not list source copies", e);
        }
        return new File[0];
    }

    private Set<String> sourceCopyNames() {
        Set<String> names = new HashSet<>();
        for (File copy : sourceCopies()) names.add(copy.getName());
        return names;
    }

    /**
     * Xoá bản sao xuất hiện sau `before`. Nếu job khác đang chạy song song mà
     * bản sao của nó bị xoá theo cũng vô hại: LightCompressor 1.3.2 chỉ
     * null-check đường dẫn đó, còn nén thì đọc thẳng từ Uri gốc.
     */
    private void deleteSourceCopiesSince(Set<String> before) {
        for (File copy : sourceCopies()) {
            if (!before.contains(copy.getName())) deleteQuietly(copy);
        }
    }

    private void deleteQuietly(File file) {
        try {
            if (!file.delete()) Log.w(TAG, "Could not delete " + file);
        } catch (Exception e) {
            Log.w(TAG, "Could not delete " + file, e);
        }
    }

    /**
     * Stop the running compress. The job is stopped directly and answers
     * CANCELLED itself; LightCompressor's own callbacks after that are no-ops.
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
        // Both calls are non-blocking (one cancels a coroutine job, the other
        // returns an Operation), so holding the lock across them costs nothing.
        synchronized (this) {
            cancelled = currentJobId != null && (requested == null || requested.equals(currentJobId));
            if (cancelled) {
                String jobId = currentJobId;
                // Dừng job trực tiếp chứ không trông vào onStopped: work còn
                // ENQUEUED thì huỷ xong WorkManager không hề dựng Worker, nên
                // onStopped không bao giờ bắn và PluginCall sẽ treo.
                if (!VideoCompressionWorker.stop(jobId)) VideoCompressor.cancel();
                cancelWork(jobId);
            }
        }

        ret.put("cancelled", cancelled);
        call.resolve(ret);
    }

    /**
     * Caller báo đã xong việc với kết quả nén - thường là upload xong - nên
     * worker đang giữ process sống được phép kết thúc.
     *
     * Phải gọi trên MỌI nhánh kết thúc của pha upload, kể cả nhánh lỗi. Bỏ sót
     * một nhánh nghĩa là máy phải nuôi một job rỗng tới khi hết hạn giữ.
     */
    @PluginMethod
    public void finishUpload(PluginCall call) {
        String jobId = call.getString("jobId");
        JSObject ret = new JSObject();
        ret.put("released", jobId != null && VideoCompressionWorker.release(jobId));
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
        NativeVideoCompressor.Target target = NativeVideoCompressor.target(qualityString);

        // Kích thước + bitrate theo cùng bậc thang với iOS/web. Đọc metadata
        // hỏng thì để null, LightCompressor tự chọn như trước.
        int[] size = null;
        NativeVideoCompressor.BitratePlan bitrate = null;
        MediaMetadataRetriever retriever = new MediaMetadataRetriever();
        try {
            retriever.setDataSource(getContext(), srcUri);
            int width = Integer.parseInt(retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH));
            int height = Integer.parseInt(retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT));
            size = NativeVideoCompressor.outputSize(width, height, target.shortSide);
            bitrate = NativeVideoCompressor.bitrate(
                target.bitrate,
                Long.parseLong(retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_BITRATE))
            );
        } catch (Exception e) {
            // Containers without a bitrate tag (MKV, WebM, screen recordings) still keep the tier's size.
            Log.w(TAG, "Could not read video metadata, using LightCompressor defaults for the rest", e);
        } finally {
            // release() khai báo IOException từ API 29; không dùng
            // try-with-resources vì minSdk 24 chưa có AutoCloseable.
            try {
                retriever.release();
            } catch (Exception ignored) {}
        }

        // Với bitrate tính theo nguồn, quality chỉ còn chọn hệ số nhân của
        // LightCompressor; với Mbps tường minh hoặc metadata hỏng thì giữ MEDIUM.
        VideoQuality videoQuality =
            bitrate != null && bitrate.mbps == null ? QUALITY_BY_SOURCE_FACTOR[bitrate.sourceFactorIndex] : VideoQuality.MEDIUM;

        Log.d(
            TAG,
            "Compress " +
                qualityString +
                ": size=" +
                (size == null ? "default" : size[0] + "x" + size[1]) +
                ", mbps=" +
                (bitrate == null ? "default" : bitrate.mbps) +
                ", quality=" +
                videoQuality
        );

        // 2. Cấu hình thông số nén (Dành riêng cho LightCompressor 1.3.2)
        // Thứ tự tham số theo Configuration.kt: height ĐỨNG TRƯỚC width.
        Configuration configuration = new Configuration(
            videoQuality, // Chất lượng nén
            false, // tắt tính năng giới hạn Bitrate tối thiểu của file gốc
            bitrate == null ? null : bitrate.mbps, // videoBitrateInMbps
            false, // disableAudio
            false, // keepOriginalResolution
            size == null ? null : Double.valueOf(size[1]), // videoHeight
            size == null ? null : Double.valueOf(size[0]), // videoWidth
            Arrays.asList(fileName) // videoNames
        );

        // 3. Cấu hình nơi lưu (Lưu an toàn vào thư mục nội bộ của App)
        AppSpecificStorageConfiguration storageConfig = new AppSpecificStorageConfiguration(STORAGE_SUBFOLDER);

        synchronized (this) {
            currentJobId = jobId;
        }

        // 4. Giao pha nén cho WorkManager. Không nén thẳng ở đây: một thread
        // thường bị đóng băng cùng process ngay khi user rời app, còn process
        // đang chạy worker thì không. Đây là phương án Google Play chỉ đích
        // danh khi từ chối foreground service ở version code 32.
        boolean holdForUpload = Boolean.TRUE.equals(call.getBoolean("holdForUpload", false));
        CompressionJob job = new CompressionJob(jobId, srcUri, fileName, configuration, storageConfig, call, holdForUpload);
        VideoCompressionWorker.register(jobId, job);

        OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(VideoCompressionWorker.class)
            .setInputData(new Data.Builder().putString(VideoCompressionWorker.KEY_JOB_ID, jobId).build())
            .addTag(WORK_TAG)
            .build();

        try {
            WorkManager.getInstance(getContext()).enqueueUniqueWork(workName(jobId), ExistingWorkPolicy.REPLACE, request);
        } catch (Exception e) {
            VideoCompressionWorker.unregister(jobId);
            synchronized (this) {
                currentJobId = null;
            }
            call.reject("Cannot schedule video compression", e);
        }
    }

    /**
     * Một lần nén, chạy bên trong {@link VideoCompressionWorker}.
     *
     * Không phải static: nó cần notifyListeners và getContext của plugin đang
     * sống để bắn progress và trả kết quả về đúng PluginCall.
     */
    private final class CompressionJob implements VideoCompressionWorker.Job {

        private final String jobId;
        private final Uri srcUri;
        private final String fileName;
        private final Configuration configuration;
        private final AppSpecificStorageConfiguration storageConfig;
        private final PluginCall call;
        private final boolean holdForUpload;

        /** Mở khi pha nén kết thúc, để worker biết lúc nào được trả về. */
        private final CountDownLatch done = new CountDownLatch(1);

        /** Mở khi caller gọi finishUpload - chỉ dùng khi holdForUpload. */
        private final CountDownLatch released = new CountDownLatch(1);

        /** Chốt một-lần cho mọi nhánh kết thúc; PluginCall chỉ được trả lời một lần. */
        private final AtomicBoolean delivered = new AtomicBoolean(false);

        /** True khi nén xong có kết quả dùng được, tức là có cái để upload. */
        private volatile boolean compressed = false;

        /** Bản sao nguồn có sẵn trước job này; claim() xoá những cái mới hơn. */
        private volatile Set<String> copiesBefore = null;

        private boolean started = false;
        private boolean stopped = false;

        CompressionJob(
            String jobId,
            Uri srcUri,
            String fileName,
            Configuration configuration,
            AppSpecificStorageConfiguration storageConfig,
            PluginCall call,
            boolean holdForUpload
        ) {
            this.jobId = jobId;
            this.srcUri = srcUri;
            this.fileName = fileName;
            this.configuration = configuration;
            this.storageConfig = storageConfig;
            this.call = call;
            this.holdForUpload = holdForUpload;
        }

        @Override
        public void run() {
            synchronized (this) {
                // stop() đã chạy trước khi worker kịp khởi động: đừng bắt đầu
                // một lần nén mà không còn ai chờ kết quả.
                if (!stopped) {
                    copiesBefore = sourceCopyNames();
                    VideoCompressor.start(
                        getContext(),
                        Collections.singletonList(srcUri), // Nhận vào một List chứa đường dẫn
                        false, // isStreamable
                        null, // sharedStorageConfiguration (Không dùng)
                        storageConfig, // Cấu hình lưu trữ
                        configuration, // Cấu hình chất lượng
                        listener()
                    );
                    started = true;
                }
            }

            if (!started) {
                deliverCancelled();
                return;
            }

            try {
                done.await();
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                deliverCancelled();
                return;
            }

            // Nén hỏng hoặc bị huỷ thì không có gì để upload - về ngay thay vì
            // giữ process sống chờ một finishUpload không bao giờ tới.
            if (!holdForUpload || !compressed) return;

            try {
                // Có hạn chứ không chờ vô tận: nếu caller chết giữa pha upload
                // mà không gọi finishUpload, worker sẽ treo tới khi WorkManager
                // cắt ở phút thứ 10. Về sớm hơn để trả quota job lại cho máy.
                released.await(HOLD_FOR_UPLOAD_TIMEOUT_MINUTES, TimeUnit.MINUTES);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }

        @Override
        public void release() {
            released.countDown();
        }

        @Override
        public void stop() {
            boolean wasRunning;
            synchronized (this) {
                if (stopped) return;
                stopped = true;
                wasRunning = started;
            }

            // Trước mọi thứ khác: worker đang bị cắt, đừng để run() còn ngồi
            // chờ finishUpload nữa.
            released.countDown();

            // Đã trả kết quả (đang giữ cho upload) thì không còn gì của job này
            // để huỷ - cancel() global lúc đó chỉ giết job khác đang nén.
            if (wasRunning && !delivered.get()) {
                try {
                    VideoCompressor.cancel();
                } catch (Exception e) {
                    Log.w(TAG, "Could not cancel compression", e);
                }
            }
            // Luôn tự kết thúc: coroutine của LightCompressor bị huỷ thường ném
            // CancellationException mà không bắn callback nào (trước onStart,
            // hay lúc processAudio/finishMovie không đọc isRunning). claim()
            // biến onCancelled tới sau thành no-op, còn onSuccess lỡ tới thì
            // tự xoá output.
            deliverCancelled();
        }

        private CompressionListener listener() {
            return new CompressionListener() {
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
                    if (!claim()) return;
                    deleteOutput(fileName);
                    call.reject("Nén thất bại: " + failureMessage);
                }

                @Override
                public void onSuccess(int i, long l, @Nullable String s) {
                    // Phải đặt TRƯỚC claim(): claim() mở chốt `done`, và run()
                    // đọc `compressed` ngay khi chốt đó mở để quyết định có ở
                    // lại chờ upload hay không.
                    compressed = s != null;
                    if (!claim()) {
                        // Đã trả CANCELLED trước đó (stop() tự kết thúc):
                        // không ai nhận file này.
                        deleteOutput(fileName);
                        return;
                    }
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
                    deliverCancelled();
                }
            };
        }

        private void deliverCancelled() {
            if (!claim()) return;
            // LightCompressor leaves whatever it had already written behind;
            // without this the cache keeps a partial mp4 per cancel, and
            // nothing ever collects them.
            deleteOutput(fileName);
            // Coded so the caller can tell "the user asked for this" apart
            // from a real failure — same code on every platform.
            call.reject("Đã hủy nén", CANCELLED_CODE);
        }

        /** True đúng một lần, cho nhánh kết thúc đầu tiên tới đích. */
        private boolean claim() {
            if (!delivered.compareAndSet(false, true)) return false;
            Set<String> before = copiesBefore;
            if (before != null) deleteSourceCopiesSince(before);
            synchronized (NativeVideoCompressorPlugin.this) {
                if (jobId.equals(currentJobId)) currentJobId = null;
            }
            done.countDown();
            return true;
        }
    }

    private String workName(String jobId) {
        return "video-compression:" + jobId;
    }

    /** Best-effort: huỷ một work đã xong là no-op, không đáng để hỏng lời gọi cancel. */
    private void cancelWork(String jobId) {
        try {
            WorkManager.getInstance(getContext()).cancelUniqueWork(workName(jobId));
        } catch (Exception e) {
            Log.w(TAG, "Could not cancel work for " + jobId, e);
        }
    }

    /** Best-effort: a partial file left behind is not worth failing over. */
    private void deleteOutput(String fileName) {
        try {
            // Nơi LightCompressor 1.3.2 ghi với AppSpecificStorageConfiguration:
            // File(context.filesDir, "<subFolder>/<name>").
            File dir = new File(getContext().getFilesDir(), STORAGE_SUBFOLDER);
            File partial = new File(dir, fileName);
            if (partial.exists()) {
                partial.delete();
            }
        } catch (Exception e) {
            Log.w(TAG, "Could not delete cancelled output", e);
        }
    }
}
