using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace KhuzoeAssetsManager
{
    internal sealed class WallAnalysisForm : Form
    {
        readonly IWallService service;
        readonly SceneCapture capture;
        readonly SceneDetail scene;
        readonly string level, sceneHash;
        readonly SceneImageSet images;
        readonly SceneViewSettings settings;
        readonly WallPendingStore pendingStore;
        readonly RectangleF? selectedArea;
        readonly RadioButton whole = new RadioButton { Text = "Mappa intera", Checked = true, AutoSize = true };
        readonly RadioButton area = new RadioButton { Text = "Area selezionata nell’editor", AutoSize = true };
        readonly CheckBox reduced = new CheckBox { Text = "Dettaglio ridotto (metà risoluzione)", AutoSize = true };
        readonly Label description = Theme.Label("", 9.5F, Theme.Text, FontStyle.Regular);
        readonly Label status = Theme.Label("Verifica del servizio Khuzoe…", 9F, Theme.Muted, FontStyle.Regular);
        readonly Label usage = Theme.Label("", 9F, Theme.Muted, FontStyle.Regular);
        readonly WebButton start = new WebButton { Text = "Avvia analisi AI", Width = 151, Height = 33, Primary = true };
        readonly WebButton recover = new WebButton { Text = "Recupera risultato", Width = 151, Height = 33 };
        readonly WebButton stop = new WebButton { Text = "Interrompi analisi", Width = 151, Height = 33 };
        readonly WebButton review = new WebButton { Text = "Controlla muri", Width = 151, Height = 33 };
        readonly WebButton discard = new WebButton { Text = "Scarta risultato", Width = 151, Height = 33 };
        WallCapabilities capabilities;
        WallPending pending;
        WallJob job;
        CancellationTokenSource activity;
        bool disposed, stopRequested, missing;
        public List<SceneWall> AcceptedWalls { get; private set; }
        public WallAnalysisForm(IWallService service, AppStorage storage, string key, SceneDraft draft, string level, SceneImageSet images, SceneViewSettings settings, RectangleF? selectedArea)
        {
            this.service = service; this.level = level; this.images = images; this.settings = Json.Read<SceneViewSettings>(Json.Write(settings)); this.selectedArea = selectedArea;
            scene = SceneDraft.Copy(draft.Scene); sceneHash = SceneDraft.SceneIdentity(draft.CommittedSnapshot); capture = new SceneCapture(scene, scene.Levels.First(l => l.Id == level), images, this.settings);
            pendingStore = new WallPendingStore(storage, key, level); pending = pendingStore.Load();
            Text = "Rileva muri principali con AI"; StartPosition = FormStartPosition.CenterParent; ClientSize = new Size(750, 468); MinimumSize = new Size(700, 500); BackColor = Theme.Background; ForeColor = Theme.Text; Font = new Font("Segoe UI", 10F);
            var layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 8, Padding = new Padding(20) };
            foreach (int h in new[] { 36, 38, 35, 59, 74, -1, 43, 42 }) layout.RowStyles.Add(h < 0 ? new RowStyle(SizeType.Percent, 100) : new RowStyle(SizeType.Absolute, h));
            layout.Controls.Add(Theme.Label("Riconoscimento muri — sperimentale", 16F, Theme.Text, FontStyle.Bold), 0, 0);
            var modes = new FlowLayoutPanel { Dock = DockStyle.Fill, WrapContents = false }; whole.ForeColor = area.ForeColor = Theme.Text; modes.Controls.Add(whole); modes.Controls.Add(area); area.Margin = new Padding(28, 3, 0, 0); layout.Controls.Add(modes, 0, 1);
            reduced.ForeColor = Theme.Text; layout.Controls.Add(reduced, 0, 2); layout.Controls.Add(description, 0, 3);
            layout.Controls.Add(Theme.Label("Avvia analisi AI invia le immagini dell’area scelta al sito Khuzoe e al suo fornitore AI, con consumo delle API del sito. La cattura include sfondo e immagini visibili del livello. Muri, luci, griglia e percorsi dei file restano esclusi. Le chiavi API rimangono sul server.", 9F, Theme.Muted, FontStyle.Regular), 0, 4);
            var messages = new TableLayoutPanel { Dock = DockStyle.Fill, RowCount = 2, ColumnCount = 1 }; messages.RowStyles.Add(new RowStyle(SizeType.Percent, 65)); messages.RowStyles.Add(new RowStyle(SizeType.Percent, 35)); messages.Controls.Add(status, 0, 0); messages.Controls.Add(usage, 0, 1); layout.Controls.Add(messages, 0, 5);
            var actions = new FlowLayoutPanel { Dock = DockStyle.Fill, WrapContents = false }; actions.Controls.Add(start); actions.Controls.Add(recover); actions.Controls.Add(stop); actions.Controls.Add(review); layout.Controls.Add(actions, 0, 6);
            var bottom = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.RightToLeft }; var close = new WebButton { Text = "Chiudi", Width = 110, Height = 33 }; close.Click += (s, e) => Close(); bottom.Controls.Add(close); bottom.Controls.Add(discard); layout.Controls.Add(bottom, 0, 7); Controls.Add(layout);
            area.Enabled = selectedArea.HasValue; if (area.Enabled) area.Checked = true;
            whole.CheckedChanged += (s, e) => UpdatePlan(); reduced.CheckedChanged += (s, e) => UpdatePlan();
            start.Click += async (s, e) => await StartAsync(); recover.Click += async (s, e) => await RecoverAsync(); stop.Click += async (s, e) => { if (activity != null) { stopRequested = true; activity.Cancel(); stop.Enabled = false; } else await StopAsync(); }; review.Click += (s, e) => Review();
            discard.Click += (s, e) => { pendingStore.Clear(); pending = null; job = null; status.Text = "Suggerimenti scartati. La bozza non è stata modificata."; usage.Text = ""; SetButtons(); };
            Shown += async (s, e) => await CheckServiceAsync();
            FormClosing += (s, e) => { if (activity != null) activity.Cancel(); };
            UpdatePlan(); SetButtons();
        }
        WallRequest Plan() { return SceneWallAnalysis.Plan(area.Checked && selectedArea.HasValue ? selectedArea.Value : capture.Bounds, capture.Density * (reduced.Checked ? .5 : 1)); }
        void UpdatePlan()
        {
            try { var plan = Plan(); description.Text = Math.Round(plan.frame.width) + " × " + Math.Round(plan.frame.height) + " unità scena · " + plan.tiles.Count + " porzioni con margine di contesto. I muri proposti verranno controllati in un’anteprima separata; la conferma li aggiungerà alla bozza locale."; }
            catch (ArgumentException error) { description.Text = error.Message; }
        }
        bool Matching { get { return pending != null && pending.SceneHash == sceneHash && pending.LevelId == level; } }
        void SetButtons()
        {
            bool busy = activity != null;
            start.Enabled = !busy && capabilities != null && capabilities.enabled && (pending == null || missing || job != null && !job.IsRunning);
            recover.Enabled = !busy && pending != null; stop.Enabled = !missing && !stopRequested && pending != null && (job == null || job.IsRunning);
            review.Enabled = !busy && Matching && job != null && !job.IsRunning && job.walls != null && job.walls.Count > 0;
            discard.Enabled = !busy && pending != null && (missing || job != null && !job.IsRunning);
            whole.Enabled = reduced.Enabled = !busy; area.Enabled = !busy && selectedArea.HasValue;
        }
        async Task ExecuteAsync(Func<CancellationToken, Task> action)
        {
            if (activity != null) return; var cancellation = new CancellationTokenSource(); activity = cancellation; SetButtons();
            try { await action(cancellation.Token); }
            catch (OperationCanceledException) { if (!disposed) status.Text = "Attesa interrotta. Recupera risultato per consultare l’analisi inviata."; }
            catch (WallMissingException error) { missing = true; if (!disposed) status.Text = error.Message; }
            catch (Exception error) { if (!disposed) status.Text = error.Message + (pending != null ? " Usa Recupera risultato prima di avviare un’altra analisi." : ""); }
            finally { activity = null; cancellation.Dispose(); if (!disposed) SetButtons(); }
            if (stopRequested && !disposed) { stopRequested = false; await StopAsync(); }
        }
        Task CheckServiceAsync()
        {
            return ExecuteAsync(async cancellation => {
                if (service == null) throw new IOException("Il servizio muri richiede l’accesso Discord dell’app.");
                capabilities = await service.CapabilitiesAsync(cancellation);
                status.Text = capabilities.enabled ? "Servizio disponibile · modello configurato sul sito: " + capabilities.model + "." : "Il riconoscimento muri non è ancora attivo sul sito Khuzoe.";
                if (pending != null) status.Text += Matching ? " È presente un’analisi recuperabile." : " È presente un’analisi di una versione diversa della scena. Puoi recuperarla e interromperla; la conferma sulla scena attuale è disabilitata.";
            });
        }
        Task StartAsync()
        {
            return ExecuteAsync(async cancellation => {
                var request = Plan();
                var progress = new Progress<string>(value => { if (!disposed) status.Text = value; });
                await Task.Run(() => capture.PrepareAsync(request, progress, cancellation), cancellation);
                cancellation.ThrowIfCancellationRequested();
                // Persist the receipt before sending. An ambiguous response is recovered with GET, never a second POST.
                missing = false; pending = new WallPending { Id = request.id, SceneHash = sceneHash, LevelId = level, Frame = request.frame }; pendingStore.Save(pending);
                job = null; SetButtons(); status.Text = "Invio al servizio Khuzoe…";
                job = await service.StartWallsAsync(request, cancellation); ValidateIdentity(); await PollAsync(cancellation);
            });
        }
        Task RecoverAsync()
        {
            return ExecuteAsync(async cancellation => { if (service == null || pending == null) return; job = await service.GetWallsAsync(pending.Id, cancellation); ValidateIdentity(); await PollAsync(cancellation); });
        }
        Task StopAsync()
        {
            return ExecuteAsync(async cancellation => { if (service == null || pending == null) return; job = await service.StopWallsAsync(pending.Id, cancellation); ValidateIdentity(); ShowJob(); });
        }
        void ValidateIdentity()
        {
            if (job == null || job.id != pending.Id || job.frame == null || !job.frame.Valid || job.frame.x != pending.Frame.x || job.frame.y != pending.Frame.y || job.frame.width != pending.Frame.width || job.frame.height != pending.Frame.height) throw new IOException("Il risultato non corrisponde all’analisi richiesta.");
        }
        async Task PollAsync(CancellationToken cancellation)
        {
            ShowJob();
            while (job.IsRunning)
            {
                await Task.Delay(2000, cancellation); job = await service.GetWallsAsync(pending.Id, cancellation); ValidateIdentity(); ShowJob();
            }
        }
        void ShowJob()
        {
            if (disposed || job == null) return;
            status.Text = job.IsRunning ? "Analisi sul sito: " + job.completed + "/" + job.total + " porzioni completate. Chiudi permette di recuperare il risultato in seguito." : job.status == "ready" ? job.walls.Count + " segmenti suggeriti. Apri Controlla muri per correggerli e confermarli." : job.error;
            usage.Text = job.completed + "/" + job.total + " porzioni · " + job.inputTokens + " token ingresso + " + job.outputTokens + " uscita registrati · " + job.model;
        }
        void Review()
        {
            if (!Matching || job == null || job.IsRunning) return;
            using (var form = new WallReviewForm(scene, level, images, job, settings))
            {
                if (form.ShowDialog(this) != DialogResult.OK) return;
                AcceptedWalls = form.AcceptedWalls; DialogResult = DialogResult.OK; Close();
            }
        }
        protected override void Dispose(bool disposing) { if (disposing) { disposed = true; if (activity != null) activity.Cancel(); } base.Dispose(disposing); }
        public void Complete() { pendingStore.Clear(); }
    }
}
