package com.atomic.videocompressor;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class NativeVideoCompressorTest {

    private static int[] medium(int width, int height) {
        return NativeVideoCompressor.outputSize(width, height, 540);
    }

    @Test
    public void outputSizeCapsShortSideAlignsTo16NeverUpscales() {
        assertArrayEquals(new int[] { 944, 528 }, medium(1920, 1080));
        assertArrayEquals(new int[] { 528, 944 }, medium(1080, 1920));
        assertArrayEquals(new int[] { 944, 528 }, medium(3840, 2160));
        assertArrayEquals(new int[] { 704, 528 }, medium(1440, 1080));
        assertArrayEquals(new int[] { 624, 352 }, medium(640, 360));
        assertArrayEquals(new int[] { 624, 352 }, medium(641, 361));
        assertArrayEquals(new int[] { 320, 176 }, medium(320, 180));
        assertArrayEquals(new int[] { 1904, 1072 }, NativeVideoCompressor.outputSize(3840, 2160, 1080));
        assertArrayEquals(new int[] { 992, 528 }, medium(1000, 528));
        assertNull(medium(0, 1080));
    }

    @Test
    public void bitrateUsesWholeMbpsOrSourceFactorClosestToTarget() {
        // 1080p phone clip ~17 Mbps, MEDIUM 1.5 Mbps: 0.1 x 17 = 1.7 beats 1 or 2 Mbps.
        NativeVideoCompressor.BitratePlan plan = NativeVideoCompressor.bitrate(1_500_000, 17_000_000);
        assertNull(plan.mbps);
        assertEquals(0, plan.sourceFactorIndex);

        // 4K ~50 Mbps: every factor is far above, so 1 Mbps (ties go lower).
        plan = NativeVideoCompressor.bitrate(1_500_000, 50_000_000);
        assertEquals(Integer.valueOf(1), plan.mbps);

        // VERY_HIGH 4.5 Mbps on 17 Mbps: 4 Mbps.
        plan = NativeVideoCompressor.bitrate(4_500_000, 17_000_000);
        assertEquals(Integer.valueOf(4), plan.mbps);

        // Never above source: an 800 kbps clip can't get 1 Mbps.
        plan = NativeVideoCompressor.bitrate(1_500_000, 800_000);
        assertNull(plan.mbps);
        assertEquals(4, plan.sourceFactorIndex);

        // Source below the target: the largest whole Mbps that fits, not 0.6 x source.
        plan = NativeVideoCompressor.bitrate(4_500_000, 3_000_000);
        assertEquals(Integer.valueOf(3), plan.mbps);

        assertNull(NativeVideoCompressor.bitrate(1_500_000, 0));
    }

    @Test
    public void sourceCopyNameIsExactlyThirteenDigits() {
        assertTrue(NativeVideoCompressor.isSourceCopyName("1762761600000"));
        assertFalse(NativeVideoCompressor.isSourceCopyName("176276160000"));
        assertFalse(NativeVideoCompressor.isSourceCopyName("17627616000000"));
        assertFalse(NativeVideoCompressor.isSourceCopyName("1762761600000.mp4"));
        assertFalse(NativeVideoCompressor.isSourceCopyName("compressed_1762761600000.mp4"));
        assertFalse(NativeVideoCompressor.isSourceCopyName("176276160000a"));
        assertFalse(NativeVideoCompressor.isSourceCopyName("files"));
        assertFalse(NativeVideoCompressor.isSourceCopyName(""));
        assertFalse(NativeVideoCompressor.isSourceCopyName(null));
    }

    @Test
    public void staleSourceCopyIsOlderThanProcessStart() {
        long processStart = 1_762_761_600_000L;
        assertTrue(NativeVideoCompressor.isStaleSourceCopy("1762000000000", processStart - 1, processStart));
        assertFalse(NativeVideoCompressor.isStaleSourceCopy("1762761600001", processStart, processStart));
        assertFalse(NativeVideoCompressor.isStaleSourceCopy("1762761600001", processStart + 5_000, processStart));
        assertFalse(NativeVideoCompressor.isStaleSourceCopy("shared_prefs", 0, processStart));
    }

    @Test
    public void unknownQualityFallsBackToMedium() {
        assertEquals(540, NativeVideoCompressor.target("nope").shortSide);
        assertEquals(360, NativeVideoCompressor.target("360P").shortSide);
        assertEquals(1_500_000, NativeVideoCompressor.target(null).bitrate);
    }
}
