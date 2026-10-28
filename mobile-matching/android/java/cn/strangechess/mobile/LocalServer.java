package cn.strangechess.mobile;

import java.io.Closeable;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.ByteArrayOutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.TimeUnit;

/** Serves packaged immutable assets only on this phone's own loopback interface. */
public final class LocalServer implements Closeable {
    public interface Source { InputStream open(String name) throws IOException; }
    private final Source source;
    private final ServerSocket listener;
    private final ThreadPoolExecutor pool = new ThreadPoolExecutor(2, 4, 10, TimeUnit.SECONDS, new ArrayBlockingQueue<Runnable>(16));
    private volatile boolean closed;
    public LocalServer(Source source) throws IOException {
        this(source, 48767);
    }
    public LocalServer(Source source, int port) throws IOException {
        this.source = source;
        listener = new ServerSocket(port, 16, InetAddress.getByName("127.0.0.1"));
        Thread accept = new Thread(() -> {
            while (!closed) {
                try {
                    Socket socket = listener.accept();
                    try { pool.execute(() -> serve(socket)); } catch (RuntimeException error) { socket.close(); }
                } catch (IOException error) { if (!closed) close(); }
            }
        }, "chess-assets");
        accept.setDaemon(true); accept.start();
    }
    public int port() { return listener.getLocalPort(); }
    public String origin() { return "http://127.0.0.1:" + port(); }
    private void serve(Socket socket) {
        try (Socket connection = socket) {
            connection.setSoTimeout(5000);
            InputStream input = connection.getInputStream();
            ByteArrayOutputStream header = new ByteArrayOutputStream();
            int previous = 0, marker = 0;
            while (header.size() < 8192) {
                int b = input.read(); if (b == -1) return; header.write(b);
                if (previous == '\r' && b == '\n') marker++; else if (b != '\r') marker = 0;
                previous = b; if (marker == 2) break;
            }
            if (marker != 2) { respond(connection, 431, "text/plain", new byte[0], false); return; }
            String[] request = new String(header.toByteArray(), StandardCharsets.US_ASCII).split("\r\n", 2)[0].split(" ");
            if (request.length != 3 || !("GET".equals(request[0]) || "HEAD".equals(request[0])) || !request[1].startsWith("/")) { respond(connection, 405, "text/plain", new byte[0], false); return; }
            String asset = LocalRoutes.asset(origin() + request[1], port());
            if (asset == null) { respond(connection, 404, "text/plain", new byte[0], false); return; }
            byte[] body;
            try (InputStream content = source.open(asset); ByteArrayOutputStream bytes = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[16384]; int count;
                while ((count = content.read(buffer)) != -1) { if (bytes.size() + count > 64 * 1024 * 1024) throw new IOException("asset too large"); bytes.write(buffer, 0, count); }
                body = bytes.toByteArray();
            } catch (IOException error) {
                respond(connection, 500, "text/plain", "Local chess resource could not be loaded. Please update the app.".getBytes(StandardCharsets.UTF_8), "HEAD".equals(request[0]));
                return;
            }
            String mime = asset.endsWith(".wasm") ? "application/wasm" : asset.endsWith(".onnx") ? "application/octet-stream" : asset.endsWith(".json") ? "application/json" : asset.endsWith(".txt") ? "text/plain" : asset.endsWith(".js") || asset.endsWith(".mjs") ? "text/javascript" : asset.endsWith(".css") ? "text/css" : asset.endsWith(".png") ? "image/png" : asset.endsWith(".svg") ? "image/svg+xml" : asset.endsWith(".webmanifest") ? "application/manifest+json" : "text/html";
            respond(connection, 200, mime, body, "HEAD".equals(request[0]));
        } catch (IOException ignored) {}
    }
    private void respond(Socket socket, int status, String mime, byte[] bytes, boolean head) throws IOException {
        OutputStream output = socket.getOutputStream();
        String header = "HTTP/1.1 " + status + (status == 200 ? " OK" : " Error") + "\r\nContent-Type: " + mime + "; charset=utf-8\r\nContent-Length: " + bytes.length + "\r\nConnection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nX-Frame-Options: DENY\r\n\r\n";
        output.write(header.getBytes(StandardCharsets.US_ASCII)); if (!head) output.write(bytes); output.flush();
    }
    @Override public void close() { closed = true; try { listener.close(); } catch (IOException ignored) {} pool.shutdownNow(); }
}
