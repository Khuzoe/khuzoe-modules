using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Windows.Forms;
using KhuzoeAssetsManager;
internal static class EditorPerformance
{
    public static int Run(string[] args)
    {
        Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
        int count = args.Length > 0 ? Int32.Parse(args[0]) : 2000;
        string state = Path.GetFullPath(args.Length > 1 ? args[1] : "build/perf-state");
        using (var form = new Form { Size = new Size(1040, 780), ShowInTaskbar = false, StartPosition = FormStartPosition.Manual, Location = new Point(-15000, -15000) })
        using (var canvas = new SceneCanvas()) using (var images = new SceneImageSet())
        {
            var scene = new SceneDetail { Schema = 1, Id = "performance-scene", Name = "Synthetic", Width = 4800, Height = 3200, Padding = 0.1, GridType = 1, GridSize = 100, GridDistance = 5, InitialLevel = "ground" };
            scene.Levels.Add(new SceneLevel { Id = "ground", BackgroundColor = "#33443c" });
            for (int i = 0; i < count; i++) scene.Walls.Add(new SceneWall { Id = "wall-" + i, X1 = 100 + i % 50 * 90, Y1 = 100 + i / 50 * 50, X2 = 180 + i % 50 * 90, Y2 = 150 + i / 50 * 50, Sight = 20, Move = 20, Light = 20, Levels = new[] { "ground" } });
            for (int i = 0; i < 40; i++) scene.Lights.Add(new SceneLight { Id = "light-" + i, X = 400 + i % 10 * 400, Y = 400 + i / 10 * 600, Bright = 10, Dim = 20, Color = "#ffcc77", Alpha = 0.5, Angle = 360, Levels = new[] { "ground" } });
            images.Background = new Bitmap(4096, 3072);
            using (var g = Graphics.FromImage(images.Background)) { g.Clear(Color.DarkSlateGray); using (var pen = new Pen(Color.Gray, 7)) for (int i = 0; i < 4096; i += 80) g.DrawLine(pen, i, 0, 4096 - i, 3072); }
            var prepare = typeof(SceneImageSet).GetMethod("PrepareForRendering"); if (prepare != null) prepare.Invoke(images, null);
            var draft = new SceneDraft(scene); canvas.Draft = draft; canvas.Editing = true; canvas.Tool = SceneEditTool.Select;
            form.Controls.Add(canvas); form.Show(); canvas.SetScene(draft.Scene, draft.Scene.Levels[0], images, true); Application.DoEvents();
            using (var frame = new Bitmap(canvas.Width, canvas.Height)) using (var g = Graphics.FromImage(frame))
            {
                Action paint = () => typeof(SceneCanvas).GetMethod("OnPaint", BindingFlags.Instance | BindingFlags.NonPublic).Invoke(canvas, new object[] { new PaintEventArgs(g, canvas.ClientRectangle) });
                Measure("paint-steady", 25, paint);
                canvas.Settings.Walls = false; canvas.Settings.Indicators = false; Measure("paint-map-lights", 10, paint);
                canvas.Settings.Lights = false; Measure("paint-map-only", 10, paint);
                canvas.Settings.Walls = true; Measure("paint-map-walls", 10, paint);
                canvas.Settings.Lights = true; canvas.Settings.Indicators = true;
                draft.Select(SceneSelectionKind.Light, "light-20"); var p = canvas.SceneScreen(draft.Light.X, draft.Light.Y);
                Measure("select-click", 12, () => { Mouse(canvas, "OnMouseDown", p); Mouse(canvas, "OnMouseUp", p); });
                Measure("cancel-click", 12, () => { Mouse(canvas, "OnMouseDown", p); canvas.CancelEditorGesture(); });
                draft.Select(SceneSelectionKind.Light, "light-20"); Mouse(canvas, "OnMouseDown", p); int step = 0;
                Measure("drag-frame", 35, () => { Mouse(canvas, "OnMouseMove", new Point(p.X + (step++ % 18), p.Y + 1)); paint(); });
                Mouse(canvas, "OnMouseUp", new Point(p.X + 30, p.Y + 1));
                draft.Select(SceneSelectionKind.Light, "light-20");
                var store = new SceneDraftStore(new AppStorage(state)); draft.Changed += (s, e) => store.Save("performance", draft);
                Measure("property-with-sync-save", 15, () => new LightProperties(draft).X = draft.Light.X + 1);
                Measure("zoom-frame", 15, () => { canvas.ChangeZoom(1.001); paint(); });
                canvas.Fit(); paint(); int wheel = 0; var anchor = new Point(canvas.Width / 2 + 70, canvas.Height / 2 - 30);
                Measure("wheel-zoom-frame", 30, () => { typeof(SceneCanvas).GetMethod("OnMouseWheel", BindingFlags.Instance | BindingFlags.NonPublic).Invoke(canvas, new object[] { new MouseEventArgs(MouseButtons.None, 0, anchor.X, anchor.Y, wheel++ % 2 == 0 ? 120 : -120) }); paint(); });
                canvas.ChangeZoom(1); paint();
            }
            form.Close();
        }
        Console.WriteLine("PERF synthetic walls=" + count + " lights=40 background=4096x3072 window=1040x780 runtime=" + typeof(SceneCanvas).Assembly.GetName().Version);
        return 0;
    }
    static void Mouse(SceneCanvas canvas, string name, Point point)
    { typeof(SceneCanvas).GetMethod(name, BindingFlags.Instance | BindingFlags.NonPublic).Invoke(canvas, new object[] { new MouseEventArgs(MouseButtons.Left, 1, point.X, point.Y, 0) }); }
    static void Measure(string name, int count, Action action)
    {
        action(); action(); var samples = new List<double>(); int gen0 = GC.CollectionCount(0); var clock = new Stopwatch();
        for (int i = 0; i < count; i++) { clock.Restart(); action(); clock.Stop(); samples.Add(clock.Elapsed.TotalMilliseconds); }
        samples.Sort(); Console.WriteLine("PERF " + name + " median_ms=" + samples[count / 2].ToString("F2", System.Globalization.CultureInfo.InvariantCulture) + " p95_ms=" + samples[(int)Math.Min(count - 1, count * .95)].ToString("F2", System.Globalization.CultureInfo.InvariantCulture) + " gen0=" + (GC.CollectionCount(0) - gen0));
    }
}
