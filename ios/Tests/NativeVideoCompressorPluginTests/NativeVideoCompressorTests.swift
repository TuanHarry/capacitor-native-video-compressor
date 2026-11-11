import XCTest
import CoreMedia
@testable import NativeVideoCompressorPlugin

class NativeVideoCompressorTests: XCTestCase {
    func testEcho() {
        // This is an example of a functional test case for a plugin.
        // Use XCTAssert and related functions to verify your tests produce the correct results.

        let implementation = NativeVideoCompressor()
        let value = "Hello, World!"
        let result = implementation.echo(value)

        XCTAssertEqual(value, result)
    }

    func testOutputSizeCapsShortSideKeepsAspectNeverUpscales() {
        func size(_ w: CGFloat, _ h: CGFloat, _ short: Int = 540) -> [Int]? {
            NativeVideoCompressor.outputSize(naturalSize: CGSize(width: w, height: h), shortSide: short).map { [$0.width, $0.height] }
        }
        // Also portrait iPhone video: natural 1920x1080 plus a 90 degree transform displays as 540x960.
        XCTAssertEqual(size(1920, 1080), [960, 540])
        XCTAssertEqual(size(1080, 1920), [540, 960])
        XCTAssertEqual(size(1440, 1080), [720, 540])
        XCTAssertEqual(size(1080, 1080), [540, 540])
        XCTAssertEqual(size(1170, 2532), [540, 1168])
        XCTAssertEqual(size(480, 360), [480, 360])
        XCTAssertEqual(size(641, 361), [640, 360])
        XCTAssertEqual(size(1920, 1080, 1080), [1920, 1080])
        XCTAssertNil(size(0, 0))
    }

    func testCappedBitrateNeverExceedsSourceAndKeepsFloor() {
        XCTAssertEqual(NativeVideoCompressor.cappedBitrate(target: 1_500_000, sourceRate: 1_000_000, floor: 200_000), 1_000_000)
        XCTAssertEqual(NativeVideoCompressor.cappedBitrate(target: 1_500_000, sourceRate: 9_000_000, floor: 200_000), 1_500_000)
        XCTAssertEqual(NativeVideoCompressor.cappedBitrate(target: 1_500_000, sourceRate: 1_000, floor: 200_000), 200_000)
        XCTAssertEqual(NativeVideoCompressor.cappedBitrate(target: 1_500_000, sourceRate: 0, floor: 200_000), 1_500_000)
        XCTAssertEqual(NativeVideoCompressor.cappedBitrate(target: 128_000, sourceRate: 96_000, floor: 64_000), 96_000)
        XCTAssertEqual(NativeVideoCompressor.cappedBitrate(target: 1_500_000, sourceRate: 1e30, floor: 200_000), 1_500_000)
        XCTAssertEqual(NativeVideoCompressor.cappedBitrate(target: 1_500_000, sourceRate: 800_000, floor: 200_000, headroom: 1.5), 1_200_000)
        XCTAssertEqual(NativeVideoCompressor.cappedBitrate(target: 1_500_000, sourceRate: 1_200_000, floor: 200_000, headroom: 1.5), 1_500_000)
    }

    func testCodecHeadroom() {
        XCTAssertEqual(NativeVideoCompressor.codecHeadroom(kCMVideoCodecType_HEVC), 1.5)
        XCTAssertEqual(NativeVideoCompressor.codecHeadroom(kCMVideoCodecType_H264), 1)
    }

    func testOnlyFragmentNavigationsKeepTheJob() {
        func isFragment(_ to: String, _ from: String) -> Bool {
            NativeVideoCompressorPlugin.isFragmentNavigation(to: URL(string: to), from: URL(string: from))
        }
        XCTAssertTrue(isFragment("capacitor://localhost/feed#x", "capacitor://localhost/feed"))
        XCTAssertTrue(isFragment("capacitor://localhost/feed#y", "capacitor://localhost/feed#x"))
        XCTAssertFalse(isFragment("capacitor://localhost/feed", "capacitor://localhost/feed#x"))
        XCTAssertFalse(isFragment("capacitor://localhost/feed", "capacitor://localhost/feed"))
        XCTAssertFalse(isFragment("capacitor://localhost/other#x", "capacitor://localhost/feed"))
    }
}
