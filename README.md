# 根本就没有这样的象棋 · 手机匹配版

本仓库只分发 Android / 鸿蒙 4.2（兼容安卓应用）匹配版安装包和更新元数据，不包含源码、签名材料、令牌或个人路径。

## 下载

- **最新 APK**：<https://github.com/sunke251127-debug/strange-chess-updates/releases/latest/download/strange-chess-matching-android.apk>
- **发行页**：<https://github.com/sunke251127-debug/strange-chess-updates/releases>
- **更新元数据**：<https://github.com/sunke251127-debug/strange-chess-updates/releases/latest/download/android-update.json>
- **SHA256 清单**：<https://github.com/sunke251127-debug/strange-chess-updates/releases/latest/download/SHA256SUMS.txt>

## 当前版本

- 版本：1.7.2（versionCode 10702）
- 包名：`cn.strangechess.mobile.matching`
- 大小：173,927 字节
- SHA256：`e0cd964157e26f5529ec8fda21180be3c0941d0bab7a37752623dfe36c4f8320`
- 发布者证书 SHA256：`ce9a58357f5126eb3d7856387a07f8b89c89309930138a48e78a46914f50fee0`
- 无 `lib/`、无 `.so`、无 Bare/JNI/native DHT 依赖
- 随机联机优先 WebRTC，失败时走加密中继

## 从 1.7.1 升级

1.7.1 只支持自建 HTTPS 更新接口，不能直接读取 GitHub Releases。请先手动下载并覆盖安装本仓库的 1.7.2 APK 一次；包名和发布者证书保持不变，不会清除本地数据。

安装 1.7.2 后，应用默认使用官方 GitHub 更新源：

`https://github.com/sunke251127-debug/strange-chess-updates`

后续可在应用内检查更新、后台下载，并在系统安装确认后覆盖安装。Android 不允许应用静默安装，安装确认必须由用户完成。

## 验证与边界

- 实际 Java `UpdateChannel` 已通过公开 latest 入口读取元数据、跟随 GitHub 获准 HTTPS 重定向、完整流式下载并校验 SHA256。
- GitHub 更新传输测试 30 项通过；Android APK/入口套件 10/10 通过；完整 Node 回归 74/74 通过。
- 尚未在实体安卓/鸿蒙手机安装 1.7.2，也未做两台实体手机跨运营商实测。
- 随机联机依赖公共 WSS 发现、STUN 和加密中继；这些是外部依赖。固定服务的逻辑标识不是已部署的 DNS 域名，二叉树扩容未实现。

## 旧内容

原来的 v1.4.0 / v1.4.1 Windows 版发行及旧标签已移除。本仓库现在只面向手机匹配版；Git 提交历史保留。
