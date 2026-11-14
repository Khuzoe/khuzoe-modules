using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Linq;

namespace KhuzoeAssetsManager
{
    // A bounded, display-sized copy avoids resampling a full 4K raster on every mouse move.
    // Original decoded assets stay owned by SceneImageSet; only these temporary copies are owned here.
    internal sealed class SceneRasterCache : IDisposable
    {
        sealed class Entry { public Bitmap Image; public int Divisor; public long Bytes, Used; }
        readonly Dictionary<Image, Entry> entries = new Dictionary<Image, Entry>();
        readonly long budget;
        long used;
        public long Bytes { get; private set; }
        public int Count { get { return entries.Count; } }
        public SceneRasterCache() : this(24L * 1024 * 1024) { }
        internal SceneRasterCache(long budget) { this.budget = budget; }
        public Image Get(Image source, double displayScale, bool interactionPreview = false)
        {
            if (source == null || displayScale <= 0 || Double.IsNaN(displayScale) || Double.IsInfinity(displayScale)) return source;
            Entry entry;
            if (interactionPreview) { if (entries.TryGetValue(source, out entry)) { entry.Used = ++used; return entry.Image; } return source; }
            int divisor = 1;
            while (displayScale * divisor < 0.5 && Math.Max(source.Width, source.Height) / divisor > 64) divisor *= 2;
            if (divisor == 1) return source;
            if (entries.TryGetValue(source, out entry) && entry.Divisor == divisor) { entry.Used = ++used; return entry.Image; }
            int width = Math.Max(1, source.Width / divisor), height = Math.Max(1, source.Height / divisor);
            long bytes = (long)width * height * 4;
            if (bytes > budget) return source;
            if (entry != null) Remove(source);
            while (Bytes + bytes > budget && entries.Count > 0) Remove(entries.OrderBy(value => value.Value.Used).First().Key);
            var preview = new Bitmap(width, height, PixelFormat.Format32bppPArgb);
            try
            {
                using (var graphics = Graphics.FromImage(preview))
                using (var attributes = new ImageAttributes())
                {
                    graphics.CompositingMode = CompositingMode.SourceCopy; graphics.InterpolationMode = InterpolationMode.HighQualityBilinear; graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
                    attributes.SetWrapMode(WrapMode.TileFlipXY);
                    graphics.DrawImage(source, new Rectangle(0, 0, width, height), 0, 0, source.Width, source.Height, GraphicsUnit.Pixel, attributes);
                }
                entries[source] = new Entry { Image = preview, Divisor = divisor, Bytes = bytes, Used = ++used }; Bytes += bytes; return preview;
            }
            catch { preview.Dispose(); throw; }
        }
        void Remove(Image source) { var entry = entries[source]; entries.Remove(source); Bytes -= entry.Bytes; entry.Image.Dispose(); }
        public void Clear() { foreach (var entry in entries.Values) entry.Image.Dispose(); entries.Clear(); Bytes = 0; }
        public void Dispose() { Clear(); }
    }
    internal sealed class SceneBackdropCache : IDisposable
    {
        Bitmap bitmap;
        Image source;
        SceneTexture texture;
        string tint;
        double panX, panY, scale, x, y, width, height;
        public bool TryDraw(Graphics target, Size size, Image image, SceneTexture value, string color, double px, double py, double zoom, double cx, double cy, double w, double h, Action<Graphics> render)
        {
            if (image == null || size.Width <= 0 || size.Height <= 0 || (long)size.Width * size.Height * 4 > 8L * 1024 * 1024) { Clear(); return false; }
            value = value ?? new SceneTexture();
            bool same = bitmap != null && bitmap.Size == size && Object.ReferenceEquals(source, image) && tint == color && panX == px && panY == py && scale == zoom && x == cx && y == cy && width == w && height == h
                && texture.AnchorX == value.AnchorX && texture.AnchorY == value.AnchorY && texture.OffsetX == value.OffsetX && texture.OffsetY == value.OffsetY && texture.ScaleX == value.ScaleX && texture.ScaleY == value.ScaleY && texture.Rotation == value.Rotation && texture.Fit == value.Fit;
            if (!same)
            {
                Clear(); var next = new Bitmap(size.Width, size.Height, PixelFormat.Format32bppPArgb);
                try
                {
                    using (var graphics = Graphics.FromImage(next)) { graphics.SmoothingMode = SmoothingMode.AntiAlias; graphics.TranslateTransform((float)px, (float)py); graphics.ScaleTransform((float)zoom, (float)zoom); render(graphics); }
                    bitmap = next;
                }
                catch { next.Dispose(); throw; }
                source = image; tint = color; panX = px; panY = py; scale = zoom; x = cx; y = cy; width = w; height = h;
                texture = new SceneTexture { AnchorX = value.AnchorX, AnchorY = value.AnchorY, OffsetX = value.OffsetX, OffsetY = value.OffsetY, ScaleX = value.ScaleX, ScaleY = value.ScaleY, Rotation = value.Rotation, Fit = value.Fit };
            }
            var state = target.Save(); try { target.ResetTransform(); target.DrawImageUnscaled(bitmap, Point.Empty); } finally { target.Restore(state); }
            return true;
        }
        public void Clear() { if (bitmap != null) bitmap.Dispose(); bitmap = null; source = null; texture = null; }
        public void Dispose() { Clear(); }
    }
}
