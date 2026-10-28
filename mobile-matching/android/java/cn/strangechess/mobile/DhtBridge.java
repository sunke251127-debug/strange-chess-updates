package cn.strangechess.mobile;

import android.content.Context;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;
import to.holepunch.bare.kit.Worklet;
import to.holepunch.bare.kit.IPC;

/** Owns the native DHT thread. No game server outside the phone is launched. */
public final class DhtBridge implements AutoCloseable {
    public interface Listener { void event(String id, JSONObject event); }
    private final Context context;
    private final Listener listener;
    private final HandlerThread thread = new HandlerThread("ChessDht");
    private final Handler handler;
    private final DhtMessages messages = new DhtMessages();
    private volatile String current = "";
    private volatile boolean closed;
    private String runtimeId = "";
    private Worklet worklet;
    private IPC ipc;

    public DhtBridge(Context context, Listener listener) {
        this.context = context.getApplicationContext(); this.listener = listener;
        thread.start(); handler = new Handler(thread.getLooper());
    }
    private static boolean validId(String id) { return id != null && id.matches("[A-Za-z0-9_-]{12,64}"); }
    public static boolean available() { return Build.VERSION.SDK_INT >= 29; }

    public void start(String id) {
        if (!validId(id) || closed) return;
        current = id;
        handler.post(() -> {
            if (closed || !id.equals(current)) return;
            cleanup(); runtimeId = id;
            try {
                if (!available()) throw new IllegalStateException("随机联机需要 Android 10 或以上；仍可使用好友直连。");
                worklet = new Worklet(new Worklet.Options().memoryLimit(64 * 1024 * 1024));
                ipc = new IPC(worklet);
                ipc.readable(this::read);
                ByteArrayOutputStream bytes = new ByteArrayOutputStream();
                try (InputStream stream = context.getAssets().open("dht/chess-dht.bundle")) {
                    byte[] part = new byte[16384]; int count;
                    while ((count = stream.read(part)) != -1) bytes.write(part, 0, count);
                }
                worklet.start("/chess-dht.bundle", ByteBuffer.wrap(bytes.toByteArray()), new String[0]);
                command("start", null);
            } catch (Throwable error) { fail(error); }
        });
    }
    public void send(String id, String payload) {
        if (closed || !validId(id) || !id.equals(current) || payload == null || payload.length() > 65536) return;
        handler.post(() -> {
            if (!id.equals(current) || !id.equals(runtimeId)) return;
            try { command("send", new JSONObject(payload)); } catch (Throwable error) { fail(error); }
        });
    }
    public void stop(String id) {
        if (!validId(id) || !id.equals(current)) return;
        current = "";
        handler.post(() -> { if (id.equals(runtimeId)) cleanup(); });
    }
    public void resume() {
        handler.post(() -> {
            if (worklet == null || !runtimeId.equals(current)) return;
            try { worklet.resume(); command("wake", null); } catch (Throwable error) { fail(error); }
        });
    }
    private void command(String type, JSONObject body) throws Exception {
        if (ipc == null) throw new IllegalStateException("DHT 原生通道尚未启动");
        JSONObject value = new JSONObject().put("id", runtimeId).put("type", type);
        if (body != null) value.put("body", body);
        messages.offer(value.toString()); flush();
    }
    private void flush() {
        try {
            ByteBuffer head;
            while (ipc != null && (head = messages.head()) != null) {
                int expected = head.remaining();
                int written = ipc.write(head);
                if (written < 0) throw new IllegalStateException("DHT 原生通道已关闭");
                messages.consumed(written);
                if (written < expected) { ipc.writable(this::flush); return; }
            }
            if (ipc != null) ipc.writable(null);
        } catch (Throwable error) { fail(error); }
    }
    private void read() {
        try {
            while (ipc != null) {
                ByteBuffer data = ipc.read();
                if (data == null) return;
                if (!data.hasRemaining()) throw new IllegalStateException("DHT 原生通道已结束");
                for (String raw : messages.accept(data)) {
                    JSONObject value = new JSONObject(raw);
                    if (runtimeId.equals(current) && runtimeId.equals(value.optString("id"))) listener.event(runtimeId, value);
                }
            }
        } catch (Throwable error) { fail(error); }
    }
    private void fail(Throwable error) {
        String id = runtimeId;
        try {
            if (id.equals(current)) listener.event(id, new JSONObject().put("type", "fatal")
                .put("message", "随机联机暂不可用：" + (error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage())));
        } catch (Exception ignored) {}
        cleanup();
    }
    private void cleanup() {
        IPC previousIpc = ipc; ipc = null;
        Worklet previous = worklet; worklet = null;
        messages.reset(); runtimeId = "";
        if (previousIpc != null) { previousIpc.readable(null); previousIpc.writable(null); previousIpc.close(); }
        if (previous != null) previous.close();
    }
    @Override public void close() {
        if (closed) return; closed = true; current = "";
        handler.post(() -> { cleanup(); thread.quitSafely(); });
    }
}
