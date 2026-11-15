using System;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace KhuzoeAssetsManager
{
    public sealed partial class SceneImages
    {
        readonly AppStorage storage;
        readonly IToolProvider tools;
        readonly IProcessRunner runner;
        public SceneImages(AppStorage storage, IToolProvider tools, IProcessRunner runner) { this.storage = storage; this.tools = tools; this.runner = runner; }
        public static bool PublicAddress(IPAddress address)
        {
            if (IPAddress.IsLoopback(address)) return false;
            if (address.IsIPv4MappedToIPv6) address = address.MapToIPv4();
            byte[] bytes = address.GetAddressBytes();
            if (bytes.Length == 16) return !address.IsIPv6LinkLocal && !address.IsIPv6SiteLocal && bytes[0] != 0xff && (bytes[0] & 0xfe) != 0xfc && !bytes.All(value => value == 0);
            return bytes[0] != 0 && bytes[0] != 10 && bytes[0] != 127 && !(bytes[0] == 169 && bytes[1] == 254)
                && !(bytes[0] == 172 && bytes[1] >= 16 && bytes[1] <= 31) && !(bytes[0] == 192 && bytes[1] == 168)
                && !(bytes[0] == 100 && bytes[1] >= 64 && bytes[1] <= 127) && bytes[0] < 224;
        }
        public static async Task ValidateRemoteAsync(Uri url)
        {
            if (url.Scheme != "https" || !url.IsDefaultPort || url.UserInfo.Length > 0 || url.Host.EndsWith(".localhost", StringComparison.OrdinalIgnoreCase) || url.Host.Equals("localhost", StringComparison.OrdinalIgnoreCase))
                throw new IOException("Sono ammesse soltanto immagini HTTPS su indirizzi pubblici.");
            IPAddress literal;
            var addresses = IPAddress.TryParse(url.Host, out literal) ? new[] { literal } : await Dns.GetHostAddressesAsync(url.Host).ConfigureAwait(false);
            if (addresses.Length == 0 || addresses.Any(address => !PublicAddress(address))) throw new IOException("L'indirizzo dell'immagine non è pubblico.");
        }
        static string Digest(string value) { using (var hash = SHA256.Create()) return BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(value))).Replace("-", "").ToLowerInvariant(); }
        public static string RasterFormat(byte[] bytes)
        {
            if (bytes.Length >= 8 && bytes[0] == 137 && Encoding.ASCII.GetString(bytes, 1, 3) == "PNG") return "png";
            if (bytes.Length >= 3 && bytes[0] == 255 && bytes[1] == 216 && bytes[2] == 255) return "jpg";
            if (bytes.Length >= 6 && Encoding.ASCII.GetString(bytes, 0, 3) == "GIF") return "gif";
            if (bytes.Length >= 12 && Encoding.ASCII.GetString(bytes, 0, 4) == "RIFF" && Encoding.ASCII.GetString(bytes, 8, 4) == "WEBP") return "webp";
            if (bytes.Length >= 2 && bytes[0] == 'B' && bytes[1] == 'M') return "bmp";
            throw new IOException("Formato non visualizzabile in questa anteprima. Sono supportati PNG, JPEG, WebP, GIF e BMP.");
        }
        static string ImageFormat(string file)
        { byte[] bytes = new byte[16]; using (var input = File.OpenRead(file)) input.Read(bytes, 0, bytes.Length); return RasterFormat(bytes); }
        async Task DownloadRemoteAsync(Uri url, string target, CancellationToken cancellation)
        {
            using (var client = Network.Client(TimeSpan.FromSeconds(45)))
            {
                for (int redirects = 0; redirects < 5; redirects++)
                {
                    await ValidateRemoteAsync(url).ConfigureAwait(false); cancellation.ThrowIfCancellationRequested();
                    using (var response = await client.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, cancellation).ConfigureAwait(false))
                    {
                        if ((int)response.StatusCode >= 300 && (int)response.StatusCode < 400)
                        { if (response.Headers.Location == null) throw new IOException("Indirizzo dell'immagine non valido."); url = response.Headers.Location.IsAbsoluteUri ? response.Headers.Location : new Uri(url, response.Headers.Location); continue; }
                        if (!response.IsSuccessStatusCode) throw new IOException("L'immagine remota non è disponibile (HTTP " + (int)response.StatusCode + ").");
                        using (var source = await response.Content.ReadAsStreamAsync().ConfigureAwait(false))
                        using (var output = new FileStream(target, FileMode.CreateNew, FileAccess.Write, FileShare.None, 65536, true))
                        {
                            byte[] buffer = new byte[65536]; int read; long total = 0;
                            while ((read = await source.ReadAsync(buffer, 0, buffer.Length, cancellation).ConfigureAwait(false)) > 0)
                            {
                                total += read; if (total > 100L * 1024 * 1024) throw new IOException("L'immagine supera il limite di 100 MiB.");
                                await output.WriteAsync(buffer, 0, read, cancellation).ConfigureAwait(false);
                            }
                        }
                        return;
                    }
                }
                throw new IOException("Troppi reindirizzamenti dell'immagine.");
            }
        }
        public async Task<Image> LoadLocalAsync(string file, Action<string> progress, CancellationToken cancellation)
        {
            var paths = await tools.EnsureAsync(progress, cancellation).ConfigureAwait(false);
            return await LoadAsync("", "khuzoe-local/import", paths, 1024, cancellation, new System.Collections.Generic.Dictionary<string, string> { { "khuzoe-local/import", file } }).ConfigureAwait(false);
        }
        public async Task<Image> LoadAsync(string dataRoot, string source, ToolPaths paths, int maxEdge, CancellationToken cancellation, System.Collections.Generic.IDictionary<string, string> localAssets = null)
        {
            var asset = await LoadAssetAsync(dataRoot, source, paths, maxEdge, cancellation, localAssets).ConfigureAwait(false);
            return asset == null ? null : asset.Image;
        }
        public async Task<SceneImageSet> LoadLevelAsync(string dataRoot, SceneDetail scene, SceneLevel level, Action<string> progress, CancellationToken cancellation)
        {
            if (String.IsNullOrEmpty(level.Background) && String.IsNullOrEmpty(level.Foreground) && !scene.Tiles.Any(tile => SceneDetail.Included(tile.Levels, level.Id) && !String.IsNullOrEmpty(tile.Src))) return new SceneImageSet();
            var paths = await tools.EnsureAsync(progress, cancellation).ConfigureAwait(false); var result = new SceneImageSet();
            try
            {
                progress("Caricamento della mappa…");
                try { result.Background = result.Register(await LoadAssetAsync(dataRoot, level.Background, paths, 2048, cancellation, scene.LocalAssets).ConfigureAwait(false)); }
                catch (IOException error) { result.Warnings.Add(error.Message); }
                try { result.Foreground = result.Register(await LoadAssetAsync(dataRoot, level.Foreground, paths, 2048, cancellation, scene.LocalAssets).ConfigureAwait(false)); }
                catch (IOException error) { result.Warnings.Add(error.Message); }
                var tiles = scene.Tiles.Where(tile => SceneDetail.Included(tile.Levels, level.Id) && !String.IsNullOrEmpty(tile.Src)).OrderBy(tile => tile.Elevation).ThenBy(tile => tile.Sort).ToList();
                if (tiles.Count > 96) result.Warnings.Add("Vengono mostrate le prime 96 immagini tile di questo livello.");
                long remaining = 64L * 1024 * 1024 - (result.Background == null ? 0 : (long)result.Background.Width * result.Background.Height * 4) - (result.Foreground == null ? 0 : (long)result.Foreground.Width * result.Foreground.Height * 4);
                int tileEdge = 1024; while ((long)tileEdge * tileEdge * 4 * Math.Min(96, tiles.Count) > remaining && tileEdge > 128) tileEdge /= 2;
                foreach (var tile in tiles.Take(96))
                {
                    cancellation.ThrowIfCancellationRequested();
                    try { var image = result.Register(await LoadAssetAsync(dataRoot, tile.Src, paths, tileEdge, cancellation, scene.LocalAssets).ConfigureAwait(false)); if (image != null) result.Tiles[tile.Id] = image; }
                    catch (IOException) { result.Warnings.Add("Un'immagine tile non è disponibile nell'anteprima."); }
                }
                return result;
            }
            catch { result.Dispose(); throw; }
        }
    }
}
