package cn.strangechess.mobile;
import java.io.File;
import java.io.FileInputStream;
public class LocalServerHarness {
    public static void main(String[] args) throws Exception {
        File root = new File(args[0]);
        try (LocalServer server = new LocalServer(name -> new FileInputStream(new File(root, name)), 0)) {
            System.out.println(server.origin()); System.out.flush(); System.in.read();
        }
    }
}
