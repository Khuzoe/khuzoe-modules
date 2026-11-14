using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

namespace KhuzoeAssetsManager
{
    public static class Json
    {
        public static T Read<T>(string text) { return new JavaScriptSerializer { MaxJsonLength = 8 * 1024 * 1024, RecursionLimit = 64 }.Deserialize<T>(text); }
        public static string Write(object value) { return new JavaScriptSerializer { MaxJsonLength = 16 * 1024 * 1024 }.Serialize(value); }
        public static string Str(Dictionary<string, object> value, string key) { object result; return value != null && value.TryGetValue(key, out result) && result != null ? Convert.ToString(result, CultureInfo.InvariantCulture) : ""; }
        public static Dictionary<string, object> Map(Dictionary<string, object> value, string key) { object result; return value != null && value.TryGetValue(key, out result) ? result as Dictionary<string, object> : null; }
        public static double Number(Dictionary<string, object> value, string key) { double number; return Double.TryParse(Str(value, key), NumberStyles.Float, CultureInfo.InvariantCulture, out number) && !Double.IsNaN(number) && !Double.IsInfinity(number) ? number : 0; }
        public static IEnumerable<Dictionary<string, object>> Array(Dictionary<string, object> value, string key)
        {
            object result; if (value == null || !value.TryGetValue(key, out result)) return Enumerable.Empty<Dictionary<string, object>>();
            var list = result as System.Collections.IEnumerable;
            return list == null ? Enumerable.Empty<Dictionary<string, object>>() : list.Cast<object>().OfType<Dictionary<string, object>>();
        }
        public static void Save(string filename, object value)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(filename));
            string temporary = filename + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try
            {
                File.WriteAllText(temporary, Write(value), new UTF8Encoding(false));
                if (File.Exists(filename)) File.Replace(temporary, filename, null);
                else File.Move(temporary, filename);
            }
            finally { if (File.Exists(temporary)) File.Delete(temporary); }
        }
    }

    public static class StartupOptions
    {
        public static void Apply(AppStorage storage, string[] args)
        {
            int index = System.Array.IndexOf(args, "--foundry-data");
            if (index < 0) return;
            if (index + 1 >= args.Length || !FoundryPaths.IsDataRoot(args[index + 1])) throw new IOException("La cartella Foundry indicata dall'Updater non è valida.");
            string data = FoundryPaths.Full(args[index + 1]); FoundryPaths.NoLinks(data);
            var preferences = storage.LoadPreferences(); preferences.DataRoot = data; preferences.SelectedPath = data;
            storage.SavePreferences(preferences);
        }
    }
    public sealed class Preferences
    {
        public string SelectedPath { get; set; }
        public string DataRoot { get; set; }
        public string Category { get; set; }
        public int Quality { get; set; }
        public Dictionary<string, string> CategoryFolders { get; set; }
        public string LastWorldId { get; set; }
        public string ActiveTab { get; set; }
        public SceneViewSettings SceneView { get; set; }
        public Preferences() { Category = "Combattimento"; Quality = 192; ActiveTab = "music"; SceneView = new SceneViewSettings(); CategoryFolders = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase); }
    }
    public sealed class AppStorage
    {
        public string Root { get; private set; }
        public string ToolRoot { get { return Path.Combine(Root, "tools"); } }
        public string WorkRoot { get { return Path.Combine(Root, "work"); } }
        public AppStorage(string root) { Root = Path.GetFullPath(root); FoundryPaths.NoLinks(Root); Directory.CreateDirectory(Root); FoundryPaths.NoLinks(Root); }
        public Preferences LoadPreferences()
        {
            string file = Path.Combine(Root, "settings.json");
            if (!File.Exists(file)) return new Preferences();
            var value = Json.Read<Preferences>(File.ReadAllText(file, Encoding.UTF8)) ?? new Preferences();
            value.CategoryFolders = new Dictionary<string, string>(value.CategoryFolders ?? new Dictionary<string, string>(), StringComparer.OrdinalIgnoreCase);
            if (!new[] { 128, 192, 256, 320 }.Contains(value.Quality)) value.Quality = 192;
            if (value.SceneView == null) value.SceneView = new SceneViewSettings();
            return value;
        }
        public void SavePreferences(Preferences value) { Json.Save(Path.Combine(Root, "settings.json"), value); }
        public void ClearSession() { string file = Path.Combine(Root, "session.bin"); if (File.Exists(file)) File.Delete(file); }
        static readonly byte[] Entropy = Encoding.UTF8.GetBytes("Khuzoe.AssetsManager.Session.v1");
        public void SaveSession(string token)
        {
            byte[] encrypted = ProtectedData.Protect(Encoding.UTF8.GetBytes(token), Entropy, DataProtectionScope.CurrentUser);
            string file = Path.Combine(Root, "session.bin"), temporary = file + ".tmp";
            File.WriteAllBytes(temporary, encrypted);
            if (File.Exists(file)) File.Replace(temporary, file, null); else File.Move(temporary, file);
        }
        public string LoadSession()
        {
            try { return Encoding.UTF8.GetString(ProtectedData.Unprotect(File.ReadAllBytes(Path.Combine(Root, "session.bin")), Entropy, DataProtectionScope.CurrentUser)); }
            catch (IOException) { return ""; } catch (CryptographicException) { return ""; }
        }
    }

    public static class FoundryPaths
    {
        public static string Full(string value) { return Path.GetFullPath(value).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar); }
        public static void NoLinks(string filename)
        {
            string current = Path.GetFullPath(filename);
            while (!String.IsNullOrEmpty(current))
            {
                if ((File.Exists(current) || Directory.Exists(current)) && (File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                    throw new IOException("Il percorso contiene un collegamento o una cartella reindirizzata. Scegli il percorso reale.");
                current = Path.GetDirectoryName(current);
            }
        }
        public static bool IsDataRoot(string folder)
        {
            return Directory.Exists(folder) && Directory.Exists(Path.Combine(folder, "modules"))
                && (Directory.Exists(Path.Combine(folder, "worlds")) || Directory.Exists(Path.Combine(folder, "systems")));
        }
        public static List<string> Find(string selected)
        {
            selected = Full(selected); NoLinks(selected);
            var candidates = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { selected, Path.Combine(selected, "Data"), Path.Combine(selected, "Data", "Data") };
            if (String.Equals(Path.GetFileName(selected), "modules", StringComparison.OrdinalIgnoreCase)) candidates.Add(Path.GetDirectoryName(selected));
            foreach (string folder in new[] { selected, Path.Combine(selected, "Data"), Path.GetDirectoryName(selected) })
            {
                if (String.IsNullOrEmpty(folder)) continue;
                string config = Path.Combine(folder, "Config", "options.json");
                if (!File.Exists(config)) continue;
                try
                {
                    string value = Json.Str(Json.Read<Dictionary<string, object>>(File.ReadAllText(config)), "dataPath");
                    if (!String.IsNullOrWhiteSpace(value)) { string root = Path.IsPathRooted(value) ? value : Path.Combine(folder, value); candidates.Add(root); candidates.Add(Path.Combine(root, "Data")); }
                }
                catch (ArgumentException) { } catch (IOException) { }
            }
            if (Directory.Exists(Path.Combine(selected, "resources", "app")) || Directory.Exists(Path.Combine(selected, "App", "resources", "app")))
                candidates.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "FoundryVTT", "Data"));
            return candidates.Where(IsDataRoot).Select(Full).Distinct(StringComparer.OrdinalIgnoreCase).Where(candidate => { NoLinks(candidate); return true; }).OrderBy(candidate => candidate).ToList();
        }
        public static string MusicDirectory(string root, string relative, bool create)
        {
            if (!IsDataRoot(root)) throw new IOException("La cartella dati Foundry non è disponibile. Sceglila di nuovo.");
            root = Full(root); NoLinks(root);
            string clean = (relative ?? "").Trim().Replace('\\', '/').TrimEnd('/');
            if (clean.Length > 180 || (clean != "musics" && !clean.StartsWith("musics/", StringComparison.Ordinal))) throw new IOException("Scegli una cartella relativa dentro musics/.");
            foreach (string part in clean.Split('/'))
                if (part.Length == 0 || part == "." || part == ".." || Regex.IsMatch(part, "[<>:\"|?*%\\x00-\\x1f]") || part.EndsWith(".") || part.EndsWith(" ") || Reserved(part))
                    throw new IOException("La cartella contiene un nome non valido o un percorso fuori dalle musiche.");
            string target = Full(Path.Combine(root, clean.Replace('/', Path.DirectorySeparatorChar)));
            if (!target.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new IOException("Cartella esterna ai dati Foundry.");
            if (target.Length > 210) throw new IOException("Il percorso è troppo lungo. Usa una cartella più breve.");
            NoLinks(target);
            if (create) { Directory.CreateDirectory(target); NoLinks(target); }
            return target;
        }
        public static bool Reserved(string value) { return Regex.IsMatch(value, "^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\\.|$)", RegexOptions.IgnoreCase); }
        public static string SafeName(string value)
        {
            string clean = Regex.Replace((value ?? "").Normalize(NormalizationForm.FormKC), "[<>:\"/\\\\|?*%#\\x00-\\x1f]", " ");
            clean = Regex.Replace(clean, "\\s+", " ").Trim(' ', '.');
            if (clean.Length > 85) clean = clean.Substring(0, 85).TrimEnd(' ', '.');
            if (clean.Length == 0) clean = "Audio";
            return Reserved(clean) ? "_" + clean : clean;
        }
        public static string CategoryDirectory(string category)
        {
            string text = SafeName(category).Normalize(NormalizationForm.FormD);
            text = new string(text.Where(c => CharUnicodeInfo.GetUnicodeCategory(c) != UnicodeCategory.NonSpacingMark).ToArray()).ToLowerInvariant();
            text = Regex.Replace(text, "[^\\p{L}\\p{N}]+", "-").Trim('-');
            return "musics/youtube/" + (text.Length == 0 ? "generale" : text);
        }
        public static string TrackFile(string root, TrackRecord track)
        {
            string folder = MusicDirectory(root, track.Directory, false);
            if (Path.GetFileName(track.Filename) != track.Filename || String.IsNullOrEmpty(track.Filename)) throw new IOException("Nome del file salvato non valido.");
            string file = Path.Combine(folder, track.Filename); NoLinks(file); return file;
        }
        public static string Hash(string file) { using (var hash = SHA256.Create()) using (var stream = File.OpenRead(file)) return BitConverter.ToString(hash.ComputeHash(stream)).Replace("-", "").ToLowerInvariant(); }
        public static void RemoveWork(string parent, string work)
        {
            if (!Full(work).StartsWith(Full(parent) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) || Path.GetDirectoryName(Full(work)) != Full(parent)) throw new IOException("Directory temporanea non valida.");
            NoLinks(work); if (Directory.Exists(work)) Directory.Delete(work, true);
        }
    }

    public sealed class VideoLink
    {
        public string Id { get; private set; }
        public string Url { get; private set; }
        public static VideoLink Parse(string input)
        {
            Uri url;
            if (!Uri.TryCreate((input ?? "").Trim(), UriKind.Absolute, out url) || url.Scheme != "https" || url.UserInfo.Length != 0 || !url.IsDefaultPort) throw new ArgumentException("Inserisci un link HTTPS a un video YouTube.");
            string id = "";
            if (url.Host == "youtu.be") id = url.AbsolutePath.Trim('/').Split('/')[0];
            else if (new[] { "youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com" }.Contains(url.Host))
            {
                if (url.AbsolutePath == "/watch")
                    foreach (string pair in url.Query.TrimStart('?').Split('&')) { var parts = pair.Split(new[] { '=' }, 2); if (parts[0] == "v" && parts.Length == 2) id = Uri.UnescapeDataString(parts[1]); }
                else { var match = Regex.Match(url.AbsolutePath, "^/(shorts|embed|live)/([a-zA-Z0-9_-]{11})(?:/|$)"); if (match.Success) id = match.Groups[2].Value; }
            }
            if (!Regex.IsMatch(id, "^[a-zA-Z0-9_-]{11}$")) throw new ArgumentException("Usa il link di un singolo video YouTube, non di un canale o una playlist.");
            return new VideoLink { Id = id, Url = "https://www.youtube.com/watch?v=" + id };
        }
    }

    public sealed class TrackRecord
    {
        public string VideoId { get; set; }
        public string Url { get; set; }
        public string Title { get; set; }
        public string Author { get; set; }
        public string Category { get; set; }
        public string DataRoot { get; set; }
        public string Directory { get; set; }
        public string Filename { get; set; }
        public string Sha256 { get; set; }
        public long Bytes { get; set; }
        public double Duration { get; set; }
        public int Quality { get; set; }
        public DateTime AddedAt { get; set; }
        public string RelativePath { get { return Directory + "/" + Filename; } }
        public string DurationText { get { var span = TimeSpan.FromSeconds(Duration); return Duration >= 3600 ? span.ToString(@"h\:mm\:ss") : span.ToString(@"m\:ss"); } }
    }
    public sealed class MusicLibrary
    {
        readonly string file;
        readonly object gate = new object();
        List<TrackRecord> tracks;
        public MusicLibrary(string storage)
        {
            file = Path.Combine(storage, "library.json");
            tracks = File.Exists(file) ? Json.Read<List<TrackRecord>>(File.ReadAllText(file, Encoding.UTF8)) ?? new List<TrackRecord>() : new List<TrackRecord>();
        }
        public List<TrackRecord> All() { lock (gate) return tracks.OrderByDescending(track => track.AddedAt).ToList(); }
        public TrackRecord Find(string id, string dataRoot, string directory)
        {
            lock (gate) return tracks.FirstOrDefault(track => track.VideoId == id && String.Equals(track.DataRoot, dataRoot, StringComparison.OrdinalIgnoreCase) && String.Equals(track.Directory, directory, StringComparison.OrdinalIgnoreCase));
        }
        public void Add(TrackRecord track)
        {
            lock (gate)
            {
                var next = tracks.Where(old => !(old.VideoId == track.VideoId && String.Equals(old.DataRoot, track.DataRoot, StringComparison.OrdinalIgnoreCase) && String.Equals(old.Directory, track.Directory, StringComparison.OrdinalIgnoreCase))).ToList();
                next.Add(track); Json.Save(file, next); tracks = next;
            }
        }
    }
}
