using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using KhuzoeUpdater;

internal static class DesktopApplicationTests
{
    static Release Release(string version)
    { return new Release { id = "khuzoe-assets-manager", title = "Khuzoe Assets Manager", version = version, entryPoint = "KhuzoeAssetsManager.exe", sha256 = new string('a', 64), size = 100,
        download = "https://github.com/Khuzoe/khuzoe-modules/releases/download/khuzoe-assets-manager-v" + version + "/application.zip", compatibility = new Dictionary<string, object> { { "minimum", "14" }, { "maximum", "14" } } }; }
    static void Save(string file, object value) { Directory.CreateDirectory(Path.GetDirectoryName(file)); File.WriteAllText(file, Json.Write(value)); }
    static string Package(string root, string version, string fixture)
    {
        string source = Path.Combine(root, "source-" + version); Directory.CreateDirectory(source);
        string binaries = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..", "build", "app-update-fixtures"));
        File.Copy(Path.Combine(binaries, fixture + ".exe"), Path.Combine(source, "KhuzoeAssetsManager.exe"));
        File.Copy(Path.Combine(binaries, fixture + ".config"), Path.Combine(source, "KhuzoeAssetsManager.exe.config"));
        Save(Path.Combine(source, "application.json"), new { id = "khuzoe-assets-manager", version = version, entryPoint = "KhuzoeAssetsManager.exe" });
        string runtime = Path.Combine(source, "scene-reader"); Directory.CreateDirectory(runtime);
        File.WriteAllText(Path.Combine(runtime, "reader.cjs"), "fixture reader"); File.WriteAllText(Path.Combine(runtime, "fixture.node"), "fixture binary");
        Save(Path.Combine(runtime, "integrity.json"), new Dictionary<string, string> { { "reader.cjs", Network.Hash(Path.Combine(runtime, "reader.cjs")) }, { "fixture.node", Network.Hash(Path.Combine(runtime, "fixture.node")) } });
        string zip = Path.Combine(root, version + ".zip"); ZipFile.CreateFromDirectory(source, zip); return zip;
    }
    public static void Run(string parent, Action<bool, string> assert, Action<Action, string> reject)
    {
        string root = Path.Combine(parent, "desktop apps"), modules = Path.Combine(root, "Foundry", "Data", "modules"); Directory.CreateDirectory(modules);
        var install = new Installation { ModulesPath = modules, FoundryVersion = "14.367" }; var release = Release("0.0.1");
        var catalog = new Catalog { schemaVersion = 1, repository = "Khuzoe/khuzoe-modules", modules = new List<Release>(), applications = new List<Release> { release } };
        Network.Validate(catalog); assert(true, "app autorizzata nel catalogo insieme ai moduli");
        release.entryPoint = "../untrusted.exe"; reject(() => Network.Validate(catalog), "eseguibile app arbitrario rifiutato"); release.entryPoint = "KhuzoeAssetsManager.exe";
        catalog.modules.Add(release); reject(() => Network.Validate(catalog), "app non installabile nella raccolta dei moduli"); catalog.modules.Clear();
        var row = Planner.Scan(install, catalog).Single();
        assert(!row.IsInstalled && row.CanUpdate && row.Status == "Da installare" && row.DirectoryPath == Path.Combine(root, "Foundry", "Data", "khuzoe-apps", release.id), "destinazione app dedicata e stato Da installare");
        assert(Planner.BuildPlan(install, new List<ModuleStatus> { row }, new ModuleStatus[0]).Count == 0, "Aggiorna non installa automaticamente un'app mancante");
        string zip = Package(root, "0.0.1", "old"), staged = Path.Combine(root, "stage-old"); Installer.Extract(zip, staged, release);
        Installer.Replace(Installer.RootFor(install, release), staged, row); row = Planner.Scan(install, catalog).Single();
        assert(row.IsInstalled && !row.CanUpdate && row.LocalVersion == "0.0.1", "installazione app con versione eseguibile verificata");
        var launch = DesktopApplications.LaunchInfo(install, row);
        assert(!launch.UseShellExecute && launch.Arguments == "--foundry-data \"" + Path.GetDirectoryName(modules) + "\"" && launch.FileName == Path.Combine(row.DirectoryPath, "KhuzoeAssetsManager.exe"), "avvio con cartella Foundry già scelta e percorsi con spazi");
        using (var running = Process.Start(new ProcessStartInfo { FileName = launch.FileName, Arguments = "--hold", UseShellExecute = false, CreateNoWindow = true }))
        { try { reject(() => DesktopApplications.EnsureClosed(row), "app aperta non sostituita durante aggiornamento"); } finally { if (!running.WaitForExit(6000)) { running.Kill(); running.WaitForExit(); } } }
        string savedState = Path.Combine(root, "user-settings", "session.bin"); Directory.CreateDirectory(Path.GetDirectoryName(savedState)); File.WriteAllText(savedState, "fixture session");
        string sentinel = Path.Combine(modules, "existing-module", "keep.txt"); Directory.CreateDirectory(Path.GetDirectoryName(sentinel)); File.WriteAllText(sentinel, "keep module");
        File.WriteAllText(Path.Combine(row.DirectoryPath, "obsolete.txt"), "obsolete");
        release = Release("0.0.2"); catalog.applications[0] = release; row = Planner.Scan(install, catalog).Single();
        assert(row.CanUpdate && row.Status == "Da aggiornare", "app installata inclusa nel normale piano aggiornamenti");
        string next = Package(root, "0.0.2", "new"), newer = Path.Combine(root, "stage-new"); Installer.Extract(next, newer, release);
        Installer.Replace(Installer.RootFor(install, release), newer, row); row = Planner.Scan(install, catalog).Single();
        assert(row.LocalVersion == "0.0.2" && !File.Exists(Path.Combine(row.DirectoryPath, "obsolete.txt")) && File.ReadAllText(savedState) == "fixture session" && File.ReadAllText(sentinel) == "keep module", "aggiornamento app completo, sessioni e moduli conservati");
        catalog.applications[0] = Release("0.0.1"); assert(!Planner.Scan(install, catalog).Single().CanUpdate, "versione locale app più recente mantenuta");
        string broken = Path.Combine(root, "broken"); Installer.Extract(next, broken, release); File.WriteAllText(Path.Combine(broken, "scene-reader", "fixture.node"), "tampered");
        reject(() => DesktopApplications.ValidatePackage(broken, release), "runtime scene incompleto o alterato rifiutato");
        reject(() => DesktopApplications.ValidateLocal(broken, release, "99.0.0"), "versione manifest ed eseguibile diverse rifiutate");
    }
}
