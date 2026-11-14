using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Linq;
using System.Windows.Forms;

namespace KhuzoeAssetsManager
{
    public sealed class SceneCanvas : Control
    {
        public SceneDetail Scene { get; private set; }
        public SceneLevel Level { get; private set; }
        public SceneImageSet Images { get; private set; }
        public SceneViewSettings Settings { get; set; }
        SceneLayout layout;
        double scale = 1, panX, panY;
        bool fit = true, dragging;
        Point previous;
        readonly ToolTip tooltip = new ToolTip();
        string tooltipText;
        public event EventHandler ZoomChanged;
        public double Zoom { get { return scale; } }
        public SceneCanvas()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw | ControlStyles.Selectable, true);
            BackColor = Color.FromArgb(17, 18, 22); Dock = DockStyle.Fill; TabStop = true; Settings = new SceneViewSettings();
            AccessibleName = "Anteprima scena"; AccessibleDescription = "Trascina per spostare la mappa e usa la rotella per ingrandirla.";
        }
        public void SetScene(SceneDetail scene, SceneLevel level, SceneImageSet images, bool refit)
        {
            Scene = scene; Level = level; Images = images; layout = scene == null ? null : SceneLayout.From(scene);
            if (refit) Fit(); else Invalidate();
        }
        public void Fit()
        {
            fit = true;
            if (layout != null && ClientSize.Width > 40 && ClientSize.Height > 40)
            {
                scale = Math.Max(0.00001, Math.Min((ClientSize.Width - 36) / layout.Width, (ClientSize.Height - 36) / layout.Height));
                panX = (ClientSize.Width - layout.Width * scale) / 2; panY = (ClientSize.Height - layout.Height * scale) / 2;
            }
            Invalidate(); if (ZoomChanged != null) ZoomChanged(this, EventArgs.Empty);
        }
        public void ChangeZoom(double factor) { ZoomAt(factor, new Point(Width / 2, Height / 2)); }
        void ZoomAt(double factor, Point point)
        {
            if (Scene == null) return;
            double next = Math.Max(0.00001, Math.Min(128, scale * factor));
            panX = point.X - (point.X - panX) * next / scale; panY = point.Y - (point.Y - panY) * next / scale;
            scale = next; fit = false; Invalidate(); if (ZoomChanged != null) ZoomChanged(this, EventArgs.Empty);
        }
        protected override void OnResize(EventArgs e) { base.OnResize(e); if (fit) Fit(); }
        protected override void OnMouseWheel(MouseEventArgs e) { base.OnMouseWheel(e); ZoomAt(e.Delta > 0 ? 1.2 : 1 / 1.2, e.Location); }
        protected override void OnMouseDown(MouseEventArgs e)
        { base.OnMouseDown(e); Focus(); if (Scene != null && (e.Button == MouseButtons.Left || e.Button == MouseButtons.Middle)) { dragging = true; previous = e.Location; Capture = true; Cursor = Cursors.SizeAll; } }
        protected override void OnMouseUp(MouseEventArgs e) { base.OnMouseUp(e); dragging = false; Capture = false; Cursor = Cursors.Default; }
        protected override void OnMouseMove(MouseEventArgs e)
        {
            base.OnMouseMove(e);
            if (dragging) { panX += e.X - previous.X; panY += e.Y - previous.Y; previous = e.Location; fit = false; Invalidate(); return; }
            string text = "";
            if (Scene != null && Level != null && Settings.Lights && Settings.Indicators)
            {
                var light = Scene.Lights.FirstOrDefault(value => SceneDetail.Included(value.Levels, Level.Id) && (Settings.Hidden || !value.Hidden) && Distance(Screen(value.X, value.Y), e.Location) < 12);
                if (light != null) text = (String.IsNullOrWhiteSpace(light.Name) ? "Luce" : light.Name) + (light.Hidden ? " · disattivata" : "") + "\nIntensa: " + light.Bright + " · tenue: " + light.Dim + " " + Scene.GridUnits;
            }
            if (text != tooltipText) { tooltipText = text; tooltip.SetToolTip(this, text); }
        }
        static double Distance(PointF a, Point b) { double x = a.X - b.X, y = a.Y - b.Y; return Math.Sqrt(x * x + y * y); }
        PointF Screen(double x, double y) { return new PointF((float)(x * scale + panX), (float)(y * scale + panY)); }
        public static Color ParseColor(string value, Color fallback)
        { try { return !String.IsNullOrEmpty(value) && System.Text.RegularExpressions.Regex.IsMatch(value, "^#[a-fA-F0-9]{6}$") ? ColorTranslator.FromHtml(value) : fallback; } catch (ArgumentException) { return fallback; } }
        static Color WallColor(SceneWall wall)
        {
            if (wall.Door == 2) return Color.FromArgb(192, 135, 231);
            if (wall.Door != 0) return wall.DoorState == 1 ? Theme.Green : wall.DoorState == 2 ? Color.FromArgb(239, 121, 111) : Color.FromArgb(242, 177, 108);
            return wall.Sight == 0 ? Color.FromArgb(116, 190, 220) : Theme.Gold;
        }
        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e); var g = e.Graphics; g.Clear(BackColor); g.SmoothingMode = SmoothingMode.AntiAlias;
            if (Scene == null || Level == null || layout == null)
            {
                using (var font = new Font("Segoe UI", 14F)) TextRenderer.DrawText(g, "Seleziona un mondo e una scena", font, ClientRectangle, Theme.Muted, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter); return;
            }
            var saved = g.Save(); g.TranslateTransform((float)panX, (float)panY); g.ScaleTransform((float)scale, (float)scale);
            using (var brush = new SolidBrush(ParseColor(Level.BackgroundColor, Color.FromArgb(50, 52, 60)))) g.FillRectangle(brush, (float)layout.MapX, (float)layout.MapY, (float)layout.MapWidth, (float)layout.MapHeight);
            if (Images != null)
            {
                DrawImage(g, Images.Background, layout.MapX + layout.MapWidth / 2, layout.MapY + layout.MapHeight / 2, layout.MapWidth, layout.MapHeight, Level.Textures, Level.BackgroundTint, 1);
                if (Settings.Tiles)
                    foreach (var tile in Scene.Tiles.Where(value => SceneDetail.Included(value.Levels, Level.Id) && (Settings.Hidden || !value.Hidden)).OrderBy(value => value.Elevation).ThenBy(value => value.Sort))
                    {
                        Image image; if (!Images.Tiles.TryGetValue(tile.Id, out image)) continue;
                        var texture = tile.Textures ?? new SceneTexture();
                        var copy = new SceneTexture { AnchorX = texture.AnchorX, AnchorY = texture.AnchorY, ScaleX = texture.ScaleX, ScaleY = texture.ScaleY, Fit = texture.Fit, Rotation = tile.Rotation };
                        DrawImage(g, image, tile.X, tile.Y, tile.Width, tile.Height, copy, tile.Tint, tile.Hidden ? Math.Min(0.25, tile.Alpha) : tile.Alpha);
                    }
                if (Settings.Foreground) DrawImage(g, Images.Foreground, layout.MapX + layout.MapWidth / 2, layout.MapY + layout.MapHeight / 2, layout.MapWidth, layout.MapHeight, Level.Textures, Level.ForegroundTint, 1);
            }
            if (Settings.Grid && Scene.GridType == 1) DrawGrid(g);
            if (Settings.Lights) DrawLights(g);
            if (Settings.Walls)
                foreach (var wall in Scene.Walls.Where(value => SceneDetail.Included(value.Levels, Level.Id)))
                    using (var pen = new Pen(WallColor(wall), (float)(2.1 / scale)))
                    { if (wall.DoorState == 1 && wall.Door != 0) pen.DashStyle = DashStyle.Dash; g.DrawLine(pen, (float)wall.X1, (float)wall.Y1, (float)wall.X2, (float)wall.Y2); }
            using (var border = new Pen(Color.FromArgb(90, 180, 185, 195), (float)(1 / scale))) g.DrawRectangle(border, (float)layout.MapX, (float)layout.MapY, (float)layout.MapWidth, (float)layout.MapHeight);
            g.Restore(saved);
            if (Settings.Indicators) DrawIndicators(g);
        }
        void DrawGrid(Graphics g)
        {
            double step = Scene.GridSize; if (step * scale < 9) return;
            double left = Math.Max(0, -panX / scale), top = Math.Max(0, -panY / scale);
            double right = Math.Min(layout.Width, (Width - panX) / scale), bottom = Math.Min(layout.Height, (Height - panY) / scale);
            using (var pen = new Pen(Color.FromArgb(45, 235, 235, 240), (float)(1 / scale)))
            {
                for (double x = Math.Floor(left / step) * step; x <= right; x += step) g.DrawLine(pen, (float)x, (float)top, (float)x, (float)bottom);
                for (double y = Math.Floor(top / step) * step; y <= bottom; y += step) g.DrawLine(pen, (float)left, (float)y, (float)right, (float)y);
            }
        }
        void DrawLights(Graphics g)
        {
            double maxRadius = Math.Sqrt(layout.Width * layout.Width + layout.Height * layout.Height) * 3;
            foreach (var light in Scene.Lights.Where(value => SceneDetail.Included(value.Levels, Level.Id) && (Settings.Hidden || !value.Hidden)))
            {
                Color color = light.Hidden ? Theme.Muted : light.Luminosity < 0 ? Color.MediumPurple : ParseColor(light.Color, Color.FromArgb(255, 224, 154));
                double dim = Math.Min(maxRadius, Math.Max(light.Dim, light.Bright) * Scene.GridSize / Math.Max(0.001, Scene.GridDistance));
                double bright = Math.Min(dim, light.Bright * Scene.GridSize / Math.Max(0.001, Scene.GridDistance));
                DrawRange(g, light, dim, color, light.Hidden ? 4 : 16);
                if (bright > 0) DrawRange(g, light, bright, color, light.Hidden ? 4 : 23);
            }
        }
        void DrawRange(Graphics g, SceneLight light, double radius, Color color, int alpha)
        {
            if (radius <= 0) return;
            var rect = new RectangleF((float)(light.X - radius), (float)(light.Y - radius), (float)(radius * 2), (float)(radius * 2));
            using (var fill = new SolidBrush(Color.FromArgb(alpha, color)))
            using (var pen = new Pen(Color.FromArgb(110, color), (float)(1 / scale)))
            {
                pen.DashStyle = DashStyle.Dash;
                if (light.Angle > 0 && light.Angle < 360) { float start = (float)(light.Rotation + 90 - light.Angle / 2); g.FillPie(fill, rect.X, rect.Y, rect.Width, rect.Height, start, (float)light.Angle); g.DrawPie(pen, rect.X, rect.Y, rect.Width, rect.Height, start, (float)light.Angle); }
                else { g.FillEllipse(fill, rect); g.DrawEllipse(pen, rect); }
            }
        }
        void DrawIndicators(Graphics g)
        {
            if (Settings.Walls)
                foreach (var wall in Scene.Walls.Where(value => SceneDetail.Included(value.Levels, Level.Id)))
                {
                    var a = Screen(wall.X1, wall.Y1); var b = Screen(wall.X2, wall.Y2); Color color = WallColor(wall);
                    using (var brush = new SolidBrush(color)) { g.FillEllipse(brush, a.X - 2, a.Y - 2, 4, 4); g.FillEllipse(brush, b.X - 2, b.Y - 2, 4, 4); }
                    if (wall.Door != 0)
                    {
                        var midpoint = Screen((wall.X1 + wall.X2) / 2, (wall.Y1 + wall.Y2) / 2);
                        using (var brush = new SolidBrush(Theme.Background)) using (var pen = new Pen(color, 2))
                        { g.FillRectangle(brush, midpoint.X - 5, midpoint.Y - 6, 10, 12); g.DrawRectangle(pen, midpoint.X - 5, midpoint.Y - 6, 10, 12); }
                    }
                }
            if (Settings.Lights)
                foreach (var light in Scene.Lights.Where(value => SceneDetail.Included(value.Levels, Level.Id) && (Settings.Hidden || !value.Hidden)))
                {
                    var point = Screen(light.X, light.Y); Color color = light.Hidden ? Theme.Muted : ParseColor(light.Color, Color.FromArgb(255, 224, 154));
                    using (var fill = new SolidBrush(Theme.Background)) using (var pen = new Pen(color, 2))
                    { g.FillEllipse(fill, point.X - 6, point.Y - 6, 12, 12); g.DrawEllipse(pen, point.X - 6, point.Y - 6, 12, 12); g.DrawLine(pen, point.X - 3, point.Y + 8, point.X + 3, point.Y + 8); }
                }
        }
        static void DrawImage(Graphics g, Image image, double x, double y, double width, double height, SceneTexture texture, string tint, double alpha)
        {
            if (image == null || width <= 0 || height <= 0 || alpha <= 0) return;
            texture = texture ?? new SceneTexture(); double sx = width / image.Width, sy = height / image.Height;
            if (texture.Fit == "contain") sx = sy = Math.Min(sx, sy);
            else if (texture.Fit == "cover") sx = sy = Math.Max(sx, sy);
            else if (texture.Fit == "width") sy = sx; else if (texture.Fit == "height") sx = sy;
            sx *= texture.ScaleX; sy *= texture.ScaleY; if (sx == 0 || sy == 0) return;
            var state = g.Save(); g.TranslateTransform((float)(x + texture.OffsetX), (float)(y + texture.OffsetY)); g.RotateTransform((float)texture.Rotation); g.ScaleTransform((float)sx, (float)sy);
            Color color = ParseColor(tint, Color.White);
            using (var attributes = new ImageAttributes())
            {
                attributes.SetColorMatrix(new ColorMatrix { Matrix00 = color.R / 255F, Matrix11 = color.G / 255F, Matrix22 = color.B / 255F, Matrix33 = (float)Math.Max(0, Math.Min(1, alpha)), Matrix44 = 1 });
                g.DrawImage(image, new Rectangle((int)(-image.Width * texture.AnchorX), (int)(-image.Height * texture.AnchorY), image.Width, image.Height), 0, 0, image.Width, image.Height, GraphicsUnit.Pixel, attributes);
            }
            g.Restore(state);
        }
        protected override void Dispose(bool disposing) { if (disposing) tooltip.Dispose(); base.Dispose(disposing); }
    }
}
