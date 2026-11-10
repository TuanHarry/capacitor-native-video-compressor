import XCTest
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
}
