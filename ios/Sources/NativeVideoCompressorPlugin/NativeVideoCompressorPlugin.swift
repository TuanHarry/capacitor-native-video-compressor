import Foundation
import Capacitor
import AVFoundation
import UIKit

@objc(NativeVideoCompressorPlugin)
public class NativeVideoCompressorPlugin: CAPPlugin, CAPBridgedPlugin {
    
    public let identifier = "NativeVideoCompressorPlugin"
    public let jsName = "NativeVideoCompressor"
    public let pluginMethods:[CAPPluginMethod] = [
        CAPPluginMethod(name: "compressVideo", returnType: CAPPluginReturnPromise)
    ]
    
    private var isCompressing = false

    @objc func compressVideo(_ call: CAPPluginCall) {
        guard let sourcePath = call.getString("sourcePath") else {
            call.reject("Missing sourcePath")
            return
        }
        
        let videoURL = sourcePath.hasPrefix("file://") ? URL(string: sourcePath)! : URL(fileURLWithPath: sourcePath)
        let outputURL = FileManager.default.temporaryDirectory.appendingPathComponent("compressed_\(UUID().uuidString).mp4")
        
        let qualityStr = call.getString("quality") ?? "MEDIUM"
        
        // 1. Định nghĩa Kích thước và Bitrate (Quyết định dung lượng file)
        var targetWidth: CGFloat
        var targetHeight: CGFloat
        var targetBitrate: Int // Bitrate càng thấp file càng nhẹ
        
        print("====== VIDEO COMPRESSION QUALITY: \(qualityStr) ======")
        
        switch qualityStr {
        case "VERY_HIGH":
            targetWidth = 1920; targetHeight = 1080; targetBitrate = 4_500_000 // ~4.5 Mbps
        case "HIGH":
            targetWidth = 1280; targetHeight = 720; targetBitrate = 2_500_000 // ~2.5 Mbps
        case "MEDIUM":
            targetWidth = 960; targetHeight = 540; targetBitrate = 1_500_000 // ~1.5 Mbps (Giảm dung lượng cực tốt)
        case "LOW":
            targetWidth = 640; targetHeight = 480; targetBitrate = 1_000_000 // ~1.0 Mbps
        case "360P":
            targetWidth = 640; targetHeight = 360; targetBitrate = 700_000 // ~0.7 Mbps
        case "VERY_LOW":
            targetWidth = 426; targetHeight = 240; targetBitrate = 400_000 // ~0.4 Mbps
        default:
            targetWidth = 960; targetHeight = 540; targetBitrate = 1_500_000
        }
        
        let asset = AVAsset(url: videoURL)
        
        self.notifyListeners("onProgress", data:["status": "started"])
        self.isCompressing = true
        
        var backgroundTask: UIBackgroundTaskIdentifier = .invalid
        backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "VideoCompression") {
            UIApplication.shared.endBackgroundTask(backgroundTask)
            backgroundTask = .invalid
        }
        
