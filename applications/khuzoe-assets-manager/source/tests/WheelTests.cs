using System;
using System.Drawing;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace KhuzoeAssetsManager
{
    internal static partial class Tests
    {
        static async Task RunWheel()
        {
            await Test("Zoom: anteprima riusa i raster e ripristina la risoluzione richiesta", () => Sync(() => {
                using (var image = new Bitmap(512, 256)) using (var cache = new SceneRasterCache(65536))
                {
                    Check(Object.ReferenceEquals(image, cache.Get(image, 0.2, true)) && cache.Count == 0, "wheel generated a raster before one was available");
                    var preview = cache.Get(image, 0.2); long bytes = cache.Bytes;
                    Check(Object.ReferenceEquals(preview, cache.Get(image, 2, true)) && Object.ReferenceEquals(preview, cache.Get(image, 0.05, true)) && cache.Bytes == bytes, "wheel rebuilt a preview at every scale");
                    Check(Object.ReferenceEquals(image, cache.Get(image, 2)), "full-quality zoom did not use the original resolution");
                    Check(!Object.ReferenceEquals(preview, cache.Get(image, 0.05)) && cache.Bytes < bytes, "idle quality kept an outdated raster scale");
                }
            }));
            await Test("Zoom: puntatore ancorato, delta precisi, limiti e documenti invariati", () => WheelUi((canvas, form) => {
                var source = DemoScene(); string before = Json.Write(source); var draft = new SceneDraft(source); canvas.Draft = draft; canvas.Editing = true;
                canvas.SetScene(draft.Scene, draft.Scene.Levels[0], null, true); double initial = canvas.Zoom;
                var point = new Point(canvas.Width / 2 + 45, canvas.Height / 2 - 30); var anchor = canvas.ScenePoint(point, false);
                Wheel(canvas, point, 0); Check(canvas.Zoom == initial && !canvas.WheelPreviewActive, "zero wheel delta changed the view");
                Wheel(canvas, point, 30); Check(Math.Abs(canvas.Zoom / initial - Math.Pow(1.2, .25)) < .000001, "fractional wheel delta became a full notch");
                Wheel(canvas, point, 30); Wheel(canvas, point, 60);
                Check(Math.Abs(canvas.Zoom / initial - 1.2) < .000001 && Math.Abs(canvas.ScenePoint(point, false).X - anchor.X) < .01 && Math.Abs(canvas.ScenePoint(point, false).Y - anchor.Y) < .01, "zoom drifted away from the pointer");
                Wheel(canvas, point, -120); Check(Math.Abs(canvas.Zoom - initial) < .000001, "zoom in/out did not round trip");
                Wheel(canvas, point, 240); Check(Math.Abs(canvas.Zoom / initial - 1.44) < .000001, "multiple notches were dropped");
                Wheel(canvas, point, Int32.MaxValue); Check(canvas.Zoom == 128, "maximum zoom limit was lost");
                Wheel(canvas, point, Int32.MinValue); Check(canvas.Zoom == .00001, "minimum zoom limit was lost");
                Check(Json.Write(source) == before && draft.Snapshot() == before && !draft.CanUndo && !draft.IsDirty, "wheel zoom edited scene data or history");
            }));
            await Test("Zoom: eventi accorpati, qualità ripristinata e strumenti subito utilizzabili", () => WheelUi((canvas, form) => {
                var source = DemoScene(); string before = Json.Write(source); var draft = new SceneDraft(source); canvas.Draft = draft; canvas.Editing = true;
                using (var images = new SceneImageSet())
                {
                    images.Background = new Bitmap(256, 192); using (var graphics = Graphics.FromImage(images.Background)) { graphics.Clear(Color.DarkSlateGray); using (var pen = new Pen(Color.Coral, 3)) for (int x = 0; x < 250; x += 13) graphics.DrawLine(pen, x, 0, 256 - x, 192); }
                    canvas.SetScene(draft.Scene, draft.Scene.Levels[0], images, true); Application.DoEvents(); int invalidated = 0; canvas.Invalidated += (s, e) => invalidated++;
                    var point = new Point(canvas.Width / 2, canvas.Height / 2);
                    for (int i = 0; i < 40; i++) Wheel(canvas, point, i % 2 == 0 ? 120 : -120);
                    Check(canvas.WheelPreviewActive && invalidated == 0, "wheel queued a repaint for every input event");
                    Pump(() => !canvas.WheelPreviewActive); Check(invalidated > 0, "idle wheel did not request a final quality repaint");
                    using (var settled = new Bitmap(canvas.Width, canvas.Height)) using (var explicitQuality = new Bitmap(canvas.Width, canvas.Height))
                    {
                        canvas.DrawToBitmap(settled, canvas.ClientRectangle); canvas.ChangeZoom(1); canvas.DrawToBitmap(explicitQuality, canvas.ClientRectangle);
                        for (int y = 5; y < canvas.Height; y += 19) for (int x = 5; x < canvas.Width; x += 19) Check(settled.GetPixel(x, y) == explicitQuality.GetPixel(x, y), "wheel remained in low-quality preview after settling");
                    }
                    canvas.Tool = SceneEditTool.Pan; Mouse(canvas, "OnMouseDown", point); canvas.Capture = false;
                    Wheel(canvas, point, 120); Check(canvas.WheelPreviewActive, "lost pan capture left wheel preview disabled");
                    canvas.Tool = SceneEditTool.Light; var at = canvas.SceneScreen(1200, 900); Mouse(canvas, "OnMouseDown", at); Mouse(canvas, "OnMouseUp", at);
                    Check(!canvas.WheelPreviewActive && draft.Scene.Lights.Count == 2 && draft.CanUndo, "editing immediately after wheel input used a stale view");
                    Wheel(canvas, point, -120); canvas.SetScene(null, null, null, true); Check(!canvas.WheelPreviewActive, "changing the scene left a wheel timer active");
                    Check(Json.Write(source) == before, "navigation changed the source scene");
                }
            }));
        }
        static void Wheel(SceneCanvas canvas, Point point, int delta)
        { typeof(SceneCanvas).GetMethod("OnMouseWheel", BindingFlags.Instance | BindingFlags.NonPublic).Invoke(canvas, new object[] { new MouseEventArgs(MouseButtons.None, 0, point.X, point.Y, delta) }); }
        static Task WheelUi(Action<SceneCanvas, Form> action)
        {
            var done = new TaskCompletionSource<bool>(); var thread = new Thread(() => {
                try
                {
                    using (var form = new Form { Size = new Size(800, 600), ShowInTaskbar = false, StartPosition = FormStartPosition.Manual, Location = new Point(-15000, -15000) })
                    using (var canvas = new SceneCanvas())
                    { form.Controls.Add(canvas); form.Show(); Application.DoEvents(); action(canvas, form); form.Close(); }
                    done.SetResult(true);
                } catch (Exception error) { done.SetException(error); }
            }); thread.SetApartmentState(ApartmentState.STA); thread.Start(); return done.Task;
        }
    }
}
