using System;
using System.Collections.Generic;
using System.Drawing;
using System.Linq;

namespace KhuzoeAssetsManager
{
    public sealed class WallFrame
    {
        public double x { get; set; } public double y { get; set; } public double width { get; set; } public double height { get; set; }
        public WallFrame() { }
        public WallFrame(double x, double y, double width, double height) { this.x = x; this.y = y; this.width = width; this.height = height; }
        [System.Web.Script.Serialization.ScriptIgnore] public RectangleF Rectangle { get { return new RectangleF((float)x, (float)y, (float)width, (float)height); } }
        public static WallFrame From(RectangleF area) { return new WallFrame(area.X, area.Y, area.Width, area.Height); }
        [System.Web.Script.Serialization.ScriptIgnore] public bool Valid { get { return new[] { x, y, width, height, x + width, y + height }.All(n => !Double.IsNaN(n) && !Double.IsInfinity(n) && Math.Abs(n) <= 2000000) && Math.Abs(x) <= 1000000 && Math.Abs(y) <= 1000000 && Math.Abs(x + width) <= 1000000 && Math.Abs(y + height) <= 1000000 && width > 0 && height > 0; } }
    }
    public sealed class WallTile
    {
        public WallFrame frame { get; set; } public WallFrame core { get; set; } public int width { get; set; } public int height { get; set; } public string image { get; set; }
    }
    public sealed class WallRequest
    {
        public string id { get; set; } public WallFrame frame { get; set; } public List<WallTile> tiles { get; set; }
    }
    public sealed class WallSegment
    {
        public double x1 { get; set; } public double y1 { get; set; } public double x2 { get; set; } public double y2 { get; set; } public bool uncertain { get; set; }
    }
    public sealed class WallCapabilities
    {
        public bool ok { get; set; } public bool enabled { get; set; } public int version { get; set; } public string model { get; set; } public string detail { get; set; } public int maxTiles { get; set; } public int maxBytes { get; set; }
    }
    public sealed class WallJob
    {
        public string id { get; set; } public string status { get; set; } public string model { get; set; } public string error { get; set; }
        public int total { get; set; } public int completed { get; set; } public long inputTokens { get; set; } public long outputTokens { get; set; }
        public WallFrame frame { get; set; } public List<WallSegment> walls { get; set; }
        public bool IsRunning { get { return status == "pending" || status == "running"; } }
    }
    public sealed class WallJobResponse { public bool ok { get; set; } public WallJob job { get; set; } }
    public sealed class WallPending
    {
        public string Id { get; set; } public string SceneHash { get; set; } public string LevelId { get; set; } public WallFrame Frame { get; set; }
    }
    public static class SceneWallAnalysis
    {
        public static WallRequest Plan(RectangleF area, double density)
        {
            var frame = WallFrame.From(area); if (!frame.Valid) throw new ArgumentException("Seleziona un’area valida della mappa.");
            if (Double.IsNaN(density) || Double.IsInfinity(density) || density <= 0) throw new ArgumentException("Risoluzione di analisi non valida.");
            density = Math.Max(.0001, Math.Min(4, density));
            int columns, rows;
            for (;;) { columns = Math.Max(1, (int)Math.Ceiling(area.Width * density / 1024)); rows = Math.Max(1, (int)Math.Ceiling(area.Height * density / 1024)); if ((long)columns * rows <= 64) break; density *= .8; }
            var result = new WallRequest { id = Guid.NewGuid().ToString(), frame = frame, tiles = new List<WallTile>() };
            double stepX = area.Width / columns, stepY = area.Height / rows, margin = 128 / density;
            for (int row = 0; row < rows; row++) for (int column = 0; column < columns; column++)
            {
                double x = area.Left + column * stepX, y = area.Top + row * stepY;
                var core = new WallFrame(x, y, stepX, stepY);
                double left = Math.Max(area.Left, x - margin), top = Math.Max(area.Top, y - margin), right = Math.Min(area.Right, x + stepX + margin), bottom = Math.Min(area.Bottom, y + stepY + margin);
                var bounds = new WallFrame(left, top, right - left, bottom - top);
                result.tiles.Add(new WallTile { frame = bounds, core = core, width = Math.Max(1, Math.Min(1280, (int)Math.Ceiling(bounds.width * density))), height = Math.Max(1, Math.Min(1280, (int)Math.Ceiling(bounds.height * density))) });
            }
            return result;
        }
        static bool Near(SceneWall a, SceneWall b, double tolerance)
        { return (Distance(a.X1, a.Y1, b.X1, b.Y1) <= tolerance && Distance(a.X2, a.Y2, b.X2, b.Y2) <= tolerance) || (Distance(a.X1, a.Y1, b.X2, b.Y2) <= tolerance && Distance(a.X2, a.Y2, b.X1, b.Y1) <= tolerance); }
        static double Distance(double ax, double ay, double bx, double by) { return Math.Sqrt((ax - bx) * (ax - bx) + (ay - by) * (ay - by)); }
        public static List<SceneWall> Walls(WallJob job, string level)
        {
            if (job == null || job.frame == null || !job.frame.Valid || job.walls == null || job.walls.Count > 20000) throw new ArgumentException("Risultato di analisi non valido.");
            var result = new List<SceneWall>();
            // Small endpoint tolerance, never the grid size: door-sized gaps must remain open.
            var buckets = new Dictionary<string, List<PointF>>();
            Func<double, double, PointF> snap = (x, y) => {
                int bx = (int)Math.Floor(x / 2), by = (int)Math.Floor(y / 2);
                for (int dx = -1; dx <= 1; dx++) for (int dy = -1; dy <= 1; dy++) { List<PointF> points; if (!buckets.TryGetValue((bx + dx) + ":" + (by + dy), out points)) continue; foreach (var p in points) if (Distance(x, y, p.X, p.Y) <= 1.5) return p; }
                string key = bx + ":" + by; List<PointF> values; if (!buckets.TryGetValue(key, out values)) buckets[key] = values = new List<PointF>();
                var point = new PointF((float)x, (float)y); values.Add(point); return point;
            };
            var segments = new Dictionary<string, List<SceneWall>>();
            foreach (var segment in job.walls)
            {
                if (segment == null || new[] { segment.x1, segment.y1, segment.x2, segment.y2 }.Any(v => Double.IsNaN(v) || Double.IsInfinity(v) || v < -1000000 || v > 1000000)) throw new ArgumentException("Coordinate dei muri non valide.");
                foreach (var p in new[] { new PointF((float)segment.x1, (float)segment.y1), new PointF((float)segment.x2, (float)segment.y2) })
                    if (p.X < job.frame.x - .1 || p.X > job.frame.x + job.frame.width + .1 || p.Y < job.frame.y - .1 || p.Y > job.frame.y + job.frame.height + .1) throw new ArgumentException("Un muro suggerito è esterno all’area analizzata.");
                var a = snap(segment.x1, segment.y1); var b = snap(segment.x2, segment.y2); if (Distance(a.X, a.Y, b.X, b.Y) < .5) continue;
                var wall = new SceneWall { Id = SceneDraft.NewId(), X1 = a.X, Y1 = a.Y, X2 = b.X, Y2 = b.Y, Sight = 20, Move = 20, Light = 20, Sound = 20, Levels = new[] { level }, SuggestedUncertain = segment.uncertain };
                string key = Math.Min(a.X, b.X) + ":" + Math.Min(a.Y, b.Y) + ":" + Math.Max(a.X, b.X) + ":" + Math.Max(a.Y, b.Y);
                List<SceneWall> matches; if (!segments.TryGetValue(key, out matches)) segments[key] = matches = new List<SceneWall>();
                var duplicate = matches.FirstOrDefault(v => Near(v, wall, .01)); if (duplicate != null) { duplicate.SuggestedUncertain |= wall.SuggestedUncertain; continue; }
                matches.Add(wall); result.Add(wall);
            }
            return result;
        }
        public static int AddToDraft(SceneDraft draft, IEnumerable<SceneWall> suggestions, string level)
        {
            var proposed = suggestions.ToList(); if (proposed.Count > 20000) throw new ArgumentException("Troppi muri suggeriti.");
            var existing = new Dictionary<string, List<SceneWall>>();
            Action<SceneWall> index = wall => { foreach (var p in new[] { new PointF((float)wall.X1, (float)wall.Y1), new PointF((float)wall.X2, (float)wall.Y2) }) { string key = Math.Floor(p.X / 4) + ":" + Math.Floor(p.Y / 4); List<SceneWall> values; if (!existing.TryGetValue(key, out values)) existing[key] = values = new List<SceneWall>(); values.Add(wall); } };
            foreach (var wall in draft.Scene.Walls.Where(w => SceneDetail.Included(w.Levels, level))) index(wall);
            var add = new List<SceneWall>();
            foreach (var wall in proposed)
            {
                foreach (double n in new[] { wall.X1, wall.Y1, wall.X2, wall.Y2 }) SceneDraft.Number(n, -1000000, 1000000);
                if (Distance(wall.X1, wall.Y1, wall.X2, wall.Y2) < .5) continue;
                bool duplicate = false; int bx = (int)Math.Floor(wall.X1 / 4), by = (int)Math.Floor(wall.Y1 / 4);
                for (int dx = -1; dx <= 1 && !duplicate; dx++) for (int dy = -1; dy <= 1 && !duplicate; dy++) { List<SceneWall> candidates; if (existing.TryGetValue((bx + dx) + ":" + (by + dy), out candidates)) duplicate = candidates.Any(w => Near(w, wall, 1.5)); }
                if (duplicate) continue;
                var copy = Json.Read<SceneWall>(Json.Write(wall)); copy.Id = SceneDraft.NewId(); copy.Levels = new[] { level }; add.Add(copy); index(copy);
            }
            if (add.Count > 0) draft.Apply("Conferma muri AI", () => draft.Scene.Walls.AddRange(add));
            return add.Count;
        }
    }
}
