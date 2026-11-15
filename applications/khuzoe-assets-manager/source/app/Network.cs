using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace KhuzoeAssetsManager
{
    public sealed class ConfiguredProxy : IWebProxy
    {
        readonly Uri address;
        readonly string[] bypass;
        public ICredentials Credentials { get; set; }
        public ConfiguredProxy(string proxy, string noProxy)
        {
            Uri parsed;
            if (!Uri.TryCreate(proxy, UriKind.Absolute, out parsed) || (parsed.Scheme != "http" && parsed.Scheme != "https") || String.IsNullOrEmpty(parsed.Host)) throw new IOException("La configurazione del proxy di rete non è valida.");
            if (!String.IsNullOrEmpty(parsed.UserInfo))
            {
                string[] credentials = parsed.UserInfo.Split(new[] { ':' }, 2);
                Credentials = new NetworkCredential(Uri.UnescapeDataString(credentials[0]), credentials.Length == 2 ? Uri.UnescapeDataString(credentials[1]) : "");
            }
            var clean = new UriBuilder(parsed) { UserName = "", Password = "" }; address = clean.Uri;
            bypass = (noProxy ?? "").Split(',').Select(value => value.Trim()).Where(value => value.Length > 0).ToArray();
        }
        public Uri GetProxy(Uri destination) { return IsBypassed(destination) ? destination : address; }
        public bool IsBypassed(Uri destination)
        {
            foreach (string item in bypass)
            {
                if (item == "*") return true;
                string host = item.TrimStart('.'); int port = 0;
                if (host.Count(c => c == ':') == 1)
                {
                    int separator = host.LastIndexOf(':'); int parsed;
                    if (Int32.TryParse(host.Substring(separator + 1), out parsed)) { port = parsed; host = host.Substring(0, separator); }
                }
                host = host.Trim('[', ']');
                if ((port == 0 || port == destination.Port) && (destination.Host.Equals(host, StringComparison.OrdinalIgnoreCase) || destination.Host.EndsWith("." + host, StringComparison.OrdinalIgnoreCase))) return true;
            }
            return false;
        }
    }
    public static class Network
    {
        public static HttpClient Client(TimeSpan timeout)
        {
            ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
            var handler = new HttpClientHandler { AllowAutoRedirect = false };
            // .NET Framework does not read HTTPS_PROXY/ALL_PROXY itself. Respect
            // standard process proxy settings without changing Windows settings.
            string proxy = Environment.GetEnvironmentVariable("https_proxy") ?? Environment.GetEnvironmentVariable("HTTPS_PROXY")
                ?? Environment.GetEnvironmentVariable("all_proxy") ?? Environment.GetEnvironmentVariable("ALL_PROXY");
            if (!String.IsNullOrWhiteSpace(proxy)) handler.Proxy = new ConfiguredProxy(proxy, Environment.GetEnvironmentVariable("no_proxy") ?? Environment.GetEnvironmentVariable("NO_PROXY"));
            var client = new HttpClient(handler) { Timeout = timeout };
            client.DefaultRequestHeaders.UserAgent.ParseAdd("KhuzoeAssetsManager/" + BuildConfig.Version);
            return client;
        }
        public static bool TrustedDownload(Uri url)
        {
            return url.Scheme == "https" && url.IsDefaultPort && url.UserInfo.Length == 0 && new[] { "api.github.com", "github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com", "nodejs.org" }.Contains(url.Host);
        }
        public static async Task<HttpResponseMessage> GetDownloadAsync(HttpClient client, Uri url, CancellationToken cancellation)
        {
            for (int redirects = 0; redirects < 6; redirects++)
            {
                if (!TrustedDownload(url)) throw new IOException("Il download non proviene da una fonte ufficiale autorizzata.");
                var response = await client.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, cancellation);
                if ((int)response.StatusCode >= 300 && (int)response.StatusCode < 400)
                {
                    Uri location = response.Headers.Location; response.Dispose();
                    if (location == null) throw new IOException("Indirizzo di download non valido.");
                    url = location.IsAbsoluteUri ? location : new Uri(url, location); continue;
                }
                response.EnsureSuccessStatusCode(); return response;
            }
            throw new IOException("Troppi reindirizzamenti durante il download.");
        }
        public static async Task<string> TextAsync(HttpClient client, Uri url, CancellationToken cancellation)
        {
            using (var response = await GetDownloadAsync(client, url, cancellation))
            using (var source = await response.Content.ReadAsStreamAsync())
            using (var destination = new MemoryStream())
            {
                byte[] buffer = new byte[65536]; int read;
                while ((read = await source.ReadAsync(buffer, 0, buffer.Length, cancellation)) != 0)
                {
                    if (destination.Length + read > 4 * 1024 * 1024) throw new IOException("Risposta di aggiornamento troppo grande.");
                    await destination.WriteAsync(buffer, 0, read, cancellation);
                }
                return Encoding.UTF8.GetString(destination.ToArray());
            }
        }
        public static async Task DownloadAsync(HttpClient client, Uri url, string destination, long expectedSize, CancellationToken cancellation, Action<int> progress)
        {
            using (var response = await GetDownloadAsync(client, url, cancellation))
            using (var source = await response.Content.ReadAsStreamAsync())
            using (var output = new FileStream(destination, FileMode.CreateNew, FileAccess.Write, FileShare.None, 65536, true))
            {
                long received = 0, length = response.Content.Headers.ContentLength ?? expectedSize;
                byte[] buffer = new byte[65536]; int read, previous = -1;
                while ((read = await source.ReadAsync(buffer, 0, buffer.Length, cancellation)) != 0)
                {
                    received += read;
                    if (received > 450L * 1024 * 1024 || (expectedSize > 0 && received > expectedSize)) throw new IOException("Il pacchetto supera la dimensione prevista.");
                    await output.WriteAsync(buffer, 0, read, cancellation);
                    int value = length > 0 ? (int)Math.Min(100, 100 * received / length) : 0;
                    if (value != previous) { previous = value; if (progress != null) progress(value); }
                }
                if (expectedSize > 0 && received != expectedSize) throw new IOException("Download incompleto. Riprova.");
            }
        }
    }

    public interface IUserSession : IDisposable
    {
        bool IsAuthenticated { get; }
        string DisplayName { get; }
        Task<bool> VerifyAsync(CancellationToken cancellation);
        Task LoginAsync(Action<Uri> openBrowser, Action<string> progress, CancellationToken cancellation);
        void Logout();
    }
    public sealed partial class DiscordAuth : IUserSession, IWallService
    {
        public const string Backend = "https://sigillo-api.khuzoe.workers.dev";
        public const string Site = "https://khuzoe.github.io/sigillo-del-male/";
        const string Campaign = "cripta-di-sangue";
        readonly AppStorage storage;
        readonly HttpClient client;
        string token;
        public Dictionary<string, object> User { get; private set; }
        public bool IsAuthenticated { get { return User != null && !String.IsNullOrEmpty(token); } }
        public string DisplayName { get { string name = Json.Str(User, "global_name"); return name.Length > 0 ? name : Json.Str(User, "username"); } }
        public DiscordAuth(AppStorage storage) { this.storage = storage; client = Network.Client(TimeSpan.FromSeconds(20)); token = storage.LoadSession(); }
        public static Uri ValidateAuthUrl(string input, string expectedPath)
        {
            Uri url;
            if (!Uri.TryCreate(input, UriKind.Absolute, out url) || url.Scheme != "https" || url.GetLeftPart(UriPartial.Authority) != Backend || url.AbsolutePath != expectedPath || url.UserInfo.Length != 0)
                throw new IOException("Il servizio ha restituito un indirizzo di accesso non valido.");
            return url;
        }
        async Task<Dictionary<string, object>> RequestAsync(Uri url, bool authenticated, CancellationToken cancellation)
        {
            using (var request = new HttpRequestMessage(HttpMethod.Get, url))
            {
                request.Headers.Accept.ParseAdd("application/json");
                if (authenticated) request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
                using (var response = await client.SendAsync(request, cancellation))
                {
                    if (response.StatusCode == HttpStatusCode.Unauthorized || response.StatusCode == HttpStatusCode.Forbidden) throw new UnauthorizedAccessException("La sessione è scaduta. Accedi di nuovo con Discord.");
                    if (!response.IsSuccessStatusCode) throw new IOException("Il servizio di accesso non è disponibile (HTTP " + (int)response.StatusCode + "). Riprova tra poco.");
                    string text = await response.Content.ReadAsStringAsync();
                    if (text.Length > 100000) throw new IOException("Risposta di accesso non valida.");
                    return Json.Read<Dictionary<string, object>>(text);
                }
            }
        }
        public async Task<bool> VerifyAsync(CancellationToken cancellation)
        {
            if (String.IsNullOrEmpty(token)) { User = null; return false; }
            try
            {
                var data = await RequestAsync(new Uri(Backend + "/auth/discord/verify?campaign=" + Campaign), true, cancellation);
                var user = Json.Map(data, "user");
                if (user == null || Json.Str(user, "authProvider") != "discord" || Json.Number(user, "exp") <= (DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalSeconds)
                { Logout(); return false; }
                User = user; return true;
            }
            catch (UnauthorizedAccessException) { Logout(); return false; }
        }
        public async Task LoginAsync(Action<Uri> openBrowser, Action<string> progress, CancellationToken cancellation)
        {
            var start = await RequestAsync(new Uri(Backend + "/auth/discord/foundry/start?campaign=" + Campaign), false, cancellation);
            string state = Json.Str(start, "state");
            if (!Regex.IsMatch(state, "^[a-zA-Z0-9_-]{20,256}$")) throw new IOException("Richiesta di accesso non valida.");
            Uri browser = ValidateAuthUrl(Json.Str(start, "authUrl"), "/auth/discord/login");
            Uri poll = ValidateAuthUrl(Json.Str(start, "pollUrl"), "/auth/discord/foundry/poll");
            if (!browser.Query.Contains("bridgeState=" + Uri.EscapeDataString(state)) || !poll.Query.Contains("state=" + Uri.EscapeDataString(state))) throw new IOException("Il collegamento di accesso non corrisponde alla sessione richiesta.");
            openBrowser(browser);
            if (progress != null) progress("Completa l’accesso nel browser. La password viene inserita soltanto su Discord.");
            DateTime expires = DateTime.UtcNow.AddMinutes(9);
            while (DateTime.UtcNow < expires)
            {
                await Task.Delay(2500, cancellation);
                var result = await RequestAsync(poll, false, cancellation);
                string status = Json.Str(result, "status");
                if (status == "missing") throw new IOException("Il collegamento è scaduto. Premi di nuovo Accedi con Discord.");
                if (status != "complete") continue;
                string received = Json.Str(result, "token");
                if (received.Length < 40 || received.Length > 16000) throw new IOException("Sessione ricevuta non valida.");
                token = received;
                if (!await VerifyAsync(cancellation)) throw new IOException("L’identità Discord non è stata verificata.");
                storage.SaveSession(token); return;
            }
            throw new IOException("Tempo di accesso scaduto. Puoi riprovare.");
        }
        public void Logout() { token = ""; User = null; storage.ClearSession(); }
        public void Dispose() { client.Dispose(); }
    }
}
