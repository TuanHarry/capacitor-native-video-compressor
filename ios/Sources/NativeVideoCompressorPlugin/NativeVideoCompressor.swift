import Foundation
import CoreGraphics

@objc public class NativeVideoCompressor: NSObject {
    @objc public func echo(_ value: String) -> String {
        print(value)
        return value
    }

    /// Encoder size in the track's natural orientation. `shortSide` caps the
    /// shorter displayed side, like the web `QUALITY_LADDER`; the long side keeps
    /// the source aspect ratio. A 90/270 degree `preferredTransform` only swaps
    /// width and height, so the short/long pair is the same in natural and
    /// display orientation and the transform is not needed here.
    /// Nil for an empty track: dividing by zero would trap.
    static func outputSize(naturalSize: CGSize, shortSide: Int) -> (width: Int, height: Int)? {
        let width = abs(naturalSize.width), height = abs(naturalSize.height)
        let sourceShort = min(width, height)
        guard sourceShort > 0 else { return nil }
        let short = min(CGFloat(shortSide), sourceShort)
        // Floor, not round: rounding an odd side up to even would upscale by a pixel.
        func even(_ value: CGFloat) -> Int { max(2, Int(value / 2) * 2) }
        let outShort = even(short)
        let outLong = even(max(width, height) * short / sourceShort)
        return width >= height ? (outLong, outShort) : (outShort, outLong)
    }
}