        // 2. Gọi hàm nén Custom bằng AVAssetWriter
        self.compressWithAVAssetWriter(
            asset: asset,
            outputURL: outputURL,
            targetWidth: targetWidth,
            targetHeight: targetHeight,
            targetBitrate: targetBitrate,
            call: call,
            backgroundTask: backgroundTask
        )
    }
    
    // MARK: - Core Compression Logic (AVAssetWriter)
    private func compressWithAVAssetWriter(
        asset: AVAsset,
        outputURL: URL,
        targetWidth: CGFloat,
        targetHeight: CGFloat,
        targetBitrate: Int,
        call: CAPPluginCall,
        backgroundTask: UIBackgroundTaskIdentifier
    ) {
        guard let videoTrack = asset.tracks(withMediaType: .video).first else {
            call.reject("Không tìm thấy track video")
            return
        }
        let audioTrack = asset.tracks(withMediaType: .audio).first
        
        do {
            let reader = try AVAssetReader(asset: asset)
            let writer = try AVAssetWriter(url: outputURL, fileType: .mp4)
            writer.shouldOptimizeForNetworkUse = true // Tối ưu cho Web/Network
            
            // --- XỬ LÝ KÍCH THƯỚC VÀ CHIỀU XOAY (ORIENTATION) ---
            let naturalSize = videoTrack.naturalSize
            let transform = videoTrack.preferredTransform
            
            // Tính toán chiều thực tế khi hiển thị
            var visualSize = naturalSize.applying(transform)
            visualSize.width = abs(visualSize.width)
            visualSize.height = abs(visualSize.height)
            
            let isVisualPortrait = visualSize.height > visualSize.width
            let boundingWidth = isVisualPortrait ? min(targetWidth, targetHeight) : max(targetWidth, targetHeight)
            let boundingHeight = isVisualPortrait ? max(targetWidth, targetHeight) : min(targetWidth, targetHeight)
            
            let isNaturalPortrait = naturalSize.height > naturalSize.width
            let outputWidth = isNaturalPortrait ? min(boundingWidth, boundingHeight) : max(boundingWidth, boundingHeight)
            let outputHeight = isNaturalPortrait ? max(boundingWidth, boundingHeight) : min(boundingWidth, boundingHeight)
            
            // --- CẤU HÌNH VIDEO ---
            let videoOutputSettings: [String: Any] = [
                kCVPixelBufferPixelFormatTypeKey as String: Int(kCVPixelFormatType_32BGRA)
            ]
            let videoOutput = AVAssetReaderTrackOutput(track: videoTrack, outputSettings: videoOutputSettings)
            if reader.canAdd(videoOutput) { reader.add(videoOutput) }
            
            let videoInputSettings:[String: Any] = [
                AVVideoCodecKey: AVVideoCodecType.h264,
                AVVideoWidthKey: Int(outputWidth),
                AVVideoHeightKey: Int(outputHeight),
                AVVideoCompressionPropertiesKey:[
                    AVVideoAverageBitRateKey: targetBitrate, // ÉP BITRATE TẠI ĐÂY
                    AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel
                ]
            ]
            let videoInput = AVAssetWriterInput(mediaType: .video, outputSettings: videoInputSettings)
            videoInput.transform = transform // Giữ nguyên chiều xoay gốc
            if writer.canAdd(videoInput) { writer.add(videoInput) }
            
            // --- CẤU HÌNH AUDIO ---
            var audioOutput: AVAssetReaderTrackOutput?
            var audioInput: AVAssetWriterInput?
            
            if let audioTrack = audioTrack {
                let audioOutputSettings:[String: Any] = [AVFormatIDKey: kAudioFormatLinearPCM]
                audioOutput = AVAssetReaderTrackOutput(track: audioTrack, outputSettings: audioOutputSettings)
                if reader.canAdd(audioOutput!) { reader.add(audioOutput!) }
                
                let audioInputSettings:[String: Any] = [
                    AVFormatIDKey: kAudioFormatMPEG4AAC,
                    AVNumberOfChannelsKey: 2,
                    AVSampleRateKey: 44100,
                    AVEncoderBitRateKey: 128000 // Audio nén về 128kbps
                ]
                audioInput = AVAssetWriterInput(mediaType: .audio, outputSettings: audioInputSettings)
                if writer.canAdd(audioInput!) { writer.add(audioInput!) }
            }
            
            // --- BẮT ĐẦU NÉN ---
            writer.startWriting()
            reader.startReading()
            writer.startSession(atSourceTime: .zero)
            
            let group = DispatchGroup()
            let videoQueue = DispatchQueue(label: "videoCompressQueue")
            let audioQueue = DispatchQueue(label: "audioCompressQueue")
            
            let duration = CMTimeGetSeconds(asset.duration)
            var lastReportedProgress: Int = 0
            
            // Xử lý Video Frame
            group.enter()
            videoInput.requestMediaDataWhenReady(on: videoQueue) {
                while videoInput.isReadyForMoreMediaData {
                    autoreleasepool {
                        if reader.status == .reading, let buffer = videoOutput.copyNextSampleBuffer() {
                            videoInput.append(buffer)
                            
                            // Tính toán Progress
                            if duration > 0 && !duration.isNaN {
                                let pts = CMSampleBufferGetPresentationTimeStamp(buffer)
                                let currentSeconds = CMTimeGetSeconds(pts)
                                let progress = Int((currentSeconds / duration) * 100)
                                
                                if progress > lastReportedProgress && progress <= 100 {
                                    lastReportedProgress = progress
                                    DispatchQueue.main.async {
                                        self.notifyListeners("onProgress", data:[
                                            "status": "progress",
                                            "percent": Double(progress)
                                        ])
                                    }
                                }
                            }
                        } else {
                            videoInput.markAsFinished()
                            group.leave()
                        }
                    }
                }
            }
            
            // Xử lý Audio Frame
            if let aInput = audioInput, let aOutput = audioOutput {
                group.enter()
                aInput.requestMediaDataWhenReady(on: audioQueue) {
                    while aInput.isReadyForMoreMediaData {
                        autoreleasepool {
                            if reader.status == .reading, let buffer = aOutput.copyNextSampleBuffer() {
                                aInput.append(buffer)
                            } else {
                                aInput.markAsFinished()
                                group.leave()
                            }
                        }
                    }
                }
            }
            
            // --- KẾT THÚC ---
            group.notify(queue: .main) {
                self.isCompressing = false
                if backgroundTask != .invalid {
                    UIApplication.shared.endBackgroundTask(backgroundTask)
                }
                
                if reader.status == .completed {
                    writer.finishWriting {
                        DispatchQueue.main.async {
                            if writer.status == .completed {
                                call.resolve([
                                    "success": true,
                                    "destPath": outputURL.path
                                ])
                            } else {
                                call.reject("Lỗi khi ghi file: \(writer.error?.localizedDescription ?? "Unknown")")
                            }
                        }
                    }
                } else {
                    writer.cancelWriting()
                    call.reject("Lỗi khi đọc file: \(reader.error?.localizedDescription ?? "Unknown")")
                }
            }
            
        } catch {
            call.reject("Lỗi khởi tạo bộ nén: \(error.localizedDescription)")
        }
    }
}
