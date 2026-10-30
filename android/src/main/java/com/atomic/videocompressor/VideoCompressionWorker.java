package com.atomic.videocompressor;

import android.content.Context;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Giữ pha nén chạy được khi user rời app, không cần foreground service.
 *
 * Android 14+ đóng băng process ở trạng thái cached, nên nén bằng một thread
 * thường sẽ đứng lại ngay khi user chuyển app. Foreground service từng là cách
 * giữ nó sống, nhưng Google Play từ chối version code 32: use case này được xếp
 * vào data sync + local processing, không đủ điều kiện cho
 * FOREGROUND_SERVICE_MEDIA_PROCESSING, và họ chỉ đích danh WorkManager làm
 * phương án thay thế. Process đang chạy một worker thì không bị đóng băng.
 *
 * Worker chỉ là vỏ bọc: việc nén thật do plugin đăng ký qua {@link #register}
 * ngay trước khi enqueue, vì chỉ plugin mới giữ được PluginCall để trả kết quả.
 *
 * Giới hạn phải biết: WorkManager dừng worker sau 10 phút. Quá mức đó
 * {@link #onStopped()} huỷ pha nén và caller nhận lỗi CANCELLED - đổi lại lấy
 * được một video dài hơn 10 phút nén xong thì phải có foreground service, thứ
 * không còn được phép ở đây.
 */
public class VideoCompressionWorker extends Worker {

    static final String KEY_JOB_ID = "jobId";

    /**
     * Việc nén do plugin đăng ký, tra theo jobId.
     *
     * Static vì worker được WorkManager dựng mới, không nhận được tham chiếu
     * nào từ phía plugin. Map chỉ có nghĩa trong phạm vi một process: process
     * chết là WebView chết, không còn ai nhận kết quả nén nữa.
     */
    private static final Map<String, Job> pending = new ConcurrentHashMap<>();

    interface Job {
        /** Chạy pha nén và chỉ trả về khi nó đã kết thúc: xong, lỗi, hoặc huỷ. */
        void run();

        /** WorkManager đòi dừng - hết 10 phút, hoặc work bị cancel. */
        void stop();
    }

    static void register(String jobId, Job job) {
        pending.put(jobId, job);
    }

    static void unregister(String jobId) {
        pending.remove(jobId);
    }

    @Nullable
    private volatile Job running = null;

    public VideoCompressionWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        String jobId = getInputData().getString(KEY_JOB_ID);
        if (jobId == null) return Result.success();

        Job job = pending.get(jobId);
        // Không còn job: process đã bị kill và WorkManager dựng lại worker ở
        // process mới. WebView đã chết cùng nó nên không còn ai nhận kết quả -
        // chạy lại pha nén chỉ tốn pin. Success chứ không retry, để WorkManager
        // bỏ hẳn work này đi.
        if (job == null) return Result.success();

        running = job;
        try {
            job.run();
        } finally {
            running = null;
            pending.remove(jobId);
        }
        return Result.success();
    }

    @Override
    public void onStopped() {
        Job job = running;
        if (job != null) job.stop();
        super.onStopped();
    }
}
