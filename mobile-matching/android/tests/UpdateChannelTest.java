package cn.strangechess.mobile;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public final class UpdateChannelTest {
    private static int checks;
    private static void check(boolean value, String message) { checks++; if (!value) throw new AssertionError(message); }
    private interface Run { void run() throws Exception; }
    private static void rejects(Run run, String message) throws Exception { boolean failed = false; try { run.run(); } catch (Exception expected) { failed = true; } check(failed, message); }
    private static String sha(byte[] bytes) throws Exception { StringBuilder out = new StringBuilder(); for (byte value : MessageDigest.getInstance("SHA-256").digest(bytes)) out.append(String.format("%02x", value & 255)); return out.toString(); }
    private static final class Response extends HttpURLConnection {
        final int status; final String location; final byte[] body; boolean disconnected;
        Response(URL url, int status, String location, byte[] body) { super(url); this.status = status; this.location = location; this.body = body; }
        public void connect() {} public boolean usingProxy() { return false; } public void disconnect() { disconnected = true; }
        public int getResponseCode() { return status; }
        public String getHeaderField(String name) { return "Location".equals(name) ? location : null; }
        public InputStream getInputStream() { return new ByteArrayInputStream(body); }
    }
    public static void main(String[] args) throws Exception {
        if (args.length > 0 && args[0].equals("read-public")) {
            System.out.print(new String(UpdateChannel.read(UpdateChannel.metadata(""), "", 65536), StandardCharsets.UTF_8)); return;
        }
        if (args.length > 0 && args[0].equals("download-public")) {
            URL url = UpdateChannel.download("", args[1]); File file = new File(args[4]);
            HttpURLConnection connection = UpdateChannel.open(url, "");
            try (InputStream input = connection.getInputStream()) { UpdateChannel.copyVerified(input, file, Long.parseLong(args[2]), args[3], null); }
            finally { connection.disconnect(); }
            System.out.println("Public GitHub download verified: " + file.length() + " bytes"); return;
        }
        String official = UpdateChannel.DEFAULT_SOURCE;
        check(UpdateChannel.normalize("").equals(official), "empty settings must automatically select GitHub");
        check(UpdateChannel.normalize(official + "/").equals(official), "repository path must survive normalization");
        check(UpdateChannel.normalize("https://github.com/").equals(official), "migrate old settings which stripped the repository path");
        check(UpdateChannel.metadata("").toString().equals(official + "/releases/latest/download/android-update.json"), "stable release metadata endpoint");
        check(UpdateChannel.metadata("https://updates.example.test/folder").toString().equals("https://updates.example.test/api/android/latest"), "custom HTTPS server remains supported");
        check(UpdateChannel.normalize("http://updates.example.test/").isEmpty(), "HTTP update source rejected");
        check(UpdateChannel.normalize("https://user:secret@github.com/" + UpdateChannel.REPOSITORY).isEmpty(), "credentials rejected");
        check(UpdateChannel.normalize("https://github.com/other/repository").isEmpty(), "unrelated GitHub repository rejected");
        String apk = official + "/releases/download/mobile-v1.7.2/" + UpdateChannel.APK;
        check(UpdateChannel.download("", apk).toString().equals(apk), "official APK accepted");
        check(UpdateChannel.download("https://updates.example.test/", "/download/android").toString().equals("https://updates.example.test/download/android"), "custom download API preserved");
        rejects(() -> UpdateChannel.download("", "https://github.com/other/repo/releases/download/v1/" + UpdateChannel.APK), "cross-repository APK rejected");
        rejects(() -> UpdateChannel.download("", official + "/releases/download/v1/desktop.exe"), "desktop binary rejected");
        rejects(() -> UpdateChannel.download("", apk + "#fragment"), "fragment rejected");
        rejects(() -> UpdateChannel.download("", official + "/releases/download/%2e%2e/" + UpdateChannel.APK), "encoded path traversal rejected");
        rejects(() -> UpdateChannel.download("https://updates.example.test/", "https://evil.example/download.apk"), "custom server remains same-origin");
        URL latest = UpdateChannel.metadata(""), tagged = new URL(official + "/releases/download/mobile-v1.7.2/android-update.json");
        URL cdn = new URL("https://release-assets.githubusercontent.com/github-production-release-asset/example?token=test");
        Map<String, Response> responses = new HashMap<>();
        Response first = new Response(latest, 302, tagged.toString(), new byte[0]);
        Response second = new Response(tagged, 302, cdn.toString(), new byte[0]);
        byte[] manifest = "{\"available\":true,\"versionCode\":10702}".getBytes(StandardCharsets.UTF_8);
        Response last = new Response(cdn, 200, null, manifest);
        responses.put(latest.toString(), first); responses.put(tagged.toString(), second); responses.put(cdn.toString(), last);
        List<URL> seen = new ArrayList<>();
        HttpURLConnection opened = UpdateChannel.open(latest, "", url -> { seen.add(url); Response response = responses.get(url.toString()); if (response == null) throw new AssertionError("Unexpected destination " + url); return response; });
        check(opened == last && seen.size() == 3, "GitHub latest-to-tag-to-CDN redirects must work");
        check(first.disconnected && second.disconnected, "redirect connections released");
        check(!first.getInstanceFollowRedirects() && !second.getInstanceFollowRedirects(), "redirect policy controls every hop");
        rejects(() -> UpdateChannel.open(latest, "", url -> new Response(url, 302, "http://release-assets.githubusercontent.com/file", new byte[0])), "HTTPS downgrade rejected before another connection");
        rejects(() -> UpdateChannel.open(latest, "", url -> new Response(url, 302, "https://evil.example/file", new byte[0])), "foreign redirect rejected");
        rejects(() -> UpdateChannel.open(latest, "", url -> new Response(url, 302, latest.toString(), new byte[0])), "redirect loop rejected");
        check(!UpdateChannel.permittedRedirect("", new URL(official + "/releases/%2e%2e/private")), "redirect traversal rejected");
        byte[] actualApk = Files.readAllBytes(new File(args[0]).toPath());
        File directory = Files.createTempDirectory("ChessUpdateChannel-").toFile(), partial = new File(directory, "candidate.part");
        long[] progress = {0};
        UpdateChannel.copyVerified(new ByteArrayInputStream(actualApk), partial, actualApk.length, sha(actualApk), (count, total) -> progress[0] = count);
        check(Arrays.equals(Files.readAllBytes(partial.toPath()), actualApk) && progress[0] == actualApk.length, "real APK streams completely and validates before promotion");
        rejects(() -> UpdateChannel.copyVerified(new ByteArrayInputStream(actualApk), partial, actualApk.length, new String(new char[64]).replace('\0', '0'), null), "wrong SHA256 rejected");
        check(!partial.exists(), "hash failure removes incomplete candidate");
        rejects(() -> UpdateChannel.copyVerified(new ByteArrayInputStream(Arrays.copyOf(actualApk, actualApk.length - 1)), partial, actualApk.length, sha(actualApk), null), "truncation rejected");
        check(!partial.exists(), "truncation removes candidate");
        rejects(() -> UpdateChannel.copyVerified(new ByteArrayInputStream(actualApk), partial, actualApk.length - 1, sha(actualApk), null), "oversize response rejected");
        check(!partial.exists(), "oversize response removes candidate");
        rejects(() -> UpdateChannel.copyVerified(new ByteArrayInputStream(actualApk), partial, UpdateChannel.MAX_BYTES + 1, sha(actualApk), null), "download limit retained");
        directory.delete();
        System.out.println("GitHub update transport: " + checks + " checks passed");
    }
}
