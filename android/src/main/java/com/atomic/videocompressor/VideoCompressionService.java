package com.atomic.videocompressor;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import java.util.HashMap;
import java.util.Map;

public class VideoCompressionService extends Service {

    private static final String CHANNEL_ID = "VideoCompressionChannel";
    private static final int NOTIFICATION_ID = 1001;
    private static final String ACTION_START = "com.atomic.videocompressor.START";
    private static final String ACTION_UPLOAD = "com.atomic.videocompressor.UPLOAD";
    private static final String ACTION_FINISH = "com.atomic.videocompressor.FINISH";
    private final Map<String, Boolean> jobs = new HashMap<>();

    @Override
    public void onCreate() {
        super.onCreate();
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID, "Video processing and upload", NotificationManager.IMPORTANCE_LOW
        );
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.createNotificationChannel(channel);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) return START_NOT_STICKY;
        String jobId = intent.getStringExtra("jobId");
        if (jobId == null) return START_NOT_STICKY;

        String action = intent.getAction();
        if (ACTION_START.equals(action)) jobs.put(jobId, false);
        else if (ACTION_UPLOAD.equals(action) && jobs.containsKey(jobId)) jobs.put(jobId, true);
        else if (ACTION_FINISH.equals(action)) jobs.remove(jobId);

        if (jobs.isEmpty()) {
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
            stopSelf(startId);
            return START_NOT_STICKY;
        }

        int type = 0;
        for (boolean uploading : jobs.values()) {
            type |= uploading
                ? ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
                : ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROCESSING;
        }
        boolean uploading = jobs.containsValue(true);
        Notification notification = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(uploading ? "Đang tải video lên" : "Đang nén video")
            .setContentText("Tác vụ sẽ tiếp tục khi bạn dùng ứng dụng khác")
            .setSmallIcon(android.R.drawable.ic_popup_sync)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build();
        ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, type);
        return START_NOT_STICKY;
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
