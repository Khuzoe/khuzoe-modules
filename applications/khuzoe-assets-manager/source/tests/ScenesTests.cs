using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace KhuzoeAssetsManager
{
    internal static partial class Tests
    {
        static string FixtureWriter { get { return Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..", "engine", "fixture.cjs")); } }
        static async Task<string> ReadLine(Process process)
        {
            var line = process.StandardOutput.ReadLineAsync();
            if (await Task.WhenAny(line, Task.Delay(8000)) != line) throw new Exception("Fixture process did not respond");
            string value = await line; if (value == null) throw new Exception("Fixture stopped: " + await process.StandardError.ReadToEndAsync()); return value;
        }
        static Dictionary<string, string> DatabaseHashes(string directory)
        {
            var result = new Dictionary<string, string>();
            foreach (string file in Directory.GetFiles(directory).Where(file => !new[] { "LOCK", "LOG", "LOG.old" }.Contains(Path.GetFileName(file))))
                using (var hash = SHA256.Create()) using (var input = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                    result[Path.GetFileName(file)] = BitConverter.ToString(hash.ComputeHash(input));
            return result;
        }
        static async Task RunScenes()
        {
            await Test("Updater: cartella Foundry ricevuta e preferenze conservate", () => Sync(() => {
                var storage = new AppStorage(NewDir("updater-launch")); string data = Foundry(storage.Root);
                var preferences = new Preferences(); preferences.SceneView.Indicators = false; preferences.Category = "Taverna"; storage.SavePreferences(preferences);
                StartupOptions.Apply(storage, new[] { "--foundry-data", data }); var saved = storage.LoadPreferences();
                Check(saved.DataRoot == data && saved.Category == "Taverna" && !saved.SceneView.Indicators, "updater launch lost preferences");
                Throws(() => StartupOptions.Apply(storage, new[] { "--foundry-data" }));
                Throws(() => StartupOptions.Apply(storage, new[] { "--foundry-data", Path.Combine(data, "unknown") }));
                Check(storage.LoadPreferences().DataRoot == data, "invalid launch replaced known data root");
            }));
            await Test("Scene: mondi e percorsi asset confinati ai dati Foundry", () => Sync(() => {
                string data = Foundry(NewDir("scene-paths")); string world = Path.Combine(data, "worlds", "demo"); Directory.CreateDirectory(world);
                Json.Save(Path.Combine(world, "world.json"), new { id = "demo", title = "Mondo dimostrativo" });
                Check(SceneFiles.Worlds(data).Single().Name == "Mondo dimostrativo", "world discovery failed");
                foreach (string asset in new[] { "../secret.png", "%2e%2e/secret.png", "file:///C:/secret.png", "C:/secret.png", "/absolute.png" }) Throws(() => SceneFiles.LocalAsset(data, asset));
                Check(SceneFiles.LocalAsset(data, "maps/a%20b.webp").EndsWith("maps\\a b.webp"), "encoded asset path failed");
            }));
            await Test("Scene: rifiuto indirizzi privati e contenuti non immagine", () => Sync(() => {
                foreach (string value in new[] { "127.0.0.1", "10.1.1.1", "192.168.1.2", "172.20.1.2", "169.254.169.254", "::1", "fc00::1", "::ffff:127.0.0.1" }) Check(!SceneImages.PublicAddress(IPAddress.Parse(value)), "private address allowed " + value);
                Check(SceneImages.PublicAddress(IPAddress.Parse("8.8.8.8")), "public address rejected");
                Throws(() => SceneImages.RasterFormat(Encoding.UTF8.GetBytes("#EXTM3U\nhttps://private/secret")));
                Check(SceneImages.RasterFormat(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 }) == "png", "PNG signature rejected");
            }));
            await Test("Scene: allineamento a padding e spostamento Foundry", () => Sync(() => {
                var layout = SceneLayout.From(new SceneDetail { Width = 1600, Height = 1200, Padding = 0.25, GridSize = 100, GridType = 1, ShiftX = 20, ShiftY = -30 });
                Check(layout.MapX == 380 && layout.MapY == 330 && layout.Width == 2400 && layout.Height == 1800, "wrong world-to-map frame");
                Check(SceneDetail.Included(new string[0], "floor-a") && !SceneDetail.Included(new[] { "floor-b" }, "floor-a"), "wrong level filtering");
            }));
            await Test("Scene: preferenze filtri persistenti senza cambiare la geometria", () => Sync(() => {
                var storage = new AppStorage(NewDir("scene-options")); var options = new Preferences(); options.SceneView.Walls = false; options.SceneView.Indicators = false; options.SceneView.Grid = true;
                storage.SavePreferences(options); var loaded = storage.LoadPreferences(); Check(!loaded.SceneView.Walls && !loaded.SceneView.Indicators && loaded.SceneView.Grid && loaded.SceneView.Lights, "filter state lost");
            }));
            await Test("Scene: snapshot leggibile con database originale aperto e invariato", async () => {
                string parent = NewDir("live-scenes"), data = Foundry(parent), state = Path.Combine(parent, "state"); var storage = new AppStorage(state);
                using (var process = new Process()) using (var job = new ProcessJob())
                {
                    process.StartInfo = new ProcessStartInfo { FileName = "node", Arguments = ProcessRunner.Quote(FixtureWriter) + " --root " + ProcessRunner.Quote(data) + " --hold", UseShellExecute = false, CreateNoWindow = true,
                        RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8 };
                    process.Start(); job.Attach(process);
                    try
                    {
                        Check(await ReadLine(process) == "READY", "fixture not ready");
                        string source = Path.Combine(data, "worlds", "assets-fixture", "data", "scenes"); var before = DatabaseHashes(source);
                        var provider = new ExistingTools(new ToolPaths { Node = "node" }); var repository = new SceneRepository(storage, provider, new ProcessRunner());
                        using (var snapshot = await repository.CaptureAsync(data, "assets-fixture", value => { }, CancellationToken.None))
                        {
                            var catalog = await repository.CatalogAsync(snapshot, CancellationToken.None); Check(catalog.Scenes.Count == 1, "live catalog not read");
                            var scene = await repository.DetailAsync(snapshot, catalog.Scenes[0].Id, CancellationToken.None);
                            Check(scene.Levels.Count == 2 && scene.Walls.Count == 6 && scene.Lights.Count == 3, "embedded documents missing");
                            Check(scene.Levels[0].Background == "maps/fixture.png", "v14 background missing");
                        }
                        var after = DatabaseHashes(source); Check(before.Count == after.Count && before.All(item => after.ContainsKey(item.Key) && after[item.Key] == item.Value), "source database was changed by reading");
                        process.StandardInput.WriteLine("add"); process.StandardInput.Flush(); Check(await ReadLine(process) == "UPDATED", "live update failed");
                        using (var snapshot = await repository.CaptureAsync(data, "assets-fixture", value => { }, CancellationToken.None))
                            Check((await repository.CatalogAsync(snapshot, CancellationToken.None)).Scenes.Count == 2, "new WAL record not included in refreshed snapshot");
                    }
                    finally { job.Terminate(process); process.WaitForExit(3000); }
                }
            });
            await Test("Scene: annullamento snapshot senza copia parziale", async () => {
                string data = Foundry(NewDir("scene-cancel")), cache = Path.Combine(root, "scene-cancel-cache");
                using (var cancellation = new CancellationTokenSource()) { cancellation.Cancel(); await Rejects(async () => { await SceneFiles.SnapshotAsync(data, "demo", cache, cancellation.Token); }); }
                Check(!Directory.Exists(cache) || !Directory.EnumerateFileSystemEntries(cache).Any(), "partial scene snapshot left behind");
            });
            await Test("Scene: manifesti runtime alterati rifiutati", () => Sync(() => {
                string runtime = NewDir("reader-integrity"); File.WriteAllText(Path.Combine(runtime, "reader.cjs"), "original"); File.WriteAllText(Path.Combine(runtime, "test.node"), "binary-fixture");
                Json.Save(Path.Combine(runtime, "integrity.json"), new Dictionary<string, string> { { "reader.cjs", FoundryPaths.Hash(Path.Combine(runtime, "reader.cjs")) }, { "test.node", FoundryPaths.Hash(Path.Combine(runtime, "test.node")) } });
                SceneRepository.VerifyEngine(runtime); File.WriteAllText(Path.Combine(runtime, "reader.cjs"), "modified"); Throws(() => SceneRepository.VerifyEngine(runtime));
            }));
            await Test("Scene: filtri grafici indipendenti senza modificare dati", async () => {
                var completion = new TaskCompletionSource<bool>(); var thread = new Thread(() => {
                    try
                    {
                        using (var canvas = new SceneCanvas { Size = new Size(640, 480) }) using (var images = new SceneImageSet())
                        {
                            var scene = DemoScene(); var level = scene.Levels[0]; images.Background = new Bitmap(1600, 1200); using (var g = Graphics.FromImage(images.Background)) g.Clear(Color.FromArgb(48, 61, 57));
                            canvas.CreateControl(); canvas.SetScene(scene, level, images, true);
                            using (var before = new Bitmap(640, 480)) using (var hidden = new Bitmap(640, 480))
                            {
                                canvas.DrawToBitmap(before, new Rectangle(0, 0, 640, 480)); canvas.Settings.Walls = false; canvas.Settings.Lights = false; canvas.Settings.Indicators = false;
                                canvas.DrawToBitmap(hidden, new Rectangle(0, 0, 640, 480));
                                bool different = false; for (int y = 0; y < 480 && !different; y += 2) for (int x = 0; x < 640; x += 2) if (before.GetPixel(x, y) != hidden.GetPixel(x, y)) { different = true; break; }
                                Check(different && scene.Walls.Count == 1 && scene.Lights.Count == 1, "filters did not change preview or mutated scene");
                            }
                        }
                        completion.SetResult(true);
                    }
                    catch (Exception error) { completion.SetException(error); }
                }); thread.SetApartmentState(ApartmentState.STA); thread.Start(); await completion.Task;
            });
        }
        internal static SceneDetail DemoScene()
        {
            var scene = new SceneDetail { Id = "scene00000000001", Name = "La cittadella", Width = 1600, Height = 1200, Padding = 0.25, GridType = 1, GridSize = 100, GridDistance = 5, GridUnits = "m", InitialLevel = "level00000000001" };
            scene.Levels.Add(new SceneLevel { Id = scene.InitialLevel, Name = "Piano terra", BackgroundColor = "#33443c", Background = "maps/fixture.png" });
            scene.Walls.Add(new SceneWall { Id = "wall000000000001", X1 = 500, Y1 = 400, X2 = 1800, Y2 = 400, Sight = 20, Move = 1, Levels = new[] { scene.InitialLevel } });
            scene.Lights.Add(new SceneLight { Id = "light00000000001", X = 800, Y = 800, Bright = 10, Dim = 20, Color = "#ffaa33", Angle = 360, Luminosity = 0.5 });
            return scene;
        }
        static void DrawFixtureMap(string data)
        {
            string folder = Path.Combine(data, "maps"); Directory.CreateDirectory(folder);
            using (var map = new Bitmap(1600, 1200)) using (var g = Graphics.FromImage(map))
            {
                g.Clear(Color.FromArgb(30, 34, 31));
                using (var floor = new SolidBrush(Color.FromArgb(95, 100, 88))) g.FillRectangle(floor, 100, 100, 1300, 1000);
                using (var pen = new Pen(Color.FromArgb(120, 60, 67, 59), 2))
                    for (int x = 100; x <= 1400; x += 100) for (int y = 100; y <= 1100; y += 100) g.DrawRectangle(pen, x, y, 100, 100);
                using (var wall = new Pen(Color.FromArgb(40, 46, 42), 28)) { g.DrawRectangle(wall, 100, 100, 1300, 1000); g.DrawLine(wall, 700, 100, 700, 500); }
                using (var table = new SolidBrush(Color.FromArgb(104, 77, 49))) { g.FillRectangle(table, 250, 620, 260, 130); g.FillRectangle(table, 1000, 620, 180, 90); }
                using (var border = new Pen(Color.FromArgb(52, 36, 23), 8)) { g.DrawRectangle(border, 250, 620, 260, 130); g.DrawRectangle(border, 1000, 620, 180, 90); }
                using (var font = new Font("Georgia", 19F, FontStyle.Bold)) using (var ink = new SolidBrush(Color.FromArgb(190, 212, 211, 181)))
                { g.DrawString("SALA DELLE GUARDIE", font, ink, 180, 900); g.DrawString("CORTILE COPERTO", font, ink, 840, 900); }
                map.Save(Path.Combine(folder, "fixture.png"), System.Drawing.Imaging.ImageFormat.Png);
            }
        }
        static ToolPaths PreparedSceneTools()
        {
            string folder = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..", "build", "live", "tools"));
            if (!File.Exists(Path.Combine(folder, "ffmpeg.exe"))) throw new IOException("Prepara prima gli strumenti di test in build/live.");
            return new ToolPaths { Node = Path.Combine(folder, "node.exe"), Ffmpeg = Path.Combine(folder, "ffmpeg.exe"), Ffprobe = Path.Combine(folder, "ffprobe.exe"), Downloader = Path.Combine(folder, "yt-dlp.exe") };
        }
        static async Task CreateSceneFixture(string data, ToolPaths tools)
        {
            await new ProcessRunner().RunAsync(tools.Node, new[] { FixtureWriter, "--root", data }, TimeSpan.FromSeconds(15), CancellationToken.None, null);
            DrawFixtureMap(data);
        }
        static async Task SceneSmoke(string location)
        {
            var storage = new AppStorage(location); string data = Foundry(storage.Root); var tools = PreparedSceneTools(); await CreateSceneFixture(data, tools);
            var provider = new ExistingTools(tools); var repository = new SceneRepository(storage, provider, new ProcessRunner());
            using (var snapshot = await repository.CaptureAsync(data, "assets-fixture", value => { }, CancellationToken.None))
            {
                var catalog = await repository.CatalogAsync(snapshot, CancellationToken.None); Check(catalog.Scenes.Count == 2, "catalog not read");
                var scene = await repository.DetailAsync(snapshot, "scene00000000001", CancellationToken.None);
                var loader = new SceneImages(storage, provider, new ProcessRunner());
                using (var images = await loader.LoadLevelAsync(data, scene, scene.Levels[0], value => { }, CancellationToken.None)) Check(images.Background != null, "PNG background did not load: " + String.Join("; ", images.Warnings));
                string webp = Path.Combine(data, "maps", "fixture.webp");
                await new ProcessRunner().RunAsync(tools.Ffmpeg, new[] { "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", Path.Combine(data, "maps", "fixture.png"), "-c:v", "libwebp", "-lossless", "1", webp }, TimeSpan.FromSeconds(30), CancellationToken.None, null);
                using (var image = await loader.LoadAsync(data, "maps/fixture.webp", tools, 2048, CancellationToken.None)) Check(image.Width == 1600 && image.Height == 1200, "WebP preview has wrong size");
                Console.WriteLine("SCENE PIPELINE OK: 2 scenes, 2 levels, 6 walls, 3 lights, PNG and WebP previews; source untouched.");
            }
        }
        static IEnumerable<Control> Descendants(Control parent)
        { foreach (Control child in parent.Controls) { yield return child; foreach (var item in Descendants(child)) yield return item; } }
        static void RenderScenes(string location)
        {
            var storage = new AppStorage(location); string data = Foundry(storage.Root); var tools = PreparedSceneTools(); CreateSceneFixture(data, tools).GetAwaiter().GetResult();
            storage.SavePreferences(new Preferences { DataRoot = data, SelectedPath = Path.GetDirectoryName(data), ActiveTab = "scenes", LastWorldId = "assets-fixture" });
            Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
            using (var form = new MainForm(storage, new FixtureSession(), new ExistingTools(tools)))
            {
                form.ShowInTaskbar = false; form.StartPosition = FormStartPosition.Manual; form.Location = new Point(-15000, -15000); form.Show();
                var pane = Descendants(form).OfType<ScenesPanel>().Single(); var deadline = DateTime.UtcNow.AddSeconds(25);
                while (DateTime.UtcNow < deadline && (pane.IsBusy || pane.Canvas.Scene == null)) { Application.DoEvents(); Thread.Sleep(15); }
                var sceneList = Descendants(pane).OfType<ListBox>().Single();
                sceneList.SelectedItem = sceneList.Items.Cast<SceneSummary>().Single(value => value.Id == "scene00000000001");
                while (DateTime.UtcNow < deadline && (pane.IsBusy || pane.Canvas.Images == null || pane.Canvas.Images.Background == null)) { Application.DoEvents(); Thread.Sleep(15); }
                Application.DoEvents(); Console.WriteLine("SCENE UI: " + pane.StatusText);
                using (var bitmap = new Bitmap(form.Width, form.Height))
                { form.DrawToBitmap(bitmap, new Rectangle(0, 0, form.Width, form.Height)); string file = Path.Combine(storage.Root, "scenes-preview.png"); bitmap.Save(file, System.Drawing.Imaging.ImageFormat.Png); Console.WriteLine(file); }
                Check(pane.Canvas.Images != null && pane.Canvas.Images.Background != null, "scene UI did not finish loading: " + pane.StatusText);
                Descendants(pane).OfType<CheckBox>().Single(value => value.Text == "Indicatori").Checked = false; Application.DoEvents();
                using (var bitmap = new Bitmap(form.Width, form.Height)) { form.DrawToBitmap(bitmap, new Rectangle(0, 0, form.Width, form.Height)); bitmap.Save(Path.Combine(storage.Root, "scenes-no-indicators.png"), System.Drawing.Imaging.ImageFormat.Png); }
                foreach (var box in Descendants(pane).OfType<CheckBox>().Where(value => value.Text == "Muri" || value.Text == "Luci")) box.Checked = false;
                Application.DoEvents();
                using (var bitmap = new Bitmap(form.Width, form.Height)) { form.DrawToBitmap(bitmap, new Rectangle(0, 0, form.Width, form.Height)); bitmap.Save(Path.Combine(storage.Root, "scenes-no-overlays.png"), System.Drawing.Imaging.ImageFormat.Png); }
                var levelList = Descendants(pane).OfType<ComboBox>().Single(value => value.AccessibleName == "Livello della scena"); levelList.SelectedIndex = 1;
                deadline = DateTime.UtcNow.AddSeconds(10); while (pane.IsBusy && DateTime.UtcNow < deadline) { Application.DoEvents(); Thread.Sleep(15); }
                Check(pane.Canvas.Level.Id == "level00000000002" && !pane.IsBusy, "level selector did not load the upper floor");
                var query = Descendants(pane).OfType<TextBox>().Single(value => value.AccessibleName == "Cerca una scena"); query.Text = "nessuna-corrispondenza"; Application.DoEvents();
                Check(sceneList.Items.Count == 0 && pane.Canvas.Scene == null, "empty search did not clear stale preview");
                query.Text = "cittadella"; deadline = DateTime.UtcNow.AddSeconds(10); while (pane.IsBusy && DateTime.UtcNow < deadline) { Application.DoEvents(); Thread.Sleep(15); }
                Check(sceneList.Items.Count == 1 && pane.Canvas.Scene.Id == "scene00000000001", "search did not restore the matching scene");
                form.Size = form.MinimumSize; Application.DoEvents();
                using (var bitmap = new Bitmap(form.Width, form.Height)) { form.DrawToBitmap(bitmap, new Rectangle(0, 0, form.Width, form.Height)); bitmap.Save(Path.Combine(storage.Root, "scenes-small.png"), System.Drawing.Imaging.ImageFormat.Png); }
                Console.WriteLine("SCENE UI OK: overlays, indicators, levels, search and minimum window size.");
                form.Close();
            }
        }
    }
}
