package cn.strangechess.mobile;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.CharacterCodingException;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;

/** Byte-stream framing and bounded partial-write queue shared by the native IPC. */
public final class DhtMessages {
    private final ByteArrayOutputStream incoming = new ByteArrayOutputStream();
    private final ArrayDeque<ByteBuffer> outgoing = new ArrayDeque<>();
    private int queued;
    public List<String> accept(ByteBuffer data) throws CharacterCodingException {
        List<String> messages = new ArrayList<>();
        while (data.hasRemaining()) {
            byte next = data.get();
            if (next == 10) {
                messages.add(StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(incoming.toByteArray())).toString());
                incoming.reset();
            } else {
                if (incoming.size() >= 70000) throw new IllegalArgumentException("DHT 原生消息过大");
                incoming.write(next);
            }
        }
        return messages;
    }
    public void offer(String message) {
        byte[] bytes = (message + "\n").getBytes(StandardCharsets.UTF_8);
        if (bytes.length > 70000 || outgoing.size() >= 64 || queued + bytes.length > 1024 * 1024) throw new IllegalArgumentException("联机消息队列已满，请等待连接恢复");
        outgoing.add(ByteBuffer.wrap(bytes)); queued += bytes.length;
    }
    public ByteBuffer head() { return outgoing.isEmpty() ? null : outgoing.peek().slice(); }
    public void consumed(int count) {
        ByteBuffer head = outgoing.peek();
        if (head == null || count < 0 || count > head.remaining()) throw new IllegalArgumentException("Invalid IPC write count");
        head.position(head.position() + count); queued -= count;
        if (!head.hasRemaining()) outgoing.remove();
    }
    public void reset() { incoming.reset(); outgoing.clear(); queued = 0; }
}
