# 根本就没有这样的象棋

手机版更新与安装包仓库。当前版本 **1.7.4**，安装包约 **174 KB**。

[下载最新版安装包](https://github.com/sunke251127-debug/strange-chess-updates/releases/latest/download/strange-chess-matching-android.apk) · [1.7.4发布说明](https://github.com/sunke251127-debug/strange-chess-updates/releases/tag/mobile-v1.7.4)

## 本次更新

- 黑方改为己方在下方，棋子文字保持正向，换边后视角同步调整。
- 优化随机匹配建连，双方支持时增量交换连接地址，同时准备中继，减少顺序等待。
- 主持端先发送棋局再刷新本地，缓存重复规则计算，改善非主持端交互。
- 同意新局后交换红黑；重新连接记住下一次颜色偏好，提供连接的一方不再总执红。

双方都升级到1.7.4使用完整优化。保留本地双人、随机联机、好友直连、双方申请悔棋/新局，以及名称和输入框焦点修复。拒绝申请后原局继续。

## 手机更新

**1.7.2/1.7.3用户**：在应用内点击“检查更新”，下载后按系统提示确认安装即可，无需卸载。

**1.7.1及更早版本用户**：先手动下载上面的APK并覆盖安装一次；之后使用内置GitHub更新。包名和原发布者证书不变，保留本地存档。

目标为安卓8.0+和兼容安卓APK的鸿蒙4.2，不适用于鸿蒙NEXT。57项相关回归通过；实体手机帧率、软键盘、安装升级和跨运营商连接尚未实测。本机建连数据不代表公网速度，随机联机仍受公共发现服务和双方网络影响。

## 校验

1.7.4：versionCode 10704，173,926字节。

SHA256：`4428c39c7624387600f56d7974052e7ef6890aa2e5c20af43438312c7d6f041e`

[更新清单](https://github.com/sunke251127-debug/strange-chess-updates/releases/latest/download/android-update.json) · [校验和](https://github.com/sunke251127-debug/strange-chess-updates/releases/latest/download/SHA256SUMS.txt)

本仓库只分发安装包、更新清单和校验和。英文附件名与内部包名保留以兼容升级协议，手机显示名称不含“匹配版”。
