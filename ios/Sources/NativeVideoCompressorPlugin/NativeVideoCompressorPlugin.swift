import Foundation
import Capacitor
import AVFoundation
import UIKit
import WebKit

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
        CAPPluginMethod(name: "initialize", returnType: CAPPluginReturnPromise),
    ]

    /// One compress with its own flag, so cancelling an orphaned job can't
    /// cancel (or un-cancel) the job that replaced it.
    private final class Job {
        let id: String
        var isCancelled = false
        init(id: String) { self.id = id }
    }

    /// The job `compressVideo` is running right now, for `cancel(jobId:)`.
    private var currentJob: Job?
    /// Guards `currentJob` and every `Job.isCancelled` — `cancel` arrives on the
    /// main thread while the reader is being driven from the compression queues.
    private let stateLock = NSLock()

    /// Nothing to do natively; AVFoundation needs no warm-up. Answered rather
    /// than left unimplemented so a caller can await it unconditionally.
    @objc func initialize(_ call: CAPPluginCall) {
        call.resolve(["success": true, "message": "No initialization needed on iOS"])
    }

    /**
     * Stop the running compress.
     *
     * Only raises the flag. Calling `cancelReading()` from here tore the reader
     * down while a frame loop was inside `copyNextSampleBuffer()` on its own
     * queue and crashed (`_os_unfair_lock_corruption_abort`). The loops check
     * the flag before every read and finish themselves; the completion handler
     * cancels the reader once neither loop can touch it.
     */
    @objc func cancel(_ call: CAPPluginCall) {
        stateLock.lock()
        let requested = call.getString("jobId")
        // A cancel for a job that isn't the one running would otherwise kill
        // an unrelated caller's compress — there is only ever one.
        guard let running = currentJob, requested == nil || requested == running.id else {
            stateLock.unlock()
            call.resolve(["cancelled": false])
            return
        }
        running.isCancelled = true
        stateLock.unlock()

        call.resolve(["cancelled": true])
    }

    /**
     * Capacitor iOS resets the bridge on every main-frame navigation but has no
     * plugin hook for it, so this is the closest one. A reload (pull-to-refresh,
     * web content process restart) or any same-origin page load ends the JS
     * session that owns the job; left running it encodes for nobody while the
     * new session starts its own. Returning nil keeps Capacitor's own policy.
     */
    override public func shouldOverrideLoad(_ navigationAction: WKNavigationAction) -> NSNumber? {
        if navigationAction.targetFrame?.isMainFrame == true,
           navigationAction.navigationType == .reload
            || navigationAction.request.url?.host == bridge?.webView?.url?.host {
            stateLock.lock()
            currentJob?.isCancelled = true
            stateLock.unlock()
        }
        return nil
    }

    @objc func compressVideo(_ call: CAPPluginCall) {
        guard let sourcePath = call.getString("sourcePath") else {
            call.reject("Missing sourcePath")
            return
        }

        let job = Job(id: call.getString("jobId") ?? "default")
        stateLock.lock()
        // The app runs one compress at a time, so a job still here was orphaned
        // by a JS session the shouldOverrideLoad hook missed.
        currentJob?.isCancelled = true
        currentJob = job
        stateLock.unlock()

        let videoURL = sourcePath.hasPrefix("file://") ? URL(string: sourcePath)! : URL(fileURLWithPath: sourcePath)
        let outputURL = FileManager.default.temporaryDirectory.appendingPathComponent("compressed_\(UUID().uuidString).mp4")
        
        let qualityStr = call.getString("quality") ?? "MEDIUM"
        
        // 1. Định nghĩa Kích thước và Bitrate (Quyết định dung lượng file)
        // Short side of the displayed picture, matching the web QUALITY_LADDER.
        var shortSide: Int
        var targetBitrate: Int // Bitrate càng thấp file càng nhẹ

        print("====== VIDEO COMPRESSION QUALITY: \(qualityStr) ======")

        switch qualityStr {
        case "VERY_HIGH":
            shortSide = 1080; targetBitrate = 4_500_000 // ~4.5 Mbps
        case "HIGH":
            shortSide = 720; targetBitrate = 2_500_000 // ~2.5 Mbps
        case "MEDIUM":
            shortSide = 540; targetBitrate = 1_500_000 // ~1.5 Mbps (Giảm dung lượng cực tốt)
        case "LOW":
            shortSide = 480; targetBitrate = 1_000_000 // ~1.0 Mbps
        case "360P":
            shortSide = 360; targetBitrate = 700_000 // ~0.7 Mbps
        case "VERY_LOW":
            shortSide = 240; targetBitrate = 400_000 // ~0.4 Mbps
        default:
            shortSide = 540; targetBitrate = 1_500_000
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
            job: job,
            outputURL: outputURL,
            shortSide: shortSide,
            targetBitrate: targetBitrate,
            call: call,
            backgroundTask: backgroundTask
        )
    }
    
    // MARK: - Core Compression Logic (AVAssetWriter)
    private func compressWithAVAssetWriter(
        asset: AVAsset,
        job: Job,
        outputURL: URL,
        shortSide: Int,
        targetBitrate: Int,
        call: CAPPluginCall,
        backgroundTask: UIBackgroundTaskIdentifier
    ) {
        guard let videoTrack = asset.tracks(withMediaType: .video).first,
              let outputSize = NativeVideoCompressor.outputSize(naturalSize: videoTrack.naturalSize, shortSide: shortSide) else {
            clearJobState(job)
            call.reject("Không tìm thấy track video")
            return
        }
        let audioTrack = asset.tracks(withMediaType: .audio).first
        
        do {
            let reader = try AVAssetReader(asset: asset)
            let writer = try AVAssetWriter(url: outputURL, fileType: .mp4)
            writer.shouldOptimizeForNetworkUse = true // Tối ưu cho Web/Network

            // A cancel that landed before the loops start would otherwise only
            // be noticed after the writer had started, so honour it now.
            if cancelRequested(job) {
                finishCancelled(job: job, outputURL: outputURL, call: call, backgroundTask: backgroundTask)
                return
            }
            
            let transform = videoTrack.preferredTransform
            let sourceCodec = videoTrack.formatDescriptions.first
                .map { CMFormatDescriptionGetMediaSubType($0 as! CMFormatDescription) } ?? 0

            // --- CẤU HÌNH VIDEO ---
            // Decoder and H.264 encoder both work in YUV 4:2:0; asking for BGRA cost two colour conversions per frame.
            let videoOutputSettings: [String: Any] = [
                kCVPixelBufferPixelFormatTypeKey as String: Int(kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange)
            ]
            let videoOutput = AVAssetReaderTrackOutput(track: videoTrack, outputSettings: videoOutputSettings)
            // Each buffer goes straight to the writer and is never mutated, so the per-sample copy is wasted work.
            videoOutput.alwaysCopiesSampleData = false
            if reader.canAdd(videoOutput) { reader.add(videoOutput) }
            
            let videoInputSettings:[String: Any] = [
                AVVideoCodecKey: AVVideoCodecType.h264,
                AVVideoWidthKey: outputSize.width,
                AVVideoHeightKey: outputSize.height,
                // The default mode is Resize, which stretches. The size already matches the source aspect
                // within even-rounding, so Fill only crops that sub-pixel instead of adding a black line (ResizeAspect).
                AVVideoScalingModeKey: AVVideoScalingModeResizeAspectFill,
                // 8-bit H.264 can't carry HDR: without this an HLG/PQ source keeps its BT.2020 tags on SDR-range data.
                // The writer colour-converts (tone-maps) tagged buffers to these properties; BT.709 sources pass through unchanged.
                AVVideoColorPropertiesKey: [
                    AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
                    AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
                    AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2
                ],
                AVVideoCompressionPropertiesKey:[
                    AVVideoAverageBitRateKey: NativeVideoCompressor.cappedBitrate(
                        target: targetBitrate, sourceRate: videoTrack.estimatedDataRate, floor: 200_000,
                        headroom: NativeVideoCompressor.codecHeadroom(sourceCodec)),
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
                let output = AVAssetReaderTrackOutput(track: audioTrack, outputSettings: audioOutputSettings)
                output.alwaysCopiesSampleData = false
                if reader.canAdd(output) { reader.add(output) }
                audioOutput = output
                
                let audioInputSettings:[String: Any] = [
                    AVFormatIDKey: kAudioFormatMPEG4AAC,
                    AVNumberOfChannelsKey: 2,
                    AVSampleRateKey: 44100,
                    // AAC takes only discrete rates and AVAssetWriterInput raises on an unsupported one,
                    // so snap down to 64/96/128 kbps.
                    AVEncoderBitRateKey: NativeVideoCompressor.cappedBitrate(
                        target: 128_000, sourceRate: audioTrack.estimatedDataRate, floor: 64_000) / 32_000 * 32_000
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
                        if !self.cancelRequested(job), reader.status == .reading, let buffer = videoOutput.copyNextSampleBuffer() {
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
                            if !self.cancelRequested(job), reader.status == .reading, let buffer = aOutput.copyNextSampleBuffer() {
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
                let wasCancelled = job.isCancelled
                if self.currentJob === job { self.currentJob = nil }
                self.stateLock.unlock()

                if wasCancelled {
                    // Both loops have left the group, so nothing else is reading.
                    reader.cancelReading()
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
            clearJobState(job)
            call.reject("Lỗi khởi tạo bộ nén: \(error.localizedDescription)")
        }
    }

    /// Cancelled before the reader started — nothing to stop, just clean up.
    private func finishCancelled(
        job: Job,
        outputURL: URL,
        call: CAPPluginCall,
        backgroundTask: UIBackgroundTaskIdentifier
    ) {
        if backgroundTask != .invalid {
            UIApplication.shared.endBackgroundTask(backgroundTask)
        }
        clearJobState(job)
        try? FileManager.default.removeItem(at: outputURL)
        call.reject("Đã hủy nén", NativeVideoCompressorPlugin.cancelledCode)
    }

    private func cancelRequested(_ job: Job) -> Bool {
        stateLock.lock()
        defer { stateLock.unlock() }
        return job.isCancelled
    }

    private func clearJobState(_ job: Job) {
        stateLock.lock()
        if currentJob === job { currentJob = nil }
        stateLock.unlock()
    }

    /// Matches the `CANCELLED` constant the JS side exports, so one
    /// `error.code` check covers web, iOS and Android alike.
    private static let cancelledCode = "CANCELLED"
}
