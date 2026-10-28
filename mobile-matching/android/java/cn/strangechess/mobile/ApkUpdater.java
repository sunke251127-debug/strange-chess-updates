package cn.strangechess.mobile;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import org.json.JSONObject;
import java.net.URL;
import java.net.HttpURLConnection;
import java.nio.charset.StandardCharsets;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.ByteArrayOutputStream;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** HTTPS discovery plus size/hash/package/certificate verification before Android's installer. */
public final class ApkUpdater {
    private final Activity activity;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private volatile String status = "idle", message = "将从官方 GitHub 仓库检查安装包更新。";
    private volatile boolean checking;
    private final File verified;
    ApkUpdater(Activity activity) { this.activity = activity; verified = new File(activity.getCacheDir(), "verified-update.apk"); }
    synchronized String state() {
        try { return new JSONObject().put("status", status).put("message", message).put("currentVersion", activity.getPackageManager().getPackageInfo(activity.getPackageName(), 0).versionName).toString(); }
        catch (Exception error) { return "{}"; }
    }
    private void state(String next, String text) { status = next; message = text; }
    synchronized void check(String raw) {
        if (checking || "ready".equals(status)) return;
        String base = UpdateChannel.normalize(raw);
        if (base.isEmpty()) { state("idle", "更新地址无效，请使用官方 GitHub 仓库或 HTTPS 更新站点。"); return; }
        checking = true; state("checking", "正在检查安装包更新…");
        executor.execute(() -> {
            File partial = new File(activity.getCacheDir(), "download-update.part");
            try {
                JSONObject meta = new JSONObject(new String(UpdateChannel.read(UpdateChannel.metadata(base), base, 65536), StandardCharsets.UTF_8));
                if (!meta.optBoolean("available")) { state("current", "此服务器暂未发布 APK 更新；可继续游玩。"); return; }
                if (!activity.getPackageName().equals(meta.getString("packageId"))) throw new Exception("更新包名称不匹配");
                long code = meta.getLong("versionCode");
                if (code <= installedVersion()) { state("current", "当前已是更新来源提供的最新安装包。"); return; }
                long expected = meta.getLong("bytes");
                if (expected <= 0 || expected > 128L * 1024 * 1024) throw new Exception("更新包大小无效");
                String hash = meta.getString("sha256");
                if (!hash.matches("[a-fA-F0-9]{64}")) throw new Exception("更新校验信息无效");
                URL url = UpdateChannel.download(base, meta.getString("url"));
                state("downloading", "正在后台下载更新，可继续游玩…");
                HttpURLConnection connection = UpdateChannel.open(url, base);
                try (InputStream input = connection.getInputStream()) {
                    UpdateChannel.copyVerified(input, partial, expected, hash, (bytes, total) -> message = "后台下载更新 " + (bytes * 100 / total) + "%");
                } finally { connection.disconnect(); }
                verifyPackage(partial, code);
                if (verified.exists() && !verified.delete()) throw new Exception("无法准备更新文件");
                if (!partial.renameTo(verified)) throw new Exception("无法保存更新文件");
                state("ready", "新版已验证并下载。退出当前对局后，点击“安装更新”；系统会要求确认安装。");
            } catch (Exception error) { state("error", "暂未完成更新，当前游戏可继续使用。" + String.valueOf(error.getMessage())); }
            finally { partial.delete(); checking = false; }
        });
    }
    private long installedVersion() throws Exception { return version(activity.getPackageManager().getPackageInfo(activity.getPackageName(), 0)); }
    private long version(PackageInfo info) { return Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode; }
    private Signature[] signatures(PackageInfo info) {
        return Build.VERSION.SDK_INT >= 28 ? (info.signingInfo == null ? new Signature[0] : info.signingInfo.getApkContentsSigners()) : info.signatures;
    }
    private void verifyPackage(File file, long expectedVersion) throws Exception {
        PackageManager pm = activity.getPackageManager();
        int flags = Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
        PackageInfo archive = pm.getPackageArchiveInfo(file.getPath(), flags), current = pm.getPackageInfo(activity.getPackageName(), flags);
        if (archive == null || !activity.getPackageName().equals(archive.packageName) || version(archive) != expectedVersion || expectedVersion <= installedVersion()) throw new Exception("APK 版本或包名不匹配");
        Signature[] left = signatures(archive), right = signatures(current);
        if (left == null || right == null || left.length != 1 || right.length != 1 || !Arrays.equals(left[0].toByteArray(), right[0].toByteArray())) throw new Exception("APK 发布者签名不匹配");
    }
    void install() {
        if (!"ready".equals(status) || !verified.isFile()) return;
        try {
            PackageInfo archive = activity.getPackageManager().getPackageArchiveInfo(verified.getPath(), 0);
            if (archive == null) throw new Exception("安装包已失效");
            verifyPackage(verified, version(archive));
            if (Build.VERSION.SDK_INT >= 26 && !activity.getPackageManager().canRequestPackageInstalls()) {
                new AlertDialog.Builder(activity).setMessage("请允许此应用安装已验证的游戏更新，返回后再点“安装更新”。")
                    .setPositiveButton("打开设置", (d,w) -> activity.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + activity.getPackageName()))))
                    .setNegativeButton("取消", null).show(); return;
            }
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse("content://cn.strangechess.mobile.matching.updates/apk"));
            intent.setDataAndType(intent.getData(), "application/vnd.android.package-archive");
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION); activity.startActivity(intent);
        } catch (Exception error) { state("error", "无法安装更新：" + error.getMessage()); }
    }
    private static String hex(byte[] bytes) { StringBuilder result = new StringBuilder(); for (byte b : bytes) result.append(String.format("%02x", b & 255)); return result.toString(); }
}
