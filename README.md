# capacitor-native-video-compressor

Native video compressor using LightCompressor and AVFoundation

## Install

```bash
npm install capacitor-native-video-compressor
npx cap sync
```

## API

<docgen-index>

* [`compressVideo(...)`](#compressvideo)
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

| Prop             | Type                                                                  |
| ---------------- | --------------------------------------------------------------------- |
| **`sourcePath`** | <code>string</code>                                                   |
| **`destPath`**   | <code>string</code>                                                   |
| **`quality`**    | <code>'VERY_HIGH' \| 'HIGH' \| 'MEDIUM' \| 'LOW' \| 'VERY_LOW'</code> |


#### PluginListenerHandle

| Prop         | Type                                      |
| ------------ | ----------------------------------------- |
| **`remove`** | <code>() =&gt; Promise&lt;void&gt;</code> |

</docgen-api>
