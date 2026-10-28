package cn.strangechess.mobile;
public class LocalRoutesTest {
    private static void check(boolean value, String message) { if (!value) throw new AssertionError(message); }
    public static void main(String[] args) {
        check("www/index.html".equals(LocalRoutes.asset(LocalRoutes.ORIGIN + "/")), "offline entry");
        check("www/src/game-engine.js".equals(LocalRoutes.asset(LocalRoutes.ORIGIN + "/src/game-engine.js?v=1")), "rules route");
        check("www/ai/model.onnx".equals(LocalRoutes.asset(LocalRoutes.ORIGIN + "/ai/model.onnx")), "packaged offline model");
        check("www/ai/ort-wasm-simd-threaded.mjs".equals(LocalRoutes.asset(LocalRoutes.ORIGIN + "/ai/ort-wasm-simd-threaded.mjs")), "packaged runtime module");
        for (String value : new String[]{"https://evil.test/app.js", "http://127.0.0.1:48768/app.js", "https://127.0.0.1:48767/app.js", "http://user@127.0.0.1:48767/app.js", LocalRoutes.ORIGIN + "/../AndroidManifest.xml", LocalRoutes.ORIGIN + "/%2e%2e/secrets", LocalRoutes.ORIGIN + "/server/server.cjs"}) check(LocalRoutes.asset(value) == null, "blocked route " + value);
        check("https://example.test/".equals(LocalRoutes.server("wss://example.test/ws")), "WSS conversion");
        check("http://192.168.1.5:38766/".equals(LocalRoutes.server("http://192.168.1.5:38766/a?room=ABCDEF")), "LAN server");
        check("".equals(LocalRoutes.server("https://user:secret@example.test/")), "reject embedded credentials");
        check("".equals(LocalRoutes.server("javascript:alert(1)")), "reject script");
        check(LocalRoutes.sameHttpsOrigin("https://example.test/", "https://example.test/download/android"), "same source APK");
        check(!LocalRoutes.sameHttpsOrigin("https://example.test/", "http://example.test/download/android"), "no HTTP update");
        check(!LocalRoutes.sameHttpsOrigin("https://example.test/", "https://other.test/a.apk"), "no foreign origin APK");
        System.out.println("Local routes, offline entry and update-origin checks passed");
    }
}
