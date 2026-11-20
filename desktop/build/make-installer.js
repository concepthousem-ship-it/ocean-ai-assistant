// Builds dist/Ocean-Setup-<version>.exe without Windows or Wine:
// 1. electron-builder makes the app folder (win-unpacked),
// 2. resedit puts the Ocean icon and name into Ocean.exe,
// 3. NSIS (makensis) wraps it in an installer.
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

(async () => {
  const root = path.join(__dirname, "..");
  const pkg = require(path.join(root, "package.json"));
  const version = pkg.version;
  const unpacked = path.join(root, "dist", "win-unpacked");
  const ico = path.join(__dirname, "icon.ico");

  execFileSync("npx", ["electron-builder", "--win", "dir", "--x64"], { cwd: root, stdio: "inherit" });

  const ResEdit = await import("resedit");
  const exePath = path.join(unpacked, "Ocean.exe");
  const exe = ResEdit.NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(exe);
  const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(ico));
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  const target = groups[0] || { id: 1, lang: 1033 };
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, target.id, target.lang, iconFile.icons.map((i) => i.data));
  const vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0];
  if (vi) {
    const [a, b, c] = version.split(".").map(Number);
    vi.setFileVersion(a, b, c, 0, 1033);
    vi.setProductVersion(a, b, c, 0, 1033);
    vi.setStringValues({ lang: 1033, codepage: 1200 }, {
      ProductName: "Ocean", FileDescription: "Ocean", CompanyName: "DigiVireo",
      OriginalFilename: "Ocean.exe", InternalName: "Ocean", LegalCopyright: "Gudani",
      FileVersion: version, ProductVersion: version,
    });
    vi.outputToResourceEntries(res.entries);
  }
  res.outputResource(exe);
  fs.writeFileSync(exePath, Buffer.from(exe.generate()));
  console.log("Icon and version set on Ocean.exe");

  const out = path.join(root, "dist", `Ocean-Setup-${version}.exe`);
  execFileSync("makensis", [
    "-V2", `-DVERSION=${version}`, `-DSRC=${unpacked}`, `-DOUT=${out}`, `-DICON=${ico}`,
    path.join(__dirname, "installer.nsi"),
  ], { stdio: "inherit" });
  console.log("Installer:", out, `${(fs.statSync(out).size / 1048576).toFixed(1)} MB`);

  // dist/updates/ holds what goes on the update site: the installer in
  // 9 MB parts (the hosting upload takes small files) and latest.json.
  const data = fs.readFileSync(out);
  const upd = path.join(root, "dist", "updates");
  fs.rmSync(upd, { recursive: true, force: true });
  fs.mkdirSync(upd, { recursive: true });
  const PART = 9 * 1024 * 1024;
  const parts = [];
  for (let i = 0, n = 1; i < data.length; i += PART, n++) {
    const name = `${path.basename(out)}.${String(n).padStart(2, "0")}`;
    const chunk = data.subarray(i, i + PART);
    fs.writeFileSync(path.join(upd, name), chunk);
    parts.push({ name, size: chunk.length });
  }
  const latest = {
    version,
    file: path.basename(out),
    size: data.length,
    sha512: require("crypto").createHash("sha512").update(data).digest("hex"),
    parts,
    released: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(upd, "latest.json"), JSON.stringify(latest, null, 2));
  console.log(`Update files written: ${parts.length} parts and latest.json in ${upd}`);
})().catch((e) => { console.error(e); process.exit(1); });
