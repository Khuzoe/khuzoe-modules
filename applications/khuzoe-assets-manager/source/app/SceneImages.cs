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
    public sealed class SceneImages
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
            if (String.IsNullOrWhiteSpace(source)) return null;
            string cache = Path.Combine(storage.Root, "scene-images"); FoundryPaths.NoLinks(cache); Directory.CreateDirectory(cache);
            string input, key; bool temporaryInput = false;
            Uri remote = null; string explicitFile;
            bool imported = localAssets != null && localAssets.TryGetValue(source, out explicitFile);
            if (!imported && Uri.TryCreate(source, UriKind.Absolute, out remote))
            {
                if (remote.Scheme != "https") throw new IOException("L'anteprima non carica immagini con protocolli non sicuri.");
                key = Digest(source + "|" + maxEdge + "|" + (DateTime.UtcNow.Ticks / TimeSpan.FromMinutes(10).Ticks));
                input = Path.Combine(cache, Guid.NewGuid().ToString("N") + ".download"); temporaryInput = true;
            }
            else
            {
                input = imported ? Path.GetFullPath(localAssets[source]) : SceneFiles.LocalAsset(dataRoot, source);
                FoundryPaths.NoLinks(input);
                if (!File.Exists(input)) throw new IOException("Immagine non trovata nei dati Foundry: " + source);
                var info = new FileInfo(input); if (info.Length > 100L * 1024 * 1024) throw new IOException("L'immagine supera il limite di 100 MiB.");
                key = Digest(input + "|" + info.Length + "|" + info.LastWriteTimeUtc.Ticks + "|" + maxEdge);
            }
            string output = Path.Combine(cache, key + ".png"); FoundryPaths.NoLinks(output);
            if (File.Exists(output)) { using (var existing = Image.FromFile(output)) return new Bitmap(existing); }
            string pending = Path.Combine(cache, Guid.NewGuid().ToString("N") + ".png"), renamed = null;
            try
            {
                if (temporaryInput)
                {
                    try
                    {
                        using (var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellation))
                        { timeout.CancelAfter(TimeSpan.FromSeconds(45)); await DownloadRemoteAsync(remote, input, timeout.Token).ConfigureAwait(false); }
                    }
                    catch (HttpRequestException) { throw new IOException("L'immagine remota non è raggiungibile."); }
                    catch (System.Net.Sockets.SocketException) { throw new IOException("L'indirizzo dell'immagine remota non è raggiungibile."); }
                    catch (OperationCanceledException) { cancellation.ThrowIfCancellationRequested(); throw new IOException("Tempo scaduto durante il caricamento dell'immagine remota."); }
                }
                string format = ImageFormat(input);
                // Force the raster demuxer and forbid network protocols during decoding.
                // An asset can never be interpreted as a playlist or execute a helper.
                if (temporaryInput) { renamed = Path.ChangeExtension(input, format); File.Move(input, renamed); input = renamed; }
                await runner.RunAsync(paths.Ffmpeg, new[] { "-nostdin", "-hide_banner", "-loglevel", "error", "-max_alloc", "268435456", "-threads", "2", "-protocol_whitelist", "file,pipe", "-f", "image2", "-pattern_type", "none", "-i", input, "-frames:v", "1", "-vf", "scale=w='min(" + maxEdge + ",iw)':h='min(" + maxEdge + ",ih)':force_original_aspect_ratio=decrease", pending }, TimeSpan.FromSeconds(45), cancellation, null).ConfigureAwait(false);
                cancellation.ThrowIfCancellationRequested();
                Bitmap result;
                using (var image = Image.FromFile(pending))
                {
                    if (image.Width > maxEdge || image.Height > maxEdge) throw new IOException("L'anteprima dell'immagine supera le dimensioni previste.");
                    result = new Bitmap(image);
                }
                try { File.Move(pending, output); } catch (IOException) { if (!File.Exists(output)) { result.Dispose(); throw; } }
                return result;
            }
            finally { if (temporaryInput && File.Exists(input)) File.Delete(input); if (File.Exists(pending)) File.Delete(pending); }
        }
        public async Task<SceneImageSet> LoadLevelAsync(string dataRoot, SceneDetail scene, SceneLevel level, Action<string> progress, CancellationToken cancellation)
        {
            if (String.IsNullOrEmpty(level.Background) && String.IsNullOrEmpty(level.Foreground) && !scene.Tiles.Any(tile => SceneDetail.Included(tile.Levels, level.Id) && !String.IsNullOrEmpty(tile.Src))) return new SceneImageSet();
            var paths = await tools.EnsureAsync(progress, cancellation).ConfigureAwait(false); var result = new SceneImageSet();
            try
            {
                progress("Caricamento della mappa…");
                try { result.Background = await LoadAsync(dataRoot, level.Background, paths, 4096, cancellation, scene.LocalAssets).ConfigureAwait(false); }
                catch (IOException error) { result.Warnings.Add(error.Message); }
                try { result.Foreground = await LoadAsync(dataRoot, level.Foreground, paths, 4096, cancellation, scene.LocalAssets).ConfigureAwait(false); }
                catch (IOException error) { result.Warnings.Add(error.Message); }
                var tiles = scene.Tiles.Where(tile => SceneDetail.Included(tile.Levels, level.Id) && !String.IsNullOrEmpty(tile.Src)).OrderBy(tile => tile.Elevation).ThenBy(tile => tile.Sort).ToList();
                if (tiles.Count > 96) result.Warnings.Add("Vengono mostrate le prime 96 immagini tile di questo livello.");
                foreach (var tile in tiles.Take(96))
                {
                    cancellation.ThrowIfCancellationRequested();
                    try { var image = await LoadAsync(dataRoot, tile.Src, paths, 512, cancellation, scene.LocalAssets).ConfigureAwait(false); if (image != null) result.Tiles[tile.Id] = image; }
                    catch (IOException) { result.Warnings.Add("Un'immagine tile non è disponibile nell'anteprima."); }
                }
                return result;
            }
            catch { result.Dispose(); throw; }
        }
    }
}
