using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Linq;

namespace KhuzoeAssetsManager
{
    // Source pixel coordinates and scene coordinates remain independent of every preview resolution.
    internal sealed class SceneImagePlacement
    {
        public readonly Size Native;
        public readonly double X, Y, ScaleX, ScaleY, Rotation, AnchorX, AnchorY;
        public SceneImagePlacement(Size native, double x, double y, double width, double height, SceneTexture texture)
        {
            texture = texture ?? new SceneTexture(); Native = native; X = x + texture.OffsetX; Y = y + texture.OffsetY; Rotation = texture.Rotation; AnchorX = texture.AnchorX; AnchorY = texture.AnchorY;
            double sx = width / native.Width, sy = height / native.Height;
            if (texture.Fit == "contain") sx = sy = Math.Min(sx, sy); else if (texture.Fit == "cover") sx = sy = Math.Max(sx, sy);
            else if (texture.Fit == "width") sy = sx; else if (texture.Fit == "height") sx = sy;
            ScaleX = sx * texture.ScaleX; ScaleY = sy * texture.ScaleY;
        }
        public Matrix ToScreen(double zoom, double panX, double panY)
        {
            double angle = Rotation * Math.PI / 180, c = Math.Cos(angle), s = Math.Sin(angle);
            double a = ScaleX * c, b = ScaleX * s, d = ScaleY * c, e = -ScaleY * s;
            return new Matrix((float)(a * zoom), (float)(b * zoom), (float)(e * zoom), (float)(d * zoom),
                (float)((X - Native.Width * AnchorX * a - Native.Height * AnchorY * e) * zoom + panX),
                (float)((Y - Native.Width * AnchorX * b - Native.Height * AnchorY * d) * zoom + panY));
        }
        public PointF[] Corners()
        {
            var points = new[] { new PointF(0, 0), new PointF(Native.Width, 0), new PointF(Native.Width, Native.Height), new PointF(0, Native.Height) };
            using (var matrix = ToScreen(1, 0, 0)) matrix.TransformPoints(points); return points;
        }
        public SceneDetailSpec VisibleDetail(Size viewport, double zoom, double panX, double panY)
        {
            double density = Math.Max(Math.Abs(ScaleX), Math.Abs(ScaleY)) * zoom;
            if (density <= 0 || Double.IsInfinity(density) || Double.IsNaN(density)) return null;
            var points = new[] { new PointF(0, 0), new PointF(viewport.Width, 0), new PointF(viewport.Width, viewport.Height), new PointF(0, viewport.Height) };
            using (var matrix = ToScreen(zoom, panX, panY))
            { if (!matrix.IsInvertible) return null; matrix.Invert(); matrix.TransformPoints(points); }
            double left = Math.Max(0, points.Min(p => p.X)), top = Math.Max(0, points.Min(p => p.Y));
            double right = Math.Min(Native.Width, points.Max(p => p.X)), bottom = Math.Min(Native.Height, points.Max(p => p.Y));
            if (right <= left || bottom <= top) return null;
            double marginX = Math.Max(16, (right - left) * .1), marginY = Math.Max(16, (bottom - top) * .1);
            int x1 = Math.Max(0, (int)Math.Floor((left - marginX) / 32) * 32), y1 = Math.Max(0, (int)Math.Floor((top - marginY) / 32) * 32);
            int x2 = Math.Min(Native.Width, (int)Math.Ceiling((right + marginX) / 32) * 32), y2 = Math.Min(Native.Height, (int)Math.Ceiling((bottom + marginY) / 32) * 32);
            var region = Rectangle.FromLTRB(x1, y1, x2, y2);
            double sample = Math.Min(1, density * 1.1);
            sample = Math.Min(sample, 4096.0 / Math.Max(region.Width, region.Height));
            sample = Math.Min(sample, Math.Sqrt((2.0 * 1024 * 1024) / ((double)region.Width * region.Height)));
            var output = new Size(Math.Max(1, (int)Math.Floor(region.Width * sample)), Math.Max(1, (int)Math.Floor(region.Height * sample)));
            return new SceneDetailSpec { Region = region, Output = output };
        }
    }
    internal sealed class SceneDetailSpec
    {
        public Rectangle Region; public Size Output;
        public double Sample { get { return Math.Min((double)Output.Width / Region.Width, (double)Output.Height / Region.Height); } }
        public bool Same(SceneDetailSpec other) { return other != null && Region == other.Region && Output == other.Output; }
    }
}
