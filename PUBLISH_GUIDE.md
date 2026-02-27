# Hướng dẫn Publish Capacitor Plugin lên NPM

Tài liệu này hướng dẫn cách xuất bản (publish) plugin `capacitor-native-video-compressor` lên hệ thống NPM (Node Package Registry) để có thể cài đặt dễ dàng thông qua phiên bản cố định (`"capacitor-native-video-compressor": "1.0.0"`).

## Bước 1: Chuẩn bị tài khoản NPM

1. Truy cập [npmjs.com](https://www.npmjs.com/) và đăng ký một tài khoản miễn phí (nếu chưa có).
2. Xác thực email đăng ký theo yêu cầu của NPM.

## Bước 2: Đăng nhập vào NPM từ Terminal

Mở Terminal và điều hướng đến thư mục gốc của plugin:

```bash
cd /Users/tuantran/Documents/SourceWeb/capacitor-plugins/capacitor-native-video-compressor
```

Đăng nhập vào tài khoản NPM:

```bash
npm login
```

_Hệ thống sẽ yêu cầu bạn nhập Username, Password và Email._

## Bước 3: Cấu hình `package.json` của Plugin

Cập nhật lại file `package.json` trong thư mục `capacitor-native-video-compressor` với các thông tin chuẩn:

- **`name`**: Tên gói phải là duy nhất trên NPM. Có thể sử dụng scope cá nhân để tránh trùng lặp, ví dụ `@tuanharry/capacitor-native-video-compressor`.
- **`version`**: Phiên bản hiện tại, nên bắt đầu bằng `1.0.0` hoặc `0.0.1`.
- **`author`**: Tên hoặc email của bạn.
- **`license`**: Giấy phép sử dụng (thường là `MIT`).
- **`main`/`module`/`types`**: Đảm bảo các đường dẫn này trỏ đúng đến file đã build (thường trong thư mục `dist/`).

_Ví dụ:_

```json
{
  "name": "@tuanharry/capacitor-native-video-compressor",
  "version": "1.0.0",
  "description": "A native video compressor plugin for Capacitor",
  "author": "TuanHarry",
  "license": "MIT",
  "main": "dist/plugin.cjs.js",
  "module": "dist/esm/index.js",
  "types": "dist/esm/index.d.ts",
  ...
}
```

## Bước 4: Build Plugin

Trước khi publish, cần đảm bảo code TypeScript và cấu trúc được biên dịch ra file JavaScript mới nhất (thư mục `dist`).

Chạy lệnh build của plugin:

```bash
npm run build
# hoặc
yarn build
```

## Bước 5: Publish lên NPM

Thực hiện lệnh xuất bản:

```bash
# Nếu tên gói KHÔNG có @scope (ví dụ: capacitor-native-video-compressor)
npm publish

# Nếu tên gói CÓ @scope (ví dụ: @tuanharry/capacitor-native-video-compressor)
npm publish --access public
```

---

## 🛠 Cách sử dụng trong dự án chính (Ví dụ: `demo-video-compression`)

Sau khi publish thành công, bạn quay lại dự án sử dụng plugin và cài đặt thông qua version:

**1. Gỡ bỏ link github cũ:**
Xóa dòng liên quan đến `capacitor-native-video-compressor` có chứa link git hoặc đường dẫn local ra khỏi `package.json`.

**2. Cài đặt lại từ NPM:**

```bash
# Điền chính xác tên package bạn đã publish
yarn add @tuanharry/capacitor-native-video-compressor@1.0.0

# Đồng bộ lại Capacitor
yarn cap sync
```

## 🔄 Quy trình Update phiên bản mới

Mỗi khi plugin có sự thay đổi (fix bug, thêm feature), hãy làm theo quy trình sau:

1. Sửa code trong thư mục `/capacitor-plugins/capacitor-native-video-compressor`.
2. Tăng số `version` trong `package.json` (ví dụ: từ `1.0.0` lên `1.0.1`).
3. Chạy `yarn build` (hoặc `npm run build`).
4. Chạy `npm publish` (hoặc `npm publish --access public`).
5. Vào dự án application, chạy `yarn upgrade @tuanharry/capacitor-native-video-compressor` để lấy code mới nhất.
