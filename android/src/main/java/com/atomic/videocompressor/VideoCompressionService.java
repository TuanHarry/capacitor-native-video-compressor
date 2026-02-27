package com.atomic.videocompressor;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;

public class VideoCompressionService extends Service {

    private static final String CHANNEL_ID = "VideoCompressionChannel";
    private static final int NOTIFICATION_ID = 1001;

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Notification notification = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("Đang nén video")
                .setContentText("Tiến trình đang chạy ngầm...")
                .setSmallIcon(android.R.drawable.ic_popup_sync)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .build();

        // Check for Android 14+ specific foreground service typing requirements if compiled against API 34+
        // In this case, we rely on the manifest declaration for dataSync.
        try {
            startForeground(NOTIFICATION_ID, notification);
        } catch (Exception e) {
            e.printStackTrace();
        }

        return START_NOT_STICKY;
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel serviceChannel = new NotificationChannel(
                    CHANNEL_ID,
                    "Video Compression Service Channel",
                    NotificationManager.IMPORTANCE_LOW
            );
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.createNotificationChannel(serviceChannel);
            }
        }
    }
}
