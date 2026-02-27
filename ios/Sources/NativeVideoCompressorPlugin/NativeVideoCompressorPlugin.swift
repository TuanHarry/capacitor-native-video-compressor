import Foundation
import Capacitor
import AVFoundation

@objc(NativeVideoCompressorPlugin)
public class NativeVideoCompressorPlugin: CAPPlugin, CAPBridgedPlugin {
    
    // --- BẮT ĐẦU PHẦN ĐĂNG KÝ PLUGIN (Thay thế cho file .m cũ) ---
    public let identifier = "NativeVideoCompressorPlugin"
    public let jsName = "NativeVideoCompressor"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "compressVideo", returnType: CAPPluginReturnPromise)
    ]
    // --- KẾT THÚC PHẦN ĐĂNG KÝ ---

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
        
        let asset = AVAsset(url: videoURL)
        
        // 3. Khởi tạo bộ nén phần cứng (Chọn chất lượng MediumQuality hoặc 1280x720)
        guard let exportSession = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetMediumQuality) else {
            call.reject("Không thể khởi tạo bộ nén iOS")
            return
        }
        
        exportSession.outputURL = outputURL
        exportSession.outputFileType = .mp4
        exportSession.shouldOptimizeForNetworkUse = true
        
        // Báo cho giao diện biết là đã bắt đầu nén
        self.notifyListeners("onProgress", data:["status": "started"])
        
        // 4. Timer báo % tiến trình về cho Frontend (Cập nhật mỗi 0.1s)
        let timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { _ in
            let progress = exportSession.progress * 100
            self.notifyListeners("onProgress", data: [
                "status": "progress",
                "percent": progress
            ])
        }
        
        // 5. Bắt đầu tiến trình nén (Chạy ngầm trên GPU)
        exportSession.exportAsynchronously {
            timer.invalidate() // Dừng báo % khi chạy xong
            
            DispatchQueue.main.async {
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
}