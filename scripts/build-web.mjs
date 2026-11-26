// Kopiert die Web-App (liegt für GitHub Pages im Hauptordner) nach www/ für die Android-App.
import { cpSync, mkdirSync, rmSync, readdirSync, existsSync, writeFileSync } from "node:fs";
const KEEP = /\.(html|js|css|json|png|svg|webmanifest)$/;
const SKIP = new Set(["package.json", "package-lock.json", "capacitor.config.json", "sw.js"]);
rmSync("www", { recursive: true, force: true });
mkdirSync("www");
for (const f of readdirSync(".")) {
  if (KEEP.test(f) && !SKIP.has(f)) cpSync(f, "www/" + f);
}
// leerer Service Worker: in der App nicht nötig (Dateien liegen lokal)
writeFileSync("www/sw.js", "// In der Android-App nicht benötigt.\n");
const push = existsSync("android/app/google-services.json");
writeFileSync("www/build-config.js", "window.GRAVITY_BUILD=" + JSON.stringify({ push }) + ";\n");
console.log("www/ erstellt:", readdirSync("www").join(", "));
