package cn.strangechess.mobile;
public final class RelayRoutesTest {
    private static void check(boolean value) { if (!value) throw new AssertionError("relay route assertion failed"); }
    public static void main(String[] args) {
        check(LocalRoutes.remoteRelay("wss://broker.emqx.io:8084/mqtt"));
        check(LocalRoutes.remoteRelay("wss://test.mosquitto.org:8081/mqtt"));
        for (String url : new String[] {
            "ws://broker.emqx.io:8084/mqtt", "https://broker.emqx.io:8084/mqtt", "wss://broker.emqx.io:443/mqtt",
            "wss://attacker.example:8084/mqtt", "wss://broker.emqx.io.attacker.example:8084/mqtt",
            "wss://broker.emqx.io:8084/else", "wss://broker.emqx.io:8084/mqtt?q=1",
            "wss://name:password@broker.emqx.io:8084/mqtt", "wss://broker.emqx.io:8084/mqtt#x", "invalid"
        }) check(!LocalRoutes.remoteRelay(url));
        check("www/src/piece-glyphs.js".equals(LocalRoutes.asset("http://127.0.0.1:48767/src/piece-glyphs.js")));
        check("www/src/relay-channel.js".equals(LocalRoutes.asset("http://127.0.0.1:48767/src/relay-channel.js")));
        System.out.println("native relay allowlist and packaged glyph/relay routes passed");
    }
}
