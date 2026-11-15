using System;
using System.Collections.Generic;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace KhuzoeAssetsManager
{
    public sealed class SceneImageSource
    {
        public string Identity { get; private set; }
        public Size NativeSize { get; private set; }
        readonly Func<Rectangle, Size, CancellationToken, Task<Bitmap>> decode;
        internal SceneImageSource(string identity, Size size, Func<Rectangle, Size, CancellationToken, Task<Bitmap>> decode)
        { Identity = identity; NativeSize = size; this.decode = decode; }
        internal Task<Bitmap> ReadRegionAsync(Rectangle region, Size output, CancellationToken cancellation) { return decode(region, output, cancellation); }
    }
    internal sealed class SceneImageAsset : IDisposable
    {
        public Image Image; public SceneImageSource Source;
        public void Dispose() { if (Image != null) Image.Dispose(); Image = null; }
    }
    internal sealed class SceneImageMetadata { public int Width { get; set; } public int Height { get; set; } }
    public sealed partial class SceneImages
    {
        internal async Task<SceneImageAsset> LoadLocalAssetAsync(string file, Action<string> progress, CancellationToken cancellation)
        {
            var paths = await tools.EnsureAsync(progress, cancellation).ConfigureAwait(false);
            return await LoadAssetAsync("", "khuzoe-local/import", paths, 1024, cancellation, new Dictionary<string, string> { { "khuzoe-local/import", file } }).ConfigureAwait(false);
        }
        internal async Task<SceneImageAsset> LoadAssetAsync(string dataRoot, string source, ToolPaths paths, int maxEdge, CancellationToken cancellation, IDictionary<string, string> localAssets = null)
        {
            if (String.IsNullOrWhiteSpace(source)) return null;
            string cache = Path.Combine(storage.Root, "scene-images"); FoundryPaths.NoLinks(cache); Directory.CreateDirectory(cache);
            string input, identity, explicitFile; Uri remote;
            bool imported = localAssets != null && localAssets.TryGetValue(source, out explicitFile);
            if (!imported && Uri.TryCreate(source, UriKind.Absolute, out remote))
            {
                if (remote.Scheme != "https") throw new IOException("L'anteprima carica soltanto immagini HTTPS pubbliche.");
                string remoteKey = Digest("original-v3|" + source + "|" + DateTime.UtcNow.Ticks / TimeSpan.FromMinutes(10).Ticks);
                input = Path.Combine(cache, remoteKey + ".source"); FoundryPaths.NoLinks(input);
                if (!File.Exists(input))
                {
                    string pending = Path.Combine(cache, Guid.NewGuid().ToString("N") + ".download");
                    try
                    {
                        using (var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellation))
                        { timeout.CancelAfter(TimeSpan.FromSeconds(45)); await DownloadRemoteAsync(remote, pending, timeout.Token).ConfigureAwait(false); }
                        ImageFormat(pending); cancellation.ThrowIfCancellationRequested();
                        try { File.Move(pending, input); } catch (IOException) { if (!File.Exists(input)) throw; }
                    }
                    catch (OperationCanceledException) { cancellation.ThrowIfCancellationRequested(); throw new IOException("Tempo scaduto durante il caricamento dell'immagine."); }
                    catch (HttpRequestException) { throw new IOException("L'immagine remota non è raggiungibile."); }
                    catch (System.Net.Sockets.SocketException) { throw new IOException("L'indirizzo dell'immagine remota non è raggiungibile."); }
                    finally { if (File.Exists(pending)) File.Delete(pending); }
                }
            }
            else input = imported ? Path.GetFullPath(localAssets[source]) : SceneFiles.LocalAsset(dataRoot, source);
            FoundryPaths.NoLinks(input);
            var info = new FileInfo(input);
            if (!info.Exists) throw new IOException("Immagine originale non trovata: " + source);
            if (info.Length > 100L * 1024 * 1024) throw new IOException("L'immagine supera il limite di 100 MiB.");
            ImageFormat(input); long length = info.Length, stamp = info.LastWriteTimeUtc.Ticks;
            identity = Digest(input + "|" + length + "|" + stamp);
            string key = Digest("preview-v3|" + identity + "|" + maxEdge), output = Path.Combine(cache, key + ".png"), metadataFile = Path.Combine(cache, key + ".json");
            FoundryPaths.NoLinks(output); FoundryPaths.NoLinks(metadataFile);
            SceneImageMetadata metadata = null; Bitmap image = null;
            if (File.Exists(output) && File.Exists(metadataFile))
            {
                try { if (new FileInfo(metadataFile).Length > 4096) throw new IOException("Metadati immagine non validi."); metadata = Json.Read<SceneImageMetadata>(File.ReadAllText(metadataFile)); if (metadata == null) throw new IOException("Metadati immagine mancanti."); ValidateSize(metadata.Width, metadata.Height); image = ReadBitmap(output, maxEdge, (long)maxEdge * maxEdge); }
                catch (Exception error) { if (!(error is IOException) && !(error is ArgumentException) && !(error is InvalidOperationException)) throw; if (image != null) image.Dispose(); image = null; }
            }
            if (image == null)
            {
                string pending = Path.Combine(cache, Guid.NewGuid().ToString("N") + ".png");
                try
                {
                    var args = DecodeArguments(input, "showinfo=checksum=0,scale=w='min(" + maxEdge + ",iw)':h='min(" + maxEdge + ",ih)':force_original_aspect_ratio=decrease:flags=lanczos", pending, true);
                    var result = await runner.RunAsync(paths.Ffmpeg, args, TimeSpan.FromSeconds(45), cancellation, null).ConfigureAwait(false);
                    cancellation.ThrowIfCancellationRequested(); CheckOriginal(input, length, stamp);
                    image = ReadBitmap(pending, maxEdge, (long)maxEdge * maxEdge);
                    var match = Regex.Match(result.Error ?? "", @"\[Parsed_showinfo_[^\]]*\][^\r\n]*\bs:(\d+)x(\d+)\b");
                    if (!match.Success) throw new IOException("Non riesco a leggere le dimensioni originali dell'immagine. Aggiorna gli strumenti e riprova.");
                    metadata = new SceneImageMetadata { Width = Int32.Parse(match.Groups[1].Value, CultureInfo.InvariantCulture), Height = Int32.Parse(match.Groups[2].Value, CultureInfo.InvariantCulture) };
                    ValidateSize(metadata.Width, metadata.Height);
                    InstallCacheFile(pending, output); Json.Save(metadataFile, metadata);
                }
                catch { if (image != null) image.Dispose(); throw; }
                finally { if (File.Exists(pending)) File.Delete(pending); }
            }
            var size = new Size(metadata.Width, metadata.Height);
            var assetSource = new SceneImageSource(identity, size, (region, dimensions, token) => DecodeRegionAsync(input, identity, length, stamp, paths, size, region, dimensions, token));
            return new SceneImageAsset { Image = image, Source = assetSource };
        }
        static void ValidateSize(int width, int height)
        { if (width < 1 || height < 1 || width > 1000000 || height > 1000000) throw new IOException("Dimensioni dell'immagine non valide."); }
        static void CheckOriginal(string file, long length, long stamp)
        { FoundryPaths.NoLinks(file); var info = new FileInfo(file); if (!info.Exists || info.Length != length || info.LastWriteTimeUtc.Ticks != stamp) throw new IOException("L'immagine originale è cambiata: riaprila per aggiornare il dettaglio."); }
        static Bitmap ReadBitmap(string file, int maxEdge, long maxPixels)
        {
            using (var source = Image.FromFile(file))
            { if (source.Width > maxEdge || source.Height > maxEdge || (long)source.Width * source.Height > maxPixels) throw new IOException("Il dettaglio supera la memoria prevista."); return new Bitmap(source); }
        }
        static void InstallCacheFile(string pending, string output)
        { if (File.Exists(output)) File.Replace(pending, output, null); else { try { File.Move(pending, output); } catch (IOException) { if (!File.Exists(output)) throw; } } }
        static IList<string> DecodeArguments(string input, string filter, string output, bool info)
        { string format = ImageFormat(input); string codec = format == "jpg" ? "mjpeg" : format; return new[] { "-nostdin", "-hide_banner", "-loglevel", info ? "info" : "error", "-max_alloc", "536870912", "-threads", "2", "-protocol_whitelist", "file,pipe", "-f", "image2", "-pattern_type", "none", "-c:v", codec, "-i", input, "-frames:v", "1", "-vf", filter, "-threads", "2", output }; }
        async Task<Bitmap> DecodeRegionAsync(string input, string identity, long length, long stamp, ToolPaths paths, Size native, Rectangle region, Size dimensions, CancellationToken cancellation)
        {
            if (region.Width < 1 || region.Height < 1 || region.Left < 0 || region.Top < 0 || region.Right > native.Width || region.Bottom > native.Height || dimensions.Width < 1 || dimensions.Height < 1 || dimensions.Width > region.Width || dimensions.Height > region.Height || (long)dimensions.Width * dimensions.Height > 2 * 1024 * 1024) throw new IOException("Area di dettaglio non valida.");
            cancellation.ThrowIfCancellationRequested(); CheckOriginal(input, length, stamp);
            string cache = Path.Combine(storage.Root, "scene-images"); FoundryPaths.NoLinks(cache);
            string key = Digest("detail-v3|" + identity + "|" + region.X + "," + region.Y + "," + region.Width + "," + region.Height + "|" + dimensions.Width + "," + dimensions.Height);
            string output = Path.Combine(cache, "detail-" + key + ".png"); FoundryPaths.NoLinks(output);
            if (File.Exists(output)) return ReadBitmap(output, 4096, 2 * 1024 * 1024);
            string pending = Path.Combine(cache, Guid.NewGuid().ToString("N") + ".png");
            try
            {
                string filter = "crop=w=" + region.Width + ":h=" + region.Height + ":x=" + region.X + ":y=" + region.Y + ":exact=1,scale=" + dimensions.Width + ":" + dimensions.Height + ":flags=lanczos";
                await runner.RunAsync(paths.Ffmpeg, DecodeArguments(input, filter, pending, false), TimeSpan.FromSeconds(45), cancellation, null).ConfigureAwait(false);
                cancellation.ThrowIfCancellationRequested(); CheckOriginal(input, length, stamp);
                var image = ReadBitmap(pending, 4096, 2 * 1024 * 1024);
                try { InstallCacheFile(pending, output); TrimDetails(cache, output); } catch { image.Dispose(); throw; }
                return image;
            }
            finally { if (File.Exists(pending)) File.Delete(pending); }
        }
        internal static void TrimDetails(string cache, string keep, long budget = 256L * 1024 * 1024)
        {
            // Only disposable detail previews belong to this quota; originals and user files are never candidates.
            var files = new DirectoryInfo(cache).GetFiles("detail-*.png").Where(file => Regex.IsMatch(file.Name, "^detail-[a-f0-9]{64}\\.png$")).OrderBy(file => file.LastWriteTimeUtc).ToList();
            long bytes = files.Sum(file => file.Length);
            foreach (var file in files)
            {
                if (bytes <= budget) break; if (String.Equals(file.FullName, keep, StringComparison.OrdinalIgnoreCase)) continue;
                try { FoundryPaths.NoLinks(file.FullName); long length = file.Length; file.Delete(); bytes -= length; } catch (IOException) { } catch (UnauthorizedAccessException) { }
            }
        }
    }
}
