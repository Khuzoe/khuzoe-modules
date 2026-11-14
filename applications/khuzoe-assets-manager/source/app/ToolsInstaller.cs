using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net.Http;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace KhuzoeAssetsManager
{
    public sealed class ToolPaths
    {
        public string Downloader { get; set; }
        public string Ffmpeg { get; set; }
        public string Ffprobe { get; set; }
        public string Node { get; set; }
    }
    public interface IToolProvider { Task<ToolPaths> EnsureAsync(Action<string> progress, CancellationToken cancellation); }
    public sealed class ReleaseAsset
    {
        public Uri Url;
        public string Hash;
        public long Size;
        public string Version;
    }
    public sealed class ToolsInstaller : IToolProvider
    {
        readonly AppStorage storage;
        readonly SemaphoreSlim gate = new SemaphoreSlim(1, 1);
        public ToolsInstaller(AppStorage storage) { this.storage = storage; }
        ToolPaths Paths { get { return new ToolPaths { Downloader = Path.Combine(storage.ToolRoot, "yt-dlp.exe"), Ffmpeg = Path.Combine(storage.ToolRoot, "ffmpeg.exe"), Ffprobe = Path.Combine(storage.ToolRoot, "ffprobe.exe"), Node = Path.Combine(storage.ToolRoot, "node.exe") }; } }
        public bool Ready()
        {
            try
            {
                FoundryPaths.NoLinks(storage.ToolRoot);
                var manifest = Json.Read<Dictionary<string, string>>(File.ReadAllText(Path.Combine(storage.ToolRoot, "integrity.json")));
                foreach (string name in new[] { "yt-dlp.exe", "ffmpeg.exe", "ffprobe.exe", "node.exe" })
                {
                    string expected, file = Path.Combine(storage.ToolRoot, name);
                    if (!manifest.TryGetValue(name, out expected) || !Regex.IsMatch(expected, "^[a-f0-9]{64}$") || !File.Exists(file) || FoundryPaths.Hash(file) != expected) return false;
                }
                return true;
            }
            catch (IOException) { return false; } catch (ArgumentException) { return false; }
        }
        public static ReleaseAsset ParseAsset(string json, string repo, string name)
        {
            var release = Json.Read<Dictionary<string, object>>(json);
            var asset = Json.Array(release, "assets").SingleOrDefault(item => Json.Str(item, "name") == name);
            if (asset == null) throw new IOException("Il componente richiesto non è disponibile nella release ufficiale.");
            Uri url;
            string digest = Json.Str(asset, "digest");
            if (!Uri.TryCreate(Json.Str(asset, "browser_download_url"), UriKind.Absolute, out url) || url.Scheme != "https" || !url.IsDefaultPort || url.Host != "github.com" || !url.AbsolutePath.StartsWith("/" + repo + "/releases/download/", StringComparison.Ordinal) || url.UserInfo.Length != 0 || !Regex.IsMatch(digest, "^sha256:[a-f0-9]{64}$"))
                throw new IOException("La release non contiene un download ufficiale con impronta SHA-256 valida.");
            long size = (long)Json.Number(asset, "size");
            if (size <= 0 || size > 450L * 1024 * 1024) throw new IOException("Dimensione del componente non valida.");
            return new ReleaseAsset { Url = url, Hash = digest.Substring(7), Size = size, Version = Json.Str(release, "tag_name") };
        }
        public static void VerifyHash(string file, string hash)
        {
            if (!Regex.IsMatch(hash ?? "", "^[a-f0-9]{64}$") || FoundryPaths.Hash(file) != hash) throw new IOException("La verifica del pacchetto non è riuscita. Nessun componente è stato installato.");
        }
        public static void ExtractFfmpeg(string archive, string destination)
        {
            using (var zip = ZipFile.OpenRead(archive))
            {
                foreach (string name in new[] { "ffmpeg.exe", "ffprobe.exe" })
                {
                    var entries = zip.Entries.Where(item => item.FullName.Replace('\\', '/').EndsWith("/bin/" + name, StringComparison.OrdinalIgnoreCase)).ToList();
                    if (entries.Count != 1 || entries[0].Length <= 0 || entries[0].Length > 350L * 1024 * 1024) throw new IOException("Il pacchetto audio non contiene i componenti attesi.");
                    // Only these two fixed filenames are extracted; archive paths are never used as destinations.
                    using (var source = entries[0].Open()) using (var output = new FileStream(Path.Combine(destination, name), FileMode.CreateNew)) source.CopyTo(output);
                }
            }
        }
        public async Task<ToolPaths> EnsureAsync(Action<string> progress, CancellationToken cancellation)
        {
            await gate.WaitAsync(cancellation);
            try { if (await Task.Run(() => Ready(), cancellation)) return Paths; return await InstallAsync(progress, cancellation); }
            finally { gate.Release(); }
        }
        public async Task UpdateAsync(Action<string> progress, CancellationToken cancellation)
        {
            await gate.WaitAsync(cancellation);
            try { await InstallAsync(progress, cancellation); } finally { gate.Release(); }
        }
        async Task<ToolPaths> InstallAsync(Action<string> progress, CancellationToken cancellation)
        {
            if (!Environment.Is64BitOperatingSystem) throw new IOException("Questa versione richiede Windows a 64 bit.");
            string stage = Path.Combine(storage.Root, "prepare-" + Guid.NewGuid().ToString("N"));
            string previous = Path.Combine(storage.Root, "previous-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(stage); FoundryPaths.NoLinks(stage);
            try
            {
                using (var client = Network.Client(TimeSpan.FromMinutes(15)))
                {
                    progress("Preparazione iniziale: ricerca dei componenti ufficiali…");
                    var downloader = ParseAsset(await Network.TextAsync(client, new Uri("https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest"), cancellation), "yt-dlp/yt-dlp", "yt-dlp.exe");
                    var ffmpeg = ParseAsset(await Network.TextAsync(client, new Uri("https://api.github.com/repos/yt-dlp/FFmpeg-Builds/releases/latest"), cancellation), "yt-dlp/FFmpeg-Builds", "ffmpeg-master-latest-win64-gpl.zip");
                    await Network.DownloadAsync(client, downloader.Url, Path.Combine(stage, "yt-dlp.exe"), downloader.Size, cancellation, value => progress("Preparazione del download · " + value + "%"));
                    VerifyHash(Path.Combine(stage, "yt-dlp.exe"), downloader.Hash);
                    string archive = Path.Combine(stage, "ffmpeg.zip");
                    await Network.DownloadAsync(client, ffmpeg.Url, archive, ffmpeg.Size, cancellation, value => progress("Preparazione della conversione audio · " + value + "%"));
                    VerifyHash(archive, ffmpeg.Hash);
                    progress("Preparazione della conversione audio…");
                    await Task.Run(() => ExtractFfmpeg(archive, stage), cancellation); File.Delete(archive);
                    string checksums = await Network.TextAsync(client, new Uri("https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt"), cancellation);
                    var match = Regex.Match(checksums, "(?m)^([a-f0-9]{64})\\s+win-x64/node.exe\\r?$");
                    if (!match.Success) throw new IOException("Il componente di supporto non ha un’impronta ufficiale valida.");
                    string node = Path.Combine(stage, "node.exe");
                    await Network.DownloadAsync(client, new Uri("https://nodejs.org/dist/latest-v22.x/win-x64/node.exe"), node, 0, cancellation, value => progress("Preparazione finale · " + value + "%"));
                    VerifyHash(node, match.Groups[1].Value);
                    var manifest = new Dictionary<string, string>();
                    foreach (string name in new[] { "yt-dlp.exe", "ffmpeg.exe", "ffprobe.exe", "node.exe" }) manifest[name] = FoundryPaths.Hash(Path.Combine(stage, name));
                    Json.Save(Path.Combine(stage, "integrity.json"), manifest);
                    Json.Save(Path.Combine(stage, "versions.json"), new { downloader = downloader.Version, ffmpeg = ffmpeg.Hash, preparedAt = DateTime.UtcNow.ToString("o") });
                    cancellation.ThrowIfCancellationRequested();
                    FoundryPaths.NoLinks(storage.ToolRoot);
                    if (Directory.Exists(storage.ToolRoot)) Directory.Move(storage.ToolRoot, previous);
                    try { Directory.Move(stage, storage.ToolRoot); }
                    catch { if (Directory.Exists(previous) && !Directory.Exists(storage.ToolRoot)) Directory.Move(previous, storage.ToolRoot); throw; }
                    progress("Strumenti pronti."); return Paths;
                }
            }
            finally
            {
                if (Directory.Exists(stage)) FoundryPaths.RemoveWork(storage.Root, stage);
                if (Directory.Exists(previous) && Directory.Exists(storage.ToolRoot)) FoundryPaths.RemoveWork(storage.Root, previous);
            }
        }
    }
}
