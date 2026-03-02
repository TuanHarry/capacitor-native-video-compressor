import Foundation
import Capacitor
import AVFoundation
import UIKit

@objc(NativeVideoCompressorPlugin)
public class NativeVideoCompressorPlugin: CAPPlugin, CAPBridgedPlugin {
    
    // --- BẮT ĐẦU PHẦN ĐĂNG KÝ PLUGIN (Thay thế cho file .m cũ) ---
    public let identifier = "NativeVideoCompressorPlugin"
    public let jsName = "NativeVideoCompressor"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "compressVideo", returnType: CAPPluginReturnPromise)
    ]
    // --- KẾT THÚC PHẦN ĐĂNG KÝ ---
    private var isCompressing = false

    @objc func compressVideo(_ call: CAPPluginCall) {
        // 1. Lấy đường dẫn từ Javascript truyền vào
        guard let sourcePath = call.getString("sourcePath") else {
            call.reject("Missing sourcePath")
            return
        }
        
        // 2. Xử lý đường dẫn (hỗ trợ cả dạng file:// và đường dẫn tuyệt đối)
        let videoURL = sourcePath.hasPrefix("file://") ? URL(string: sourcePath)! : URL(fileURLWithPath: sourcePath)
        
        // Tạo file đầu ra lưu ở thư mục Temp
        let outputURL = FileManager.default.temporaryDirectory.appendingPathComponent("compressed_\(UUID().uuidString).mp4")
        
        // Lấy thông số chất lượng truyền từ giao diện (Mặc định là MEDIUM nếu không có)
        let qualityStr = call.getString("quality") ?? "MEDIUM"
        var presetName: String
        
        print("====== VIDEO COMPRESSION QUALITY RECEIVED: \(qualityStr) ======")
        
        switch qualityStr {
        case "VERY_HIGH":
            presetName = AVAssetExportPresetHighestQuality
        case "HIGH":
            presetName = AVAssetExportPreset1280x720 // 720p cho mức High để nhận thấy sự giảm dung lượng rõ rệt
        case "MEDIUM":
            presetName = AVAssetExportPreset960x540 // 540p cho mức Medium
        case "LOW":
            presetName = AVAssetExportPreset640x480 // 480p cho mức Low
        case "360P" :
            presetName = AVAssetExportPresetMediumQuality // 360p cho mức 
        case "VERY_LOW":
            presetName = AVAssetExportPresetLowQuality // 124 cho mức Very Low
        default:
            presetName = AVAssetExportPreset960x540
        }
        
        let asset = AVAsset(url: videoURL)
        
        // 3. Khởi tạo bộ nén phần cứng với preset tương ứng
        guard let exportSession = AVAssetExportSession(asset: asset, presetName: presetName) else {
            call.reject("Không thể khởi tạo bộ nén iOS")
            return
        }
        
        exportSession.outputURL = outputURL
        exportSession.outputFileType = .mp4
        exportSession.shouldOptimizeForNetworkUse = true
        
        // Báo cho giao diện biết là đã bắt đầu nén
        self.notifyListeners("onProgress", data:["status": "started"])
        
        self.isCompressing = true
        let startTime = Date()
        self.checkProgress(session: exportSession)
        
        // Đăng ký Background Task để ứng dụng tiếp tục nén khi thu nhỏ
        var backgroundTask: UIBackgroundTaskIdentifier = .invalid
        
        // Cần gọi UIBackgroundTaskIdentifier trên Main Thread (nếu an toàn) hoặc dùng trực tiếp (beginBackgroundTask thread-safe)
        backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "VideoCompression") {
            // Callback khi hết thời gian chạy ngầm do OS cấp
            UIApplication.shared.endBackgroundTask(backgroundTask)
            backgroundTask = .invalid
        }
        
        // 5. Bắt đầu tiến trình nén (Chạy ngầm trên GPU)
        exportSession.exportAsynchronously {
            self.isCompressing = false
            let elapsed = Date().timeIntervalSince(startTime)
            print("Compression finished in \(elapsed) seconds. Final status: \(exportSession.status.rawValue)")
            
            DispatchQueue.main.async {
                // Kết thúc Background Task khi xử lý xong
                if backgroundTask != .invalid {
                    UIApplication.shared.endBackgroundTask(backgroundTask)
                    backgroundTask = .invalid
                }
                
                switch exportSession.status {
                case .completed:
                    // THÀNH CÔNG! Trả kết quả về cho Nuxt.js
                    call.resolve([
                        "success": true,
                        "destPath": outputURL.path
                    ])
                case .failed:
                    call.reject("Nén thất bại: \(exportSession.error?.localizedDescription ?? "Lỗi không xác định")")
                case .cancelled:
                    call.reject("Đã hủy nén")
                default:
                    call.reject("Lỗi không xác định")
                }
            }
        }
    }
    
    private func checkProgress(session: AVAssetExportSession) {
        let progress = session.progress * 100
        print("Export Progress: \(progress)%") // Log để debug
        self.notifyListeners("onProgress", data: [
            "status": "progress",
            "percent": Double(progress)
        ])
        
        if self.isCompressing && (session.status == .exporting || session.status == .waiting || session.status == .unknown) {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in
                self?.checkProgress(session: session)
            }
        }
    }
}