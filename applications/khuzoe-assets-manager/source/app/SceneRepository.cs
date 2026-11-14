using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace KhuzoeAssetsManager
{
    public sealed class SceneSnapshot : IDisposable
    {
        public string Directory { get; private set; }
        public string WorldId { get; private set; }
        readonly string parent;
        public SceneSnapshot(string directory, string parent, string world) { Directory = directory; this.parent = parent; WorldId = world; }
        public void Dispose() { if (System.IO.Directory.Exists(Directory)) FoundryPaths.RemoveWork(parent, Directory); }
    }
    public static class SceneFiles
    {
        public static bool ValidId(string id) { return Regex.IsMatch(id ?? "", "^[A-Za-z0-9_-]{1,96}$"); }
        public static List<FoundryWorld> Worlds(string dataRoot)
        {
            if (!FoundryPaths.IsDataRoot(dataRoot)) throw new IOException("Scegli una cartella dati Foundry valida.");
            string root = Path.Combine(dataRoot, "worlds"); FoundryPaths.NoLinks(root);
            var result = new List<FoundryWorld>();
            foreach (string directory in System.IO.Directory.EnumerateDirectories(root))
            {
                string id = Path.GetFileName(directory);
                if (!ValidId(id) || (File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0) continue;
                string manifest = Path.Combine(directory, "world.json");
                if (!File.Exists(manifest)) continue;
                FoundryPaths.NoLinks(manifest);
                if (new FileInfo(manifest).Length > 1024 * 1024) continue;
                try
                {
                    var data = Json.Read<Dictionary<string, object>>(File.ReadAllText(manifest, Encoding.UTF8));
                    string title = Json.Str(data, "title");
                    result.Add(new FoundryWorld { Id = id, Name = String.IsNullOrWhiteSpace(title) ? id : title, Directory = directory });
                }
                catch (ArgumentException) { } catch (InvalidOperationException) { }
            }
            return result.OrderBy(value => value.Name, StringComparer.CurrentCultureIgnoreCase).ToList();
        }
        sealed class Stamp
        {
            public string Name;
            public long Length, Time;
            public string Hash;
        }
        static List<Stamp> Capture(string source)
        {
            FoundryPaths.NoLinks(source);
            var files = System.IO.Directory.EnumerateFiles(source).Where(file => Regex.IsMatch(Path.GetFileName(file), "^(CURRENT|MANIFEST-[0-9]+|[0-9]+\\.(ldb|sst|log))$", RegexOptions.IgnoreCase)).OrderBy(file => file, StringComparer.Ordinal).ToList();
            if (!files.Any(file => Path.GetFileName(file) == "CURRENT")) throw new IOException("Questo mondo non contiene un database scene LevelDB. Aprilo prima in Foundry v14.");
            if (files.Count > 10000) throw new IOException("La raccolta scene è troppo grande per creare questa anteprima.");
            long total = 0; var result = new List<Stamp>();
            foreach (string file in files)
            {
                FoundryPaths.NoLinks(file); var info = new FileInfo(file); total += info.Length;
                if (total > 2L * 1024 * 1024 * 1024) throw new IOException("Il database scene supera il limite di lettura di 2 GiB.");
                string name = info.Name;
                result.Add(new Stamp { Name = name, Length = info.Length, Time = info.LastWriteTimeUtc.Ticks,
                    Hash = name == "CURRENT" || name.StartsWith("MANIFEST-", StringComparison.Ordinal) || name.EndsWith(".log", StringComparison.OrdinalIgnoreCase) ? HashShared(file) : "" });
            }
            string manifest;
            using (var input = new FileStream(Path.Combine(source, "CURRENT"), FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            using (var reader = new StreamReader(input, Encoding.UTF8)) manifest = reader.ReadToEnd().Trim();
            if (!Regex.IsMatch(manifest, "^MANIFEST-[0-9]+$") || !result.Any(file => file.Name == manifest)) throw new IOException("L'indice delle scene è cambiato durante la lettura. Premi Aggiorna.");
            return result;
        }
        static string HashShared(string file)
        {
            using (var hash = System.Security.Cryptography.SHA256.Create())
            using (var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                return BitConverter.ToString(hash.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
        }
        public static async Task<SceneSnapshot> SnapshotAsync(string dataRoot, string worldId, string cacheRoot, CancellationToken cancellation)
        {
            if (!ValidId(worldId) || !FoundryPaths.IsDataRoot(dataRoot)) throw new IOException("Mondo Foundry non valido.");
            string source = Path.Combine(dataRoot, "worlds", worldId, "data", "scenes");
            if (!System.IO.Directory.Exists(source) || !File.Exists(Path.Combine(source, "CURRENT"))) throw new IOException("Questo mondo non contiene un database scene LevelDB. Aprilo prima in Foundry v14.");
            FoundryPaths.NoLinks(source); FoundryPaths.NoLinks(cacheRoot); System.IO.Directory.CreateDirectory(cacheRoot);
            for (int attempt = 0; attempt < 3; attempt++)
            {
                cancellation.ThrowIfCancellationRequested();
                string work = Path.Combine(cacheRoot, Guid.NewGuid().ToString("N").Substring(0, 16));
                System.IO.Directory.CreateDirectory(work);
                try
                {
                    var before = Capture(source);
                    foreach (var file in before)
                    {
                        cancellation.ThrowIfCancellationRequested();
                        string inputPath = Path.Combine(source, file.Name), target = Path.Combine(work, file.Name); FoundryPaths.NoLinks(inputPath);
                        using (var input = new FileStream(inputPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 65536, true))
                        using (var output = new FileStream(target, FileMode.CreateNew, FileAccess.Write, FileShare.None, 65536, true))
                            await input.CopyToAsync(output, 65536, cancellation).ConfigureAwait(false);
                        if (new FileInfo(target).Length != file.Length || (file.Hash.Length > 0 && FoundryPaths.Hash(target) != file.Hash)) throw new IOException("Le scene sono cambiate durante la lettura.");
                    }
                    var after = Capture(source);
                    if (before.Count != after.Count || before.Where((file, i) => file.Name != after[i].Name || file.Length != after[i].Length || file.Time != after[i].Time || file.Hash != after[i].Hash).Any()) throw new IOException("Le scene sono cambiate durante la lettura.");
                    Json.Save(Path.Combine(work, "khuzoe-snapshot.json"), new { Schema = 1, Kind = "KhuzoeSceneSnapshot", WorldId = worldId, CapturedAt = DateTime.UtcNow.ToString("o") });
                    return new SceneSnapshot(work, cacheRoot, worldId);
                }
                catch (IOException)
                {
                    FoundryPaths.RemoveWork(cacheRoot, work);
                    if (attempt == 2) throw new IOException("Non riesco a creare una copia stabile delle scene. Attendi la fine dei salvataggi di Foundry e premi Aggiorna.");
                }
                catch { FoundryPaths.RemoveWork(cacheRoot, work); throw; }
                await Task.Delay(180, cancellation).ConfigureAwait(false);
            }
            throw new IOException("Impossibile leggere le scene.");
        }
        public static string LocalAsset(string dataRoot, string input)
        {
            string decoded;
            try { decoded = Uri.UnescapeDataString(input ?? ""); } catch (UriFormatException) { throw new IOException("Percorso dell'immagine non valido."); }
            decoded = decoded.Replace('\\', '/');
            if (decoded.StartsWith("/") || decoded.Contains(':') || decoded.IndexOf('\0') >= 0) throw new IOException("L'immagine non è un percorso relativo ai dati Foundry.");
            var parts = decoded.Split('/');
            if (parts.Any(part => part.Length == 0 || part == "." || part == ".." || part.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0)) throw new IOException("Il percorso dell'immagine non è valido.");
            string root = FoundryPaths.Full(dataRoot), file = Path.GetFullPath(Path.Combine(root, decoded.Replace('/', Path.DirectorySeparatorChar)));
            if (!file.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new IOException("Immagine esterna ai dati Foundry.");
            FoundryPaths.NoLinks(file); return file;
        }
    }
    public sealed class SceneRepository
    {
        readonly AppStorage storage;
        readonly IToolProvider tools;
        readonly IProcessRunner runner;
        readonly string engine;
        public SceneRepository(AppStorage storage, IToolProvider tools, IProcessRunner runner)
        { this.storage = storage; this.tools = tools; this.runner = runner; engine = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "scene-reader"); }
        public static void VerifyEngine(string engine)
        {
            FoundryPaths.NoLinks(engine); string manifest = Path.Combine(engine, "integrity.json");
            if (!File.Exists(manifest)) throw new IOException("Manca il lettore scene. Estrai tutto il pacchetto dell'app, inclusa la cartella scene-reader.");
            var records = Json.Read<Dictionary<string, string>>(File.ReadAllText(manifest, Encoding.UTF8));
            if (!records.ContainsKey("reader.cjs") || !records.Keys.Any(key => key.EndsWith(".node", StringComparison.OrdinalIgnoreCase))) throw new IOException("Il lettore scene è incompleto.");
            foreach (var item in records)
            {
                string file = Path.GetFullPath(Path.Combine(engine, item.Key.Replace('/', Path.DirectorySeparatorChar)));
                if (!file.StartsWith(FoundryPaths.Full(engine) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new IOException("Manifesto del lettore non valido.");
                FoundryPaths.NoLinks(file);
                if (!File.Exists(file)) throw new IOException("Il lettore scene è incompleto. Estrai di nuovo il pacchetto dell'app.");
                ToolsInstaller.VerifyHash(file, item.Value);
            }
        }
        public async Task<SceneSnapshot> CaptureAsync(string root, string world, Action<string> progress, CancellationToken cancellation)
        {
            VerifyEngine(engine);
            await tools.EnsureAsync(progress, cancellation).ConfigureAwait(false);
            progress("Lettura della copia locale delle scene…");
            return await SceneFiles.SnapshotAsync(root, world, Path.Combine(storage.Root, "sc"), cancellation).ConfigureAwait(false);
        }
        async Task<T> ReadAsync<T>(SceneSnapshot snapshot, string id, CancellationToken cancellation)
        {
            var paths = await tools.EnsureAsync(message => { }, cancellation).ConfigureAwait(false);
            var args = new List<string> { Path.Combine(engine, "reader.cjs"), "--snapshot", snapshot.Directory };
            if (id != null) { if (!SceneFiles.ValidId(id)) throw new IOException("Identificatore scena non valido."); args.AddRange(new[] { "--scene", id }); }
            var result = await runner.RunAsync(paths.Node, args, TimeSpan.FromSeconds(90), cancellation, null).ConfigureAwait(false);
            return Json.Read<T>(result.Output);
        }
        public Task<SceneCatalog> CatalogAsync(SceneSnapshot snapshot, CancellationToken cancellation) { return ReadAsync<SceneCatalog>(snapshot, null, cancellation); }
        public Task<SceneDetail> DetailAsync(SceneSnapshot snapshot, string id, CancellationToken cancellation) { return ReadAsync<SceneDetail>(snapshot, id, cancellation); }
    }
}
