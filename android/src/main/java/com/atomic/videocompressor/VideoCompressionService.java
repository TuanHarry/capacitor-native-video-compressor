package com.atomic.videocompressor;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
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
 * Giữ pha nén sống khi user rời app.
 *
 * Chỉ pha nén, không kèm upload: upload chạy bằng JS trong webview nên nó đứng
 * lại ngay khi app xuống nền, và một foreground service ngồi chờ user quay lại
 * là khai một việc không diễn ra - Play từ chối version code 30 vì đúng loại
 * sai lệch đó (nén khai dưới dataSync). Service giờ sống đúng bằng pha nén.
 *
 * Mọi thứ trong đây phải đáp ứng được 5 tiêu chí foreground service của Google
 * Play, vì bản thiếu chúng (1.1.0) đã bị từ chối ở version code 29:
 *
 *  - user perceptible  -> notification có progress thật, cập nhật theo % nén,
 *    chứ không phải một dòng chữ tĩnh
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
    static final String ACTION_FINISH = "com.atomic.videocompressor.FINISH";
    /** Do chính user bấm từ notification. */
    static final String ACTION_CANCEL = "com.atomic.videocompressor.CANCEL";

    static final String EXTRA_JOB_ID = "jobId";
    static final String EXTRA_PERCENT = "percent";

    /**
     * Không nhận được update nào trong khoảng này thì coi như phía gọi đã chết
     * (WebView bị kill, hoặc một exception thoát ra ngoài mọi nhánh kết thúc
     * job) và tự dừng. Không có nó, `jobs` không bao giờ rỗng và service chạy
     * mãi với một notification treo - đúng thứ khiến Play đánh trượt tiêu chí
     * "runs only for as long as necessary".
     *
     * Chọn 15 phút: dài hơn mọi khoảng lặng hợp lệ (pha nén chưa kịp bắn
     * progress đầu tiên trên một video dài), ngắn hơn nhiều so với mức mà user
     * kịp nhận ra có gì đó treo.
     */
    private static final long WATCHDOG_MS = 15 * 60 * 1000L;

    /** Đừng vẽ lại notification mỗi tick progress của LightCompressor. */
    private static final long MIN_REDRAW_INTERVAL_MS = 500L;

    private static final class Job {
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
            CHANNEL_ID, "Nén video", NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("Tiến trình nén video");
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

        String title = running > 1
            ? "Đang nén " + running + " video"
            : "Đang nén video";

        Notification notification = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(shown.percent + "% - đang nén")
            .setSmallIcon(resolveSmallIcon())
            .setProgress(100, shown.percent, false)
            .setOngoing(true)
            // Không có nó, mỗi lần vẽ lại progress là một lần notification
            // nhảy lên đầu danh sách và rung máy.
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setContentIntent(buildOpenAppIntent())
            .addAction(0, "Huỷ", buildCancelIntent())
            .build();

        try {
            // Gọi thẳng Service.startForeground, KHÔNG qua ServiceCompat:
            // ServiceCompat.Api34Impl AND type với một mask cứng các type có từ
            // Android 14 (FOREGROUND_SERVICE_TYPE_ALLOWED_SINCE_U), mà
            // mediaProcessing thì mới có ở Android 15. Qua nó, 8192 & mask = 0
            // và hệ thống ném InvalidForegroundServiceTypeException "type none".
            // Đo trên emulator API 36: startForegroundCount=0, service không bao
            // giờ vào foreground.
            startForeground(
                NOTIFICATION_ID, notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROCESSING
            );
            inForeground = true;
        } catch (Exception e) {
            // Nuốt để không giết app, nhưng log: service chạy nền âm thầm thì
            // nén vẫn bị huỷ ngay khi user rời app và không ai biết tại sao.
            Log.e(TAG, "startForeground thất bại - tiến trình có thể bị huỷ khi rời app", e);
        }
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
     * Android 15+ giới hạn mediaProcessing tổng 6 giờ/24 giờ rồi gọi onTimeout. Phải
     * dừng trong vài giây, nếu không app ăn ANR. destini-web đặt minSdk 35 nên
     * mọi thiết bị đều ở trong diện này.
     */
    @Override
    public void onTimeout(int startId, int fgsType) {
        Log.w(TAG, "Hệ thống hết hạn foreground service (type " + fgsType + ") - dừng ngay");
        NativeVideoCompressorPlugin.cancelAllFromNotification();
        stopEverything();
    }

    /**
     * Overload của API 34. minSdk 35 nên hệ thống luôn gọi bản hai tham số ở
     * trên; giữ lại vì bản mặc định của Service không làm gì, và một thiết bị
     * gọi nhầm vào đây mà service không dừng thì app ăn ANR.
     */
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
