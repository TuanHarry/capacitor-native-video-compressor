package com.atomic.videocompressor;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Giữ tiến trình nén + upload sống khi user rời app.
 *
 * Mọi thứ trong đây phải đáp ứng được 5 tiêu chí foreground service của Google
 * Play, vì bản thiếu chúng (1.1.0) đã bị từ chối ở version code 29:
 *
 *  - user perceptible  -> notification có progress thật, cập nhật theo % nén
 *    và theo pha (nén / tải lên), chứ không phải một dòng chữ tĩnh
 *  - stoppable by user -> action "Huỷ" ngay trên notification, vì khi user đã
 *    rời app thì UI trong app không còn với tới được
 *  - runs only as long as necessary -> watchdog tự tắt khi không còn ai báo
 *    tiến trình, để một lần JS chết giữa đường không để lại FGS chạy vô hạn
 */
public class VideoCompressionService extends Service {

    private static final String TAG = "VideoCompressionService";
    private static final String CHANNEL_ID = "VideoCompressionChannel";
    private static final int NOTIFICATION_ID = 1001;

    static final String ACTION_START = "com.atomic.videocompressor.START";
    static final String ACTION_UPLOAD = "com.atomic.videocompressor.UPLOAD";
    static final String ACTION_FINISH = "com.atomic.videocompressor.FINISH";
    /** Do chính user bấm từ notification. */
    static final String ACTION_CANCEL = "com.atomic.videocompressor.CANCEL";

    static final String EXTRA_JOB_ID = "jobId";
    static final String EXTRA_PERCENT = "percent";

    /**
     * Không nhận được update nào trong khoảng này thì coi như phía gọi đã chết
     * (WebView bị kill, hoặc một exception thoát ra ngoài nhánh finishUpload) và
     * tự dừng. Không có nó, `jobs` không bao giờ rỗng và service chạy mãi với
     * một notification treo - đúng thứ khiến Play đánh trượt tiêu chí "runs only
     * for as long as necessary".
     *
     * Chọn 15 phút: dài hơn mọi khoảng lặng hợp lệ (upload một video đã nén trên
     * mạng chậm, hoặc pha nén chưa kịp bắn progress đầu tiên), ngắn hơn nhiều so
     * với mức mà user kịp nhận ra có gì đó treo.
     */
    private static final long WATCHDOG_MS = 15 * 60 * 1000L;

    /** Đừng vẽ lại notification mỗi tick progress của LightCompressor. */
    private static final long MIN_REDRAW_INTERVAL_MS = 500L;

    private enum Phase { COMPRESSING, UPLOADING }

    private static final class Job {
        Phase phase = Phase.COMPRESSING;
        int percent = 0;
    }

    /** LinkedHashMap: notification một job hiển thị đúng job đã bắt đầu trước. */
    private final Map<String, Job> jobs = new LinkedHashMap<>();

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable watchdog = this::onWatchdogFired;

    private long lastRedrawUptime = 0;
    private boolean inForeground = false;

