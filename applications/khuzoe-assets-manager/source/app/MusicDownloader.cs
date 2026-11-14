using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace KhuzoeAssetsManager
{
    public sealed class ProcessResult { public string Output; public string Error; }
    public interface IProcessRunner
    {
        Task<ProcessResult> RunAsync(string executable, IList<string> arguments, TimeSpan timeout, CancellationToken cancellation, Action<string> line);
    }
    public sealed class ProcessRunner : IProcessRunner
    {
        public static string Quote(string value)
        {
            var result = new StringBuilder("\""); int slashes = 0;
            foreach (char c in value)
            {
                if (c == '\\') { slashes++; continue; }
                if (c == '"') result.Append('\\', slashes * 2 + 1).Append(c);
                else result.Append('\\', slashes).Append(c);
                slashes = 0;
            }
            return result.Append('\\', slashes * 2).Append('"').ToString();
        }
        public Task<ProcessResult> RunAsync(string executable, IList<string> arguments, TimeSpan timeout, CancellationToken cancellation, Action<string> line)
        {
            return Task.Run(() =>
            {
                cancellation.ThrowIfCancellationRequested();
                using (var process = new Process())
                using (var job = new ProcessJob())
                {
                    process.StartInfo = new ProcessStartInfo {
                        FileName = executable, Arguments = String.Join(" ", arguments.Select(Quote)),
                        UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden,
                        RedirectStandardOutput = true, RedirectStandardError = true,
                        StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
                    };
                    var output = new StringBuilder(); var error = new StringBuilder(); object gate = new object(); bool tooLarge = false;
                    process.OutputDataReceived += (sender, args) => {
                        if (args.Data == null) return;
                        lock (gate) { if (output.Length < 6 * 1024 * 1024) output.AppendLine(args.Data); else tooLarge = true; }
                        if (tooLarge) job.Terminate(process); else if (line != null) line(args.Data);
                    };
                    process.ErrorDataReceived += (sender, args) => {
                        if (args.Data == null) return;
                        lock (gate) { error.AppendLine(args.Data); if (error.Length > 12000) error.Remove(0, error.Length - 12000); }
                        if (line != null) line(args.Data);
                    };
                    process.Start(); job.Attach(process); process.BeginOutputReadLine(); process.BeginErrorReadLine();
                    using (cancellation.Register(() => job.Terminate(process)))
                    {
                        if (!process.WaitForExit((int)Math.Min(Int32.MaxValue, timeout.TotalMilliseconds)))
                        { job.Terminate(process); throw new IOException("Tempo massimo superato. Riprova o scegli un video più breve."); }
                        process.WaitForExit(); cancellation.ThrowIfCancellationRequested();
                        if (tooLarge) throw new IOException("Il downloader ha restituito una risposta troppo grande.");
                        if (process.ExitCode != 0) throw new IOException(FriendlyError(error.ToString()));
                        return new ProcessResult { Output = output.ToString(), Error = error.ToString() };
                    }
                }
            }, cancellation);
        }
        public static string FriendlyError(string error)
        {
            if (error.IndexOf("Sign in", StringComparison.OrdinalIgnoreCase) >= 0 || error.IndexOf("bot", StringComparison.OrdinalIgnoreCase) >= 0)
                return "YouTube richiede una verifica per questo video o per questa connessione. Riprova più tardi o scegli un altro video.";
            if (error.IndexOf("Private video", StringComparison.OrdinalIgnoreCase) >= 0 || error.IndexOf("Video unavailable", StringComparison.OrdinalIgnoreCase) >= 0)
                return "Il video non è disponibile o è privato.";
            if (error.IndexOf("No space left", StringComparison.OrdinalIgnoreCase) >= 0) return "Lo spazio disponibile sul disco non è sufficiente.";
            string[] lines = error.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
            string text = String.Join("\n", lines.Skip(Math.Max(0, lines.Length - 4)));
            return String.IsNullOrWhiteSpace(text) ? "Il download non è riuscito. Puoi aggiornare gli strumenti e riprovare." : text;
        }
    }
    public sealed class VideoMetadata
    {
        public string VideoId;
        public string Title;
        public string Author;
        public double Duration;
        public string DurationText { get { return TimeSpan.FromSeconds(Duration).ToString(Duration >= 3600 ? @"h\:mm\:ss" : @"m\:ss"); } }
    }
    public sealed class DownloadItem
    {
        public string Id { get; set; }
        public string Url { get; set; }
        public string VideoId { get; set; }
        public string Name { get; set; }
        public string Category { get; set; }
        public string DataRoot { get; set; }
        public string Directory { get; set; }
        public int Quality { get; set; }
        public string Status { get; set; }
        public string Message { get; set; }
        public DateTime CreatedAt { get; set; }
        public string DisplayTitle { get { return String.IsNullOrWhiteSpace(Name) ? VideoId : Name; } }
        public DownloadItem() { Id = Guid.NewGuid().ToString("N"); Status = "In coda"; CreatedAt = DateTime.UtcNow; }
    }
    public sealed class JobProgress
    {
        public string Stage;
        public string Message;
        public int Percent;
        public bool Indeterminate;
    }
    public sealed class DownloadResult { public TrackRecord Track; public bool Reused; public string Warning; }
    public sealed class MusicDownloader
    {
        readonly AppStorage storage;
        readonly MusicLibrary library;
        readonly IToolProvider toolProvider;
        readonly IProcessRunner runner;
        public MusicDownloader(AppStorage storage, MusicLibrary library, IToolProvider tools, IProcessRunner runner)
        { this.storage = storage; this.library = library; toolProvider = tools; this.runner = runner; }
        static List<string> Common(ToolPaths tools)
        {
            return new List<string> { "--ignore-config", "--no-playlist", "--no-colors", "--socket-timeout", "20", "--retries", "2", "--fragment-retries", "2", "--js-runtimes", "node:" + tools.Node };
        }
        static VideoMetadata ParseMetadata(string json, string id)
        {
            var data = Json.Read<Dictionary<string, object>>(json);
            if (Json.Str(data, "id") != id) throw new IOException("Il video ricevuto non corrisponde al link richiesto.");
            if (Json.Str(data, "is_live").Equals("True", StringComparison.OrdinalIgnoreCase) || Json.Str(data, "live_status") == "is_live") throw new IOException("Le dirette in corso non sono supportate.");
            double duration = Json.Number(data, "duration");
            if (duration > 43200) throw new IOException("Scegli un video di durata inferiore a 12 ore.");
            return new VideoMetadata { VideoId = id, Title = Json.Str(data, "title"), Author = Json.Str(data, "uploader"), Duration = Math.Max(0, duration) };
        }
        async Task<VideoMetadata> MetadataAsync(VideoLink video, ToolPaths tools, CancellationToken cancellation)
        {
            var args = Common(tools); args.AddRange(new[] { "--skip-download", "--dump-single-json", "--", video.Url });
            var result = await runner.RunAsync(tools.Downloader, args, TimeSpan.FromSeconds(90), cancellation, null);
            return ParseMetadata(result.Output, video.Id);
        }
        public async Task<VideoMetadata> AnalyzeAsync(string input, Action<string> progress, CancellationToken cancellation)
        {
            var video = VideoLink.Parse(input);
            var tools = await toolProvider.EnsureAsync(progress, cancellation);
            progress("Lettura del titolo e della durata…");
            return await MetadataAsync(video, tools, cancellation);
        }
        async Task<double> ProbeAsync(string file, ToolPaths tools, CancellationToken cancellation)
        {
            FoundryPaths.NoLinks(file);
            if (!File.Exists(file) || new FileInfo(file).Length == 0) throw new IOException("La conversione non ha prodotto un file audio.");
            var result = await runner.RunAsync(tools.Ffprobe, new[] { "-v", "error", "-show_entries", "format=duration:stream=codec_name", "-of", "json", file }, TimeSpan.FromSeconds(30), cancellation, null);
            var data = Json.Read<Dictionary<string, object>>(result.Output);
            double duration = Json.Number(Json.Map(data, "format"), "duration");
            if (duration <= 0 || !Json.Array(data, "streams").Any(stream => Json.Str(stream, "codec_name") == "mp3")) throw new IOException("Il file ottenuto non è un MP3 riproducibile.");
            return duration;
        }
        public async Task<DownloadResult> DownloadAsync(DownloadItem item, IProgress<JobProgress> progress, CancellationToken cancellation)
        {
            var video = VideoLink.Parse(item.Url);
            if (video.Id != item.VideoId) throw new IOException("Il link nella coda non è valido.");
            if (!new[] { 128, 192, 256, 320 }.Contains(item.Quality)) throw new IOException("Qualità MP3 non valida.");
            FoundryPaths.MusicDirectory(item.DataRoot, item.Directory, false);
            Action<string> preparation = message => progress.Report(new JobProgress { Stage = "Preparazione", Message = message, Indeterminate = true });
            var tools = await toolProvider.EnsureAsync(preparation, cancellation);
            var previous = library.Find(video.Id, item.DataRoot, item.Directory);
            if (previous != null)
            {
                string existing = FoundryPaths.TrackFile(item.DataRoot, previous);
                if (File.Exists(existing) && FoundryPaths.Hash(existing) == previous.Sha256)
                {
                    await ProbeAsync(existing, tools, cancellation);
                    progress.Report(new JobProgress { Stage = "Già presente", Message = "Il brano è già stato scaricato in questa cartella.", Percent = 100 });
                    return new DownloadResult { Track = previous, Reused = true };
                }
            }
            preparation("Lettura del video…");
            var metadata = await MetadataAsync(video, tools, cancellation);
            string title = String.IsNullOrWhiteSpace(item.Name) ? metadata.Title : item.Name;
            string work = Path.Combine(storage.WorkRoot, Guid.NewGuid().ToString("N"));
            FoundryPaths.NoLinks(work); Directory.CreateDirectory(work); FoundryPaths.NoLinks(work);
            try
            {
                var args = Common(tools);
                args.AddRange(new[] { "--newline", "--progress", "--format", "bestaudio/best", "--extract-audio", "--audio-format", "mp3", "--audio-quality", item.Quality + "K", "--ffmpeg-location", Path.GetDirectoryName(tools.Ffmpeg),
                    "--max-filesize", "500M", "--match-filter", "!is_live & duration <= 43200", "--no-keep-video", "--add-metadata",
                    "--progress-template", "download:KHUZOE_PROGRESS:%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s", "--output", Path.Combine(work, "audio.%(ext)s"), "--", video.Url });
                progress.Report(new JobProgress { Stage = "Download", Message = title, Percent = 0 });
                await runner.RunAsync(tools.Downloader, args, TimeSpan.FromHours(2), cancellation, line => {
                    var match = Regex.Match(line, "^KHUZOE_PROGRESS:\\s*([0-9.]+)%\\|(.*?)\\|(.*)$");
                    if (match.Success)
                    {
                        double value; Double.TryParse(match.Groups[1].Value, NumberStyles.Float, CultureInfo.InvariantCulture, out value);
                        progress.Report(new JobProgress { Stage = "Download", Message = title + " · " + match.Groups[2].Value.Trim() + " · " + match.Groups[3].Value.Trim(), Percent = Math.Min(99, Math.Max(0, (int)value)) });
                    }
                    else if (line.Contains("[ExtractAudio]") || line.Contains("[Metadata]")) progress.Report(new JobProgress { Stage = "Conversione", Message = "Preparazione dell’MP3 · " + title, Indeterminate = true });
                });
                string audio = Path.Combine(work, "audio.mp3");
                double duration = await ProbeAsync(audio, tools, cancellation);
                cancellation.ThrowIfCancellationRequested();
                string directory = FoundryPaths.MusicDirectory(item.DataRoot, item.Directory, true);
                string filename = FoundryPaths.SafeName(title);
                int available = 240 - directory.Length - 18;
                if (available < 8) throw new IOException("Il percorso è troppo lungo. Scegli una cartella più breve.");
                if (filename.Length > available) filename = filename.Substring(0, available).TrimEnd(' ', '.');
                filename += "--" + video.Id + ".mp3";
                string destination = Path.Combine(directory, filename); FoundryPaths.NoLinks(destination);
                if (File.Exists(destination)) throw new IOException("Esiste già un file con questo nome. Cambia il nome del brano per conservarli entrambi.");
                var track = new TrackRecord { VideoId = video.Id, Url = video.Url, Title = title, Author = metadata.Author, Category = item.Category,
                    DataRoot = FoundryPaths.Full(item.DataRoot), Directory = item.Directory.Replace('\\', '/').TrimEnd('/'), Filename = filename,
                    Quality = item.Quality, Duration = duration, AddedAt = DateTime.UtcNow, Bytes = new FileInfo(audio).Length, Sha256 = FoundryPaths.Hash(audio) };
                // Stage on the destination drive, then publish with an exclusive atomic move.
                // A disk error or cancellation must never expose a partial .mp3 to Foundry.
                string pending = Path.Combine(directory, ".khuzoe-" + Guid.NewGuid().ToString("N") + ".tmp");
                try
                {
                    File.Copy(audio, pending, false);
                    ToolsInstaller.VerifyHash(pending, track.Sha256);
                    cancellation.ThrowIfCancellationRequested();
                    FoundryPaths.NoLinks(directory);
                    File.Move(pending, destination);
                }
                finally { if (File.Exists(pending)) File.Delete(pending); }
                var result = new DownloadResult { Track = track };
                try { library.Add(track); }
                catch (IOException) { result.Warning = "MP3 salvato, ma non è stato possibile aggiornare la raccolta dell’app. Il file è disponibile nella cartella selezionata."; }
                catch (UnauthorizedAccessException) { result.Warning = "MP3 salvato, ma non è stato possibile aggiornare la raccolta dell’app. Il file è disponibile nella cartella selezionata."; }
                progress.Report(new JobProgress { Stage = "Completato", Message = "Salvato in " + track.RelativePath, Percent = 100 });
                return result;
            }
            finally { FoundryPaths.RemoveWork(storage.WorkRoot, work); }
        }
    }
}
