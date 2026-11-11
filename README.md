# capacitor-native-video-compressor

A Capacitor plugin to compress videos natively on iOS (using AVFoundation), Android (using LightCompressor), and Web (using FFmpeg.wasm).

## Install

```bash
npm install capacitor-native-video-compressor
npx cap sync
```

## Supported Platforms

- **iOS**: Uses `AVAssetExportSession` (Hardware accelerated).
- **Android**: Uses `LightCompressor` (MediaCodec hardware accelerated).
- **Web**: Uses `@ffmpeg/ffmpeg` (WebAssembly).

## Native Configuration

### iOS

Remember to add the following to your `Info.plist` if you are picking videos from the Photo Library before compressing them:

```xml
<key>NSPhotoLibraryUsageDescription</key>
<string>We need access to your photo library to select videos for compression.</string>
```

### Android

If you are reading videos from external storage, ensure you have the appropriate permissions in your `AndroidManifest.xml`:

```xml
<uses-permission android:name="android.permission.READ_MEDIA_VIDEO" />
<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="32" />
```

#### JitPack repository (required)

The Android implementation depends on `LightCompressor`, which is published on JitPack.
A plugin's own `repositories` block does not propagate to the consuming app, so you must
add JitPack to your app's `android/build.gradle` — otherwise the build fails with
`Could not find com.github.AbedElazizShe:LightCompressor`:

```gradle
allprojects {
    repositories {
        google()
        mavenCentral()
        maven { url 'https://jitpack.io' }
    }
}
```

#### minSdk 35 / compileSdk 35+ (required)

The compression foreground service declares `android:foregroundServiceType="mediaProcessing"`,
and `mediaProcessing` exists only from **API 35 (Android 15)**. On API 34 and below the
system reads the type as unknown and `startForeground()` throws
`InvalidForegroundServiceTypeException` - the service never reaches the foreground and
compression is killed as soon as the user leaves the app. There is no second type to fall
back to, so the plugin requires `minSdkVersion` 35.

**The service covers compression only.** It stops as soon as the compress finishes. Anything
you do with the output afterwards - uploading it, for instance - runs without a foreground
service, because JS in the webview is paused while the app is backgrounded anyway: holding
the service open for it would declare work that does not happen. Google Play classifies
foreground services by *use case*, not by how many services you run, and a `dataSync`
declaration covering a phase that is really "waiting for the user to come back" is what got
version code 30 of Destini rejected.

## Web Configuration (Required)

To use video compression on the Web platform, `FFmpeg.wasm` requires `SharedArrayBuffer` to function properly. You must configure your web server/framework to serve these specific HTTP headers:

```http
Cross-Origin-Embedder-Policy: credentialless
Cross-Origin-Opener-Policy: same-origin
```

### Example: Nuxt 3 / Vite

If you are using Vite or Nuxt, update your configuration to include these headers and avoid optimizing the FFmpeg packages:

```typescript
// nuxt.config.ts or vite.config.ts
export default defineNuxtConfig({
  routeRules: {
    '/**': {
      headers: {
        'Cross-Origin-Embedder-Policy': 'credentialless',
        'Cross-Origin-Opener-Policy': 'same-origin',
      },
    },
  },
  vite: {
    server: {
      headers: {
        'Cross-Origin-Embedder-Policy': 'credentialless',
        'Cross-Origin-Opener-Policy': 'same-origin',
      },
    },
    optimizeDeps: {
      exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util', 'capacitor-native-video-compressor'],
    },
  },
});
```

## Usage

### 1. Initialization (Web Only)

Before compressing videos on the Web platform, you **must** initialize the FFmpeg core. This step is safely ignored on Native platforms (iOS/Android), so calling it cross-platform is perfectly fine.

```typescript
import { NativeVideoCompressor } from 'capacitor-native-video-compressor';
import { Capacitor } from '@capacitor/core';

const initCompressor = async () => {
  if (Capacitor.getPlatform() === 'web') {
    const result = await NativeVideoCompressor.initialize();
    if (!result.success) {
      console.error('Failed to load FFmpeg core:', result.message);
    }
  }
};
```

### 2. Compression & Progress Subscription

Subscribe to the `onProgress` event to get updates on the compression process, and then call `compressVideo()`.

```typescript
import { NativeVideoCompressor } from 'capacitor-native-video-compressor';

// 1. Add progress listener
const listener = await NativeVideoCompressor.addListener('onProgress', (info) => {
  // info.status can be: 'started', 'loading_core', 'progress'
  if (info.status === 'progress') {
    console.log(`Compression Progress: ${info.percent}%`);
  }
});

// 2. Start Compression
try {
  const result = await NativeVideoCompressor.compressVideo({
    sourcePath: '/path/to/original/video.mp4', // Web: blob URL or file path
    quality: 'MEDIUM', // 'VERY_HIGH' | 'HIGH' | 'MEDIUM' | 'LOW' | 'VERY_LOW'
  });

  console.log('Compression successful! Saved at:', result.destPath);
} catch (error) {
  console.error('Compression failed:', error);
}

// 3. Remove listener when done
listener.remove();
```

