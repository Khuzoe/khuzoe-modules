using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace KhuzoeAssetsManager
{
    internal static partial class Tests
    {
        static async Task RunEditor()
        {
            await Test("Editor: identità scena indipendente dall'ordine JSON e bozze precedenti leggibili", () => Sync(() => {
                Check(SceneDraft.SceneIdentity("{\"x\":1,\"nested\":{\"a\":2,\"b\":3}}") == SceneDraft.SceneIdentity("{\"nested\":{\"b\":3,\"a\":2},\"x\":1}"), "property order changed scene identity");
                var storage = new AppStorage(NewDir("old-draft")); var source = DemoScene(); var draft = new SceneDraft(source); draft.AddLight(new PointF(600, 600), source.InitialLevel);
                string directory = Path.Combine(storage.Root, "scene-drafts"); Directory.CreateDirectory(directory);
                Json.Save(Path.Combine(directory, SceneDraft.Digest("old") + ".json"), new SceneDraftRecord { Schema = 1, OriginalHash = draft.LegacyOriginalHash, Scene = draft.Scene });
                var loaded = new SceneDraft(source); Check(new SceneDraftStore(storage).Load("old", loaded) && loaded.Scene.Lights.Count == 2, "previous draft format was rejected");
            }));
            await Test("Editor: clone, creazione e modifica senza mutare la scena originale", () => Sync(() => {
                var source = DemoScene(); string original = Json.Write(source); var draft = new SceneDraft(source);
                var light = draft.AddLight(new PointF(900, 600), source.InitialLevel); new LightProperties(draft).Color = Color.CornflowerBlue;
                draft.AddWall(new PointF(100, 100), new PointF(500, 100), source.InitialLevel); new WallProperties(draft).Door = EditorDoor.Porta;
                draft.AddImage(Path.Combine(root, "external.png"), new Size(200, 100), new PointF(1000, 700), source.InitialLevel); new ImageProperties(draft).Rotation = 45;
                draft.ChangeMap(Path.Combine(root, "map.png"), source.InitialLevel); new MapProperties(draft, source.InitialLevel).ScaleX = 1.5;
                Check(Json.Write(source) == original && draft.Scene.Lights.Count == 2 && draft.Scene.Walls.Count == 2 && draft.Scene.Tiles.Count == 1 && draft.IsDirty, "editing leaked into source or lost data");
                Check(draft.Scene.Lights.Single(value => value.Id == light.Id).Color == "#6495ed" && draft.Scene.Tiles[0].Rotation == 45, "properties not applied to the draft");
            }));
            await Test("Editor: annulla, ripeti, duplica, elimina e ripristina", () => Sync(() => {
                var draft = new SceneDraft(DemoScene()); draft.AddLight(new PointF(900, 600), draft.Scene.InitialLevel); draft.DuplicateSelection();
                Check(draft.Scene.Lights.Select(value => value.Id).Distinct().Count() == 3, "duplicate IDs");
                draft.DeleteSelection(); Check(draft.Scene.Lights.Count == 2, "delete failed"); draft.Undo(); Check(draft.Scene.Lights.Count == 3, "undo delete failed"); draft.Redo(); Check(draft.Scene.Lights.Count == 2, "redo failed");
                draft.Reset(); Check(!draft.IsDirty && draft.Scene.Lights.Count == 1, "reset did not restore baseline"); draft.Undo(); Check(draft.IsDirty && draft.Scene.Lights.Count == 2, "reset cannot be undone");
            }));
            await Test("Editor: valori invalidi e gesto annullato non lasciano modifiche", () => Sync(() => {
                var draft = new SceneDraft(DemoScene()); draft.Select(SceneSelectionKind.Light, draft.Scene.Lights[0].Id); string before = draft.Snapshot();
                Throws(() => new LightProperties(draft).Bright = Double.NaN); Throws(() => new LightProperties(draft).Dim = -1);
                Check(draft.Snapshot() == before && !draft.CanUndo, "invalid value changed history");
                draft.Light.X += 150; draft.Cancel(before); Check(draft.Snapshot() == before && !draft.CanUndo && !draft.IsDirty, "escape did not restore draft");
            }));
            await Test("Editor: bozze persistenti solo nello stato app e conflitti rilevati", () => Sync(() => {
                string folder = NewDir("draft-persistence"); var storage = new AppStorage(Path.Combine(folder, "state")); string data = Foundry(folder);
                string sentinel = Path.Combine(data, "worlds", "untouched.txt"); File.WriteAllText(sentinel, "world original"); var store = new SceneDraftStore(storage);
                var draft = new SceneDraft(DemoScene()); draft.AddWall(new PointF(100, 200), new PointF(600, 200), draft.Scene.InitialLevel); store.Save(data + "|world|scene", draft);
                var loaded = new SceneDraft(DemoScene()); Check(store.Load(data + "|world|scene", loaded) && loaded.IsDirty && loaded.Scene.Walls.Count == 2, "draft did not restore");
                var changedSource = DemoScene(); changedSource.Lights[0].X++; Check(!store.Load(data + "|world|scene", new SceneDraft(changedSource)), "stale draft applied to changed source");
                loaded.Reset(); store.Save(data + "|world|scene", loaded); Check(!Directory.GetFiles(Path.Combine(storage.Root, "scene-drafts")).Any(), "reset did not clear local draft");
                Check(File.ReadAllText(sentinel) == "world original" && Directory.GetFiles(data, "*.json", SearchOption.AllDirectories).Length == 0, "editor wrote into Foundry");
            }));
            await Test("Editor: import immagine esterna senza scritture ai dati Foundry", async () => {
                string folder = NewDir("external-image"), data = Foundry(folder), imageFile = Path.Combine(folder, "external.png");
                using (var image = new Bitmap(128, 64)) { using (var g = Graphics.FromImage(image)) g.Clear(Color.CornflowerBlue); image.Save(imageFile, ImageFormat.Png); }
                string before = FoundryPaths.Hash(imageFile); var paths = new ExistingTools(new ToolPaths { Ffmpeg = "fake-ffmpeg.exe" });
                var loader = new SceneImages(new AppStorage(Path.Combine(folder, "state")), paths, new ImageRunner());
                using (var image = await loader.LoadLocalAsync(imageFile, value => { }, CancellationToken.None)) Check(image.Width == 128 && image.Height == 64, "external image decode failed");
                var draft = new SceneDraft(DemoScene()); var tile = draft.AddImage(imageFile, new Size(128, 64), new PointF(700, 700), draft.Scene.InitialLevel);
                using (var images = await loader.LoadLevelAsync(data, draft.Scene, draft.Scene.Levels[0], value => { }, CancellationToken.None)) Check(images.Tiles.ContainsKey(tile.Id), "alias did not resolve imported image");
                Check(FoundryPaths.Hash(imageFile) == before && Directory.GetFiles(data, "*", SearchOption.AllDirectories).Length == 0, "import changed source image or Foundry files");
            });
            await Test("Editor: hit test e gesti reali per muri, luci e immagini ruotate", async () => {
                var done = new TaskCompletionSource<bool>(); var thread = new Thread(() => {
                    try
                    {
                        using (var form = new Form { Size = new Size(820, 650), ShowInTaskbar = false, StartPosition = FormStartPosition.Manual, Location = new Point(-15000, -15000) })
                        using (var canvas = new SceneCanvas())
                        using (var images = new SceneImageSet())
                        {
                            form.Controls.Add(canvas); form.Show(); Application.DoEvents();
                            var source = DemoScene(); string baseline = Json.Write(source); var draft = new SceneDraft(source); canvas.Draft = draft; canvas.Editing = true;
                            Action refresh = () => canvas.SetScene(draft.Scene, draft.Scene.Levels[0], images, false); draft.Changed += (s, e) => refresh();
                            canvas.SetScene(draft.Scene, draft.Scene.Levels[0], images, true);
                            int changes = 0; draft.Changed += (s, e) => changes++; var originalClone = draft.Scene;
                            Point originalLight = canvas.SceneScreen(source.Lights[0].X, source.Lights[0].Y);
                            Mouse(canvas, "OnMouseDown", originalLight); Mouse(canvas, "OnMouseUp", originalLight);
                            Mouse(canvas, "OnMouseDown", originalLight); canvas.CancelEditorGesture();
                            Check(changes == 0 && !draft.CanUndo && Object.ReferenceEquals(originalClone, draft.Scene), "selection-only gesture rebuilt or saved the scene");
                            canvas.Tool = SceneEditTool.Wall;
                            Mouse(canvas, "OnMouseDown", canvas.SceneScreen(800, 500)); Mouse(canvas, "OnMouseMove", canvas.SceneScreen(1300, 500)); Mouse(canvas, "OnMouseUp", canvas.SceneScreen(1300, 500)); Check(draft.Scene.Walls.Count == 2 && draft.CanUndo, "wall drag did not create a segment");
                            canvas.Tool = SceneEditTool.Light; Mouse(canvas, "OnMouseDown", canvas.SceneScreen(1400, 1000)); Mouse(canvas, "OnMouseUp", canvas.SceneScreen(1400, 1000)); Check(draft.Scene.Lights.Count == 2, "light click did not create a light");
                            canvas.Tool = SceneEditTool.Select; var light = draft.Scene.Lights.Last(); draft.Select(SceneSelectionKind.None, null);
                            Mouse(canvas, "OnMouseDown", canvas.SceneScreen(light.X, light.Y)); Mouse(canvas, "OnMouseMove", canvas.SceneScreen(light.X + 120, light.Y + 100)); Mouse(canvas, "OnMouseUp", canvas.SceneScreen(1520, 1100)); Check(draft.Light != null && Math.Abs(draft.Light.X - 1520) < 12, "light drag failed");
                            var tile = draft.AddImage("fixture.png", new Size(200, 100), new PointF(1000, 1000), source.InitialLevel); new ImageProperties(draft).Rotation = 45; refresh();
                            Check(canvas.HitTestElement(canvas.SceneScreen(1000, 1000)).Id == tile.Id, "rotated image hit test failed");
                            PointF corner = canvas.ImageCorners(tile)[2]; Mouse(canvas, "OnMouseDown", canvas.SceneScreen(corner.X, corner.Y)); Mouse(canvas, "OnMouseMove", canvas.SceneScreen(corner.X + 100, corner.Y + 150)); Mouse(canvas, "OnMouseUp", canvas.SceneScreen(corner.X + 100, corner.Y + 150)); Check(tile.Width > 200 && tile.Height > 100, "image resize handle did not change dimensions");
                            Check(Json.Write(source) == baseline, "canvas gestures mutated original scene"); form.Close();
                        }
                        done.SetResult(true);
                    } catch (Exception error) { done.SetException(error); }
                }); thread.SetApartmentState(ApartmentState.STA); thread.Start(); await done.Task;
            });
            await Test("Editor: scrittura asincrona ordinata, accorpata e completata alla chiusura", async () => {
                var original = DemoScene(); var draft = new SceneDraft(original); var store = new SceneDraftStore(new AppStorage(NewDir("wr")));
                var started = new TaskCompletionSource<bool>(); var snapshots = new List<string>(); int writes = 0;
                using (var release = new ManualResetEventSlim(false))
                using (var saver = new SceneDraftSaver((key, hash, snapshot, dirty) => {
                    if (++writes == 1) { started.SetResult(true); if (!release.Wait(5000)) throw new IOException("Writer fixture timed out"); }
                    snapshots.Add(snapshot); store.SaveSnapshot(key, hash, snapshot, dirty);
                }))
                {
                    draft.Select(SceneSelectionKind.Light, original.Lights[0].Id); new LightProperties(draft).X = 901; string first = draft.CommittedSnapshot; saver.Queue("draft", draft);
                    await started.Task;
                    for (int i = 0; i < 10; i++) { new LightProperties(draft).X = 1000 + i; saver.Queue("draft", draft); }
                    string last = draft.CommittedSnapshot;
                    var reopened = new SceneDraft(original); Check(saver.RestorePending("draft", reopened) && reopened.Scene.Lights[0].X == 1009, "reopening while the writer is busy lost pending changes");
                    var changedOriginal = SceneDraft.Copy(original); changedOriginal.Lights[0].X++;
                    Check(!saver.RestorePending("draft", new SceneDraft(changedOriginal)), "pending draft was restored over changed source data");
                    release.Set(); await saver.FlushAsync();
                    Check(writes == 2 && snapshots[0] == first && snapshots[1] == last && saver.PendingRevision("draft") == 0 && saver.LastError("draft") == null, "queued snapshots were mutable, out of order or not coalesced");
                    var loaded = new SceneDraft(original); Check(store.Load("draft", loaded) && loaded.Scene.Lights[0].X == 1009, "last queued draft did not persist");
                    draft.Reset(); saver.Queue("draft", draft);
                }
                var reset = new SceneDraft(original); Check(store.Load("draft", reset) && !reset.IsDirty, "closing did not finish reset persistence");
                Check(original.Lights[0].X == 800, "asynchronous writer mutated source");
            });
            await Test("Editor: errori di salvataggio riportati e nuovo tentativo possibile", async () => {
                int attempts = 0; var draft = new SceneDraft(DemoScene()); draft.AddLight(new PointF(500, 500), draft.Scene.InitialLevel);
                using (var saver = new SceneDraftSaver((key, hash, snapshot, dirty) => { if (++attempts == 1) throw new IOException("Simulated full disk"); }))
                {
                    saver.Queue("draft", draft); await saver.FlushAsync(); Check(saver.LastError("draft") is IOException, "writer failure was lost");
                    saver.Queue("draft", draft); await saver.FlushAsync(); Check(attempts == 2 && saver.LastError("draft") == null, "writer did not recover after failure");
                }
            });
            await Test("Scene: cache raster limitata, trasparenza e originali conservati", () => Sync(() => {
                using (var first = new Bitmap(256, 128)) using (var second = new Bitmap(256, 128)) using (var cache = new SceneRasterCache(8192))
                {
                    using (var g = Graphics.FromImage(first)) { g.Clear(Color.Transparent); using (var brush = new SolidBrush(Color.FromArgb(128, 60, 120, 180))) g.FillRectangle(brush, 0, 0, 256, 128); }
                    var preview = cache.Get(first, 0.1); var pixel = ((Bitmap)preview).GetPixel(preview.Width / 2, preview.Height / 2);
                    Check(preview.Width < first.Width && pixel.A == 128 && Math.Abs(pixel.B - 180) < 3, "display preview lost image scale or transparency");
                    Check(Object.ReferenceEquals(preview, cache.Get(first, 0.1)), "steady rendering rebuilt the same preview");
                    cache.Get(second, 0.1); Check(cache.Count == 1 && cache.Bytes <= 8192, "raster cache exceeded its memory budget");
                    Check(Object.ReferenceEquals(first, cache.Get(first, 1)), "zoom did not retain access to full resolution");
                    cache.Clear(); Check(cache.Count == 0 && cache.Bytes == 0 && first.Width == 256, "cache retained memory or disposed original asset");
                }
            }));
            await Test("Scene: sfondo memorizzato aggiornato con spostamento, zoom e dimensioni", () => Sync(() => {
                using (var image = new Bitmap(16, 16)) using (var target = new Bitmap(100, 80)) using (var graphics = Graphics.FromImage(target)) using (var cache = new SceneBackdropCache())
                {
                    int rendered = 0; var texture = new SceneTexture(); Action<Graphics> render = g => { rendered++; using (var brush = new SolidBrush(Color.FromArgb(128, 240, 80, 30))) g.FillRectangle(brush, 10, 10, 20, 20); };
                    Action<double, double, Size> draw = (px, zoom, size) => { graphics.Clear(Color.Transparent); Check(cache.TryDraw(graphics, size, image, texture, "#ffffff", px, 0, zoom, 0, 0, 100, 80, render), "backdrop not cached"); };
                    draw(0, 1, new Size(100, 80)); var first = target.GetPixel(15, 15); draw(0, 1, new Size(100, 80));
                    Check(rendered == 1 && first.A == 128 && target.GetPixel(15, 15).A == 128, "steady frame rerendered or accumulated opacity");
                    draw(30, 1, new Size(100, 80)); Check(rendered == 2 && target.GetPixel(15, 15).A == 0 && target.GetPixel(45, 15).A == 128, "panning reused stale screen pixels");
                    texture.OffsetX = 20; draw(30, 1, new Size(100, 80)); Check(rendered == 3, "map texture edit did not invalidate backdrop");
                    draw(0, 2, new Size(100, 80)); draw(0, 2, new Size(90, 70)); Check(rendered == 5, "zoom or resizing reused an incorrect backdrop");
                    cache.Clear(); draw(0, 2, new Size(90, 70)); Check(rendered == 6 && image.Width == 16, "releasing cache damaged source image");
                }
            }));
            await Test("Editor: ispettore stabile e selezione valida dopo annulla/ripeti", async () => {
                var done = new TaskCompletionSource<bool>(); var thread = new Thread(() => {
                    try
                    {
                        using (var form = new Form { Size = new Size(900, 600), ShowInTaskbar = false, StartPosition = FormStartPosition.Manual, Location = new Point(-15000, -15000) })
                        using (var canvas = new SceneCanvas()) using (var panel = new SceneEditorPanel(canvas))
                        {
                            panel.Dock = DockStyle.Right; panel.Width = 240; form.Controls.Add(canvas); form.Controls.Add(panel); form.Show();
                            var draft = new SceneDraft(DemoScene()); canvas.SetScene(draft.Scene, draft.Scene.Levels[0], null, true); panel.Bind(draft); panel.SetEditing(true); draft.Select(SceneSelectionKind.Light, draft.Scene.Lights[0].Id);
                            var grid = Descendants(panel).OfType<PropertyGrid>().Single(); object adapter = grid.SelectedObject;
                            new LightProperties(draft).X = 910; new LightProperties(draft).X = 930; Application.DoEvents();
                            Check(Object.ReferenceEquals(adapter, grid.SelectedObject), "property change rebound the inspector");
                            var previous = draft.Light; draft.Undo(); Application.DoEvents(); Check(draft.Light.X == 910 && !Object.ReferenceEquals(previous, draft.Light) && Object.ReferenceEquals(draft.Light, draft.Scene.Lights[0]), "selection pointed at stale undo data");
                            draft.Redo(); Application.DoEvents(); Check(draft.Light.X == 930 && Object.ReferenceEquals(adapter, grid.SelectedObject), "redo lost selection or inspector");
                            panel.SetEditing(false); Check(grid.SelectedObject == null, "disabled inspector retained editable properties"); form.Close();
                        }
                        done.SetResult(true);
                    } catch (Exception error) { done.SetException(error); }
                }); thread.SetApartmentState(ApartmentState.STA); thread.Start(); await done.Task;
            });
        }
        static void Mouse(SceneCanvas canvas, string name, Point point)
        { typeof(SceneCanvas).GetMethod(name, BindingFlags.Instance | BindingFlags.NonPublic).Invoke(canvas, new object[] { new MouseEventArgs(MouseButtons.Left, 1, point.X, point.Y, 0) }); }
        sealed class ImageRunner : IProcessRunner
        {
            public Task<ProcessResult> RunAsync(string executable, IList<string> args, TimeSpan timeout, CancellationToken cancellation, Action<string> line)
            { string file = args[args.IndexOf("-i") + 1]; File.Copy(file, args.Last()); using (var image = Image.FromFile(file)) return Task.FromResult(new ProcessResult { Output = "", Error = "[Parsed_showinfo_0 @ fixture] n:0 s:" + image.Width + "x" + image.Height }); }
        }
        static void RenderEditor(string location)
        {
            var storage = new AppStorage(location); string data = Foundry(storage.Root); var tools = PreparedSceneTools(); CreateSceneFixture(data, tools).GetAwaiter().GetResult();
            var originalFiles = Directory.GetFiles(data, "*", SearchOption.AllDirectories).ToDictionary(value => value, FoundryPaths.Hash);
            string overlay = Path.Combine(storage.Root, "overlay.png");
            using (var image = new Bitmap(320, 210)) using (var g = Graphics.FromImage(image))
            {
                g.Clear(Color.Transparent); using (var brush = new SolidBrush(Color.FromArgb(188, 87, 41))) g.FillEllipse(brush, 12, 12, 280, 180);
                using (var font = new Font("Georgia", 24F, FontStyle.Bold)) using (var brush = new SolidBrush(Color.FromArgb(250, 219, 158))) g.DrawString("SIGILLO", font, brush, 58, 75);
                image.Save(overlay, ImageFormat.Png);
            }
            storage.SavePreferences(new Preferences { DataRoot = data, ActiveTab = "scenes", LastWorldId = "assets-fixture" });
            Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
            using (var form = new MainForm(storage, new FixtureSession(), new ExistingTools(tools)))
            {
                form.ShowInTaskbar = false; form.StartPosition = FormStartPosition.Manual; form.Location = new Point(-15000, -15000); form.Show();
                SynchronizationContext.SetSynchronizationContext(new WindowsFormsSynchronizationContext());
                var pane = Descendants(form).OfType<ScenesPanel>().Single(); Pump(() => !pane.IsBusy && pane.Canvas.Scene != null);
                var list = Descendants(pane).OfType<ListBox>().Single(); list.SelectedItem = list.Items.Cast<SceneSummary>().Single(value => value.Id == "scene00000000001"); Pump(() => !pane.IsBusy && pane.Canvas.Images != null && pane.Canvas.Images.Background != null);
                pane.SetEditMode(true); string original = Json.Write(pane.Canvas.Scene);
                var task = pane.ImportLocalImageAsync(overlay, false); Pump(() => task.IsCompleted && !pane.IsBusy); task.GetAwaiter().GetResult();
                Check(pane.Draft.Scene.Tiles.Count == 1, "UI image import failed: " + pane.StatusText);
                new ImageProperties(pane.Draft).Rotation = -18; new ImageProperties(pane.Draft).Width = 420;
                Application.DoEvents(); Screenshot(form, Path.Combine(storage.Root, "editor-image.png"));
                var zoomPoint = new Point(pane.Canvas.Width / 2 + 35, pane.Canvas.Height / 2 - 20);
                var zoomAnchor = pane.Canvas.ScenePoint(zoomPoint, false); Wheel(pane.Canvas, zoomPoint, 120); Wheel(pane.Canvas, zoomPoint, 120);
                Screenshot(form, Path.Combine(storage.Root, "editor-wheel-preview.png")); Pump(() => !pane.Canvas.WheelPreviewActive);
                Check(Math.Abs(pane.Canvas.ScenePoint(zoomPoint, false).X - zoomAnchor.X) < .01 && Math.Abs(pane.Canvas.ScenePoint(zoomPoint, false).Y - zoomAnchor.Y) < .01, "UI wheel zoom drifted from its anchor");
                Screenshot(form, Path.Combine(storage.Root, "editor-wheel-quality.png")); pane.Canvas.Fit();
                pane.Editor.SetTool(SceneEditTool.Wall); Mouse(pane.Canvas, "OnMouseDown", pane.Canvas.SceneScreen(600, 1200)); Mouse(pane.Canvas, "OnMouseMove", pane.Canvas.SceneScreen(1400, 1200)); Mouse(pane.Canvas, "OnMouseUp", pane.Canvas.SceneScreen(1400, 1200)); new WallProperties(pane.Draft).Door = EditorDoor.Porta; Application.DoEvents(); Screenshot(form, Path.Combine(storage.Root, "editor-wall.png"));
                pane.Editor.SetTool(SceneEditTool.Light); Mouse(pane.Canvas, "OnMouseDown", pane.Canvas.SceneScreen(1200, 600)); Mouse(pane.Canvas, "OnMouseUp", pane.Canvas.SceneScreen(1200, 600)); new LightProperties(pane.Draft).Color = Color.MediumPurple; Application.DoEvents(); Screenshot(form, Path.Combine(storage.Root, "editor-light.png"));
                form.Size = form.MinimumSize; Application.DoEvents(); Screenshot(form, Path.Combine(storage.Root, "editor-small.png"));
                Check(pane.Draft.IsDirty && Json.Write(pane.Canvas.Scene) != original && pane.Draft.CanUndo, "UI editor did not change local draft");
                task = pane.ImportLocalImageAsync(overlay, true); Pump(() => task.IsCompleted && !pane.IsBusy); task.GetAwaiter().GetResult();
                Check(pane.Canvas.Images.Background != null && pane.Canvas.Level.Background.StartsWith("khuzoe-local/", StringComparison.Ordinal), "UI map replacement failed");
                new MapProperties(pane.Draft, pane.Canvas.Level.Id).X = 150; pane.Draft.Undo(); pane.Draft.Redo();
                pane.OpenBlankDraft(); pane.Draft.AddLight(new PointF(600, 500), pane.Canvas.Level.Id); pane.OpenBlankDraft();
                Check(pane.Draft.Scene.Lights.Count == 1 && pane.Draft.IsDirty, "blank workbench did not reopen its draft");
                Application.DoEvents(); Screenshot(form, Path.Combine(storage.Root, "editor-blank.png"));
                Check(originalFiles.Count == Directory.GetFiles(data, "*", SearchOption.AllDirectories).Length && originalFiles.All(value => FoundryPaths.Hash(value.Key) == value.Value), "UI editor modified original Foundry files");
                Console.WriteLine("EDITOR UI OK: image import, resize/rotation, wall/light tools, properties, minimum size, map replacement, reopened blank draft and unchanged Foundry files."); form.Close();
                Check(Directory.GetFiles(Path.Combine(storage.Root, "scene-drafts"), "*.json").Select(file => Json.Read<SceneDraftRecord>(File.ReadAllText(file))).Any(record => record.Scene.Id == "local-editor-scene" && record.Scene.Lights.Count == 1), "closing the app lost its last queued draft");
            }
        }
        static void Pump(Func<bool> ready)
        { var deadline = DateTime.UtcNow.AddSeconds(30); while (!ready() && DateTime.UtcNow < deadline) { Application.DoEvents(); Thread.Sleep(15); } Application.DoEvents(); Check(ready(), "UI operation did not complete"); }
        static void Screenshot(Form form, string file)
        { using (var image = new Bitmap(form.Width, form.Height)) { form.DrawToBitmap(image, new Rectangle(0, 0, form.Width, form.Height)); image.Save(file, ImageFormat.Png); Console.WriteLine(file); } }
    }
}
