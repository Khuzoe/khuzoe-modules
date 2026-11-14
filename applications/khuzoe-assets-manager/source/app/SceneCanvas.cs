using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Linq;
using System.Windows.Forms;

namespace KhuzoeAssetsManager
{
    public sealed partial class SceneCanvas : Control
    {
        public SceneDetail Scene { get; private set; }
        public SceneLevel Level { get; private set; }
        public SceneImageSet Images { get; private set; }
        public SceneViewSettings Settings { get; set; }
        SceneLayout layout;
        readonly SceneRasterCache rasterCache = new SceneRasterCache();
        readonly SceneBackdropCache backgroundCache = new SceneBackdropCache(), foregroundCache = new SceneBackdropCache();
        readonly Dictionary<long, Pen> wallPens = new Dictionary<long, Pen>();
        readonly Dictionary<int, SolidBrush> wallBrushes = new Dictionary<int, SolidBrush>();
        readonly Dictionary<int, Pen> indicatorPens = new Dictionary<int, Pen>();
        double penScale;
        double scale = 1, panX, panY;
        bool fit = true, dragging;
        bool wheelPreview, wheelFramePending;
        readonly System.Windows.Forms.Timer wheelTimer = new System.Windows.Forms.Timer { Interval = 16 };
        readonly Stopwatch wheelIdle = new Stopwatch();
        internal bool WheelPreviewActive { get { return wheelPreview; } }
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
            wheelTimer.Tick += WheelTick;
        }
        public void SetScene(SceneDetail scene, SceneLevel level, SceneImageSet images, bool refit)
        {
            FinishWheelPreview();
            if (!Object.ReferenceEquals(Images, images)) { rasterCache.Clear(); backgroundCache.Clear(); foregroundCache.Clear(); }
            Scene = scene; Level = level; Images = images; layout = scene == null ? null : SceneLayout.From(scene);
            if (refit) Fit(); else Invalidate();
        }
        public void Fit()
        {
            FinishWheelPreview();
            fit = true;
            if (layout != null && ClientSize.Width > 40 && ClientSize.Height > 40)
            {
                scale = Math.Max(0.00001, Math.Min((ClientSize.Width - 36) / layout.Width, (ClientSize.Height - 36) / layout.Height));
                panX = (ClientSize.Width - layout.Width * scale) / 2; panY = (ClientSize.Height - layout.Height * scale) / 2;
            }
            Invalidate(); if (ZoomChanged != null) ZoomChanged(this, EventArgs.Empty);
        }
        public void ChangeZoom(double factor) { FinishWheelPreview(); ZoomAt(factor, new Point(Width / 2, Height / 2), false); }
        void ZoomAt(double factor, Point point, bool wheel)
        {
            if (Scene == null) return;
            double next = Math.Max(0.00001, Math.Min(128, scale * factor));
            panX = point.X - (point.X - panX) * next / scale; panY = point.Y - (point.Y - panY) * next / scale;
            scale = next; fit = false;
            if (wheel) { wheelFramePending = true; if (!wheelTimer.Enabled) wheelTimer.Start(); } else Invalidate();
            if (ZoomChanged != null) ZoomChanged(this, EventArgs.Empty);
        }
        void WheelTick(object sender, EventArgs e)
        {
            if (!wheelPreview || wheelIdle.ElapsedMilliseconds >= 150) FinishWheelPreview();
            else if (wheelFramePending) { wheelFramePending = false; Invalidate(); }
        }
        void FinishWheelPreview()
        {
            bool repaint = wheelPreview;
            if (wheelTimer != null) wheelTimer.Stop();
            if (wheelIdle != null) wheelIdle.Reset();
            wheelPreview = wheelFramePending = false;
            if (repaint && !IsDisposed && !Disposing) Invalidate();
        }
        protected override void OnResize(EventArgs e) { FinishWheelPreview(); base.OnResize(e); if (fit) Fit(); }
        protected override void OnVisibleChanged(EventArgs e) { if (!Visible) FinishWheelPreview(); base.OnVisibleChanged(e); }
        protected override void OnMouseWheel(MouseEventArgs e)
        {
            base.OnMouseWheel(e); if (Scene == null || e.Delta == 0) return;
            bool preview = !dragging && gesture == null;
            if (preview) { wheelPreview = true; wheelIdle.Restart(); } else FinishWheelPreview();
            ZoomAt(Math.Pow(1.2, e.Delta / 120.0), e.Location, preview);
        }
        protected override void OnMouseDown(MouseEventArgs e)
        { FinishWheelPreview(); base.OnMouseDown(e); Focus(); if (EditorDown(e)) return; if (Scene != null && (e.Button == MouseButtons.Left || e.Button == MouseButtons.Middle)) { dragging = true; previous = e.Location; Capture = true; Cursor = Cursors.SizeAll; } }
        protected override void OnMouseUp(MouseEventArgs e) { base.OnMouseUp(e); if (EditorUp(e)) return; dragging = false; Capture = false; Cursor = Cursors.Default; }
        protected override void OnMouseMove(MouseEventArgs e)
        {
            base.OnMouseMove(e);
            if (EditorMove(e)) return;
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
            base.OnPaint(e); var g = e.Graphics; g.Clear(BackColor);
            g.SmoothingMode = wheelPreview ? SmoothingMode.None : SmoothingMode.AntiAlias;
            g.InterpolationMode = wheelPreview ? InterpolationMode.NearestNeighbor : InterpolationMode.Bilinear;
            g.PixelOffsetMode = wheelPreview ? PixelOffsetMode.Half : PixelOffsetMode.Default;
            g.CompositingQuality = wheelPreview ? CompositingQuality.HighSpeed : CompositingQuality.Default;
            if (Scene == null || Level == null || layout == null)
            {
                using (var font = new Font("Segoe UI", 14F)) TextRenderer.DrawText(g, "Seleziona un mondo e una scena", font, ClientRectangle, Theme.Muted, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter); return;
            }
            if (penScale != scale) { foreach (var pen in wallPens.Values) pen.Dispose(); wallPens.Clear(); penScale = scale; }
            var saved = g.Save(); g.TranslateTransform((float)panX, (float)panY); g.ScaleTransform((float)scale, (float)scale);
            using (var brush = new SolidBrush(ParseColor(Level.BackgroundColor, Color.FromArgb(50, 52, 60)))) g.FillRectangle(brush, (float)layout.MapX, (float)layout.MapY, (float)layout.MapWidth, (float)layout.MapHeight);
            if (Images != null)
            {
                DrawBackdrop(g, Images.Background, Level.BackgroundTint, backgroundCache);
                if (Settings.Tiles)
                    foreach (var tile in Scene.Tiles.Where(value => SceneDetail.Included(value.Levels, Level.Id) && (Settings.Hidden || !value.Hidden)).OrderBy(value => value.Elevation).ThenBy(value => value.Sort))
                    {
                        Image image; if (!Images.Tiles.TryGetValue(tile.Id, out image)) continue;
                        var texture = tile.Textures ?? new SceneTexture();
                        var copy = new SceneTexture { AnchorX = texture.AnchorX, AnchorY = texture.AnchorY, OffsetX = texture.OffsetX, OffsetY = texture.OffsetY, ScaleX = texture.ScaleX, ScaleY = texture.ScaleY, Fit = texture.Fit, Rotation = tile.Rotation + texture.Rotation };
                        DrawImage(g, image, tile.X, tile.Y, tile.Width, tile.Height, copy, tile.Tint, tile.Hidden ? Math.Min(0.25, tile.Alpha) : tile.Alpha);
                    }
                if (Settings.Foreground) DrawBackdrop(g, Images.Foreground, Level.ForegroundTint, foregroundCache);
            }
            if (Settings.Grid && Scene.GridType == 1) DrawGrid(g);
            if (Settings.Lights) DrawLights(g);
            if (Settings.Walls)
                foreach (var wall in Scene.Walls.Where(value => SceneDetail.Included(value.Levels, Level.Id)))
                {
                    if (!InView(wall.X1, wall.Y1, wall.X2, wall.Y2, 8)) continue;
                    var color = WallColor(wall); bool dashed = wall.DoorState == 1 && wall.Door != 0;
                    long key = ((long)(uint)color.ToArgb() << 1) | (dashed ? 1L : 0L); Pen pen;
                    if (!wallPens.TryGetValue(key, out pen)) { pen = new Pen(color, (float)(2.1 / scale)); if (dashed) pen.DashStyle = DashStyle.Dash; wallPens[key] = pen; }
                    g.DrawLine(pen, (float)wall.X1, (float)wall.Y1, (float)wall.X2, (float)wall.Y2);
                }
            using (var border = new Pen(Color.FromArgb(90, 180, 185, 195), (float)(1 / scale))) g.DrawRectangle(border, (float)layout.MapX, (float)layout.MapY, (float)layout.MapWidth, (float)layout.MapHeight);
            g.Restore(saved);
            if (Settings.Indicators) DrawIndicators(g);
            DrawEditor(g);
        }
        bool InView(double x1, double y1, double x2, double y2, double margin)
        { return Math.Max(x1, x2) * scale + panX >= -margin && Math.Min(x1, x2) * scale + panX <= Width + margin && Math.Max(y1, y2) * scale + panY >= -margin && Math.Min(y1, y2) * scale + panY <= Height + margin; }
        bool InView(PointF point, double margin) { return point.X >= -margin && point.X <= Width + margin && point.Y >= -margin && point.Y <= Height + margin; }
        SolidBrush WallBrush(Color color)
        { SolidBrush brush; if (!wallBrushes.TryGetValue(color.ToArgb(), out brush)) { brush = new SolidBrush(color); wallBrushes[color.ToArgb()] = brush; } return brush; }
        Pen IndicatorPen(Color color)
        { Pen pen; if (!indicatorPens.TryGetValue(color.ToArgb(), out pen)) { pen = new Pen(color, 2); indicatorPens[color.ToArgb()] = pen; } return pen; }
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
            if (!InView(rect.Left, rect.Top, rect.Right, rect.Bottom, 2)) return;
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
                    var brush = WallBrush(color);
                    if (InView(a, 3)) g.FillEllipse(brush, a.X - 2, a.Y - 2, 4, 4);
                    if (InView(b, 3)) g.FillEllipse(brush, b.X - 2, b.Y - 2, 4, 4);
                    if (wall.Door != 0)
                    {
                        var midpoint = Screen((wall.X1 + wall.X2) / 2, (wall.Y1 + wall.Y2) / 2);
                        if (InView(midpoint, 7)) { g.FillRectangle(WallBrush(Theme.Background), midpoint.X - 5, midpoint.Y - 6, 10, 12); g.DrawRectangle(IndicatorPen(color), midpoint.X - 5, midpoint.Y - 6, 10, 12); }
                    }
                }
            if (Settings.Lights)
                foreach (var light in Scene.Lights.Where(value => SceneDetail.Included(value.Levels, Level.Id) && (Settings.Hidden || !value.Hidden)))
                {
                    var point = Screen(light.X, light.Y); Color color = light.Hidden ? Theme.Muted : ParseColor(light.Color, Color.FromArgb(255, 224, 154));
                    if (!InView(point, 9)) continue;
                    using (var fill = new SolidBrush(Theme.Background)) using (var pen = new Pen(color, 2))
                    { g.FillEllipse(fill, point.X - 6, point.Y - 6, 12, 12); g.DrawEllipse(pen, point.X - 6, point.Y - 6, 12, 12); g.DrawLine(pen, point.X - 3, point.Y + 8, point.X + 3, point.Y + 8); }
                }
        }
        void DrawImage(Graphics g, Image image, double x, double y, double width, double height, SceneTexture texture, string tint, double alpha)
        {
            if (image == null || width <= 0 || height <= 0 || alpha <= 0) return;
            texture = texture ?? new SceneTexture(); double sx = width / image.Width, sy = height / image.Height;
            if (texture.Fit == "contain") sx = sy = Math.Min(sx, sy);
            else if (texture.Fit == "cover") sx = sy = Math.Max(sx, sy);
            else if (texture.Fit == "width") sy = sx; else if (texture.Fit == "height") sx = sy;
            sx *= texture.ScaleX; sy *= texture.ScaleY; if (sx == 0 || sy == 0) return;
            var preview = rasterCache.Get(image, Math.Max(Math.Abs(sx), Math.Abs(sy)) * scale, wheelPreview);
            sx *= (double)image.Width / preview.Width; sy *= (double)image.Height / preview.Height; image = preview;
            var state = g.Save(); g.TranslateTransform((float)(x + texture.OffsetX), (float)(y + texture.OffsetY)); g.RotateTransform((float)texture.Rotation); g.ScaleTransform((float)sx, (float)sy);
            Color color = ParseColor(tint, Color.White);
            var destination = new Rectangle((int)(-image.Width * texture.AnchorX), (int)(-image.Height * texture.AnchorY), image.Width, image.Height);
            if (color.ToArgb() == Color.White.ToArgb() && alpha >= 1) g.DrawImage(image, destination, 0, 0, image.Width, image.Height, GraphicsUnit.Pixel);
            else using (var attributes = new ImageAttributes())
            {
                attributes.SetColorMatrix(new ColorMatrix { Matrix00 = color.R / 255F, Matrix11 = color.G / 255F, Matrix22 = color.B / 255F, Matrix33 = (float)Math.Max(0, Math.Min(1, alpha)), Matrix44 = 1 });
                g.DrawImage(image, destination, 0, 0, image.Width, image.Height, GraphicsUnit.Pixel, attributes);
            }
            g.Restore(state);
        }
        void DrawBackdrop(Graphics graphics, Image image, string tint, SceneBackdropCache cache)
        {
            if (image == null) return;
            double x = layout.MapX + layout.MapWidth / 2, y = layout.MapY + layout.MapHeight / 2;
            if (wheelPreview) { DrawImage(graphics, image, x, y, layout.MapWidth, layout.MapHeight, Level.Textures, tint, 1); return; }
            if (!cache.TryDraw(graphics, ClientSize, image, Level.Textures, tint, panX, panY, scale, x, y, layout.MapWidth, layout.MapHeight,
                target => DrawImage(target, image, x, y, layout.MapWidth, layout.MapHeight, Level.Textures, tint, 1)))
                DrawImage(graphics, image, x, y, layout.MapWidth, layout.MapHeight, Level.Textures, tint, 1);
        }
        protected override void Dispose(bool disposing)
        {
            if (disposing) { wheelTimer.Stop(); wheelTimer.Dispose(); rasterCache.Dispose(); backgroundCache.Dispose(); foregroundCache.Dispose(); tooltip.Dispose(); foreach (var pen in wallPens.Values) pen.Dispose(); foreach (var brush in wallBrushes.Values) brush.Dispose(); foreach (var pen in indicatorPens.Values) pen.Dispose(); }
            base.Dispose(disposing);
        }
    }
}
