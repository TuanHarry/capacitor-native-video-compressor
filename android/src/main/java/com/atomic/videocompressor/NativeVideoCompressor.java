package com.atomic.videocompressor;

import java.util.regex.Pattern;

/**
 * Output size, bitrate and leftover-file rules for one compress, kept free of
 * android.* so they run as plain JVM unit tests. Same ladder as iOS
 * (NativeVideoCompressorPlugin.swift) and the web QUALITY_LADDER.
 */
public class NativeVideoCompressor {

    /**
     * LightCompressor 1.3.2 getMediaPath copies any source it can't resolve
     * through MediaStore `_data` (file:// and Photo Picker URIs) to
     * `dataDir/<System.currentTimeMillis()>` and never deletes it.
     */
    private static final Pattern SOURCE_COPY_NAME = Pattern.compile("\\d{13}");

    static boolean isSourceCopyName(String name) {
        return name != null && SOURCE_COPY_NAME.matcher(name).matches();
    }

    /**
     * A copy older than `cutoff` (process start, or "now" on a WebView reload
     * when every job is orphaned) can't belong to a live job.
     */
    static boolean isStaleSourceCopy(String name, long lastModified, long cutoff) {
        return isSourceCopyName(name) && lastModified < cutoff;
    }

    /**
     * Factors LightCompressor 1.3.2 applies to the source bitrate when no
     * explicit bitrate is given (CompressorUtils.getBitrate), in VideoQuality
     * order VERY_LOW, LOW, MEDIUM, HIGH, VERY_HIGH.
     */
    static final double[] SOURCE_FACTORS = { 0.1, 0.2, 0.3, 0.4, 0.6 };

    static final class Target {

        final int shortSide;
        final long bitrate;

        Target(int shortSide, long bitrate) {
            this.shortSide = shortSide;
            this.bitrate = bitrate;
        }
    }

    static Target target(String quality) {
        if (quality == null) quality = "MEDIUM";
        switch (quality) {
            case "VERY_HIGH":
                return new Target(1080, 4_500_000);
            case "HIGH":
                return new Target(720, 2_500_000);
            case "LOW":
                return new Target(480, 1_000_000);
            case "360P":
                return new Target(360, 700_000);
            case "VERY_LOW":
                return new Target(240, 400_000);
            default:
                return new Target(540, 1_500_000);
        }
    }

    /**
     * {width, height} in the track's coded orientation, or null for an empty
     * track. `shortSide` caps the shorter side and the long side keeps the
     * aspect ratio. A 90/270 rotation only swaps the sides, and LightCompressor
     * swaps explicit dimensions itself for those, so coded order is right.
     * Unlike iOS, both sides drop to a multiple of 16 (so 540 becomes 528).
     */
    static int[] outputSize(int width, int height, int shortSide) {
        int sourceShort = Math.min(width, height);
        if (sourceShort <= 0) return null;
        int sourceLong = Math.max(width, height);
        int shortOut = Math.min(shortSide, sourceShort);
        int outShort = align16(shortOut);
        int outLong = align16((double) sourceLong * shortOut / sourceShort);
        return width >= height ? new int[] { outLong, outShort } : new int[] { outShort, outLong };
    }

    // Some MediaTek and older Qualcomm AVC encoders fail configure or draw green
    // edges off 16-pixel macroblocks; LightCompressor's own sizing aligns for that.
    // Floor so it never upscales.
    private static int align16(double value) {
        return Math.max(16, (int) (value / 16) * 16);
    }

    static final class BitratePlan {

        /** Whole Mbps for Configuration.videoBitrateInMbps, or null to scale the source instead. */
        final Integer mbps;

        /** Index into SOURCE_FACTORS when mbps is null. */
        final int sourceFactorIndex;

        BitratePlan(Integer mbps, int sourceFactorIndex) {
            this.mbps = mbps;
            this.sourceFactorIndex = sourceFactorIndex;
        }
    }

    /**
     * LightCompressor 1.3.2 only takes whole Mbps or a fixed fraction of the
     * source bitrate, so pick whichever lands closest to the target, never
     * above the source. Null when the source bitrate is unknown.
     */
    static BitratePlan bitrate(long target, long source) {
        if (source <= 0) return null;
        BitratePlan best = null;
        long bestDistance = Long.MAX_VALUE;
        long bestBps = 0;

        // Down to 1, not just floor/ceil of the target: a source below the
        // target should get the largest whole Mbps it still fits.
        for (long mbps = target / 1_000_000 + 1; mbps >= 1; mbps--) {
            long bps = mbps * 1_000_000;
            if (bps > source) continue;
            long distance = Math.abs(bps - target);
            if (distance < bestDistance || (distance == bestDistance && bps < bestBps)) {
                best = new BitratePlan((int) mbps, -1);
                bestDistance = distance;
                bestBps = bps;
            }
        }
        for (int i = 0; i < SOURCE_FACTORS.length; i++) {
            long bps = Math.round(source * SOURCE_FACTORS[i]);
            long distance = Math.abs(bps - target);
            if (distance < bestDistance || (distance == bestDistance && bps < bestBps)) {
                best = new BitratePlan(null, i);
                bestDistance = distance;
                bestBps = bps;
            }
        }
        return best;
    }
}
