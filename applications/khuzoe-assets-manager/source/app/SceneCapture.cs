using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;

namespace KhuzoeAssetsManager
{
    // A private analysis copy from original sources, independent of viewport zoom and overlays.
    internal sealed class SceneCapture
    {
        sealed class Layer { public SceneImageSource Source; public SceneImagePlacement Placement; public string Tint; public double Alpha; }
        readonly List<Layer> layers = new List<Layer>();
        readonly Color background;
        readonly RectangleF mapBounds;
        public RectangleF Bounds { get; private set; }
        public double Density { get; private set; }
        public SceneCapture(SceneDetail scene, SceneLevel level, SceneImageSet images, SceneViewSettings settings)
        {
            if (scene == null || level == null || images == null) throw new ArgumentException("Apri una mappa prima di avviare l’analisi.");
            var layout = SceneLayout.From(scene); mapBounds = new RectangleF((float)layout.MapX, (float)layout.MapY, (float)layout.MapWidth, (float)layout.MapHeight);
            background = SceneCanvas.ParseColor(level.BackgroundColor, Color.FromArgb(50, 52, 60));
            Action<Image, double, double, double, double, SceneTexture, string, double> add = (image, x, y, width, height, texture, tint, alpha) => {
                SceneImageSource source; if (image == null || alpha <= 0 || !images.Sources.TryGetValue(image, out source)) return;
                var placement = new SceneImagePlacement(source.NativeSize, x, y, width, height, texture);
                if (placement.ScaleX == 0 || placement.ScaleY == 0) return;
                layers.Add(new Layer { Source = source, Placement = placement, Tint = tint, Alpha = alpha });
                var corners = placement.Corners(); var bounds = RectangleF.FromLTRB(corners.Min(p => p.X), corners.Min(p => p.Y), corners.Max(p => p.X), corners.Max(p => p.Y));
                Bounds = layers.Count == 1 ? bounds : RectangleF.Union(Bounds, bounds);
                Density = Math.Max(Density, 1 / Math.Max(.0001, Math.Min(Math.Abs(placement.ScaleX), Math.Abs(placement.ScaleY))));
            };
            double cx = layout.MapX + layout.MapWidth / 2, cy = layout.MapY + layout.MapHeight / 2;
            add(images.Background, cx, cy, layout.MapWidth, layout.MapHeight, level.Textures, level.BackgroundTint, 1);
            if (settings.Tiles) foreach (var tile in scene.Tiles.Where(t => SceneDetail.Included(t.Levels, level.Id) && !t.Hidden).OrderBy(t => t.Elevation).ThenBy(t => t.Sort))
            {
                Image image; if (!images.Tiles.TryGetValue(tile.Id, out image)) continue; var t = tile.Textures ?? new SceneTexture();
                add(image, tile.X, tile.Y, tile.Width, tile.Height, new SceneTexture { AnchorX = t.AnchorX, AnchorY = t.AnchorY, OffsetX = t.OffsetX, OffsetY = t.OffsetY, ScaleX = t.ScaleX, ScaleY = t.ScaleY, Rotation = tile.Rotation + t.Rotation, Fit = t.Fit }, tile.Tint, tile.Alpha);
            }
            if (settings.Foreground) add(images.Foreground, cx, cy, layout.MapWidth, layout.MapHeight, level.Textures, level.ForegroundTint, 1);
            if (layers.Count == 0) throw new ArgumentException("La scena non contiene immagini originali disponibili per l’analisi.");
            Bounds = RectangleF.Intersect(Bounds, RectangleF.FromLTRB(-1000000, -1000000, 1000000, 1000000));
        }
        public async Task<Bitmap> RenderAsync(WallTile tile, CancellationToken cancellation)
        {
            var output = new Bitmap(tile.width, tile.height, PixelFormat.Format32bppArgb);
            try
            {
                using (var g = Graphics.FromImage(output))
                {
                    g.Clear(Color.FromArgb(30, 31, 36)); g.InterpolationMode = InterpolationMode.HighQualityBicubic; g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                    double sx = tile.width / tile.frame.width, sy = tile.height / tile.frame.height;
                    using (var brush = new SolidBrush(background)) g.FillRectangle(brush, (float)((mapBounds.X - tile.frame.x) * sx), (float)((mapBounds.Y - tile.frame.y) * sy), (float)(mapBounds.Width * sx), (float)(mapBounds.Height * sy));
                    foreach (var layer in layers)
                    {
                        cancellation.ThrowIfCancellationRequested();
                        var p = layer.Placement;
                        var corners = new[] { new PointF((float)tile.frame.x, (float)tile.frame.y), new PointF((float)(tile.frame.x + tile.frame.width), (float)tile.frame.y), new PointF((float)(tile.frame.x + tile.frame.width), (float)(tile.frame.y + tile.frame.height)), new PointF((float)tile.frame.x, (float)(tile.frame.y + tile.frame.height)) };
                        using (var inverse = p.ToScreen(1, 0, 0)) { if (!inverse.IsInvertible) continue; inverse.Invert(); inverse.TransformPoints(corners); }
                        int left = Math.Max(0, (int)Math.Floor(corners.Min(v => v.X))), top = Math.Max(0, (int)Math.Floor(corners.Min(v => v.Y)));
                        int right = Math.Min(p.Native.Width, (int)Math.Ceiling(corners.Max(v => v.X))), bottom = Math.Min(p.Native.Height, (int)Math.Ceiling(corners.Max(v => v.Y)));
                        if (right <= left || bottom <= top) continue;
                        var region = Rectangle.FromLTRB(left, top, right, bottom);
                        double sample = Math.Min(1, Math.Max(Math.Abs(p.ScaleX), Math.Abs(p.ScaleY)) * Math.Max(sx, sy)); sample = Math.Min(sample, Math.Sqrt(2.0 * 1024 * 1024 / ((double)region.Width * region.Height)));
                        var dimensions = new Size(Math.Max(1, (int)Math.Floor(region.Width * sample)), Math.Max(1, (int)Math.Floor(region.Height * sample)));
                        using (var patch = await layer.Source.ReadRegionAsync(region, dimensions, cancellation).ConfigureAwait(false))
                        using (var attributes = new ImageAttributes())
                        {
                            Color tint = SceneCanvas.ParseColor(layer.Tint, Color.White);
                            attributes.SetColorMatrix(new ColorMatrix(new[] { new[] { tint.R / 255F, 0F, 0F, 0F, 0F }, new[] { 0F, tint.G / 255F, 0F, 0F, 0F }, new[] { 0F, 0F, tint.B / 255F, 0F, 0F }, new[] { 0F, 0F, 0F, (float)Math.Max(0, Math.Min(1, layer.Alpha)), 0F }, new[] { 0F, 0F, 0F, 0F, 1F } }));
                            var points = new[] { new PointF(left, top), new PointF(right, top), new PointF(left, bottom) };
                            using (var matrix = p.ToScreen(1, 0, 0)) matrix.TransformPoints(points);
                            for (int i = 0; i < points.Length; i++) points[i] = new PointF((float)((points[i].X - tile.frame.x) * sx), (float)((points[i].Y - tile.frame.y) * sy));
                            g.DrawImage(patch, points, new RectangleF(0, 0, patch.Width, patch.Height), GraphicsUnit.Pixel, attributes);
                        }
                    }
                }
                cancellation.ThrowIfCancellationRequested(); return output;
            }
            catch { output.Dispose(); throw; }
        }
        public async Task PrepareAsync(WallRequest request, IProgress<string> progress, CancellationToken cancellation)
        {
            long total = 0;
            for (int i = 0; i < request.tiles.Count; i++)
            {
                progress.Report("Preparazione immagine " + (i + 1) + "/" + request.tiles.Count + ".");
                using (var image = await RenderAsync(request.tiles[i], cancellation).ConfigureAwait(false))
                using (var memory = new MemoryStream())
                using (var options = new EncoderParameters(1))
                {
                    options.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 92L);
                    image.Save(memory, ImageCodecInfo.GetImageEncoders().First(c => c.MimeType == "image/jpeg"), options);
                    request.tiles[i].image = "data:image/jpeg;base64," + Convert.ToBase64String(memory.ToArray());
                    total += request.tiles[i].image.Length;
                    if (total > 14L * 1024 * 1024) throw new IOException("Le immagini superano il limite di invio. Scegli un’area più piccola o il dettaglio ridotto.");
                }
            }
        }
    }
}
