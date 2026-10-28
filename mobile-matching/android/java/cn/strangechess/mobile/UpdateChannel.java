package cn.strangechess.mobile;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.security.MessageDigest;
import java.util.HashSet;
import java.util.Set;

/** Shared, executable update transport; Android keeps package/certificate checks. */
public final class UpdateChannel {
    public static final String REPOSITORY = "sunke251127-debug/strange-chess-updates";
    public static final String DEFAULT_SOURCE = "https://github.com/" + REPOSITORY;
    public static final String MANIFEST = "android-update.json";
    public static final String APK = "strange-chess-matching-android.apk";
    public static final long MAX_BYTES = 128L * 1024 * 1024;
    public interface Connector { HttpURLConnection open(URL url) throws Exception; }
    public interface Progress { void received(long bytes, long total); }
    private UpdateChannel() {}

    public static String normalize(String raw) {
        if (raw == null || raw.trim().isEmpty()) return DEFAULT_SOURCE;
        if (raw.length() > 2048) return "";
        try {
            URI uri = URI.create(raw.trim());
            if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null || uri.getUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null) return "";
            if ("github.com".equalsIgnoreCase(uri.getHost())) {
                if (uri.getPort() != -1 && uri.getPort() != 443) return "";
                String path = uri.getPath().replaceAll("/+$", "");
                String base = "/" + REPOSITORY;
                if (path.isEmpty() || path.equalsIgnoreCase(base) || path.equalsIgnoreCase(base + ".git") || path.equalsIgnoreCase(base + "/releases") || path.equalsIgnoreCase(base + "/releases/latest") || path.equalsIgnoreCase(base + "/releases/latest/download/" + MANIFEST)) return DEFAULT_SOURCE;
                return "";
            }
            return new URI("https", null, uri.getHost(), uri.getPort(), "/", null, null).toASCIIString();
        } catch (Exception error) { return ""; }
    }

    public static URL metadata(String source) throws Exception {
        String normalized = normalize(source);
        if (normalized.isEmpty()) throw new Exception("请输入有效的 HTTPS 更新地址或官方 GitHub 仓库地址");
        return new URL(normalized.equals(DEFAULT_SOURCE) ? DEFAULT_SOURCE + "/releases/latest/download/" + MANIFEST : normalized + "api/android/latest");
    }

    private static boolean secure(URL url) {
        if (!"https".equalsIgnoreCase(url.getProtocol()) || url.getUserInfo() != null || url.getRef() != null) return false;
        try { for (String part : url.toURI().getPath().split("/", -1)) if (part.equals(".") || part.equals("..")) return false; }
        catch (Exception error) { return false; }
        return true;
    }
    private static boolean origin(URL a, URL b) {
        int left = a.getPort() == -1 ? 443 : a.getPort(), right = b.getPort() == -1 ? 443 : b.getPort();
        return secure(a) && secure(b) && a.getHost().equalsIgnoreCase(b.getHost()) && left == right;
    }
    public static URL download(String source, String declared) throws Exception {
        String normalized = normalize(source);
        if (normalized.isEmpty()) throw new Exception("更新来源无效");
        URL url = new URL(new URL(normalized + (normalized.endsWith("/") ? "" : "/")), declared);
        if (!secure(url)) throw new Exception("更新只接受无账号信息的 HTTPS 地址");
        if (normalized.equals(DEFAULT_SOURCE)) {
            String prefix = "/" + REPOSITORY + "/releases/download/";
            if (!"github.com".equalsIgnoreCase(url.getHost()) || (url.getPort() != -1 && url.getPort() != 443) || url.getQuery() != null || !url.getPath().startsWith(prefix)) throw new Exception("更新文件不属于官方 GitHub 仓库");
            String[] parts = url.getPath().substring(prefix.length()).split("/", -1);
            if (parts.length != 2 || !parts[0].matches("[A-Za-z0-9][A-Za-z0-9._-]{0,79}") || !APK.equals(parts[1])) throw new Exception("GitHub 安装包地址无效");
        } else if (!origin(new URL(normalized), url)) throw new Exception("更新地址必须与服务器使用同一 HTTPS 来源");
        return url;
    }

    public static boolean permittedRedirect(String source, URL target) throws Exception {
        if (!secure(target)) return false;
        String normalized = normalize(source);
        if (normalized.equals(DEFAULT_SOURCE)) {
            if (target.getPort() != -1 && target.getPort() != 443) return false;
            String host = target.getHost().toLowerCase(java.util.Locale.ROOT);
            if (host.equals("github.com")) return target.getPath().startsWith("/" + REPOSITORY + "/releases/");
            return host.equals("release-assets.githubusercontent.com") || host.equals("objects.githubusercontent.com");
        }
        return !normalized.isEmpty() && origin(new URL(normalized), target);
    }

    public static HttpURLConnection open(URL initial, String source) throws Exception {
        return open(initial, source, url -> (HttpURLConnection) url.openConnection());
    }
    public static HttpURLConnection open(URL initial, String source, Connector connector) throws Exception {
        URL current = initial; Set<String> visited = new HashSet<>();
        for (int hop = 0; hop < 6; hop++) {
            if (!permittedRedirect(source, current) || !visited.add(current.toExternalForm())) throw new Exception("更新重定向无效或形成循环");
            HttpURLConnection connection = connector.open(current);
            connection.setInstanceFollowRedirects(false); connection.setConnectTimeout(15000); connection.setReadTimeout(30000);
            connection.setUseCaches(false); connection.setRequestProperty("User-Agent", "StrangeChessMobileUpdater");
            connection.setRequestProperty("Accept", "application/json, application/vnd.android.package-archive");
            int code = connection.getResponseCode();
            if (code == 200) return connection;
            if (code == 301 || code == 302 || code == 303 || code == 307 || code == 308) {
                String location = connection.getHeaderField("Location"); connection.disconnect();
                if (location == null || location.length() > 8192) throw new Exception("更新重定向缺少地址");
                current = new URL(current, location); continue;
            }
            connection.disconnect(); throw new Exception("更新服务器返回 HTTP " + code);
        }
        throw new Exception("更新重定向次数过多");
    }

    public static byte[] read(URL url, String source, int max) throws Exception {
        HttpURLConnection connection = open(url, source);
        try (InputStream input = connection.getInputStream(); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[4096]; int count;
            while ((count = input.read(buffer)) != -1) { if (output.size() + count > max) throw new Exception("更新信息过大"); output.write(buffer, 0, count); }
            return output.toByteArray();
        } finally { connection.disconnect(); }
    }

    public static void copyVerified(InputStream input, File partial, long expected, String hash, Progress progress) throws Exception {
        if (expected <= 0 || expected > MAX_BYTES || hash == null || !hash.matches("[a-fA-F0-9]{64}")) throw new Exception("更新大小或校验信息无效");
        boolean valid = false;
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256"); long count = 0;
            try (FileOutputStream output = new FileOutputStream(partial)) {
                byte[] buffer = new byte[32768]; int size;
                while ((size = input.read(buffer)) != -1) {
                    count += size; if (count > expected) throw new Exception("下载内容超出预期大小");
                    digest.update(buffer, 0, size); output.write(buffer, 0, size);
                    if (progress != null) progress.received(count, expected);
                }
                output.getFD().sync();
            }
            StringBuilder actual = new StringBuilder(); for (byte value : digest.digest()) actual.append(String.format("%02x", value & 255));
            if (count != expected || !actual.toString().equalsIgnoreCase(hash)) throw new Exception("下载校验失败");
            valid = true;
        } finally { if (!valid) partial.delete(); }
    }
}
