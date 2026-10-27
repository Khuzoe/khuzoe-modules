using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace KhuzoeUpdater
{
    public sealed class AppRelease
    {
        public int schemaVersion { get; set; }
        public string repository { get; set; }
        public string version { get; set; }
        public string download { get; set; }
        public long size { get; set; }
        public string sha256 { get; set; }
        public string exeSha256 { get; set; }
        public string configSha256 { get; set; }
    }
    public sealed class AppUpdatePlan
    {
        public AppRelease release { get; set; }
        public string target { get; set; }
        public string currentVersion { get; set; }
        public string oldExeHash { get; set; }
        public string oldConfigHash { get; set; }
        public int parentId { get; set; }
        public long parentStart { get; set; }
    }
    public static class AppUpdates
    {
        public const string ExeName = "KhuzoeUpdater.exe";
        public const string ConfigName = "KhuzoeUpdater.exe.config";
        public static string StageRoot { get { return Path.Combine(Path.GetTempPath(), "KhuzoeUpdaterUpdates"); } }
        public static string FeedUrl { get { return "https://github.com/" + BuildConfig.Repository + "/releases/download/updater-channel/app-update.json"; } }
        static bool HashValid(string hash) { return hash != null && Regex.IsMatch(hash, "^[a-fA-F0-9]{64}$"); }
        public static void Validate(AppRelease release)
        {
            if (release == null || release.schemaVersion != 1 || release.repository != BuildConfig.Repository ||
                release.version == null || !Regex.IsMatch(release.version, @"^\d+\.\d+\.\d+$") || !Versioning.Valid(release.version) ||
                release.download != "https://github.com/" + BuildConfig.Repository + "/releases/download/updater-v" + release.version + "/KhuzoeUpdater-Windows.zip" ||
                release.size <= 0 || release.size > 32L * 1024 * 1024 || !HashValid(release.sha256) || !HashValid(release.exeSha256) || !HashValid(release.configSha256))
                throw new InvalidDataException("Informazioni sull'aggiornamento dell'app non valide.");
        }
        public static async Task<AppRelease> Check()
        {
            using (var client = Network.Client())
            {
                client.Timeout = TimeSpan.FromSeconds(20);
                client.DefaultRequestHeaders.CacheControl = new System.Net.Http.Headers.CacheControlHeaderValue { NoCache = true };
                using (var response = await Network.Get(client, FeedUrl).ConfigureAwait(false))
                {
                    response.EnsureSuccessStatusCode();
                    if (response.Content.Headers.ContentLength > 16384) throw new InvalidDataException("Informazioni sull'app troppo grandi.");
                    using (var input = await response.Content.ReadAsStreamAsync().ConfigureAwait(false))
                    using (var output = new MemoryStream())
                    {
                        byte[] buffer = new byte[4096]; int read;
                        while ((read = await input.ReadAsync(buffer, 0, buffer.Length).ConfigureAwait(false)) > 0)
                        { if (output.Length + read > 16384) throw new InvalidDataException("Informazioni sull'app troppo grandi."); await output.WriteAsync(buffer, 0, read).ConfigureAwait(false); }
                        var release = Json.Read<AppRelease>(Encoding.UTF8.GetString(output.ToArray()));
                        Validate(release);
                        return release;
                    }
                }
            }
        }
        public static void ValidateTarget(string target)
        {
            if (!Path.IsPathRooted(target) || !String.Equals(Path.GetFileName(target), ExeName, StringComparison.OrdinalIgnoreCase))
                throw new IOException("Mantieni il nome KhuzoeUpdater.exe per aggiornare l'app.");
            Paths.NoLinks(target); Paths.NoLinks(target + ".config");
            if (!File.Exists(target) || !File.Exists(target + ".config")) throw new IOException("Tieni insieme l'EXE e il suo file .config nella cartella dell'app.");
            if ((File.GetAttributes(target) & FileAttributes.ReadOnly) != 0 || (File.GetAttributes(target + ".config") & FileAttributes.ReadOnly) != 0)
                throw new IOException("I file dell'app sono di sola lettura. Spostali in una cartella scrivibile e riprova.");
        }
        public static void CheckWritable(string target)
        {
            ValidateTarget(target);
            string probe = Path.Combine(Path.GetDirectoryName(target), ".khuzoe-write-" + Guid.NewGuid().ToString("N"));
            using (new FileStream(probe, FileMode.CreateNew, FileAccess.Write, FileShare.None, 1, FileOptions.DeleteOnClose)) { }
        }
        public static string NewStage()
        {
            Paths.NoLinks(StageRoot);
            string stage = Path.Combine(StageRoot, Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(stage); return stage;
        }
        public static void ValidateStage(string stage)
        {
            if (String.IsNullOrEmpty(stage) || !Path.IsPathRooted(stage) ||
                !String.Equals(Path.GetDirectoryName(Paths.Full(stage)), Paths.Full(StageRoot), StringComparison.OrdinalIgnoreCase) ||
                !Regex.IsMatch(Path.GetFileName(Paths.Full(stage)), "^[a-f0-9]{32}$")) throw new IOException("Cartella temporanea dell'app non valida.");
            Paths.NoLinks(stage);
        }
        public static void Extract(string zipPath, string stage, AppRelease release)
        {
            Validate(release); ValidateStage(stage);
            if (new FileInfo(zipPath).Length != release.size || !String.Equals(Network.Hash(zipPath), release.sha256, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("Il pacchetto dell'app non supera il controllo di integrità.");
            string payload = Paths.Child(stage, "payload"); Directory.CreateDirectory(payload);
            using (var zip = ZipFile.OpenRead(zipPath))
            {
                var names = new HashSet<string>(StringComparer.Ordinal);
                foreach (var entry in zip.Entries)
                {
                    if ((entry.FullName != ExeName && entry.FullName != ConfigName) || !names.Add(entry.FullName) ||
                        entry.Length <= 0 || entry.Length > 32L * 1024 * 1024 || ((entry.ExternalAttributes >> 16) & 0xf000) == 0xa000)
                        throw new InvalidDataException("Il pacchetto dell'app contiene file inattesi.");
                    using (var input = entry.Open())
                    using (var output = new FileStream(Paths.Child(payload, entry.FullName), FileMode.CreateNew, FileAccess.Write))
                    {
                        byte[] buffer = new byte[81920]; int read; long total = 0;
                        while ((read = input.Read(buffer, 0, buffer.Length)) > 0)
                        { total += read; if (total > entry.Length) throw new InvalidDataException("File dell'app troppo grande."); output.Write(buffer, 0, read); }
                        if (total != entry.Length) throw new InvalidDataException("File dell'app incompleto.");
                    }
                }
                if (names.Count != 2) throw new InvalidDataException("Il pacchetto dell'app è incompleto.");
            }
            ValidatePayload(stage, release);
        }
        static void ValidatePayload(string stage, AppRelease release)
        {
            string payload = Paths.Child(stage, "payload"), exe = Paths.Child(payload, ExeName), config = Paths.Child(payload, ConfigName);
            if (!String.Equals(Network.Hash(exe), release.exeSha256, StringComparison.OrdinalIgnoreCase) ||
                !String.Equals(Network.Hash(config), release.configSha256, StringComparison.OrdinalIgnoreCase) ||
                Versioning.Compare(FileVersionInfo.GetVersionInfo(exe).FileVersion, release.version) != 0)
                throw new InvalidDataException("I file dell'app non corrispondono alla versione pubblicata.");
        }
        public static AppUpdatePlan MakePlan(string target, AppRelease release, Process parent)
        {
            Validate(release); CheckWritable(target);
            string current = FileVersionInfo.GetVersionInfo(target).FileVersion;
            if (Versioning.Compare(release.version, current) <= 0) throw new IOException("L'app è già aggiornata.");
            return new AppUpdatePlan { target = Path.GetFullPath(target), release = release, currentVersion = current,
                oldExeHash = Network.Hash(target), oldConfigHash = Network.Hash(target + ".config"), parentId = parent.Id, parentStart = parent.StartTime.ToUniversalTime().Ticks };
        }
        public static async Task<string> Prepare(AppRelease release, string target)
        {
            var plan = MakePlan(target, release, Process.GetCurrentProcess());
            string stage = NewStage();
            try
            {
                string archive = Path.Combine(stage, "app.zip");
                await Network.Download(new Release { download = release.download, size = release.size, sha256 = release.sha256 }, archive).ConfigureAwait(false);
                await Task.Run(() => Extract(archive, stage, release)).ConfigureAwait(false);
                File.WriteAllText(Path.Combine(stage, "plan.json"), Json.Write(plan), new UTF8Encoding(false));
                File.Copy(target, Path.Combine(stage, "KhuzoeUpdater.UpdateHelper.exe"));
                File.Copy(target + ".config", Path.Combine(stage, "KhuzoeUpdater.UpdateHelper.exe.config"));
                if (Network.Hash(Path.Combine(stage, "KhuzoeUpdater.UpdateHelper.exe")) != plan.oldExeHash ||
                    Network.Hash(Path.Combine(stage, "KhuzoeUpdater.UpdateHelper.exe.config")) != plan.oldConfigHash)
                    throw new IOException("L'app è cambiata durante il download. Riprova.");
                return stage;
            }
            catch { RemoveStage(stage); throw; }
        }
        public static void StartHelper(string stage)
        {
            ValidateStage(stage);
            Process.Start(new ProcessStartInfo { FileName = Paths.Child(stage, "KhuzoeUpdater.UpdateHelper.exe"),
                Arguments = "--apply-app-update \"" + stage + "\"", WorkingDirectory = stage, UseShellExecute = false });
        }
        public static void WaitForParent(AppUpdatePlan plan, int timeout)
        {
            Process parent;
            try { parent = Process.GetProcessById(plan.parentId); } catch (ArgumentException) { return; }
            using (parent)
            {
                try
                {
                    if (parent.StartTime.ToUniversalTime().Ticks != plan.parentStart) return;
                    if (!parent.WaitForExit(timeout)) throw new IOException("L'Updater non si è chiuso. Chiudilo e riprova.");
                }
                catch (InvalidOperationException) { return; }
            }
        }
        public static void ReplaceFiles(string stage, AppUpdatePlan plan)
        {
            ValidateStage(stage); Validate(plan.release); ValidateTarget(plan.target); ValidatePayload(stage, plan.release);
            if (plan.parentId <= 0 || plan.parentStart <= 0 || !Versioning.Valid(plan.currentVersion) ||
                Versioning.Compare(plan.release.version, plan.currentVersion) <= 0 ||
                !String.Equals(Network.Hash(plan.target), plan.oldExeHash, StringComparison.OrdinalIgnoreCase) ||
                !String.Equals(Network.Hash(plan.target + ".config"), plan.oldConfigHash, StringComparison.OrdinalIgnoreCase) ||
                Versioning.Compare(FileVersionInfo.GetVersionInfo(plan.target).FileVersion, plan.currentVersion) != 0)
                throw new IOException("I file dell'app sono cambiati durante il download. Riapri l'Updater e riprova.");
            string targetDir = Path.GetDirectoryName(plan.target);
            string pending = Path.Combine(targetDir, ".khuzoe-app-" + Path.GetFileName(stage));
            if (Directory.Exists(pending) || File.Exists(pending)) throw new IOException("Cartella di aggiornamento già presente.");
            Directory.CreateDirectory(pending);
            Paths.NoLinks(pending);
            bool exeReplaced = false, configReplaced = false;
            bool safeToClean = false;
            try
            {
                File.Copy(Paths.Child(stage, "payload/" + ExeName), Path.Combine(pending, ExeName));
                File.Copy(Paths.Child(stage, "payload/" + ConfigName), Path.Combine(pending, ConfigName));
                File.Replace(Path.Combine(pending, ExeName), plan.target, Path.Combine(pending, "previous.exe")); exeReplaced = true;
                File.Replace(Path.Combine(pending, ConfigName), plan.target + ".config", Path.Combine(pending, "previous.config")); configReplaced = true;
                safeToClean = true;
            }
            catch
            {
                if (configReplaced) File.Replace(Path.Combine(pending, "previous.config"), plan.target + ".config", null);
                if (exeReplaced) File.Replace(Path.Combine(pending, "previous.exe"), plan.target, null);
                safeToClean = true;
                throw;
            }
            finally
            {
                // This exact random child contains only the two app files and their transient copies.
                if (safeToClean && Directory.Exists(pending) && String.Equals(Path.GetDirectoryName(pending), targetDir, StringComparison.OrdinalIgnoreCase))
                    try { Directory.Delete(pending, true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
            }
        }
        public static void RunHelper(string stage)
        {
            try
            {
                ValidateStage(stage);
                if (!String.Equals(Assembly.GetExecutingAssembly().Location, Paths.Child(stage, "KhuzoeUpdater.UpdateHelper.exe"), StringComparison.OrdinalIgnoreCase))
                    throw new IOException("Supporto di aggiornamento non valido.");
                var plan = Json.FileRead<AppUpdatePlan>(Paths.Child(stage, "plan.json"));
                if (plan == null || plan.parentId <= 0 || plan.parentStart <= 0) throw new IOException("Aggiornamento non valido.");
                WaitForParent(plan, 60000);
                ReplaceFiles(stage, plan);
                File.WriteAllText(Path.Combine(stage, "completed"), "ok");
                Process.Start(new ProcessStartInfo { FileName = plan.target, WorkingDirectory = Path.GetDirectoryName(plan.target), UseShellExecute = false });
            }
            catch (Exception ex)
            {
                System.Windows.Forms.MessageBox.Show("Aggiornamento dell'app non completato.\n\n" + ex.Message + "\n\nPuoi riaprire l'app dalla sua cartella o scaricare nuovamente lo ZIP da GitHub.", "Khuzoe Updater");
            }
        }
        public static void RemoveStage(string stage)
        {
            ValidateStage(stage);
            try { if (Directory.Exists(stage)) Directory.Delete(stage, true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
        }
        public static async Task Cleanup()
        {
            try
            {
                Paths.NoLinks(StageRoot);
                if (!Directory.Exists(StageRoot)) return;
                foreach (string stage in Directory.GetDirectories(StageRoot))
                {
                    ValidateStage(stage);
                    if (!File.Exists(Path.Combine(stage, "completed")) && Directory.GetLastWriteTimeUtc(stage) > DateTime.UtcNow.AddDays(-2)) continue;
                    for (int i = 0; i < 20 && Directory.Exists(stage); i++) { RemoveStage(stage); if (Directory.Exists(stage)) await Task.Delay(500).ConfigureAwait(false); }
                }
            }
            catch (IOException) { } catch (UnauthorizedAccessException) { }
        }
    }
}