    /**
     * Instance đang sống, để plugin đẩy % vào mà không phải gửi một Intent cho
     * mỗi tick.
     *
     * volatile vì được đọc từ thread nền: LightCompressor gọi onProgress thẳng
     * từ coroutine encoder (Dispatchers.Default), không hop về main - đã kiểm
     * bằng bytecode, onProgressChanged gọi listener trực tiếp không qua
     * withContext. Thiếu volatile thì thread đó có thể đọc phải một tham chiếu
     * cũ của service đã destroy.
     */
    @Nullable
    private static volatile VideoCompressionService instance = null;

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID, "Xử lý và tải video lên", NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("Tiến trình nén và tải video lên");
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.createNotificationChannel(channel);
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacks(watchdog);
        if (instance == this) instance = null;
        super.onDestroy();
    }

    /**
     * Cập nhật tiến độ nén. Gọi được từ thread bất kỳ.
     *
     * No-op khi service chưa/không còn sống: progress là thông tin trang trí,
     * không đáng để dựng lại một foreground service đã tắt.
     */
    static void publishProgress(String jobId, int percent) {
        VideoCompressionService service = instance;
        if (service == null) return;
        // Chuyển về main thread: lời gọi tới đây nằm trên thread encoder của
        // LightCompressor, còn jobs/handler/notification đều chỉ được chạm từ
        // main. Không post thì LinkedHashMap bị sửa đồng thời với onStartCommand.
        service.handler.post(() -> service.applyProgress(jobId, percent));
    }

    private void applyProgress(String jobId, int percent) {
        Job job = jobs.get(jobId);
        if (job == null) return;

        int clamped = Math.max(0, Math.min(100, percent));
        // Mỗi update đều gia hạn watchdog, kể cả khi bỏ qua việc vẽ lại:
        // throttle chỉ để tiết kiệm vẽ, không phải dấu hiệu job đã chết.
        armWatchdog();
        if (job.percent == clamped) return;
        job.percent = clamped;

        long now = SystemClock.uptimeMillis();
        if (now - lastRedrawUptime < MIN_REDRAW_INTERVAL_MS && clamped < 100) return;
        lastRedrawUptime = now;
        render();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) {
            // START_NOT_STICKY nên chỉ xảy ra khi hệ thống restart service;
            // không có job nào để phục hồi, dừng cho sạch.
            stopEverything();
            return START_NOT_STICKY;
        }

        String action = intent.getAction();

        if (ACTION_CANCEL.equals(action)) {
            // Notification là thứ duy nhất user còn thấy khi đã rời app, nên
            // nút này huỷ tất cả: không có UI nào ở đây để chọn từng job.
            NativeVideoCompressorPlugin.cancelAllFromNotification();
            stopEverything();
            return START_NOT_STICKY;
        }

        String jobId = intent.getStringExtra(EXTRA_JOB_ID);
        if (jobId == null) return START_NOT_STICKY;

        if (ACTION_START.equals(action)) {
            jobs.put(jobId, new Job());
        } else if (ACTION_UPLOAD.equals(action)) {
            Job job = jobs.get(jobId);
            if (job != null) {
                job.phase = Phase.UPLOADING;
                // Pha upload không có % nào bắn về, nên thanh progress chuyển
                // sang indeterminate thay vì đứng im ở con số của pha nén.
                job.percent = -1;
            }
        } else if (ACTION_FINISH.equals(action)) {
            jobs.remove(jobId);
        }

        if (jobs.isEmpty()) {
            stopEverything();
            return START_NOT_STICKY;
        }

        armWatchdog();
        lastRedrawUptime = SystemClock.uptimeMillis();
        render();
        return START_NOT_STICKY;
    }

    /**
     * startForeground() phải được gọi trong mọi nhánh của onStartCommand đến
     * được từ startForegroundService(), kể cả nhánh dừng ngay: nếu không,
     * Android giết cả app bằng ForegroundServiceDidNotStartInTimeException.
     */
    private void render() {
        Job shown = jobs.values().iterator().next();
        int running = jobs.size();
        boolean indeterminate = shown.percent < 0;

        String title;
        if (running > 1) {
            title = "Đang xử lý " + running + " video";
        } else {
            title = shown.phase == Phase.UPLOADING ? "Đang tải video lên" : "Đang nén video";
        }

        // Hai pha nói hai điều khác nhau, vì chúng chạy ở hai nơi khác nhau.
        //
        // Nén chạy ở native trong chính service này nên vẫn chạy khi app
        // xuống nền. Upload thì chạy bằng JS trong webview, nên nó đứng lại
        // và chỉ tiếp tục khi app trở lại foreground - đo được: nén xong là
        // mọi hoạt động mạng dừng hẳn cho tới khi watchdog tự dừng service
        // sau 15 phút. Vì vậy pha upload phải nói rõ việc người dùng cần làm.
        String text;
        if (shown.phase == Phase.UPLOADING) {
            text = indeterminate
                ? "Mở lại ứng dụng để hoàn tất tải lên"
                : shown.percent + "% - mở lại ứng dụng để hoàn tất tải lên";
        } else {
            text = indeterminate
                ? "Đang nén video"
                : shown.percent + "% - đang nén";
        }

        Notification notification = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(text)
            .setSmallIcon(resolveSmallIcon())
            .setProgress(100, indeterminate ? 0 : shown.percent, indeterminate)
            .setOngoing(true)
            // Không có nó, mỗi lần vẽ lại progress là một lần notification
            // nhảy lên đầu danh sách và rung máy.
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setContentIntent(buildOpenAppIntent())
            .addAction(0, "Huỷ", buildCancelIntent())
            .build();

        try {
            ServiceCompat.startForeground(
                this, NOTIFICATION_ID, notification, resolveForegroundType()
            );
            inForeground = true;
        } catch (Exception e) {
            // Nuốt để không giết app, nhưng log: service chạy nền âm thầm thì
            // nén vẫn bị huỷ ngay khi user rời app và không ai biết tại sao.
            Log.e(TAG, "startForeground thất bại - tiến trình có thể bị huỷ khi rời app", e);
        }
    }

    /**
     * Type phải đổi theo pha chứ không cố định: Play xếp nén vào media
     * transcoding còn tải lên vào data sync, và khai nén dưới dataSync chính là
     * lý do version code 30 bị từ chối. Nhiều job song song thì lấy hợp của các
     * pha, vì cả service chỉ có một notification chung cho chúng.
     */
    private int resolveForegroundType() {
        int type = 0;
        for (Job job : jobs.values()) {
            type |= job.phase == Phase.UPLOADING
                ? ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
                : mediaProcessingType();
        }
        return type;
    }

    /**
     * mediaProcessing chỉ tồn tại từ API 35; thiết bị cũ hơn không nhận type này
     * và startForeground sẽ ném. Ở đó pha nén vẫn chạy dưới dataSync như bản
     * 1.1.3. destini-web đặt minSdk 35 nên nhánh fallback không bao giờ chạy
     * trong app đó, nhưng plugin build độc lập vẫn hạ tới minSdk 24.
     */
    private static int mediaProcessingType() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.VANILLA_ICE_CREAM
            ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROCESSING
            : ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC;
    }

    /**
     * Icon brand của app nếu có drawable `ic_stat_video_compress`, nếu không thì
     * icon hệ thống. Notification mang icon hệ thống trông như của Android chứ
     * không phải của app - trên video demo gửi Play, đó là một điểm trừ.
     */
    private int resolveSmallIcon() {
        int id = getResources().getIdentifier("ic_stat_video_compress", "drawable", getPackageName());
        return id != 0 ? id : android.R.drawable.ic_popup_sync;
    }

    private PendingIntent buildCancelIntent() {
        Intent intent = new Intent(this, VideoCompressionService.class).setAction(ACTION_CANCEL);
        return PendingIntent.getService(
            this, 1, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }

    /** Bấm vào notification thì quay lại app, chứ không phải không có gì xảy ra. */
    @Nullable
    private PendingIntent buildOpenAppIntent() {
        Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (launch == null) return null;
        launch.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(
            this, 2, launch, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }

    private void armWatchdog() {
        handler.removeCallbacks(watchdog);
        handler.postDelayed(watchdog, WATCHDOG_MS);
    }

    private void onWatchdogFired() {
        Log.w(TAG, "Không có tiến trình nào trong " + (WATCHDOG_MS / 60000) + " phút - tự dừng");
        NativeVideoCompressorPlugin.cancelAllFromNotification();
        stopEverything();
    }

    /**
     * Android 15+ giới hạn dataSync và mediaProcessing mỗi loại 6 giờ/24 giờ
     * rồi gọi onTimeout, và service này dùng cả hai type. Phải
     * dừng trong vài giây, nếu không app ăn ANR. destini-web đặt minSdk 35 nên
     * mọi thiết bị đều ở trong diện này.
     */
    @Override
    public void onTimeout(int startId, int fgsType) {
        Log.w(TAG, "Hệ thống hết hạn foreground service (type " + fgsType + ") - dừng ngay");
        NativeVideoCompressorPlugin.cancelAllFromNotification();
        stopEverything();
    }

    /** Overload của API 34, giữ lại cho thiết bị chạy Android 14. */
    @Override
    public void onTimeout(int startId) {
        Log.w(TAG, "Hệ thống hết hạn foreground service - dừng ngay");
        NativeVideoCompressorPlugin.cancelAllFromNotification();
        stopEverything();
    }

    private void stopEverything() {
        handler.removeCallbacks(watchdog);
        jobs.clear();
        if (inForeground) {
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
            inForeground = false;
        }
        stopSelf();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
