# 根本就没有这样的象棋

手机版更新与安装包仓库。当前版本 **1.7.3**，安装包约 **174 KB**。

[下载最新版安装包](https://github.com/sunke251127-debug/strange-chess-updates/releases/latest/download/strange-chess-matching-android.apk) · [1.7.3发布说明](https://github.com/sunke251127-debug/strange-chess-updates/releases/tag/mobile-v1.7.3)

## 本次更新

- 应用名称和游戏标题去掉“匹配版”后缀。
- 从本地双人进入联机对战时不再自动聚焦输入框；手动点击后正常输入。
- 联机悔棋和开启新棋局都需向对方申请，同意才执行，拒绝后原局继续。悔棋撤销最近一手；继续落子或断线会使旧申请失效。

双方都升级到1.7.3使用新申请功能。本地双人、随机联机和好友直连保留。

## 手机更新

**1.7.2用户**：在应用内点击“检查更新”，下载后按系统提示确认安装即可，无需卸载。

**1.7.1及更早版本用户**：先手动下载上面的APK并覆盖安装一次；之后使用内置GitHub更新。包名和原发布者证书不变，保留本地存档。

目标为安卓8.0+和兼容安卓APK的鸿蒙4.2，不适用于鸿蒙NEXT。实体手机软键盘、安装升级和跨运营商连接尚未实测。随机联机依赖公共发现服务和双方网络。

## 校验

1.7.3：versionCode 10703，173,926字节。

SHA256：`ad147ce8bdb1887dba02a3bac762291328accf3a63efc6d1f508e60ee44a85da`

[更新清单](https://github.com/sunke251127-debug/strange-chess-updates/releases/latest/download/android-update.json) · [校验和](https://github.com/sunke251127-debug/strange-chess-updates/releases/latest/download/SHA256SUMS.txt)

本仓库只分发安装包、更新清单和校验和。英文附件名与内部包名保留以兼容升级协议，手机显示名称不含“匹配版”。
