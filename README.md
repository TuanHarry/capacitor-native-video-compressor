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

### Quality Presets

The `quality` parameter determines the output resolution and compression ratio. Depending on the original aspect ratio, the video will be scaled to match the following heights (or widths, preserving aspect ratio):

| Preset      | Target Resolution | Best For                                  |
| ----------- | ----------------- | ----------------------------------------- |
| `VERY_HIGH` | ~ 1080p           | Preserving original high quality          |
| `HIGH`      | ~ 720p            | Good balance for social media sharing     |
| `MEDIUM`    | ~ 540p            | Efficient storage and decent quality      |
| `LOW`       | ~ 480p            | Standard low-bandwidth usage              |
| `360P`      | ~ 360p            | Very small files                          |
| `VERY_LOW`  | ~ 240p            | Extreme compression, noticeably pixelated |

> **Note on Web Platform**: On Web, lower qualities also aggressively reduce the Audio Bitrate (down to 48kbps for VERY_LOW) to maximize space savings. On Native, audio maintains steady quality.

### Platform Differences for `sourcePath`

- **iOS/Android**: `sourcePath` must be a physical device file path (e.g., `file:///var/mobile/...` or `content://...`). Do not pass paths obtained from the Capacitor `WebView` (like `http://localhost/...`).
- **Web**: `sourcePath` can be a Blob URL (e.g., `blob:http://localhost:3000/...`), a base64 Data URI, or a direct link to a file if CORS allows.

## API

<docgen-index>

* [`compressVideo(...)`](#compressvideo)
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

| Param         | Type                                                        |
| ------------- | ----------------------------------------------------------- |
| **`options`** | <code><a href="#compressoptions">CompressOptions</a></code> |

**Returns:** <code>Promise&lt;<a href="#compressresult">CompressResult</a>&gt;</code>

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

| Prop             | Type                                                                            |
| ---------------- | ------------------------------------------------------------------------------- |
| **`sourcePath`** | <code>string</code>                                                             |
| **`destPath`**   | <code>string</code>                                                             |
| **`quality`**    | <code>'VERY_HIGH' \| 'HIGH' \| 'MEDIUM' \| 'LOW' \| 'VERY_LOW' \| '360P'</code> |


#### PluginListenerHandle

| Prop         | Type                                      |
| ------------ | ----------------------------------------- |
| **`remove`** | <code>() =&gt; Promise&lt;void&gt;</code> |

</docgen-api>
