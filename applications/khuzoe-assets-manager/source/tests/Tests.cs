using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace KhuzoeAssetsManager
{
    internal static partial class Tests
    {
        static int passed, failed;
        static string root;
        const string VideoId = "BaW_jenozKc";
        [STAThread]
        static int Main(string[] args)
        {
            Console.OutputEncoding = new UTF8Encoding(false);
            if (args.Length > 0 && args[0] == "--echo-args") { Console.WriteLine(Json.Write(args.Skip(1).ToArray())); return 0; }
            if (args.Length > 0 && args[0] == "--sleep") { Thread.Sleep(30000); return 0; }
            if (args.Length == 2 && args[0] == "--delayed-marker") { Thread.Sleep(1400); File.WriteAllText(args[1], "child survived"); return 0; }
            if (args.Length == 2 && args[0] == "--spawn-delayed")
            {
                using (var child = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo { FileName = Assembly.GetExecutingAssembly().Location, Arguments = "--delayed-marker " + ProcessRunner.Quote(args[1]), UseShellExecute = false, CreateNoWindow = true })) { Thread.Sleep(30000); }
                return 0;
            }
            if (args.Length == 2 && args[0] == "--ui-fixture") { ShowFixture(args[1]); return 0; }
            if (args.Length == 2 && args[0] == "--render-fixture") { RenderFixture(args[1]); return 0; }
            if (args.Length == 2 && args[0] == "--render-scenes") { RenderScenes(args[1]); return 0; }
            if (args.Length == 2 && args[0] == "--render-editor") { RenderEditor(args[1]); return 0; }
            if (args.Length > 0 && args[0] == "--benchmark-editor") return EditorPerformance.Run(args.Skip(1).ToArray());
            if (args.Length == 2 && args[0] == "--scene-smoke") { return RunLive(() => SceneSmoke(args[1])); }
            if (args.Length == 2 && args[0] == "--prepare-tools") { return RunLive(() => PrepareTools(args[1])); }
            if (args.Length == 2 && args[0] == "--audio-smoke") { return RunLive(() => AudioSmoke(args[1])); }
            if (args.Length == 3 && args[0] == "--real-download") { return RunLive(() => RealDownload(args[1], args[2])); }
            root = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..", "build", "t-" + Guid.NewGuid().ToString("N").Substring(0, 8)));
            Directory.CreateDirectory(root);
            try { Run().GetAwaiter().GetResult(); RunScenes().GetAwaiter().GetResult(); RunEditor().GetAwaiter().GetResult(); RunWheel().GetAwaiter().GetResult(); }
            catch (Exception error) { Console.WriteLine("FAIL suite: " + error); failed++; }
            Console.WriteLine("RESULT: " + passed + " passed, " + failed + " failed");
            // Keep fixtures available for diagnosis; every run has an isolated directory.
            return failed == 0 ? 0 : 1;
        }
        static int RunLive(Func<Task> action) { try { action().GetAwaiter().GetResult(); return 0; } catch (Exception error) { for (Exception detail = error; detail != null; detail = detail.InnerException) Console.WriteLine("ERROR: " + detail.GetType().Name + ": " + detail.Message); return 1; } }
        static void Check(bool condition, string reason) { if (!condition) throw new Exception(reason); }
        static void Throws(Action action)
        { try { action(); } catch (IOException) { return; } catch (ArgumentException) { return; } throw new Exception("Expected rejection"); }
        static async Task Rejects(Func<Task> action)
        { try { await action(); } catch (IOException) { return; } catch (ArgumentException) { return; } catch (OperationCanceledException) { return; } throw new Exception("Expected rejection"); }
        static async Task Test(string name, Func<Task> action)
        { try { await action(); passed++; Console.WriteLine("PASS " + name); } catch (Exception error) { failed++; Console.WriteLine("FAIL " + name + ": " + error.Message); } }
        static Task Sync(Action action) { action(); return Task.FromResult(0); }
        static string NewDir(string name) { string dir = Path.Combine(root, name); Directory.CreateDirectory(dir); return dir; }
        static string Foundry(string parent)
        { string data = Path.Combine(parent, "Foundry", "Data"); foreach (string folder in new[] { "modules", "worlds", "systems" }) Directory.CreateDirectory(Path.Combine(data, folder)); return data; }
        static DownloadItem Item(string data, string directory)
        { return new DownloadItem { Url = "https://youtu.be/" + VideoId, VideoId = VideoId, Category = "Combattimento", Directory = directory, DataRoot = data, Quality = 192 }; }
        static readonly IProgress<JobProgress> NoProgress = new InlineProgress<JobProgress>(value => { });
        static async Task Run()
        {
            await Test("YouTube: normalizzazione e rimozione tracking", () => Sync(() => {
                foreach (string url in new[] { "https://youtu.be/" + VideoId + "?si=test", "https://www.youtube.com/watch?v=" + VideoId + "&list=abc&t=60", "https://music.youtube.com/watch?v=" + VideoId, "https://youtube.com/shorts/" + VideoId })
                    Check(VideoLink.Parse(url).Url == "https://www.youtube.com/watch?v=" + VideoId, url);
            }));
            await Test("YouTube: rifiuto URL esterni, credenziali e opzioni", () => Sync(() => {
                foreach (string url in new[] { "http://youtube.com/watch?v=" + VideoId, "https://youtube.com.evil.test/watch?v=" + VideoId, "https://user@youtube.com/watch?v=" + VideoId, "https://youtube.com:123/watch?v=" + VideoId, "--exec calc.exe", "file:///test.mp3", "https://youtube.com/playlist?list=abc" }) Throws(() => VideoLink.Parse(url));
            }));
            await Test("Rilevamento installazione portable e percorso dati", () => Sync(() => {
                string parent = NewDir("detect"), data = Foundry(parent);
                Check(FoundryPaths.Find(Path.Combine(parent, "Foundry")).Single() == data, "portable data");
                Check(FoundryPaths.Find(Path.Combine(data, "modules")).Contains(data), "modules selection");
            }));
            await Test("Percorsi musicali: nessuna uscita da musics", () => Sync(() => {
                string data = Foundry(NewDir("paths"));
                foreach (string relative in new[] { "../outside", "musics/../worlds", "C:/Windows", "musics//a", "musics/%2e%2e", "musics/CON", "musics/trailing.", "assets/music", "musics/a:b" }) Throws(() => FoundryPaths.MusicDirectory(data, relative, true));
                string dir = FoundryPaths.MusicDirectory(data, "musics/Atmosfera dolce", true); Check(Directory.Exists(dir), "valid destination");
            }));
            await Test("Nomi Windows riservati e metacaratteri", () => Sync(() => {
                Check(FoundryPaths.SafeName("CON") == "_CON", "reserved device");
                Check(!FoundryPaths.SafeName("../A < B : C? | D#% / E").Contains('/'), "unsafe filename");
                Check(FoundryPaths.CategoryDirectory("Esplorazione Città") == "musics/youtube/esplorazione-citta", "accented category");
            }));
            await Test("Sessioni: DPAPI senza token in chiaro", () => Sync(() => {
                var storage = new AppStorage(NewDir("session")); string token = "test-only-secret-" + Guid.NewGuid(); storage.SaveSession(token);
                Check(storage.LoadSession() == token, "DPAPI round trip");
                Check(!Encoding.UTF8.GetString(File.ReadAllBytes(Path.Combine(storage.Root, "session.bin"))).Contains(token), "plaintext token");
                storage.ClearSession(); Check(storage.LoadSession() == "", "logout cleanup");
            }));
            await Test("OAuth: URL limitati al backend e al percorso previsto", () => Sync(() => {
                Check(DiscordAuth.ValidateAuthUrl(DiscordAuth.Backend + "/auth/discord/login?bridgeState=abc", "/auth/discord/login").Scheme == "https", "valid auth");
                foreach (string url in new[] { "http://sigillo-api.khuzoe.workers.dev/auth/discord/login", "https://evil.test/auth/discord/login", DiscordAuth.Backend + "/different", "https://sigillo-api.khuzoe.workers.dev:444/auth/discord/login" }) Throws(() => DiscordAuth.ValidateAuthUrl(url, "/auth/discord/login"));
            }));
            await Test("Proxy: rispetto di NO_PROXY e credenziali separate dall’URL", () => Sync(() => {
                var proxy = new ConfiguredProxy("http://name:pass@127.0.0.1:1234", "localhost,127.0.0.1,.example.test,exact.test:8443");
                Check(proxy.GetProxy(new Uri("https://github.com")).UserInfo == "", "proxy credentials leaked in URL");
                Check(proxy.IsBypassed(new Uri("http://localhost")) && proxy.IsBypassed(new Uri("https://sub.example.test")), "bypass ignored");
                Check(!proxy.IsBypassed(new Uri("https://notexample.test")) && !proxy.IsBypassed(new Uri("https://exact.test:443")), "bypass too broad");
                Check(proxy.IsBypassed(new Uri("https://exact.test:8443")), "bypass port ignored");
                Throws(() => new ConfiguredProxy("file:///unsafe", ""));
            }));
            await Test("Preparazione strumenti: fonti e impronte obbligatorie", () => Sync(() => {
                string hash = new string('a', 64);
                Func<string, string, string> release = (url, digest) => Json.Write(new { tag_name = "test", assets = new[] { new { name = "yt-dlp.exe", browser_download_url = url, digest = digest, size = 100 } } });
                Check(ToolsInstaller.ParseAsset(release("https://github.com/yt-dlp/yt-dlp/releases/download/test/yt-dlp.exe", "sha256:" + hash), "yt-dlp/yt-dlp", "yt-dlp.exe").Size == 100, "valid release");
                Throws(() => ToolsInstaller.ParseAsset(release("https://evil.test/yt-dlp.exe", "sha256:" + hash), "yt-dlp/yt-dlp", "yt-dlp.exe"));
                Throws(() => ToolsInstaller.ParseAsset(release("https://github.com/yt-dlp/yt-dlp/releases/download/test/yt-dlp.exe", ""), "yt-dlp/yt-dlp", "yt-dlp.exe"));
                Check(!Network.TrustedDownload(new Uri("https://github.com.evil.test/payload")), "download domain spoof");
                string file = Path.Combine(NewDir("hash"), "tool"); File.WriteAllText(file, "original"); string expected = FoundryPaths.Hash(file); File.WriteAllText(file, "modified"); Throws(() => ToolsInstaller.VerifyHash(file, expected));
            }));
            await Test("ZIP: si estraggono soltanto i due eseguibili previsti", () => Sync(() => {
                string dir = NewDir("zip"), archive = Path.Combine(dir, "test.zip"), output = Path.Combine(dir, "output"); Directory.CreateDirectory(output);
                using (var zip = ZipFile.Open(archive, ZipArchiveMode.Create))
                    foreach (string name in new[] { "build/bin/ffmpeg.exe", "build/bin/ffprobe.exe", "../../escape.txt" }) using (var writer = new StreamWriter(zip.CreateEntry(name).Open())) writer.Write("test");
                ToolsInstaller.ExtractFfmpeg(archive, output);
                Check(Directory.GetFiles(output).Length == 2 && !File.Exists(Path.Combine(dir, "escape.txt")), "unsafe extraction");
            }));
            await Test("Processi: round trip argomenti senza shell", async () => {
                var expected = new[] { "one two", "quote\"inside", "trailing\\", "$(secret)", "& | % PATH", "back\\\"quote", "" };
                var result = await new ProcessRunner().RunAsync(Assembly.GetExecutingAssembly().Location, new[] { "--echo-args" }.Concat(expected).ToArray(), TimeSpan.FromSeconds(10), CancellationToken.None, null);
                Check(Json.Read<string[]>(result.Output).SequenceEqual(expected), "argument quoting changed values");
            });
            await Test("Processi: annullamento effettivo", async () => {
                var timer = System.Diagnostics.Stopwatch.StartNew();
                using (var cancellation = new CancellationTokenSource(250))
                    await Rejects(async () => { await new ProcessRunner().RunAsync(Assembly.GetExecutingAssembly().Location, new[] { "--sleep" }, TimeSpan.FromSeconds(15), cancellation.Token, null); });
                Check(timer.Elapsed < TimeSpan.FromSeconds(6), "cancellation did not stop the process promptly: " + timer.Elapsed);
            });
            await Test("Processi: annullamento anche dei processi figli", async () => {
                string marker = Path.Combine(NewDir("child-cancel"), "marker.txt");
                using (var cancellation = new CancellationTokenSource(350))
                    await Rejects(async () => { await new ProcessRunner().RunAsync(Assembly.GetExecutingAssembly().Location, new[] { "--spawn-delayed", marker }, TimeSpan.FromSeconds(10), cancellation.Token, null); });
                await Task.Delay(1700); Check(!File.Exists(marker), "a descendant survived cancellation");
            });
            await Test("Download: MP3, raccolta persistente e duplicati", async () => {
                var storage = new AppStorage(NewDir("download")); string data = Foundry(storage.Root); var lib = new MusicLibrary(storage.Root); var runner = new FakeRunner();
                var engine = new MusicDownloader(storage, lib, new FakeTools(storage.Root), runner); var item = Item(data, "musics/combattimento");
                var first = await engine.DownloadAsync(item, NoProgress, CancellationToken.None);
                Check(File.Exists(FoundryPaths.TrackFile(data, first.Track)), "missing MP3");
                Check(new MusicLibrary(storage.Root).All().Count == 1, "library not durable");
                var second = await engine.DownloadAsync(item, NoProgress, CancellationToken.None);
                Check(second.Reused && runner.Downloads == 1 && lib.All().Count == 1, "duplicate redownload");
                Check(!Directory.EnumerateDirectories(storage.WorkRoot).Any(), "temp work retained");
            });
            await Test("Download: stesso video in cartelle diverse", async () => {
                var storage = new AppStorage(NewDir("separate")); string data = Foundry(storage.Root); var lib = new MusicLibrary(storage.Root);
                var engine = new MusicDownloader(storage, lib, new FakeTools(storage.Root), new FakeRunner());
                await engine.DownloadAsync(Item(data, "musics/a"), NoProgress, CancellationToken.None); await engine.DownloadAsync(Item(data, "musics/b"), NoProgress, CancellationToken.None);
                Check(lib.All().Count == 2, "different destinations collapsed");
            });
            await Test("Download: collisioni senza sovrascrittura", async () => {
                var storage = new AppStorage(NewDir("collision")); string data = Foundry(storage.Root); var lib = new MusicLibrary(storage.Root);
                string folder = FoundryPaths.MusicDirectory(data, "musics/a", true), file = Path.Combine(folder, "Test music--" + VideoId + ".mp3"); File.WriteAllText(file, "USER ORIGINAL");
                await Rejects(async () => { await new MusicDownloader(storage, lib, new FakeTools(storage.Root), new FakeRunner()).DownloadAsync(Item(data, "musics/a"), NoProgress, CancellationToken.None); });
                Check(File.ReadAllText(file) == "USER ORIGINAL" && lib.All().Count == 0, "existing file changed");
            });
            await Test("Download: output non MP3 rifiutato", async () => {
                var storage = new AppStorage(NewDir("bad-audio")); string data = Foundry(storage.Root); var lib = new MusicLibrary(storage.Root);
                await Rejects(async () => { await new MusicDownloader(storage, lib, new FakeTools(storage.Root), new FakeRunner { BadAudio = true }).DownloadAsync(Item(data, "musics/a"), NoProgress, CancellationToken.None); });
                Check(lib.All().Count == 0 && !Directory.Exists(Path.Combine(data, "musics", "a")), "bad audio published");
            });
            await Test("Download: video inatteso rifiutato", async () => {
                var storage = new AppStorage(NewDir("bad-id")); string data = Foundry(storage.Root); var lib = new MusicLibrary(storage.Root);
                await Rejects(async () => { await new MusicDownloader(storage, lib, new FakeTools(storage.Root), new FakeRunner { BadId = true }).DownloadAsync(Item(data, "musics/a"), NoProgress, CancellationToken.None); });
                Check(lib.All().Count == 0, "wrong video committed");
            });
            await Test("Download: annullamento e pulizia temporanei", async () => {
                var storage = new AppStorage(NewDir("cancel")); string data = Foundry(storage.Root); var lib = new MusicLibrary(storage.Root);
                using (var cancellation = new CancellationTokenSource(100))
                    await Rejects(async () => { await new MusicDownloader(storage, lib, new FakeTools(storage.Root), new FakeRunner { Slow = true }).DownloadAsync(Item(data, "musics/a"), NoProgress, cancellation.Token); });
                Check(lib.All().Count == 0 && (!Directory.Exists(storage.WorkRoot) || !Directory.GetDirectories(storage.WorkRoot).Any()), "canceled job retained files");
            });
            await Test("Raccolta alterata: percorsi esterni rifiutati", () => Sync(() => {
                string data = Foundry(NewDir("tamper")); Throws(() => FoundryPaths.TrackFile(data, new TrackRecord { Directory = "musics/a", Filename = "../secret.mp3" }));
                Throws(() => FoundryPaths.RemoveWork(Path.Combine(root, "parent"), root));
            }));
        }
        internal sealed class InlineProgress<T> : IProgress<T> { readonly Action<T> callback; public InlineProgress(Action<T> callback) { this.callback = callback; } public void Report(T value) { callback(value); } }
        internal sealed class FakeTools : IToolProvider
        {
            readonly string root; public FakeTools(string root) { this.root = root; }
            public Task<ToolPaths> EnsureAsync(Action<string> progress, CancellationToken cancellation) { return Task.FromResult(new ToolPaths { Downloader = Path.Combine(root, "download.exe"), Ffmpeg = Path.Combine(root, "ffmpeg.exe"), Ffprobe = Path.Combine(root, "probe.exe"), Node = Path.Combine(root, "node.exe") }); }
        }
        internal sealed class FakeRunner : IProcessRunner
        {
            public bool BadAudio, BadId, Slow;
            public int Downloads;
            public async Task<ProcessResult> RunAsync(string executable, IList<string> args, TimeSpan timeout, CancellationToken cancellation, Action<string> line)
            {
                cancellation.ThrowIfCancellationRequested();
                if (executable.EndsWith("probe.exe")) return new ProcessResult { Output = Json.Write(new { streams = new[] { new { codec_name = BadAudio ? "opus" : "mp3" } }, format = new { duration = "3.5" } }) };
                if (args.Contains("--dump-single-json")) return new ProcessResult { Output = Json.Write(new { id = BadId ? "abcdefghijk" : VideoId, title = "Test music", uploader = "Fixture", duration = 3.5, is_live = false }) };
                Downloads++; if (Slow) await Task.Delay(10000, cancellation);
                string template = args[args.IndexOf("--output") + 1]; File.WriteAllText(template.Replace("%(ext)s", "mp3"), "isolated fake audio");
                if (line != null) line("KHUZOE_PROGRESS:100.0%|20 KiB/s|00:00"); return new ProcessResult { Output = "" };
            }
        }
        internal sealed class FixtureSession : IUserSession
        {
            public bool IsAuthenticated { get { return true; } }
            public string DisplayName { get { return "DM · Anteprima di test"; } }
            public Task<bool> VerifyAsync(CancellationToken token) { return Task.FromResult(true); }
            public Task LoginAsync(Action<Uri> browser, Action<string> progress, CancellationToken token) { return Task.FromResult(0); }
            public void Logout() { }
            public void Dispose() { }
        }
        static AppStorage PrepareFixture(string location)
        {
            var storage = new AppStorage(location); string data = Foundry(storage.Root);
            storage.SavePreferences(new Preferences { DataRoot = data, SelectedPath = Path.GetDirectoryName(data), Category = "Combattimento", Quality = 192 });
            var library = new MusicLibrary(storage.Root);
            foreach (var item in new[] { new { Id = "aaaaaaaaaaa", Title = "Le porte della cittadella", Category = "Combattimento", Duration = 243.0 }, new { Id = "bbbbbbbbbbb", Title = "Un sentiero nella foresta", Category = "Esplorazione", Duration = 627.0 }, new { Id = "ccccccccccc", Title = "La locanda del viandante", Category = "Taverna", Duration = 314.0 } })
                if (library.Find(item.Id, data, "musics/youtube/" + item.Category.ToLowerInvariant()) == null) library.Add(new TrackRecord { VideoId = item.Id, Title = item.Title, Author = "Fixture UI", Category = item.Category, Duration = item.Duration, DataRoot = data, Directory = "musics/youtube/" + item.Category.ToLowerInvariant(), Filename = item.Title + ".mp3", Quality = 192, AddedAt = DateTime.UtcNow });
            return storage;
        }
        internal static void ShowFixture(string location)
        {
            Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new MainForm(PrepareFixture(location), new FixtureSession()));
        }
        static void RenderFixture(string location)
        {
            Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
            var storage = PrepareFixture(location);
            using (var form = new MainForm(storage, new FixtureSession()))
            {
                form.ShowInTaskbar = false; form.StartPosition = FormStartPosition.Manual; form.Location = new System.Drawing.Point(-15000, -15000);
                form.Show(); Application.DoEvents();
                using (var bitmap = new System.Drawing.Bitmap(form.Width, form.Height))
                {
                    form.DrawToBitmap(bitmap, new System.Drawing.Rectangle(0, 0, form.Width, form.Height));
                    string output = Path.Combine(storage.Root, "app-preview.png"); bitmap.Save(output, System.Drawing.Imaging.ImageFormat.Png); Console.WriteLine(output);
                }
                form.Close();
            }
        }
        static void ReportPreparation(string message) { if (!message.Contains("%") || message.EndsWith("0%")) Console.WriteLine(message); }
        static async Task PrepareTools(string location)
        {
            var storage = new AppStorage(location); var tools = await new ToolsInstaller(storage).EnsureAsync(ReportPreparation, CancellationToken.None);
            Console.WriteLine("TOOLS READY: " + new ToolsInstaller(storage).Ready());
            foreach (string exe in new[] { tools.Downloader, tools.Ffmpeg, tools.Ffprobe, tools.Node })
            {
                var output = await new ProcessRunner().RunAsync(exe, exe == tools.Downloader || exe == tools.Node ? new[] { "--version" } : new[] { "-version" }, TimeSpan.FromSeconds(30), CancellationToken.None, null);
                Console.WriteLine(Path.GetFileName(exe) + " " + output.Output.Split('\n')[0]);
            }
        }
        static async Task RealDownload(string location, string url)
        {
            var storage = new AppStorage(location); string data = Foundry(storage.Root); var library = new MusicLibrary(storage.Root); var video = VideoLink.Parse(url);
            var item = new DownloadItem { Url = video.Url, VideoId = video.Id, Category = "Test", Directory = "musics/test", DataRoot = data, Quality = 192 };
            var engine = new MusicDownloader(storage, library, new ToolsInstaller(storage), new ProcessRunner());
            var result = await engine.DownloadAsync(item, new InlineProgress<JobProgress>(value => Console.WriteLine(value.Stage + ": " + value.Message)), CancellationToken.None);
            Console.WriteLine("REAL DOWNLOAD OK: " + result.Track.RelativePath + " · " + result.Track.Bytes + " bytes · reused=" + result.Reused);
        }
        sealed class ExistingTools : IToolProvider
        {
            readonly ToolPaths tools;
            public ExistingTools(ToolPaths tools) { this.tools = tools; }
            public Task<ToolPaths> EnsureAsync(Action<string> progress, CancellationToken cancellation) { return Task.FromResult(tools); }
        }
        sealed class SyntheticAudioRunner : IProcessRunner
        {
            readonly ToolPaths tools;
            readonly ProcessRunner runner = new ProcessRunner();
            public SyntheticAudioRunner(ToolPaths tools) { this.tools = tools; }
            public Task<ProcessResult> RunAsync(string executable, IList<string> args, TimeSpan timeout, CancellationToken cancellation, Action<string> line)
            {
                if (executable == tools.Ffprobe) return runner.RunAsync(executable, args, timeout, cancellation, line);
                if (args.Contains("--dump-single-json")) return Task.FromResult(new ProcessResult { Output = Json.Write(new { id = VideoId, title = "Synthetic audio smoke test", uploader = "Khuzoe test", duration = 1, is_live = false }) });
                string output = args[args.IndexOf("--output") + 1].Replace("%(ext)s", "mp3");
                return runner.RunAsync(tools.Ffmpeg, new[] { "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", "libmp3lame", "-b:a", "192k", output }, TimeSpan.FromSeconds(30), cancellation, line);
            }
        }
        static async Task AudioSmoke(string location)
        {
            var storage = new AppStorage(location); var tools = await new ToolsInstaller(storage).EnsureAsync(ReportPreparation, CancellationToken.None);
            string data = Foundry(storage.Root); var lib = new MusicLibrary(storage.Root);
            var engine = new MusicDownloader(storage, lib, new ExistingTools(tools), new SyntheticAudioRunner(tools));
            var result = await engine.DownloadAsync(Item(data, "musics/synthetic-test"), NoProgress, CancellationToken.None);
            Check(result.Track.Bytes > 1000 && result.Track.Duration > 0.9 && result.Track.Duration < 1.3, "real MP3 validation failed");
            Check(File.Exists(FoundryPaths.TrackFile(data, result.Track)), "final MP3 missing");
            Console.WriteLine("REAL FFMPEG PIPELINE OK: " + result.Track.Bytes + " bytes · " + result.Track.Duration + " seconds · reused=" + result.Reused);
        }
    }
}
