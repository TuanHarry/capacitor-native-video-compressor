package com.atomic.videocompressor;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;

public class VideoCompressionService extends Service {

    private static final String TAG = "VideoCompressionService";
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

        try {
            // Google Play đòi mediaProcessing cho tác vụ nén video, nhưng type đó chỉ có
            // từ API 35. Trên API 34 hệ thống đọc ra "type unknown" và startForeground()
            // ném InvalidForegroundServiceTypeException - service không bao giờ vào
            // foreground, nén đứt khi user rời app. Nên chọn type theo SDK_INT lúc chạy;
            // AndroidManifest khai cả hai nên type nào cũng hợp lệ.
            if (Build.VERSION.SDK_INT >= 35) {
                startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROCESSING);
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
            } else {
                // Trước API 29 chưa có khái niệm foreground service type.
                startForeground(NOTIFICATION_ID, notification);
            }
        } catch (Exception e) {
            // Nuốt lỗi ở đây để không giết app, nhưng phải log ra TAG riêng: nếu không,
            // service chạy nền âm thầm và không ai biết cho tới khi user báo nén hỏng.
            Log.e(TAG, "startForeground thất bại - service sẽ chạy nền, nén có thể bị huỷ", e);
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
