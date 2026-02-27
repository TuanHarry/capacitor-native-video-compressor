package com.atomic.videocompressor;

import android.net.Uri;
import java.util.Collections;
import com.abedelazizshe.lightcompressorlibrary.CompressionListener;
import com.abedelazizshe.lightcompressorlibrary.VideoCompressor;
import com.abedelazizshe.lightcompressorlibrary.VideoQuality;
import com.abedelazizshe.lightcompressorlibrary.config.Configuration;
import com.abedelazizshe.lightcompressorlibrary.config.AppSpecificStorageConfiguration;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import java.io.File;
import java.util.Arrays;
import android.content.Intent;

@CapacitorPlugin(name = "NativeVideoCompressor")
public class NativeVideoCompressorPlugin extends Plugin {

    @PluginMethod
    public void compressVideo(PluginCall call) {
        String sourcePath = call.getString("sourcePath");
        
        if (sourcePath == null) {
            call.reject("Missing sourcePath");
            return;
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
            try {
                videoQuality = VideoQuality.valueOf(qualityString);
            } catch (IllegalArgumentException e) {
                videoQuality = VideoQuality.MEDIUM;
            }
        }

        // 2. Cấu hình thông số nén (Dành riêng cho LightCompressor 1.3.2)
        // Lưu ý: Java phải truyền đủ 9 tham số do thư viện gốc viết bằng Kotlin
        Configuration configuration = new Configuration(
                videoQuality, // Chất lượng nén
                false, // isMinBitrateCheckEnabled
                null,  // videoBitrateInMbps
                false, // disableAudio
                false, // keepOriginalResolution
                null,  // videoWidth
                null,  // videoHeight
                Arrays.asList(fileName) // videoNames
        );

        // 3. Cấu hình nơi lưu (Lưu an toàn vào thư mục nội bộ của App)
        AppSpecificStorageConfiguration storageConfig = new AppSpecificStorageConfiguration("compressed_videos");

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
                false,                 // isStreamable
                null,                  // sharedStorageConfiguration (Không dùng)
                storageConfig,         // Cấu hình lưu trữ
                configuration,         // Cấu hình chất lượng
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
                        getContext().stopService(serviceIntent);
                        call.reject("Nén thất bại: " + failureMessage);
                    }

                    @Override
                    public void onSuccess(int i, long l, @Nullable String s) {
                        getContext().stopService(serviceIntent);
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
                        getContext().stopService(serviceIntent);
                        call.reject("Đã hủy nén");
                    }
                }
        );
    }
}