### 3. Cancelling a Compression

Compressing a long video runs for minutes, so give the user a way out. Pass a
`jobId` when starting, then cancel with the same id:

```typescript
import { NativeVideoCompressor, CANCELLED, STORAGE_FULL, TOO_LARGE_FOR_WEB } from 'capacitor-native-video-compressor';

const jobId = crypto.randomUUID();

try {
  const result = await NativeVideoCompressor.compressVideo({
    sourcePath: '/path/to/video.mp4',
    quality: 'HIGH',
    jobId,
  });
} catch (error) {
  if (error.code === CANCELLED) {
    // The user asked for this — no error toast, no retry prompt.
    return;
  }
  if (error.code === TOO_LARGE_FOR_WEB) {
    // Web only: WebCodecs is unavailable or failed, and the file is over the 200 MB ffmpeg.wasm limit.
    // Upload the original, or ask for a shorter clip.
  }
  if (error.code === STORAGE_FULL) {
    // Web only: the browser storage quota is full. Retryable once space is freed.
  }
  throw error;
}

// From a Cancel button, anywhere:
await NativeVideoCompressor.cancel({ jobId });
```

**Why `jobId`.** Every platform compresses one video at a time, so cancellation
is global by nature. Two independent queues in the same app (say comments and
notes) would otherwise cancel each other's work. `cancel()` with no `jobId`
cancels whatever is running, whoever started it — fine when there is only one
caller.

**What it costs.** The partial output is deleted on every platform. On web,
cancelling terminates the FFmpeg worker, because `ffmpeg.exec()` runs as
synchronous WASM inside it and never reaches a message poll while encoding —
the `AbortSignal` `exec()` accepts only rejects the main-thread promise while
the encode keeps burning CPU behind it. The loaded core is dropped with the
worker, but the core URLs are cached in module scope, so the next compress
re-instantiates without re-downloading the wasm.

`cancel()` resolves `{ cancelled: false }` when nothing was running, or when a
different job was — it never throws.

### Quality Presets

The `quality` parameter determines the output resolution and compression ratio. Each tier caps the **short** side of the displayed video (the height of a landscape video, the width of a portrait one); the long side follows the aspect ratio. A source smaller than the tier is never upscaled. On Android both sides are rounded to multiples of 16, so 540 becomes 528.

| Preset      | Target Resolution | Best For                                  |
| ----------- | ----------------- | ----------------------------------------- |
| `VERY_HIGH` | ~ 1080p           | Preserving original high quality          |
| `HIGH`      | ~ 720p            | Good balance for social media sharing     |
| `MEDIUM`    | ~ 540p            | Efficient storage and decent quality      |
| `LOW`       | ~ 480p            | Standard low-bandwidth usage              |
| `360P`      | ~ 360p            | Very small files                          |
| `VERY_LOW`  | ~ 240p            | Extreme compression, noticeably pixelated |

> **Bitrate**: The video bitrate never goes above the source's own bitrate, so a lean source is not inflated; the Web ffmpeg fallback is the exception, as it uses CRF only (iOS and Web WebCodecs allow 1.5× the source for HEVC, VP9 and AV1, which need less than H.264 for the same picture). On Web, the ffmpeg fallback lowers the audio bitrate with the tier (down to 48 kbps for VERY_LOW). On iOS, AAC audio is capped at the source rate and snapped down to 64, 96 or 128 kbps.

### Platform Differences for `sourcePath`

- **iOS/Android**: `sourcePath` must be a physical device file path (e.g., `file:///var/mobile/...` or `content://...`). Do not pass paths obtained from the Capacitor `WebView` (like `http://localhost/...`).
- **Web**: `sourcePath` can be a Blob URL (e.g., `blob:http://localhost:3000/...`), a base64 Data URI, or a direct link to a file if CORS allows.

## API

<docgen-index>

