using System;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace KhuzoeAssetsManager
{
    public interface IWallService
    {
        Task<WallCapabilities> CapabilitiesAsync(CancellationToken cancellation);
        Task<WallJob> StartWallsAsync(WallRequest request, CancellationToken cancellation);
        Task<WallJob> GetWallsAsync(string id, CancellationToken cancellation);
        Task<WallJob> StopWallsAsync(string id, CancellationToken cancellation);
    }
    internal sealed class WallMissingException : IOException { public WallMissingException() : base("Analisi non trovata sul sito o scaduta. Puoi scartare il riferimento e avviare una nuova analisi.") { } }
    public sealed partial class DiscordAuth
    {
        async Task<string> WallRequestAsync(HttpMethod method, string suffix, object body, CancellationToken cancellation)
        {
            if (!IsAuthenticated) throw new UnauthorizedAccessException("Accedi con Discord prima di analizzare i muri.");
            using (var http = Network.Client(TimeSpan.FromSeconds(90)))
            using (var request = new HttpRequestMessage(method, new Uri(Backend + "/api/assets/walls" + suffix + "?campaign=" + Uri.EscapeDataString(Campaign))))
            {
                request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
                request.Headers.Accept.ParseAdd("application/json");
                if (body != null) { string json = Json.Write(body); if (Encoding.UTF8.GetByteCount(json) > 15 * 1024 * 1024) throw new IOException("Le immagini superano il limite di invio. Riduci il dettaglio o seleziona un’area più piccola."); request.Content = new StringContent(json, Encoding.UTF8, "application/json"); }
                using (var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellation).ConfigureAwait(false))
                using (var stream = await response.Content.ReadAsStreamAsync().ConfigureAwait(false))
                using (var memory = new MemoryStream())
                {
                    byte[] buffer = new byte[65536]; int count;
                    while ((count = await stream.ReadAsync(buffer, 0, buffer.Length, cancellation).ConfigureAwait(false)) != 0) { if (memory.Length + count > 4 * 1024 * 1024) throw new IOException("Risposta del servizio muri troppo grande."); memory.Write(buffer, 0, count); }
                    string text = Encoding.UTF8.GetString(memory.ToArray());
                    if (!response.IsSuccessStatusCode)
                    {
                        if (response.StatusCode == HttpStatusCode.NotFound && suffix.Length == 0) throw new IOException("Il riconoscimento muri non è ancora attivo sul sito Khuzoe. Riprova dopo l’aggiornamento del servizio.");
                        if (response.StatusCode == HttpStatusCode.NotFound) throw new WallMissingException();
                        string message = "Il servizio muri non è disponibile (HTTP " + (int)response.StatusCode + ").";
                        try { var value = Json.Read<System.Collections.Generic.Dictionary<string, object>>(text); string error = Json.Str(value, "error"); if (error.Length > 0 && error.Length < 600) message = error; } catch (ArgumentException) { }
                        if (response.StatusCode == HttpStatusCode.Unauthorized || response.StatusCode == HttpStatusCode.Forbidden) throw new UnauthorizedAccessException(message);
                        throw new IOException(message);
                    }
                    return text;
                }
            }
        }
        static string WallId(string id) { Guid guid; if (!Guid.TryParseExact(id, "D", out guid)) throw new ArgumentException("Identificativo di analisi non valido."); return "/" + guid.ToString("D"); }
        static WallJob ReadJob(string text)
        { var response = Json.Read<WallJobResponse>(text); if (response == null || !response.ok || response.job == null || response.job.walls == null || response.job.total < 1 || response.job.total > 64 || response.job.completed < 0 || response.job.completed > response.job.total || response.job.walls.Count > 20000) throw new IOException("Risultato del servizio muri non valido."); return response.job; }
        public async Task<WallCapabilities> CapabilitiesAsync(CancellationToken cancellation)
        { var value = Json.Read<WallCapabilities>(await WallRequestAsync(HttpMethod.Get, "", null, cancellation).ConfigureAwait(false)); if (value == null || !value.ok || value.version != 1) throw new IOException("Il servizio muri del sito richiede un aggiornamento."); return value; }
        public async Task<WallJob> StartWallsAsync(WallRequest request, CancellationToken cancellation)
        { WallId(request.id); return ReadJob(await WallRequestAsync(HttpMethod.Post, "", request, cancellation).ConfigureAwait(false)); }
        public async Task<WallJob> GetWallsAsync(string id, CancellationToken cancellation)
        { return ReadJob(await WallRequestAsync(HttpMethod.Get, WallId(id), null, cancellation).ConfigureAwait(false)); }
        public async Task<WallJob> StopWallsAsync(string id, CancellationToken cancellation)
        { return ReadJob(await WallRequestAsync(HttpMethod.Post, WallId(id) + "/stop", null, cancellation).ConfigureAwait(false)); }
    }
    public sealed class WallPendingStore
    {
        readonly string file;
        public WallPendingStore(AppStorage storage, string key, string level)
        { file = Path.Combine(storage.Root, "scene-ai", SceneDraft.Digest(key + "|" + level) + ".json"); }
        public WallPending Load()
        {
            FoundryPaths.NoLinks(file); if (!File.Exists(file)) return null;
            if (new FileInfo(file).Length > 8192) throw new IOException("Richiesta di analisi salvata non valida.");
            var value = Json.Read<WallPending>(File.ReadAllText(file, Encoding.UTF8)); Guid guid;
            if (value == null || !Guid.TryParseExact(value.Id, "D", out guid) || value.Frame == null || !value.Frame.Valid) throw new IOException("Richiesta di analisi salvata non valida.");
            return value;
        }
        public void Save(WallPending value) { FoundryPaths.NoLinks(file); Json.Save(file, value); }
        public void Clear() { FoundryPaths.NoLinks(file); if (File.Exists(file)) File.Delete(file); }
    }
}
