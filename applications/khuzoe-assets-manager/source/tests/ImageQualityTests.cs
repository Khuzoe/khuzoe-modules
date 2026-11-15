using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace KhuzoeAssetsManager
{
    internal static partial class Tests
    {
        static async Task RunImageQuality()
        {
            await Test("Immagini: quota disco elimina solo copie di dettaglio ricreabili", () => Sync(() => {
                string cache = NewDir("iq-cache"), first = Path.Combine(cache, "detail-" + new string('a', 64) + ".png"), keep = Path.Combine(cache, "detail-" + new string('b', 64) + ".png"), original = Path.Combine(cache, "original.png");
                File.WriteAllBytes(first, new byte[100]); File.WriteAllBytes(keep, new byte[100]); File.WriteAllText(original, "original must remain");
                SceneImages.TrimDetails(cache, keep, 100); Check(!File.Exists(first) && File.Exists(keep) && File.ReadAllText(original) == "original must remain", "detail cleanup touched originals or kept an over-budget copy");
            }));
            await Test("Immagini: dimensioni native, griglia e posizioni esterne in bozze separate", () => Sync(() => {
                var source = DemoScene(); string before = Json.Write(source); var draft = new SceneDraft(source);
                var tile = draft.AddImage(Path.Combine(root, "map.png"), new Size(8000, 6000), new PointF(-1500, 900), source.InitialLevel);
                Check(tile.Width == 8000 && tile.Height == 6000 && tile.X == -1500, "import resized original pixel coordinates");
                var props = new MapProperties(draft, source.InitialLevel); props.GridSize = 140; props.GridDistance = 1.5; props.GridUnits = "m";
                Check(draft.Scene.GridSize == 140 && draft.Scene.GridDistance == 1.5 && tile.X == -1500 && Json.Write(source) == before, "grid edits changed source or moved a layer");
                Throws(() => props.GridSize = 0); Throws(() => props.GridDistance = Double.NaN);
                var blank = new SceneDetail { Id = "local-editor-scene", Width = 2400, Height = 1600, InitialLevel = "main" }; blank.Levels.Add(new SceneLevel { Id = "main" });
                var map = new SceneDraft(blank); map.ChangeMap("map.png", "main", new Size(7000, 5000)); Check(map.Scene.Width == 7000 && map.Scene.Height == 5000 && blank.Width == 2400, "first blank map did not use native dimensions");
                map.ChangeMap("second.png", "main", new Size(4000, 2000)); Check(map.Scene.Width == 7000, "replacing a map silently resized established scene coordinates");
            }));
            await Test("Immagini: trasformazioni inverse, rotazione, specchio e dettaglio limitato", () => Sync(() => {
                var placement = new SceneImagePlacement(new Size(8000, 6000), -1200, 700, 8000, 6000, new SceneTexture { Rotation = 37, ScaleX = -1, ScaleY = .75 });
                var points = new[] { new PointF(1234, 2345) }; using (var matrix = placement.ToScreen(1, 1600, -400)) { matrix.TransformPoints(points); matrix.Invert(); matrix.TransformPoints(points); }
                Check(Math.Abs(points[0].X - 1234) < .01 && Math.Abs(points[0].Y - 2345) < .01, "scene/source pixel mapping drifted");
                var centered = new SceneImagePlacement(new Size(8000, 6000), 0, 0, 8000, 6000, new SceneTexture { Rotation = 37, ScaleX = -1 });
                var spec = centered.VisibleDetail(new Size(1000, 800), 1, 500, 400);
                Check(spec != null && spec.Region.Contains(4000, 3000) && spec.Region.Left >= 0 && spec.Region.Right <= 8000 && spec.Region.Bottom <= 6000, "visible crop missed the native center");
                Check((long)spec.Output.Width * spec.Output.Height <= 2 * 1024 * 1024 && spec.Output.Width <= spec.Region.Width && spec.Output.Height <= spec.Region.Height, "detail violated its pixel budget or upscaled source");
            }));
            await Test("Immagini: dettaglio asincrono, riuso e memoria rilasciata", () => WheelUi((canvas, form) => {
                int calls = 0, ui = Thread.CurrentThread.ManagedThreadId, worker = ui;
                using (var first = new Bitmap(1, 1)) using (var second = new Bitmap(1, 1))
                using (var cache = new SceneImageDetails(value => { }, 40000))
                {
                    var source = new SceneImageSource("source", new Size(1024, 1024), (region, size, token) => { worker = Thread.CurrentThread.ManagedThreadId; Interlocked.Increment(ref calls); return Task.FromResult(new Bitmap(size.Width, size.Height)); });
                    var spec = new SceneDetailSpec { Region = new Rectangle(0, 0, 128, 64), Output = new Size(128, 64) };
                    cache.Request(first, source, spec); Pump(() => !cache.IsBusy); Check(cache.Get(first) != null && calls == 1 && worker != ui, "detail decoded on UI thread or did not complete");
                    cache.Request(first, source, spec); Check(!cache.IsBusy && calls == 1, "identical viewport reloaded an existing patch");
                    cache.Request(second, source, spec); Pump(() => !cache.IsBusy); Check(cache.Get(first) == null && cache.Get(second) != null && cache.Bytes <= 40000, "detail cache did not evict its oldest bitmap");
                    cache.Clear(); Check(cache.Bytes == 0 && cache.Get(second) == null, "clearing detail cache retained images");
                }
            }));
            await Test("Immagini: risultati cancellati non ricompaiono dopo cambio scena", () => WheelUi((canvas, form) => {
                var started = new TaskCompletionSource<bool>(); var release = new TaskCompletionSource<bool>();
                using (var key = new Bitmap(1, 1)) using (var cache = new SceneImageDetails(value => { }))
                {
                    var source = new SceneImageSource("delayed", new Size(1024, 1024), async (region, size, token) => { started.TrySetResult(true); await release.Task; return new Bitmap(size.Width, size.Height); });
                    cache.Request(key, source, new SceneDetailSpec { Region = new Rectangle(0, 0, 64, 64), Output = new Size(64, 64) }); Pump(() => started.Task.IsCompleted);
                    cache.Clear(); release.SetResult(true); Pump(() => !cache.IsBusy); Check(cache.Get(key) == null && cache.Bytes == 0, "cancelled detail appeared in the new scene");
                }
            }));
            await Test("Immagini: dettaglio mantiene opacità e consente lavoro fuori mappa", () => WheelUi((canvas, form) => {
                var source = DemoScene(); source.Levels[0].BackgroundColor = "#000000"; var draft = new SceneDraft(source); canvas.Draft = draft; canvas.Editing = true;
                var tile = draft.AddImage("native.png", new Size(1024, 1024), new PointF(1200, 900), source.InitialLevel); new ImageProperties(draft).Alpha = .5;
                string before = draft.Snapshot(); int decoded = 0;
                using (var images = new SceneImageSet())
                {
                    var preview = new Bitmap(16, 16); using (var g = Graphics.FromImage(preview)) g.Clear(Color.FromArgb(128, 200, 100, 48)); images.Tiles[tile.Id] = preview;
                    images.Sources[preview] = new SceneImageSource("alpha", new Size(1024, 1024), (region, size, token) => { Interlocked.Increment(ref decoded); var result = new Bitmap(size.Width, size.Height); using (var g = Graphics.FromImage(result)) g.Clear(Color.FromArgb(128, 200, 100, 48)); return Task.FromResult(result); });
                    canvas.Settings.Grid = canvas.Settings.Walls = canvas.Settings.Lights = canvas.Settings.Indicators = false;
                    canvas.SetScene(draft.Scene, draft.Scene.Levels[0], images, true); canvas.ChangeZoom(1 / canvas.Zoom);
                    using (var initialFrame = new Bitmap(canvas.Width, canvas.Height)) canvas.DrawToBitmap(initialFrame, canvas.ClientRectangle);
                    Application.DoEvents();
                    var deadline = DateTime.UtcNow.AddSeconds(4); while ((decoded == 0 || canvas.IsLoadingImageDetail) && DateTime.UtcNow < deadline) { Application.DoEvents(); Thread.Sleep(15); }
                    Check(decoded > 0 && !canvas.IsLoadingImageDetail, "HD incomplete: decoded=" + decoded + ", busy=" + canvas.IsLoadingImageDetail + ", error=" + canvas.ImageDetailError + ", sources=" + canvas.Images.Sources.Count + ", zoom=" + canvas.Zoom + ", anchor=" + canvas.ScenePoint(new Point(canvas.Width / 2, canvas.Height / 2), false));
                    using (var frame = new Bitmap(canvas.Width, canvas.Height)) { canvas.DrawToBitmap(frame, canvas.ClientRectangle); var center = frame.GetPixel(canvas.Width / 2 + 10, canvas.Height / 2 + 10); Check(Math.Abs(center.R - 50) < 4 && Math.Abs(center.G - 25) < 4 && Math.Abs(center.B - 12) < 4, "high-resolution patch doubled layer opacity"); }
                    Check(draft.Snapshot() == before, "loading detail edited the document");
                    var external = canvas.ScenePoint(canvas.SceneScreen(-200, -150), false); Check(external.X < -190 && external.Y < -140, "scene coordinates were clamped to map edges");
                    new ImageProperties(draft).X = -1800; new ImageProperties(draft).Y = -1000; canvas.SetScene(draft.Scene, draft.Scene.Levels[0], images, true);
                    var corners = canvas.ImageCorners(draft.Image); Check(corners.All(p => canvas.SceneScreen(p.X, p.Y).X >= 10 && canvas.SceneScreen(p.X, p.Y).X <= canvas.Width - 10), "fit ignored an image placed outside the map");
                    canvas.SetScene(null, null, null, true);
                }
            }));
        }
        static async Task ImageQualitySmoke(string folder)
        {
            string location = Path.GetFullPath(folder); Directory.CreateDirectory(location); string file = Path.Combine(location, "native-map.png");
            using (var original = new Bitmap(4096, 3072))
            {
                using (var g = Graphics.FromImage(original))
                {
                    g.Clear(Color.FromArgb(238, 235, 214)); using (var brush = new SolidBrush(Color.FromArgb(41, 59, 65))) for (int x = 0; x < original.Width; x += 4) g.FillRectangle(brush, x, 0, 1, original.Height);
                    using (var pen = new Pen(Color.DarkRed, 3)) for (int y = 0; y < original.Height; y += 140) g.DrawLine(pen, 0, y, original.Width, y);
                    using (var font = new Font("Segoe UI", 44F, FontStyle.Bold)) using (var brush = new SolidBrush(Color.Black)) g.DrawString("DETTAGLIO NATIVO · GRIGLIA 140 PX", font, brush, 1250, 1400);
                }
                original.Save(file, ImageFormat.Png); string hash = FoundryPaths.Hash(file); var storage = new AppStorage(Path.Combine(location, "state")); var paths = PreparedSceneTools(); var loader = new SceneImages(storage, new ExistingTools(paths), new ProcessRunner());
                using (var asset = await loader.LoadLocalAssetAsync(file, value => { }, CancellationToken.None))
                {
                    Check(asset.Source.NativeSize == original.Size && asset.Image.Width == 1024, "native dimensions were replaced with preview dimensions");
                    var region = new Rectangle(1231, 871, 503, 337);
                    using (var patch = await asset.Source.ReadRegionAsync(region, region.Size, CancellationToken.None))
                    {
                        int maxError = 0; for (int y = 2; y < region.Height - 2; y += 13) for (int x = 2; x < region.Width - 2; x += 17) { var a = original.GetPixel(region.X + x, region.Y + y); var b = patch.GetPixel(x, y); maxError = Math.Max(maxError, Math.Max(Math.Abs(a.R - b.R), Math.Max(Math.Abs(a.G - b.G), Math.Abs(a.B - b.B)))); }
                        Check(maxError <= 1, "native crop lost source pixel detail: " + maxError); patch.Save(Path.Combine(location, "native-detail.png"));
                    }
                    using (var cached = await loader.LoadLocalAssetAsync(file, value => { }, CancellationToken.None)) Check(cached.Source.NativeSize == original.Size, "cached preview forgot native dimensions");
                }
                Check(FoundryPaths.Hash(file) == hash, "detail generation changed original image");
            }
            Console.WriteLine("IMAGE QUALITY OK: native 4096x3072, preview 1024x768, exact odd-offset native crop, metadata cache and unchanged original.");
        }
        static void RenderImageQuality(string folder)
        {
            string location = Path.GetFullPath(folder); ImageQualitySmoke(location).GetAwaiter().GetResult();
            var storage = new AppStorage(Path.Combine(location, "state")); string data = Foundry(location); var tools = PreparedSceneTools();
            string file = Path.Combine(location, "native-map.png"), originalHash = FoundryPaths.Hash(file);
            storage.SavePreferences(new Preferences { DataRoot = data, ActiveTab = "scenes" });
            Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
            using (var form = new MainForm(storage, new FixtureSession(), new ExistingTools(tools)))
            {
                form.ShowInTaskbar = false; form.StartPosition = FormStartPosition.Manual; form.Location = new Point(-15000, -15000); form.Show();
                SynchronizationContext.SetSynchronizationContext(new WindowsFormsSynchronizationContext());
                var pane = Descendants(form).OfType<ScenesPanel>().Single(); Pump(() => !pane.IsBusy); pane.OpenBlankDraft();
                var task = pane.ImportLocalImageAsync(file, false); Pump(() => task.IsCompleted && !pane.IsBusy); task.GetAwaiter().GetResult();
                Check(pane.Draft.Scene.Tiles.Count == 1 && pane.Draft.Scene.Tiles[0].Width == 4096 && pane.Draft.Scene.Tiles[0].Height == 3072, "UI import did not retain native dimensions: " + pane.StatusText);
                new ImageProperties(pane.Draft).X = 2048; new ImageProperties(pane.Draft).Y = 1536;
                new MapProperties(pane.Draft, pane.Canvas.Level.Id).GridSize = 140;
                pane.Canvas.Fit(); pane.Canvas.ChangeZoom(1 / pane.Canvas.Zoom); Screenshot(form, Path.Combine(location, "quality-loading.png"));
                Pump(() => !pane.Canvas.IsLoadingImageDetail); Check(String.IsNullOrEmpty(pane.Canvas.ImageDetailError), "UI detail load failed: " + pane.Canvas.ImageDetailError);
                Screenshot(form, Path.Combine(location, "quality-native.png"));
                pane.Draft.Select(SceneSelectionKind.Map, pane.Canvas.Level.Id); Application.DoEvents(); Screenshot(form, Path.Combine(location, "quality-grid.png"));
                string patch = Path.Combine(location, "adjacent.png");
                using (var image = new Bitmap(320, 280)) using (var graphics = Graphics.FromImage(image))
                { graphics.Clear(Color.FromArgb(48, 96, 74)); using (var pen = new Pen(Color.Gold, 4)) graphics.DrawRectangle(pen, 10, 10, 299, 259); using (var font = new Font("Segoe UI", 23F, FontStyle.Bold)) graphics.DrawString("AREA NUOVA", font, Brushes.White, 35, 110); image.Save(patch, ImageFormat.Png); }
                task = pane.ImportLocalImageAsync(patch, false, new PointF(4256, 140)); Pump(() => task.IsCompleted && !pane.IsBusy); task.GetAwaiter().GetResult();
                pane.Canvas.Fit(); Screenshot(form, Path.Combine(location, "quality-composition.png"));
                Check(pane.Draft.Scene.Tiles.Count == 2 && pane.Draft.Scene.Tiles[1].X - pane.Draft.Scene.Tiles[1].Width / 2 == 4096 && pane.Draft.Scene.Tiles[0].X == 2048, "adjacent layer placement moved or flattened the base map");
                Check(FoundryPaths.Hash(file) == originalHash && Directory.GetFiles(data, "*", SearchOption.AllDirectories).Length == 0, "quality editor modified source or Foundry files");
                form.Close();
            }
            Console.WriteLine("QUALITY UI OK: native import, 1:1 detail, 140px grid, independent adjacent layer, fit outside map and unchanged originals/Foundry data.");
        }
    }
}
