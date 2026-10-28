package cn.strangechess.mobile;

import java.io.FileNotFoundException;
import java.io.InputStream;
import java.util.Enumeration;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/** Reads the APK with exact ZIP names, matching Android rather than Windows extraction. */
public class ApkZipAssetsHarness {
    public static void main(String[] args) throws Exception {
        try (ZipFile apk = new ZipFile(args[0])) {
            if (args.length > 1 && "verify".equals(args[1])) {
                for (Enumeration<? extends ZipEntry> it = apk.entries(); it.hasMoreElements();) {
                    String name = it.nextElement().getName();
                    if (name.indexOf('\\') >= 0) throw new AssertionError("Non-Android APK path: " + name);
                }
                for (String path : new String[]{"index.html", "app.js", "mobile.js", "android-shell.js", "styles.css", "polish.css", "mobile.css", "icon-512.png", "src/game-engine.js", "src/check-detector.js", "src/invite.js"}) {
                    ZipEntry entry = apk.getEntry("assets/www/" + path);
                    if (entry == null || entry.isDirectory() || entry.getSize() == 0) throw new AssertionError("Missing Android asset: " + path);
                }
                System.out.println("Exact Android APK asset paths verified"); return;
            }
            try (LocalServer server = new LocalServer(name -> {
                ZipEntry entry = apk.getEntry("assets/" + name);
                if (entry == null) throw new FileNotFoundException("assets/" + name);
                return apk.getInputStream(entry);
            }, 0)) {
                System.out.println(server.origin()); System.out.flush(); System.in.read();
            }
        }
    }
}
