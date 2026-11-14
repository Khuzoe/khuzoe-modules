using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Linq;
using System.Windows.Forms;

namespace KhuzoeAssetsManager
{
    public sealed partial class SceneCanvas
    {
        public SceneDraft Draft { get; set; }
        public bool Editing { get; set; }
        public bool SnapToGrid { get; set; }
        public SceneEditTool Tool { get; set; }
        string gesture, beforeGesture;
        PointF startWorld, currentWorld, resizeOrigin;
        double[] startValues;
        bool spaceDown, gestureChanged;
        public PointF ScenePoint(Point point, bool snap)
        {
            double x = (point.X - panX) / scale, y = (point.Y - panY) / scale;
            if (snap && SnapToGrid && Scene != null && Scene.GridType == 1 && (ModifierKeys & Keys.Shift) == 0)
            { x = Math.Round(x / Scene.GridSize) * Scene.GridSize; y = Math.Round(y / Scene.GridSize) * Scene.GridSize; }
            return new PointF((float)Math.Max(0, Math.Min(layout == null ? 1000000 : layout.Width, x)), (float)Math.Max(0, Math.Min(layout == null ? 1000000 : layout.Height, y)));
        }
        public Point SceneScreen(double x, double y) { return Point.Round(Screen(x, y)); }
        public PointF SceneCenter { get { return layout == null ? new PointF(500, 500) : new PointF((float)(layout.MapX + layout.MapWidth / 2), (float)(layout.MapY + layout.MapHeight / 2)); } }
        public PointF[] ImageCorners(SceneTile tile)
        {
            var texture = tile.Textures ?? new SceneTexture();
            double width = tile.Width, height = tile.Height; Image image;
            if (Images != null && Images.Tiles.TryGetValue(tile.Id, out image))
            {
                if (texture.Fit == "contain" || texture.Fit == "cover") { double s = texture.Fit == "contain" ? Math.Min(width / image.Width, height / image.Height) : Math.Max(width / image.Width, height / image.Height); width = s * image.Width; height = s * image.Height; }
                else if (texture.Fit == "width") height = width * image.Height / image.Width;
                else if (texture.Fit == "height") width = height * image.Width / image.Height;
            }
            return Corners(tile.X + texture.OffsetX, tile.Y + texture.OffsetY, width * texture.ScaleX, height * texture.ScaleY, texture.AnchorX, texture.AnchorY, tile.Rotation + texture.Rotation);
        }
        static PointF[] Corners(double x, double y, double width, double height, double anchorX, double anchorY, double rotation)
        {
            return new[] { Rotate(-width * anchorX, -height * anchorY, rotation, x, y), Rotate(width * (1 - anchorX), -height * anchorY, rotation, x, y), Rotate(width * (1 - anchorX), height * (1 - anchorY), rotation, x, y), Rotate(-width * anchorX, height * (1 - anchorY), rotation, x, y) };
        }
        static PointF Rotate(double x, double y, double degrees, double centerX, double centerY)
        { double angle = degrees * Math.PI / 180; return new PointF((float)(centerX + x * Math.Cos(angle) - y * Math.Sin(angle)), (float)(centerY + x * Math.Sin(angle) + y * Math.Cos(angle))); }
        static double SegmentDistance(Point point, PointF a, PointF b)
        {
            double x = b.X - a.X, y = b.Y - a.Y, length = x * x + y * y;
            double t = length < 0.00001 ? 0 : Math.Max(0, Math.Min(1, ((point.X - a.X) * x + (point.Y - a.Y) * y) / length));
            return Math.Sqrt(Math.Pow(point.X - a.X - t * x, 2) + Math.Pow(point.Y - a.Y - t * y, 2));
        }
        public SceneSelection HitTestElement(Point point)
        {
            if (Scene == null || Level == null) return new SceneSelection(SceneSelectionKind.None, null);
            var light = Scene.Lights.LastOrDefault(value => Settings.Lights && SceneDetail.Included(value.Levels, Level.Id) && (Settings.Hidden || !value.Hidden) && Distance(Screen(value.X, value.Y), point) <= 12);
            if (light != null) return new SceneSelection(SceneSelectionKind.Light, light.Id);
            var wall = Scene.Walls.LastOrDefault(value => Settings.Walls && SceneDetail.Included(value.Levels, Level.Id) && SegmentDistance(point, Screen(value.X1, value.Y1), Screen(value.X2, value.Y2)) <= 7);
            if (wall != null) return new SceneSelection(SceneSelectionKind.Wall, wall.Id);
            foreach (var tile in Scene.Tiles.Where(value => Settings.Tiles && SceneDetail.Included(value.Levels, Level.Id) && (Settings.Hidden || !value.Hidden)).OrderByDescending(value => value.Elevation).ThenByDescending(value => value.Sort))
                using (var polygon = new GraphicsPath()) { polygon.AddPolygon(ImageCorners(tile).Select(value => Screen(value.X, value.Y)).ToArray()); if (polygon.IsVisible(point)) return new SceneSelection(SceneSelectionKind.Image, tile.Id); }
            return new SceneSelection(SceneSelectionKind.None, null);
        }
        bool EditorDown(MouseEventArgs e)
        {
            if (!Editing || Draft == null || Scene == null || Level == null || e.Button != MouseButtons.Left || Tool == SceneEditTool.Pan || spaceDown) return false;
            startWorld = currentWorld = ScenePoint(e.Location, true);
            gestureChanged = false;
            if (Tool == SceneEditTool.Light) { Draft.AddLight(startWorld, Level.Id); Invalidate(); return true; }
            if (Tool == SceneEditTool.Wall) { gesture = "new-wall"; Capture = true; Invalidate(); return true; }
            if (Draft.Wall != null && Settings.Walls && Distance(Screen(Draft.Wall.X1, Draft.Wall.Y1), e.Location) < 10) gesture = "wall-a";
            else if (Draft.Wall != null && Settings.Walls && Distance(Screen(Draft.Wall.X2, Draft.Wall.Y2), e.Location) < 10) gesture = "wall-b";
            else if (Draft.Light != null && Draft.Light.Dim > 0 && Settings.Lights && Distance(Screen(Draft.Light.X + Draft.Light.Dim * Scene.GridSize / Scene.GridDistance, Draft.Light.Y), e.Location) < 10) gesture = "light-radius";
            else if (Draft.Image != null && Settings.Tiles && Distance(Screen(ImageCorners(Draft.Image)[2].X, ImageCorners(Draft.Image)[2].Y), e.Location) < 10) gesture = "image-size";
            else if (Draft.Selection.Kind == SceneSelectionKind.Map) gesture = "map";
            else { var hit = HitTestElement(e.Location); Draft.Select(hit.Kind, hit.Id); gesture = hit.Kind == SceneSelectionKind.None ? null : "move"; }
            if (gesture == null) { Invalidate(); return true; }
            beforeGesture = Draft.CommittedSnapshot;
            if (Draft.Wall != null) startValues = new[] { Draft.Wall.X1, Draft.Wall.Y1, Draft.Wall.X2, Draft.Wall.Y2 };
            else if (Draft.Light != null) startValues = new[] { Draft.Light.X, Draft.Light.Y };
            else if (Draft.Image != null) { startValues = new[] { Draft.Image.X, Draft.Image.Y, Draft.Image.Width, Draft.Image.Height }; resizeOrigin = ImageCorners(Draft.Image)[0]; }
            else if (gesture == "map") startValues = new[] { Level.Textures.OffsetX, Level.Textures.OffsetY };
            Capture = true; Cursor = Cursors.SizeAll; return true;
        }
        bool EditorMove(MouseEventArgs e)
        {
            if (!Editing || gesture == null || Draft == null) return false;
            var next = ScenePoint(e.Location, true); if (next == currentWorld) return true;
            currentWorld = next; gestureChanged = true; double x = currentWorld.X - startWorld.X, y = currentWorld.Y - startWorld.Y;
            if (gesture == "wall-a") { Draft.Wall.X1 = currentWorld.X; Draft.Wall.Y1 = currentWorld.Y; }
            else if (gesture == "wall-b") { Draft.Wall.X2 = currentWorld.X; Draft.Wall.Y2 = currentWorld.Y; }
            else if (gesture == "light-radius") Draft.Light.Dim = Math.Round(Math.Sqrt(Math.Pow(currentWorld.X - Draft.Light.X, 2) + Math.Pow(currentWorld.Y - Draft.Light.Y, 2)) * Scene.GridDistance / Scene.GridSize, 1);
            else if (gesture == "image-size")
            {
                var tile = Draft.Image; var texture = tile.Textures ?? new SceneTexture();
                var local = Rotate(currentWorld.X - resizeOrigin.X, currentWorld.Y - resizeOrigin.Y, -tile.Rotation - texture.Rotation, 0, 0);
                double width = Math.Max(5, local.X / (Math.Abs(texture.ScaleX) < 0.01 ? 0.01 : texture.ScaleX)), height = Math.Max(5, local.Y / (Math.Abs(texture.ScaleY) < 0.01 ? 0.01 : texture.ScaleY));
                if ((ModifierKeys & Keys.Shift) != 0) height = width * startValues[3] / startValues[2];
                texture.Fit = "fill"; tile.Textures = texture;
                tile.Width = width; tile.Height = height;
                var anchor = Rotate(width * texture.AnchorX * texture.ScaleX, height * texture.AnchorY * texture.ScaleY, tile.Rotation + texture.Rotation, resizeOrigin.X, resizeOrigin.Y);
                tile.X = anchor.X - texture.OffsetX; tile.Y = anchor.Y - texture.OffsetY;
            }
            else if (gesture == "map") { Level.Textures.OffsetX = startValues[0] + x; Level.Textures.OffsetY = startValues[1] + y; }
            else if (gesture == "move")
            {
                if (Draft.Wall != null) { Draft.Wall.X1 = startValues[0] + x; Draft.Wall.Y1 = startValues[1] + y; Draft.Wall.X2 = startValues[2] + x; Draft.Wall.Y2 = startValues[3] + y; }
                else if (Draft.Light != null) { Draft.Light.X = startValues[0] + x; Draft.Light.Y = startValues[1] + y; }
                else if (Draft.Image != null) { Draft.Image.X = startValues[0] + x; Draft.Image.Y = startValues[1] + y; }
            }
            Invalidate(); return true;
        }
        bool EditorUp(MouseEventArgs e)
        {
            if (gesture == null || e.Button != MouseButtons.Left) return false;
            EditorMove(e); string action = gesture, before = beforeGesture; gesture = null; beforeGesture = null; Capture = false; Cursor = Cursors.Default;
            if (action == "new-wall") { if (Math.Abs(startWorld.X - currentWorld.X) + Math.Abs(startWorld.Y - currentWorld.Y) >= 5) Draft.AddWall(startWorld, currentWorld, Level.Id); }
            else if (before != null && gestureChanged) Draft.Commit(before, "Trascina elemento");
            Invalidate(); return true;
        }
        public void CancelEditorGesture()
        {
            if (gesture == null) return; string before = beforeGesture; gesture = null; beforeGesture = null;
            if (before != null && gestureChanged && Draft != null) { Draft.Cancel(before); Scene = Draft.Scene; Level = Scene.Levels.FirstOrDefault(value => value.Id == Level.Id); }
            Capture = false; Cursor = Cursors.Default; Invalidate();
        }
        protected override void OnMouseCaptureChanged(EventArgs e)
        { base.OnMouseCaptureChanged(e); if (!Capture) { dragging = false; if (gesture != null) CancelEditorGesture(); Cursor = Cursors.Default; } }
        protected override bool IsInputKey(Keys keyData) { return Editing && new[] { Keys.Left, Keys.Right, Keys.Up, Keys.Down }.Contains(keyData & Keys.KeyCode) || base.IsInputKey(keyData); }
        protected override void OnKeyDown(KeyEventArgs e)
        {
            base.OnKeyDown(e); if (!Editing || Draft == null) return;
            if (e.KeyCode == Keys.Space) { spaceDown = true; e.Handled = true; }
            if (e.KeyCode == Keys.Escape) { CancelEditorGesture(); Draft.Select(SceneSelectionKind.None, null); e.Handled = true; }
            if (gesture != null) return;
            if (e.Control && e.KeyCode == Keys.Z) { Draft.Undo(); e.Handled = true; }
            else if (e.Control && e.KeyCode == Keys.Y) { Draft.Redo(); e.Handled = true; }
            else if (e.Control && e.KeyCode == Keys.D) { Draft.DuplicateSelection(); e.Handled = true; }
            else if (e.KeyCode == Keys.Delete) { Draft.DeleteSelection(); e.Handled = true; }
        }
        protected override void OnKeyUp(KeyEventArgs e) { base.OnKeyUp(e); if (e.KeyCode == Keys.Space) spaceDown = false; }
        protected override void OnLostFocus(EventArgs e) { base.OnLostFocus(e); spaceDown = false; }
        void DrawEditor(Graphics g)
        {
            if (!Editing || Draft == null || Scene == null || Level == null) return;
            using (var pen = new Pen(Color.FromArgb(105, 213, 235), 2)) using (var fill = new SolidBrush(Theme.Background))
            {
                if (gesture == "new-wall") { pen.DashStyle = DashStyle.Dash; g.DrawLine(pen, Screen(startWorld.X, startWorld.Y), Screen(currentWorld.X, currentWorld.Y)); }
                if (Draft.Wall != null && Settings.Walls)
                {
                    var a = Screen(Draft.Wall.X1, Draft.Wall.Y1); var b = Screen(Draft.Wall.X2, Draft.Wall.Y2); g.DrawLine(pen, a, b);
                    foreach (var point in new[] { a, b }) { g.FillEllipse(fill, point.X - 5, point.Y - 5, 10, 10); g.DrawEllipse(pen, point.X - 5, point.Y - 5, 10, 10); }
                }
                if (Draft.Light != null && Settings.Lights)
                {
                    var point = Screen(Draft.Light.X, Draft.Light.Y); g.DrawEllipse(pen, point.X - 10, point.Y - 10, 20, 20);
                    var radius = Screen(Draft.Light.X + Draft.Light.Dim * Scene.GridSize / Scene.GridDistance, Draft.Light.Y); g.FillRectangle(fill, radius.X - 5, radius.Y - 5, 10, 10); g.DrawRectangle(pen, radius.X - 5, radius.Y - 5, 10, 10);
                }
                PointF[] corners = null;
                if (Draft.Image != null && Settings.Tiles) corners = ImageCorners(Draft.Image);
                else if (Draft.Selection.Kind == SceneSelectionKind.Map)
                { var texture = Level.Textures; corners = Corners(layout.MapX + layout.MapWidth / 2 + texture.OffsetX, layout.MapY + layout.MapHeight / 2 + texture.OffsetY, layout.MapWidth * texture.ScaleX, layout.MapHeight * texture.ScaleY, texture.AnchorX, texture.AnchorY, texture.Rotation); }
                if (corners != null)
                {
                    var points = corners.Select(value => Screen(value.X, value.Y)).ToArray(); g.DrawPolygon(pen, points);
                    if (Draft.Image != null) { var point = points[2]; g.FillRectangle(fill, point.X - 5, point.Y - 5, 10, 10); g.DrawRectangle(pen, point.X - 5, point.Y - 5, 10, 10); }
                }
            }
        }
    }
}
