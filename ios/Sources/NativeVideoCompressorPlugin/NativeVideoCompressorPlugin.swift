import Foundation
import Capacitor
import AVFoundation
import UIKit

@objc(NativeVideoCompressorPlugin)
public class NativeVideoCompressorPlugin: CAPPlugin, CAPBridgedPlugin {
    
    public let identifier = "NativeVideoCompressorPlugin"
    public let jsName = "NativeVideoCompressor"
    // Every method callable from JS must be listed here. `initialize` was
    // missing, so calling it threw "not implemented" on device — harmless
    // (the web build needs it, native doesn't) but it buried a real signal in
    // a console error every single compress.
    public let pluginMethods:[CAPPluginMethod] = [
        CAPPluginMethod(name: "compressVideo", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "initialize", returnType: CAPPluginReturnPromise)
    ]

    /// The job `compressVideo` is running right now, for `cancel(jobId:)`.
    private var currentJobId: String?
    private var isCancelled = false
    /// Held only so `cancel` can stop it; the compress owns it otherwise.
    private var currentReader: AVAssetReader?
    /// Guards the three fields above — `cancel` arrives on the main thread
    /// while the reader is being driven from the compression queues.
    private let stateLock = NSLock()

    /// Nothing to do natively; AVFoundation needs no warm-up. Answered rather
    /// than left unimplemented so a caller can await it unconditionally.
    @objc func initialize(_ call: CAPPluginCall) {
        call.resolve(["success": true, "message": "No initialization needed on iOS"])
    }

    /**
     * Stop the running compress.
     *
     * `cancelReading()` is all it takes: the frame loops below already check
     * `reader.status == .reading` every pass, so a cancelled reader sends them
     * down the `else` branch — `markAsFinished()`, `group.leave()` — and the
     * existing completion handler runs. No new exit path, no polling.
     */
    @objc func cancel(_ call: CAPPluginCall) {
        stateLock.lock()
        let running = currentJobId
        let requested = call.getString("jobId")
        // A cancel for a job that isn't the one running would otherwise kill
        // an unrelated caller's compress — there is only ever one.
        guard let running = running, requested == nil || requested == running else {
            stateLock.unlock()
            call.resolve(["cancelled": false])
            return
        }
        isCancelled = true
        let reader = currentReader
        stateLock.unlock()

        reader?.cancelReading()
        call.resolve(["cancelled": true])
    }

    @objc func compressVideo(_ call: CAPPluginCall) {
        guard let sourcePath = call.getString("sourcePath") else {
            call.reject("Missing sourcePath")
            return
        }

        stateLock.lock()
        currentJobId = call.getString("jobId") ?? "default"
        isCancelled = false
        stateLock.unlock()

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
            clearJobState()
            call.reject("Không tìm thấy track video")
            return
        }
        let audioTrack = asset.tracks(withMediaType: .audio).first
        
        do {
            let reader = try AVAssetReader(asset: asset)
            let writer = try AVAssetWriter(url: outputURL, fileType: .mp4)
            writer.shouldOptimizeForNetworkUse = true // Tối ưu cho Web/Network

            stateLock.lock()
            currentReader = reader
            // A cancel that landed between compressVideo and here has nothing
            // to call cancelReading() on, so honour it before any work starts.
            let cancelledEarly = isCancelled
            stateLock.unlock()

            if cancelledEarly {
                finishCancelled(outputURL: outputURL, call: call, backgroundTask: backgroundTask)
                return
            }
            
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
                if backgroundTask != .invalid {
                    UIApplication.shared.endBackgroundTask(backgroundTask)
                }

                self.stateLock.lock()
                let wasCancelled = self.isCancelled
                self.currentReader = nil
                self.currentJobId = nil
                self.isCancelled = false
                self.stateLock.unlock()

                if wasCancelled {
                    writer.cancelWriting()
                    try? FileManager.default.removeItem(at: outputURL)
                    call.reject("Đã hủy nén", NativeVideoCompressorPlugin.cancelledCode)
                    return
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
                    try? FileManager.default.removeItem(at: outputURL)
                    call.reject("Lỗi khi đọc file: \(reader.error?.localizedDescription ?? "Unknown")")
                }
            }

        } catch {
            clearJobState()
            call.reject("Lỗi khởi tạo bộ nén: \(error.localizedDescription)")
        }
    }

    /// Cancelled before the reader started — nothing to stop, just clean up.
    private func finishCancelled(
        outputURL: URL,
        call: CAPPluginCall,
        backgroundTask: UIBackgroundTaskIdentifier
    ) {
        if backgroundTask != .invalid {
            UIApplication.shared.endBackgroundTask(backgroundTask)
        }
        clearJobState()
        try? FileManager.default.removeItem(at: outputURL)
        call.reject("Đã hủy nén", NativeVideoCompressorPlugin.cancelledCode)
    }

    private func clearJobState() {
        stateLock.lock()
        currentReader = nil
        currentJobId = nil
        isCancelled = false
        stateLock.unlock()
    }

    /// Matches the `CANCELLED` constant the JS side exports, so one
    /// `error.code` check covers web, iOS and Android alike.
    private static let cancelledCode = "CANCELLED"
}
