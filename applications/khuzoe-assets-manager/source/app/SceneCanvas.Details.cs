using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Linq;

namespace KhuzoeAssetsManager
{
    public sealed partial class SceneCanvas
    {
        SceneImageDetails details;
        public event EventHandler ImageDetailChanged;
        public bool IsLoadingImageDetail { get { return details != null && details.IsBusy; } }
        public string ImageDetailError { get { return details == null ? null : details.Error; } }
        sealed class Candidate { public Image Image; public SceneImageSource Source; public SceneDetailSpec Spec; public bool Selected; }
        Size NativeSize(Image image)
        { SceneImageSource source; return Images != null && Images.Sources.TryGetValue(image, out source) ? source.NativeSize : image.Size; }
        SceneTexture TileTexture(SceneTile tile)
        {
            var value = tile.Textures ?? new SceneTexture();
            return new SceneTexture { AnchorX = value.AnchorX, AnchorY = value.AnchorY, OffsetX = value.OffsetX, OffsetY = value.OffsetY, ScaleX = value.ScaleX, ScaleY = value.ScaleY, Fit = value.Fit, Rotation = tile.Rotation + value.Rotation };
        }
        void DetailsChanged(bool repaint)
        {
            if (IsDisposed || Disposing) return;
            if (repaint) { backgroundCache.Clear(); foregroundCache.Clear(); Invalidate(); }
            if (ImageDetailChanged != null) ImageDetailChanged(this, EventArgs.Empty);
        }
        void PrepareDetails()
        {
            if (details == null || Images == null || Images.Sources.Count == 0 || wheelPreview || dragging || gesture != null) return;
            var candidates = new List<Candidate>();
            Action<Image, double, double, double, double, SceneTexture, bool> add = (image, x, y, w, h, texture, selected) => {
                SceneImageSource source; if (image == null || !Images.Sources.TryGetValue(image, out source)) return;
                var placement = new SceneImagePlacement(source.NativeSize, x, y, w, h, texture);
                double density = Math.Max(Math.Abs(placement.ScaleX), Math.Abs(placement.ScaleY)) * scale;
                double available = Math.Min((double)image.Width / source.NativeSize.Width, (double)image.Height / source.NativeSize.Height);
                if (density <= available * 1.05 || available >= .999) return;
                var spec = placement.VisibleDetail(ClientSize, scale, panX, panY); if (spec == null) return;
                candidates.Add(new Candidate { Image = image, Source = source, Spec = spec, Selected = selected });
            };
            double cx = layout.MapX + layout.MapWidth / 2, cy = layout.MapY + layout.MapHeight / 2;
            bool mapSelected = Draft != null && Draft.Selection.Kind == SceneSelectionKind.Map;
            add(Images.Background, cx, cy, layout.MapWidth, layout.MapHeight, Level.Textures, mapSelected);
            if (Settings.Tiles)
                foreach (var tile in Scene.Tiles.Where(value => SceneDetail.Included(value.Levels, Level.Id) && value.Alpha > 0 && (Settings.Hidden || !value.Hidden)))
                { Image image; if (Images.Tiles.TryGetValue(tile.Id, out image)) add(image, tile.X, tile.Y, tile.Width, tile.Height, TileTexture(tile), Draft != null && Draft.Image == tile); }
            if (Settings.Foreground) add(Images.Foreground, cx, cy, layout.MapWidth, layout.MapHeight, Level.Textures, mapSelected);
            // Eight patches of at most 8 MiB fit the cache budget; hidden layers cannot cause an eviction/reload loop.
            foreach (var item in candidates.OrderByDescending(value => value.Selected).ThenByDescending(value => (long)value.Spec.Output.Width * value.Spec.Output.Height).Take(8)) details.Request(item.Image, item.Source, item.Spec);
        }
        void DrawAsset(Graphics graphics, Image image, double x, double y, double width, double height, SceneTexture texture, string tint, double alpha)
        {
            var placement = new SceneImagePlacement(NativeSize(image), x, y, width, height, texture);
            if (placement.ScaleX == 0 || placement.ScaleY == 0) return;
            double density = Math.Max(Math.Abs(placement.ScaleX) * placement.Native.Width / image.Width, Math.Abs(placement.ScaleY) * placement.Native.Height / image.Height) * scale;
            var preview = rasterCache.Get(image, density, wheelPreview);
            var patch = wheelPreview || dragging || (gesture != null && gestureChanged) || details == null ? null : details.Get(image);
            var state = graphics.Save();
            try
            {
                graphics.TranslateTransform((float)placement.X, (float)placement.Y); graphics.RotateTransform((float)placement.Rotation); graphics.ScaleTransform((float)placement.ScaleX, (float)placement.ScaleY);
                float ax = (float)(placement.Native.Width * placement.AnchorX), ay = (float)(placement.Native.Height * placement.AnchorY);
                var destination = new RectangleF(-ax, -ay, placement.Native.Width, placement.Native.Height);
                RectangleF region = patch == null ? RectangleF.Empty : new RectangleF(patch.Spec.Region.X - ax, patch.Spec.Region.Y - ay, patch.Spec.Region.Width, patch.Spec.Region.Height);
                var clip = graphics.Save();
                try { if (patch != null) graphics.SetClip(region, CombineMode.Exclude); DrawRaster(graphics, preview, destination, tint, alpha); } finally { graphics.Restore(clip); }
                if (patch != null) DrawRaster(graphics, patch.Image, region, tint, alpha);
            }
            finally { graphics.Restore(state); }
        }
        static void DrawRaster(Graphics graphics, Image image, RectangleF destination, string tint, double alpha)
        {
            var color = ParseColor(tint, Color.White);
            if (color.ToArgb() == Color.White.ToArgb() && alpha >= 1) { graphics.DrawImage(image, destination); return; }
            using (var attributes = new ImageAttributes())
            {
                attributes.SetWrapMode(WrapMode.TileFlipXY);
                attributes.SetColorMatrix(new ColorMatrix { Matrix00 = color.R / 255F, Matrix11 = color.G / 255F, Matrix22 = color.B / 255F, Matrix33 = (float)Math.Max(0, Math.Min(1, alpha)), Matrix44 = 1 });
                var points = new[] { destination.Location, new PointF(destination.Right, destination.Top), new PointF(destination.Left, destination.Bottom) };
                graphics.DrawImage(image, points, new RectangleF(0, 0, image.Width, image.Height), GraphicsUnit.Pixel, attributes);
            }
        }
        RectangleF ContentBounds()
        {
            var points = new List<PointF> { new PointF(0, 0), new PointF((float)layout.Width, (float)layout.Height) };
            if (Level != null)
            {
                if (Images != null && Images.Background != null) points.AddRange(new SceneImagePlacement(NativeSize(Images.Background), layout.MapX + layout.MapWidth / 2, layout.MapY + layout.MapHeight / 2, layout.MapWidth, layout.MapHeight, Level.Textures).Corners());
                if (Images != null && Settings.Foreground && Images.Foreground != null) points.AddRange(new SceneImagePlacement(NativeSize(Images.Foreground), layout.MapX + layout.MapWidth / 2, layout.MapY + layout.MapHeight / 2, layout.MapWidth, layout.MapHeight, Level.Textures).Corners());
                if (Settings.Tiles) foreach (var tile in Scene.Tiles.Where(value => SceneDetail.Included(value.Levels, Level.Id) && (Settings.Hidden || !value.Hidden))) points.AddRange(ImageCorners(tile));
            }
            return RectangleF.FromLTRB(points.Min(p => p.X), points.Min(p => p.Y), points.Max(p => p.X), points.Max(p => p.Y));
        }
    }
}
