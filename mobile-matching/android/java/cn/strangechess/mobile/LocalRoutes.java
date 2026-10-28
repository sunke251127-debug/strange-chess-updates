package cn.strangechess.mobile;

import java.net.URI;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

/** No filesystem path is derived from an untrusted URL outside this exact allowlist. */
public final class LocalRoutes {
    // A virtual loopback origin keeps user-selected LAN games within the local
    // network address space. Every asset is served by WebView interception.
    public static final String ORIGIN = "http://127.0.0.1:48767";
    private static final Set<String> FILES = new HashSet<>(Arrays.asList(
        "/index.html", "/styles.css", "/polish.css", "/mobile.css", "/app.js", "/mobile.js", "/android-shell.js",
        "/src/game-engine.js", "/src/check-detector.js", "/src/invite.js", "/manifest.webmanifest", "/icon.svg", "/icon-192.png", "/icon-512.png",
        "/ai-client.js", "/ai-worker.js", "/src/ai-search.js", "/src/ai-rules.js", "/src/ai-repetition.js",
        "/ai/model.onnx", "/ai/model.json", "/ai/ort.wasm.min.js", "/ai/ort-wasm-simd-threaded.mjs",
        "/ai/ort-wasm-simd-threaded.wasm", "/ai/runtime.json", "/ai/ORT-LICENSE.txt", "/ai/ORT-NOTICES.txt"
        , "/src/system-random.js", "/src/room-model.js", "/src/peer-link.js", "/src/random-match.js", "/src/piece-glyphs.js", "/src/relay-channel.js"
    ));
    public static boolean trusted(String value) {
        return trusted(value, 48767);
    }
    public static boolean trusted(String value, int port) {
        try {
            URI uri = URI.create(value);
            return "http".equals(uri.getScheme()) && "127.0.0.1".equals(uri.getHost())
                && uri.getPort() == port && uri.getUserInfo() == null;
        } catch (Exception error) { return false; }
    }
    public static String asset(String url) {
        return asset(url, 48767);
    }
    public static String asset(String url, int port) {
        try {
            if (!trusted(url, port)) return null;
            String path = URI.create(url).getPath();
            if ("/".equals(path)) path = "/index.html";
            if (!FILES.contains(path)) return null;
            return "www" + path;
        } catch (Exception error) { return null; }
    }
    public static String server(String raw) {
        if (raw == null || raw.length() > 2048) return "";
        try {
            URI uri = URI.create(raw.trim());
            String scheme = uri.getScheme();
            if ("wss".equals(scheme)) scheme = "https";
            if ("ws".equals(scheme)) scheme = "http";
            if (!("http".equals(scheme) || "https".equals(scheme)) || uri.getHost() == null || uri.getUserInfo() != null) return "";
            return new URI(scheme, null, uri.getHost(), uri.getPort(), "/", null, null).toString();
        } catch (Exception error) { return ""; }
    }
    public static boolean remoteRelay(String value) {
        try {
            URI uri = URI.create(value);
            if (!"wss".equals(uri.getScheme()) || uri.getUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null || !"/mqtt".equals(uri.getPath())) return false;
            return ("broker.emqx.io".equals(uri.getHost()) && uri.getPort() == 8084)
                || ("test.mosquitto.org".equals(uri.getHost()) && uri.getPort() == 8081);
        } catch (Exception error) { return false; }
    }
    public static boolean sameHttpsOrigin(String a, String b) {
        String left = server(a), right = server(b);
        return left.startsWith("https://") && left.equals(right);
    }
    private LocalRoutes() {}
}