* [`compressVideo(...)`](#compressvideo)
* [`cancel(...)`](#cancel)
* [`finishUpload(...)`](#finishupload)
* [`initialize()`](#initialize)
* [`addListener('onProgress', ...)`](#addlisteneronprogress-)
* [Interfaces](#interfaces)

</docgen-index>

<docgen-api>
<!--Update the source file JSDoc comments and rerun docgen to update the docs below-->

### compressVideo(...)

```typescript
compressVideo(options: CompressOptions) => Promise<CompressResult>
```

Compress one video and resolve with the path of the result.

Android: the work runs inside a WorkManager worker, which keeps the
process out of the frozen cached state while the user is away — there is
no foreground service and no notification, because Google Play classes
this use case as data sync plus local processing and rejects
`FOREGROUND_SERVICE_MEDIA_PROCESSING` for it. WorkManager stops a worker
after 10 minutes, so a compress that runs longer rejects with
{@link CANCELLED}.

| Param         | Type                                                        |
| ------------- | ----------------------------------------------------------- |
| **`options`** | <code><a href="#compressoptions">CompressOptions</a></code> |

**Returns:** <code>Promise&lt;<a href="#compressresult">CompressResult</a>&gt;</code>

--------------------


### cancel(...)

```typescript
cancel(options?: CancelOptions | undefined) => Promise<CancelResult>
```

Stop the compress that is running now. `compressVideo` then rejects with
code {@link CANCELLED} and its partial output is deleted.

This is the only way to stop one: the work is synchronous WASM inside a
web worker (web) or an AVFoundation / LightCompressor pass on its own
thread (native), and none of them watch an AbortSignal.

| Param         | Type                                                    |
| ------------- | ------------------------------------------------------- |
| **`options`** | <code><a href="#canceloptions">CancelOptions</a></code> |

**Returns:** <code>Promise&lt;<a href="#cancelresult">CancelResult</a>&gt;</code>

--------------------


### finishUpload(...)

```typescript
finishUpload(options: { jobId: string; }) => Promise<{ released: boolean; }>
```

Release the worker that `holdForUpload` kept alive for this job.

Call it on every terminal branch of the upload, success or failure. A
missed call leaves the device feeding an idle job until the hold expires.
`released` is false when no job by that id was still being held, which is
the normal outcome of a late or duplicate call, not an error.

Web: deletes the compressed output instead, so call it only once the File
is no longer needed (not before a retry).

| Param         | Type                            |
| ------------- | ------------------------------- |
| **`options`** | <code>{ jobId: string; }</code> |

**Returns:** <code>Promise&lt;{ released: boolean; }&gt;</code>

--------------------


### initialize()

```typescript
initialize() => Promise<{ success: boolean; message?: string; }>
```

**Returns:** <code>Promise&lt;{ success: boolean; message?: string; }&gt;</code>

--------------------


### addListener('onProgress', ...)

```typescript
addListener(eventName: 'onProgress', listenerFunc: (info: { status: string; percent?: number; }) => void) => Promise<PluginListenerHandle>
```

| Param              | Type                                                                  |
| ------------------ | --------------------------------------------------------------------- |
| **`eventName`**    | <code>'onProgress'</code>                                             |
| **`listenerFunc`** | <code>(info: { status: string; percent?: number; }) =&gt; void</code> |

**Returns:** <code>Promise&lt;<a href="#pluginlistenerhandle">PluginListenerHandle</a>&gt;</code>

--------------------


### Interfaces


#### CompressResult

| Prop           | Type                 |
| -------------- | -------------------- |
| **`success`**  | <code>boolean</code> |
| **`destPath`** | <code>string</code>  |


#### CompressOptions

| Prop                | Type                                                                            | Description                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **`sourcePath`**    | <code>string</code>                                                             |                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **`destPath`**      | <code>string</code>                                                             |                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **`quality`**       | <code>'VERY_HIGH' \| 'HIGH' \| 'MEDIUM' \| 'LOW' \| 'VERY_LOW' \| '360P'</code> |                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **`jobId`**         | <code>string</code>                                                             | Names this compress so `cancel({ jobId })` can target it. Every platform compresses one video at a time, so cancellation is global by nature. Two independent callers in the same app (say a comment queue and a notes queue) therefore need a way to say *which* job they mean — without one, a cancel from either kills whatever the other is running.                                                                                         |
| **`holdForUpload`** | <code>boolean</code>                                                            | Android only: keep the background worker alive after the compress ends, until `finishUpload({ jobId })` is called. The upload runs as JavaScript in the webview, and the moment the worker returns the process becomes cached and is frozen — measured on Android 16, an in-flight upload dies about five seconds later. Set this whenever the compressed file is about to be uploaded, and always pair it with a `finishUpload` in a `finally`. |


#### CancelResult

| Prop            | Type                 | Description                                                  |
| --------------- | -------------------- | ------------------------------------------------------------ |
| **`cancelled`** | <code>boolean</code> | False when nothing was running, or when a different job was. |


#### CancelOptions

| Prop        | Type                | Description                                                                                               |
| ----------- | ------------------- | --------------------------------------------------------------------------------------------------------- |
| **`jobId`** | <code>string</code> | Only cancel if this is the job currently running. Omit to cancel whatever is running, whoever started it. |


#### PluginListenerHandle

| Prop         | Type                                      |
| ------------ | ----------------------------------------- |
| **`remove`** | <code>() =&gt; Promise&lt;void&gt;</code> |

</docgen-api>
