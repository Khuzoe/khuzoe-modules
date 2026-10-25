using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Management;
using System.Net;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace KhuzoeUpdater
{
    public sealed class Catalog
    {
        public int schemaVersion { get; set; }
        public string repository { get; set; }
        public List<Release> modules { get; set; }
    }
    public sealed class Release
    {
        public string id { get; set; }
        public string title { get; set; }
        public string version { get; set; }
        public string download { get; set; }
        public string manifest { get; set; }
        public string sha256 { get; set; }
        public long size { get; set; }
        public Dictionary<string, object> compatibility { get; set; }
        public Dictionary<string, object> relationships { get; set; }
    }
    public sealed class Installation
    {
        public string SelectedPath { get; set; }
        public string ModulesPath { get; set; }
        public string FoundryVersion { get; set; }
    }
    public sealed class ModuleStatus
    {
        public Release Release { get; set; }
        public string LocalVersion { get; set; }
        public string Status { get; set; }
        public string Detail { get; set; }
        public bool CanUpdate { get; set; }
        public string DirectoryPath { get; set; }
    }
    public sealed class Preferences
    {
        public string SelectedPath { get; set; }
        public string ModulesPath { get; set; }
    }
    public static class Json
    {
        public static T Read<T>(string text)
        {
            return new JavaScriptSerializer { MaxJsonLength = 8 * 1024 * 1024, RecursionLimit = 64 }.Deserialize<T>(text);
        }
        public static T FileRead<T>(string path) { return Read<T>(File.ReadAllText(path, Encoding.UTF8)); }
        public static string Write(object value) { return new JavaScriptSerializer().Serialize(value); }
        public static string Str(Dictionary<string, object> map, string key)
        {
            object value;
            return map != null && map.TryGetValue(key, out value) && value != null ? Convert.ToString(value) : null;
        }
        public static Dictionary<string, object> Map(Dictionary<string, object> map, string key)
        {
            object value;
            return map != null && map.TryGetValue(key, out value) ? value as Dictionary<string, object> : null;
        }
        public static IEnumerable<Dictionary<string, object>> Array(Dictionary<string, object> map, string key)
        {
            object value;
            if (map == null || !map.TryGetValue(key, out value)) return Enumerable.Empty<Dictionary<string, object>>();
            var values = value as System.Collections.IEnumerable;
            return values == null ? Enumerable.Empty<Dictionary<string, object>>() : values.Cast<object>().OfType<Dictionary<string, object>>();
        }
    }
    public static class Versioning
    {
        static string Numeric(string version)
        {
            if (version == null) return null;
            string value = version.Trim();
            return value.StartsWith("v", StringComparison.OrdinalIgnoreCase) ? value.Substring(1) : value;
        }
        public static bool Valid(string version)
        {
            string value = Numeric(version);
            return value != null && Regex.IsMatch(value, @"^\d+(\.\d+){0,3}$") && value.Split('.').All(p => { int n; return Int32.TryParse(p, out n); });
        }
        public static int Compare(string a, string b)
        {
            if (!Valid(a) || !Valid(b)) throw new InvalidDataException("Numero di versione non riconosciuto.");
            var left = Numeric(a).Split('.').Select(Int32.Parse).ToArray();
            var right = Numeric(b).Split('.').Select(Int32.Parse).ToArray();
            for (int i = 0; i < Math.Max(left.Length, right.Length); i++)
            {
                int result = (i < left.Length ? left[i] : 0).CompareTo(i < right.Length ? right[i] : 0);
                if (result != 0) return result;
            }
            return 0;
        }
        public static bool Compatible(string actual, Dictionary<string, object> rules)
        {
            string minimum = Json.Str(rules, "minimum"), maximum = Json.Str(rules, "maximum");
            if (String.IsNullOrWhiteSpace(actual)) return false;
            // A dependency with no version bounds only requires an installed module.
            if (minimum == null && maximum == null) return true;
            if (!Valid(actual)) return false;
            if (minimum != null && Compare(actual, minimum) < 0) return false;
            // Foundry's generation-only maximum 14 includes all builds 14.x.
            if (maximum != null)
            {
                string truncated = String.Join(".", Numeric(actual).Split('.').Take(Numeric(maximum).Split('.').Length));
                if (Compare(truncated, maximum) > 0) return false;
            }
            return true;
        }
    }
    public static class Paths
    {
        public static string Full(string path) { return Path.GetFullPath(path).TrimEnd(Path.DirectorySeparatorChar); }
        public static void NoLinks(string path)
        {
            string current = Path.GetFullPath(path);
            while (!String.IsNullOrEmpty(current))
            {
                if ((Directory.Exists(current) || File.Exists(current)) && (File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                    throw new IOException("Il percorso contiene un collegamento: scegliere una cartella locale reale.");
                string parent = Path.GetDirectoryName(current);
                if (parent == current) break;
                current = parent;
            }
        }
        public static string Child(string root, string relative)
        {
            if (String.IsNullOrEmpty(relative) || Path.IsPathRooted(relative) || relative.Contains(":"))
                throw new InvalidDataException("Percorso del pacchetto non valido.");
            string normalized = relative.Replace('/', Path.DirectorySeparatorChar).Replace('\\', Path.DirectorySeparatorChar);
            if (normalized.Split(Path.DirectorySeparatorChar).Any(p => p == ".." || p == "." || p.TrimEnd(' ', '.') != p))
                throw new InvalidDataException("Percorso del pacchetto non valido.");
            string fullRoot = Full(root) + Path.DirectorySeparatorChar;
            string full = Path.GetFullPath(Path.Combine(fullRoot, normalized));
            if (!full.StartsWith(fullRoot, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("File fuori dal modulo.");
            NoLinks(full);
            return full;
        }
        public static List<Installation> Find(string selected)
        {
            selected = Full(selected);
            NoLinks(selected);
            var guesses = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            if (Path.GetFileName(selected).Equals("modules", StringComparison.OrdinalIgnoreCase)) guesses.Add(selected);
            guesses.Add(Path.Combine(selected, "modules"));
            guesses.Add(Path.Combine(selected, "Data", "modules"));
            guesses.Add(Path.Combine(selected, "Data", "Data", "modules"));
            string defaultData = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "FoundryVTT");
            bool appFolder = File.Exists(Path.Combine(selected, "resources", "app", "package.json")) || File.Exists(Path.Combine(selected, "App", "resources", "app", "package.json"));
            var configRoots = new List<string> { selected, Path.Combine(selected, "Data") };
            if (appFolder) { guesses.Add(Path.Combine(defaultData, "Data", "modules")); configRoots.Add(defaultData); }
            foreach (string baseDir in configRoots)
            {
                string options = Path.Combine(baseDir, "Config", "options.json");
                if (!File.Exists(options)) continue;
                try
                {
                    string dataPath = Json.Str(Json.FileRead<Dictionary<string, object>>(options), "dataPath");
                    if (!String.IsNullOrWhiteSpace(dataPath) && Path.IsPathRooted(dataPath))
                        guesses.Add(Path.Combine(dataPath, "Data", "modules"));
                }
                catch (ArgumentException) { }
            }
            var found = new List<Installation>();
            foreach (string guess in guesses)
            {
                if (!Directory.Exists(guess)) continue;
                NoLinks(guess);
                if (!Directory.GetDirectories(guess).Any(d => File.Exists(Path.Combine(d, "module.json")))) continue;
                found.Add(new Installation { SelectedPath = selected, ModulesPath = Full(guess), FoundryVersion = DetectVersion(selected, guess) });
            }
            return found.OrderBy(f => f.ModulesPath, StringComparer.OrdinalIgnoreCase).ToList();
        }
        public static string DetectVersion(string selected, string modules)
        {
            var roots = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { selected };
            string current = modules;
            for (int i = 0; i < 5 && current != null; i++, current = Path.GetDirectoryName(current)) roots.Add(current);
            foreach (string root in roots)
                foreach (string relative in new[] { "App/resources/app/package.json", "resources/app/package.json" })
                {
                    string path = Path.Combine(root, relative.Replace('/', Path.DirectorySeparatorChar));
                    if (!File.Exists(path)) continue;
                    try
                    {
                        var manifest = Json.FileRead<Dictionary<string, object>>(path);
                        if (Json.Str(manifest, "name") != "foundryvtt") continue;
                        var release = Json.Map(manifest, "release");
                        string generation = Json.Str(release, "generation"), build = Json.Str(release, "build");
                        if (generation != null && build != null) return generation + "." + build;
                    }
                    catch (Exception ex) { if (!(ex is IOException || ex is ArgumentException)) throw; }
                }
            return null;
        }
    }
    public static class Settings
    {
        public static string FilePath { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "KhuzoeUpdater", "settings.json"); } }
        public static Preferences Load()
        {
            try { return File.Exists(FilePath) ? Json.FileRead<Preferences>(FilePath) : new Preferences(); }
            catch (Exception) { return new Preferences(); }
        }
        public static void Save(Preferences value, string path = null)
        {
            path = path ?? FilePath;
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            string temp = path + ".tmp";
            File.WriteAllText(temp, Json.Write(value), new UTF8Encoding(false));
            if (File.Exists(path)) File.Replace(temp, path, null); else File.Move(temp, path);
        }
    }
    public static class Network
    {
        public static HttpClient Client()
        {
            ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
            var handler = new HttpClientHandler { AllowAutoRedirect = false, AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate };
            var client = new HttpClient(handler) { Timeout = TimeSpan.FromMinutes(5) };
            client.DefaultRequestHeaders.UserAgent.ParseAdd("KhuzoeUpdater/" + BuildConfig.Version);
            return client;
        }
        public static async Task<HttpResponseMessage> Get(HttpClient client, string address)
        {
            var uri = new Uri(address);
            for (int i = 0; i < 8; i++)
            {
                if (uri.Scheme != "https") throw new InvalidDataException("Il download deve usare HTTPS.");
                var response = await client.GetAsync(uri, HttpCompletionOption.ResponseHeadersRead).ConfigureAwait(false);
                int status = (int)response.StatusCode;
                if (status >= 300 && status < 400 && response.Headers.Location != null)
                {
                    var next = new Uri(uri, response.Headers.Location);
                    response.Dispose();
                    uri = next;
                    continue;
                }
                return response;
            }
            throw new IOException("Troppi reindirizzamenti durante il download.");
        }
        public static async Task<Catalog> Catalog()
        {
            using (var client = Client())
            using (var response = await Get(client, BuildConfig.CatalogUrl).ConfigureAwait(false))
            {
                if (response.StatusCode == HttpStatusCode.NotFound)
                    throw new IOException("Il catalogo non è ancora pubblicato su GitHub. Consulta CONFIGURAZIONE-GITHUB.md nel progetto.");
                response.EnsureSuccessStatusCode();
                if (response.Content.Headers.ContentLength > 2 * 1024 * 1024) throw new InvalidDataException("Catalogo troppo grande.");
                var text = await response.Content.ReadAsStringAsync().ConfigureAwait(false);
                if (text.Length > 2 * 1024 * 1024) throw new InvalidDataException("Catalogo troppo grande.");
                var catalog = Json.Read<Catalog>(text);
                Validate(catalog);
                return catalog;
            }
        }
        public static void Validate(Catalog catalog)
        {
            var allowed = new HashSet<string>(BuildConfig.ModuleIds, StringComparer.Ordinal);
            var seen = new HashSet<string>(StringComparer.Ordinal);
            var baseUri = new Uri(BuildConfig.CatalogUrl);
            string owner = baseUri.Host.Split('.')[0];
            string repo = baseUri.AbsolutePath.Trim('/').Split('/')[0];
            if (catalog == null || catalog.schemaVersion != 1 || catalog.modules == null ||
                !String.Equals(catalog.repository, owner + "/" + repo, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("Catalogo Khuzoe non valido.");
            foreach (var module in catalog.modules)
            {
                if (!allowed.Contains(module.id) || !seen.Add(module.id) || !Versioning.Valid(module.version) ||
                    module.sha256 == null || !Regex.IsMatch(module.sha256, "^[a-fA-F0-9]{64}$") || module.size <= 0 || module.size > 512L * 1024 * 1024)
                    throw new InvalidDataException("Voce del catalogo non valida.");
                Uri download;
                if (!Uri.TryCreate(module.download, UriKind.Absolute, out download) || download.Scheme != "https" ||
                    !download.Host.Equals("github.com", StringComparison.OrdinalIgnoreCase) ||
                    !download.AbsolutePath.StartsWith("/" + catalog.repository + "/releases/download/", StringComparison.OrdinalIgnoreCase))
                    throw new InvalidDataException("Il pacchetto non appartiene al repository Khuzoe configurato.");
            }
        }
        public static async Task Download(Release release, string destination)
        {
            using (var client = Client())
            using (var response = await Get(client, release.download).ConfigureAwait(false))
            {
                response.EnsureSuccessStatusCode();
                using (var input = await response.Content.ReadAsStreamAsync().ConfigureAwait(false))
                using (var output = new FileStream(destination, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                {
                    byte[] buffer = new byte[81920];
                    int read;
                    long total = 0;
                    while ((read = await input.ReadAsync(buffer, 0, buffer.Length).ConfigureAwait(false)) > 0)
                    {
                        total += read;
                        if (total > release.size) throw new InvalidDataException("Dimensione del download diversa dal catalogo.");
                        await output.WriteAsync(buffer, 0, read).ConfigureAwait(false);
                    }
                    if (total != release.size) throw new InvalidDataException("Download incompleto.");
                }
            }
            if (!String.Equals(Hash(destination), release.sha256, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("Il download non supera il controllo di integrità.");
        }
        public static string Hash(string path)
        {
            using (var hash = SHA256.Create())
            using (var stream = File.OpenRead(path))
                return BitConverter.ToString(hash.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
        }
    }
    public static class Planner
    {
        public static List<ModuleStatus> Scan(Installation install, Catalog catalog)
        {
            var rows = new List<ModuleStatus>();
            foreach (var release in catalog.modules)
            {
                string path = Paths.Child(install.ModulesPath, release.id);
                if (!Directory.Exists(path)) continue;
                var row = new ModuleStatus { Release = release, DirectoryPath = path, Status = "Errore" };
                try
                {
                    var local = Json.FileRead<Dictionary<string, object>>(Path.Combine(path, "module.json"));
                    if (Json.Str(local, "id") != release.id) throw new InvalidDataException("Identificatore locale diverso dal modulo previsto.");
                    row.LocalVersion = Json.Str(local, "version");
                    int comparison = Versioning.Compare(row.LocalVersion, release.version);
                    row.Status = "Aggiornato";
                    if (comparison > 0) row.Detail = "Versione locale più recente: viene mantenuta.";
                    else if (comparison < 0)
                    {
                        row.Detail = File.Exists(Path.Combine(path, release.id + ".lock")) ? "Modulo bloccato in Foundry. Sbloccalo prima di aggiornare." : CompatibilityError(install, release);
                        row.CanUpdate = row.Detail == null;
                        row.Status = row.CanUpdate ? "Da aggiornare" : "Errore";
                    }
                }
                catch (Exception ex) { row.Detail = ex.Message; }
                rows.Add(row);
            }
            // Check dependencies against the complete proposed set, including coordinated updates.
            bool changed;
            do
            {
                changed = false;
                foreach (var row in rows.Where(r => r.CanUpdate))
                {
                    string error;
                    try { error = DependencyError(install, row.Release, rows); }
                    catch (Exception ex) { error = "Impossibile verificare le dipendenze: " + ex.Message; }
                    if (error == null) continue;
                    row.CanUpdate = false; row.Status = "Errore"; row.Detail = error; changed = true;
                }
            } while (changed);
            return rows;
        }
        static string CompatibilityError(Installation install, Release release)
        {
            if (String.IsNullOrEmpty(install.FoundryVersion))
                return "Versione Foundry non individuata. Scegli la cartella principale contenente l'app.";
            if (!Versioning.Compatible(install.FoundryVersion, release.compatibility))
                return "Aggiornamento non compatibile con Foundry " + install.FoundryVersion + ".";
            var systems = Json.Array(release.relationships, "systems").ToList();
            if (systems.Count > 0)
            {
                string systemsRoot = Path.Combine(Path.GetDirectoryName(install.ModulesPath), "systems");
                bool compatible = systems.Any(system =>
                {
                    string id = Json.Str(system, "id");
                    if (id == null || !Regex.IsMatch(id, "^[a-zA-Z0-9_-]+$")) return false;
                    string file = Path.Combine(systemsRoot, id, "system.json");
                    return File.Exists(file) && Versioning.Compatible(Json.Str(Json.FileRead<Dictionary<string, object>>(file), "version"), Json.Map(system, "compatibility"));
                });
                if (!compatible) return "Manca una versione compatibile del sistema di gioco richiesto.";
            }
            return null;
        }
        static string DependencyError(Installation install, Release release, List<ModuleStatus> plan)
        {
            foreach (var requirement in Json.Array(release.relationships, "requires"))
            {
                string type = Json.Str(requirement, "type") ?? "module";
                if (type != "module") return "Dipendenza da verificare manualmente: " + Json.Str(requirement, "id");
                string id = Json.Str(requirement, "id");
                if (id == null || !Regex.IsMatch(id, "^[a-zA-Z0-9_-]+$")) return "Dipendenza non valida.";
                var coordinated = plan.FirstOrDefault(r => r.Release.id == id && r.CanUpdate);
                string version = coordinated != null ? coordinated.Release.version : null;
                if (version == null)
                {
                    string path = Path.Combine(install.ModulesPath, id, "module.json");
                    if (!File.Exists(path)) return "Dipendenza mancante: " + id + ".";
                    version = Json.Str(Json.FileRead<Dictionary<string, object>>(path), "version");
                }
                var bounds = Json.Map(requirement, "compatibility");
                if (!Versioning.Compatible(version, bounds))
                {
                    var limits = new List<string>();
                    if (Json.Str(bounds, "minimum") != null) limits.Add("minimo " + Json.Str(bounds, "minimum"));
                    if (Json.Str(bounds, "maximum") != null) limits.Add("massimo " + Json.Str(bounds, "maximum"));
                    return "La dipendenza " + id + " (versione " + (version ?? "non indicata") + ") non soddisfa i requisiti" + (limits.Count > 0 ? ": " + String.Join(", ", limits) : "") + ".";
                }
            }
            return null;
        }
    }
    public static class RunningFoundry
    {
        public static void EnsureClosed()
        {
            foreach (var process in Process.GetProcesses())
            {
                using (process)
                {
                    string name;
                    try { name = process.ProcessName; } catch (InvalidOperationException) { continue; }
                    if (name.IndexOf("foundry", StringComparison.OrdinalIgnoreCase) >= 0)
                        throw new IOException("Chiudi completamente Foundry prima di aggiornare. La schermata iniziale conta come app aperta.");
                }
            }
            try
            {
                using (var search = new ManagementObjectSearcher("SELECT CommandLine FROM Win32_Process WHERE Name='node.exe'"))
                using (var results = search.Get())
                    foreach (ManagementObject process in results)
                    {
                        using (process)
                        {
                            string command = Convert.ToString(process["CommandLine"]);
                            if (String.IsNullOrWhiteSpace(command))
                                throw new IOException("Impossibile verificare un server Node attivo. Chiudilo prima di aggiornare.");
                            if (command.IndexOf("foundry", StringComparison.OrdinalIgnoreCase) >= 0)
                                throw new IOException("Un server Foundry è ancora attivo. Chiudilo prima di aggiornare.");
                        }
                    }
            }
            catch (ManagementException) { throw new IOException("Impossibile verificare se Foundry è chiuso. Riprova dopo aver chiuso l'app."); }
        }
    }
    public static class Installer
    {
        public static void Extract(string zip, string destination, Release release)
        {
            Directory.CreateDirectory(destination);
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            long total = 0;
            using (var archive = ZipFile.OpenRead(zip))
            {
                if (archive.Entries.Count > 20000) throw new InvalidDataException("Pacchetto con troppi file.");
                foreach (var entry in archive.Entries)
                {
                    if (entry.FullName.EndsWith("/", StringComparison.Ordinal)) continue;
                    string target = Paths.Child(destination, entry.FullName);
                    if (!seen.Add(target) || ((entry.ExternalAttributes >> 16) & 0xF000) == 0xA000)
                        throw new InvalidDataException("Il pacchetto contiene collegamenti o file duplicati.");
                    total += entry.Length;
                    if (total > 1024L * 1024 * 1024) throw new InvalidDataException("Pacchetto troppo grande dopo l'estrazione.");
                    Directory.CreateDirectory(Path.GetDirectoryName(target));
                    entry.ExtractToFile(target, false);
                }
            }
            var manifest = Json.FileRead<Dictionary<string, object>>(Path.Combine(destination, "module.json"));
            if (Json.Str(manifest, "id") != release.id || Json.Str(manifest, "version") != release.version)
                throw new InvalidDataException("Il contenuto dello ZIP non corrisponde al modulo richiesto.");
        }
        public static void Replace(string modulesRoot, string staged, ModuleStatus row)
        {
            string destination = Paths.Child(modulesRoot, row.Release.id);
            if (!Directory.Exists(destination)) throw new IOException("Il modulo non è più installato: aggiornamento annullato.");
            if (File.Exists(Path.Combine(destination, row.Release.id + ".lock"))) throw new IOException("Il modulo è stato bloccato in Foundry. Aggiorna l'elenco.");
            string existing = Json.Str(Json.FileRead<Dictionary<string, object>>(Path.Combine(destination, "module.json")), "version");
            if (existing != row.LocalVersion) throw new IOException("Il modulo è cambiato dopo il controllo. Aggiorna l'elenco.");
            // Temporary directory swap only; no version history or rollback UI.
            string previous = Paths.Child(modulesRoot, ".khuzoe-old-" + row.Release.id + "-" + Guid.NewGuid().ToString("N"));
            Directory.Move(destination, previous);
            try { Directory.Move(staged, destination); }
            catch
            {
                Directory.Move(previous, destination);
                throw;
            }
            try { Directory.Delete(previous, true); }
            catch (IOException) { /* Installed successfully; leave the temporary old copy if Windows holds it. */ }
            catch (UnauthorizedAccessException) { }
        }
        public static async Task Apply(Installation install, List<ModuleStatus> rows, Action<string> progress)
        {
            RunningFoundry.EnsureClosed();
            Paths.NoLinks(install.ModulesPath);
            string work = Paths.Child(install.ModulesPath, ".khuzoe-update-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(work);
            try
            {
                var plan = rows.Where(r => r.CanUpdate).ToList();
                foreach (var row in plan)
                {
                    progress("Scaricamento: " + row.Release.title);
                    string zip = Paths.Child(work, row.Release.id + ".zip");
                    await Network.Download(row.Release, zip).ConfigureAwait(false);
                    string unpacked = Paths.Child(work, row.Release.id);
                    Extract(zip, unpacked, row.Release);
                }
                // All packages must be valid before the first installed module is changed.
                RunningFoundry.EnsureClosed();
                foreach (var row in plan)
                {
                    RunningFoundry.EnsureClosed();
                    progress("Installazione: " + row.Release.title);
                    Replace(install.ModulesPath, Paths.Child(work, row.Release.id), row);
                    row.LocalVersion = row.Release.version;
                    row.CanUpdate = false;
                    row.Status = "Aggiornato";
                }
            }
            finally
            {
                try { if (Directory.Exists(work)) Directory.Delete(work, true); }
                catch (IOException) { }
                catch (UnauthorizedAccessException) { }
            }
        }
    }
}
