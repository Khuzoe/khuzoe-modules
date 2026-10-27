using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Threading;
using KhuzoeUpdater;

internal static class AppUpdateTests
{
    static string fixtures;
    static AppRelease Package(string archive, params string[] extra)
    {
        using (var zip = ZipFile.Open(archive, ZipArchiveMode.Create))
        {
            zip.CreateEntryFromFile(Path.Combine(fixtures, "new.exe"), AppUpdates.ExeName);
            zip.CreateEntryFromFile(Path.Combine(fixtures, "new.config"), AppUpdates.ConfigName);
            foreach (string name in extra) using (var writer = new StreamWriter(zip.CreateEntry(name).Open())) writer.Write("unexpected");
        }
        return new AppRelease { schemaVersion = 1, repository = BuildConfig.Repository, version = "0.0.2",
            download = "https://github.com/" + BuildConfig.Repository + "/releases/download/updater-v0.0.2/KhuzoeUpdater-Windows.zip",
            size = new FileInfo(archive).Length, sha256 = Network.Hash(archive), exeSha256 = Network.Hash(Path.Combine(fixtures, "new.exe")), configSha256 = Network.Hash(Path.Combine(fixtures, "new.config")) };
    }
    static string Target(string root, string name)
    {
        string folder = Path.Combine(root, name); Directory.CreateDirectory(folder);
        string target = Path.Combine(folder, AppUpdates.ExeName);
        File.Copy(Path.Combine(fixtures, "old.exe"), target); File.Copy(Path.Combine(fixtures, "old.config"), target + ".config");
        return target;
    }
    public static void Run(string root, Action<bool, string> assert, Action<Action, string> reject)
    {
        fixtures = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..", "build", "app-update-fixtures"));
        string archive = Path.Combine(root, "app.zip"); var release = Package(archive);
        AppUpdates.Validate(release); assert(true, "canale app indipendente dalle release dei moduli");
        var bad = Json.Read<AppRelease>(Json.Write(release)); bad.repository = "foreign/repo";
        reject(() => AppUpdates.Validate(bad), "app da repository estraneo rifiutata");
        bad = Json.Read<AppRelease>(Json.Write(release)); bad.download += "?unexpected=true";
        reject(() => AppUpdates.Validate(bad), "URL app diverso dal pacchetto previsto rifiutato");
        bad = Json.Read<AppRelease>(Json.Write(release)); bad.size = 33L * 1024 * 1024;
        reject(() => AppUpdates.Validate(bad), "pacchetto app troppo grande rifiutato");
        reject(() => AppUpdates.ValidateStage(root), "pulizia e sostituzione fuori dalle cartelle temporanee app rifiutate");
        string stage = AppUpdates.NewStage();
        try
        {
            AppUpdates.Extract(archive, stage, release);
            assert(File.Exists(Path.Combine(stage, "payload", AppUpdates.ConfigName)), "pacchetto app con EXE e configurazione verificati");
            string target = Target(root, "app-target");
            string untouched = Path.Combine(Path.GetDirectoryName(target), "other-module.txt"); File.WriteAllText(untouched, "keep");
            var plan = AppUpdates.MakePlan(target, release, Process.GetCurrentProcess());
            reject(() => AppUpdates.WaitForParent(plan, 10), "supporto attende la chiusura dell'app prima di sostituire file");
            using (var held = File.Open(target + ".config", FileMode.Open, FileAccess.Read, FileShare.Read))
                reject(() => AppUpdates.ReplaceFiles(stage, plan), "errore sul secondo file ripristina immediatamente il primo");
            assert(Network.Hash(target) == plan.oldExeHash && Network.Hash(target + ".config") == plan.oldConfigHash, "EXE e configurazione precedenti conservati dopo errore");
            AppUpdates.ReplaceFiles(stage, plan);
            assert(Network.Hash(target) == release.exeSha256 && Network.Hash(target + ".config") == release.configSha256, "aggiornamento sostituisce entrambi i file dell'app");
            assert(File.ReadAllText(untouched) == "keep", "file esterni all'app intatti");
            reject(() => AppUpdates.MakePlan(target, release, Process.GetCurrentProcess()), "nessun aggiornamento a versione uguale o inferiore");
        }
        finally { AppUpdates.RemoveStage(stage); }
        stage = AppUpdates.NewStage();
        try
        {
            bad = Json.Read<AppRelease>(Json.Write(release)); bad.sha256 = new string('0', 64);
            reject(() => AppUpdates.Extract(archive, stage, bad), "ZIP app con impronta errata rifiutato");
            string extraZip = Path.Combine(root, "app-extra.zip"); var extraRelease = Package(extraZip, "../outside.txt");
            reject(() => AppUpdates.Extract(extraZip, stage, extraRelease), "file inattesi e percorsi esterni nel pacchetto app rifiutati");
        }
        finally { AppUpdates.RemoveStage(stage); }
        stage = AppUpdates.NewStage();
        try
        {
            string incompleteZip = Path.Combine(root, "app-incomplete.zip");
            using (var zip = ZipFile.Open(incompleteZip, ZipArchiveMode.Create)) zip.CreateEntryFromFile(Path.Combine(fixtures, "new.exe"), AppUpdates.ExeName);
            bad = Json.Read<AppRelease>(Json.Write(release)); bad.size = new FileInfo(incompleteZip).Length; bad.sha256 = Network.Hash(incompleteZip);
            reject(() => AppUpdates.Extract(incompleteZip, stage, bad), "app senza configurazione nel pacchetto rifiutata");
        }
        finally { AppUpdates.RemoveStage(stage); }
        stage = AppUpdates.NewStage();
        try
        {
            bad = Json.Read<AppRelease>(Json.Write(release)); bad.version = "0.0.3";
            bad.download = "https://github.com/" + BuildConfig.Repository + "/releases/download/updater-v0.0.3/KhuzoeUpdater-Windows.zip";
            reject(() => AppUpdates.Extract(archive, stage, bad), "versione reale dell'EXE diversa dal manifest rifiutata");
        }
        finally { AppUpdates.RemoveStage(stage); }
        stage = AppUpdates.NewStage();
        try
        {
            bad = Json.Read<AppRelease>(Json.Write(release)); bad.exeSha256 = new string('0', 64);
            reject(() => AppUpdates.Extract(archive, stage, bad), "impronta dell'eseguibile verificata oltre a quella ZIP");
        }
        finally { AppUpdates.RemoveStage(stage); }
        stage = AppUpdates.NewStage();
        try
        {
            AppUpdates.Extract(archive, stage, release);
            string target = Target(root, "changed-app"); var plan = AppUpdates.MakePlan(target, release, Process.GetCurrentProcess());
            File.AppendAllText(target + ".config", "changed");
            reject(() => AppUpdates.ReplaceFiles(stage, plan), "app cambiata durante il download non sovrascritta");
            assert(Network.Hash(target) == plan.oldExeHash, "controllo dei file correnti precede ogni sostituzione");
        }
        finally { AppUpdates.RemoveStage(stage); }
        stage = AppUpdates.NewStage();
        try
        {
            AppUpdates.Extract(archive, stage, release);
            string target = Target(root, "helper-integration");
            File.Copy(Path.Combine(fixtures, "helper-host.exe"), Path.Combine(stage, "KhuzoeUpdater.UpdateHelper.exe"));
            File.Copy(Path.Combine(fixtures, "new.config"), Path.Combine(stage, "KhuzoeUpdater.UpdateHelper.exe.config"));
            using (var parent = Process.Start(new ProcessStartInfo { FileName = target, Arguments = "--hold", UseShellExecute = false, CreateNoWindow = true }))
            {
                var plan = AppUpdates.MakePlan(target, release, parent);
                File.WriteAllText(Path.Combine(stage, "plan.json"), Json.Write(plan));
                AppUpdates.StartHelper(stage);
                Thread.Sleep(250);
                assert(Network.Hash(target) == plan.oldExeHash, "supporto temporaneo reale lascia intatto l'EXE ancora aperto");
                parent.WaitForExit(5000);
                string marker = Path.Combine(Path.GetDirectoryName(target), "restart.marker");
                for (int i = 0; i < 100 && !File.Exists(marker); i++) Thread.Sleep(100);
                assert(File.Exists(marker) && File.Exists(Path.Combine(stage, "completed")) && Network.Hash(target) == release.exeSha256,
                    "supporto reale attende, aggiorna e riapre la nuova app");
            }
            AppUpdates.Cleanup().GetAwaiter().GetResult();
            assert(!Directory.Exists(stage), "supporto temporaneo eliminato dopo l'aggiornamento");
        }
        finally { AppUpdates.RemoveStage(stage); }
    }
}
