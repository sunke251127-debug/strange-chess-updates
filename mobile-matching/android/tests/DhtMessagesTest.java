package cn.strangechess.mobile;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.List;

public final class DhtMessagesTest {
    private static void check(boolean value, String message) { if (!value) throw new AssertionError(message); }
    public static void main(String[] args) throws Exception {
        String first = "{\"text\":\"红方落子♟\"}";
        String second = "{\"text\":\"黑方回复\\n继续\"}";
        byte[] stream = (first + "\n" + second + "\n").getBytes(StandardCharsets.UTF_8);
        DhtMessages codec = new DhtMessages(); List<String> frames = new ArrayList<>();
        for (byte next : stream) frames.addAll(codec.accept(ByteBuffer.wrap(new byte[]{next})));
        check(frames.size() == 2 && frames.get(0).equals(first) && frames.get(1).equals(second), "UTF8 survives every split boundary");
        frames = codec.accept(ByteBuffer.wrap(stream)); check(frames.size() == 2, "merged IPC frames");
        codec.offer(first); codec.offer(second); ByteArrayOutputStream written = new ByteArrayOutputStream();
        while (codec.head() != null) {
            ByteBuffer head = codec.head(); int count = Math.min(3, head.remaining());
            for (int i = 0; i < count; i++) written.write(head.get());
            codec.consumed(count);
        }
        check(java.util.Arrays.equals(stream, written.toByteArray()), "partial writes keep every byte and frame order");
        codec.offer(first); codec.reset(); check(codec.head() == null, "reset clears the prior session write queue");
        boolean rejected = false;
        try { codec.accept(ByteBuffer.wrap(new byte[]{(byte)0xc3,10})); } catch (java.nio.charset.CharacterCodingException expected) { rejected = true; }
        check(rejected, "reject malformed UTF8"); codec.reset();
        rejected = false;
        try { for (int i = 0; i < 65; i++) codec.offer(first); } catch (IllegalArgumentException expected) { rejected = true; }
        check(rejected, "write queue is bounded"); codec.reset();
        rejected = false;
        try { codec.accept(ByteBuffer.wrap(new byte[70001])); } catch (IllegalArgumentException expected) { rejected = true; }
        check(rejected, "unterminated frame is bounded");
        System.out.println("Native DHT UTF8 framing, partial writes, session reset and queue-bound checks passed");
    }
}
