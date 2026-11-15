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
    public sealed partial class ScenesPanel : UserControl
    {
        readonly AppStorage storage;
        readonly Preferences preferences;
        readonly SceneRepository repository;
        readonly SceneImages imageLoader;
        readonly Func<Task> requireLogin;
        readonly Action chooseFolder;
        readonly IWallService wallService;
        readonly ComboBox worlds = Theme.Combo("Mondo Foundry");
        readonly ComboBox levels = Theme.Combo("Livello della scena");
        readonly ListBox scenes = new ListBox();
        readonly TextBox search = Theme.TextBox("Cerca una scena");
        readonly Label path = Theme.Label("Scegli la cartella Foundry.", 9F, Theme.Muted, FontStyle.Regular);
        readonly Label status = Theme.Label("Scegli un mondo per leggere le scene presenti in Foundry.", 9F, Theme.Muted, FontStyle.Regular);
        readonly Label detail = Theme.Label("Mappa, muri e luci del livello selezionato", 9F, Theme.Muted, FontStyle.Regular);
        readonly Label zoom = Theme.Label("", 9F, Theme.Muted, FontStyle.Regular);
        readonly WebButton refresh = new WebButton { Text = "Aggiorna", Width = 115, Dock = DockStyle.Fill };
        readonly SceneCanvas canvas = new SceneCanvas();
        readonly FlowLayoutPanel filters = new FlowLayoutPanel { Dock = DockStyle.Fill, WrapContents = true, Margin = Padding.Empty, Padding = new Padding(1, 3, 0, 0) };
        readonly CheckBox grid;
        readonly ToolTip tips = new ToolTip();
        readonly SceneDraftStore draftStore;
        readonly SceneDraftSaver draftSaver;
        readonly Dictionary<string, SceneDraft> drafts = new Dictionary<string, SceneDraft>();
        readonly SceneEditorPanel editor;
        readonly TableLayoutPanel content, viewport, viewerRows;
        readonly SurfacePanel listCard;
        readonly WebButton editToggle = new WebButton { Text = "Modifica locale", Width = 142, Height = 31 };
        readonly WebButton blank = new WebButton { Text = "Bozza libera", Width = 115, Height = 31 };
        readonly WebButton reset = new WebButton { Text = "Ripristina", Width = 100, Height = 31 };
        readonly Label draftBadge = Theme.Label("Anteprima locale", 8.5F, Theme.Green, FontStyle.Regular);
        SceneDraft draft;
        string draftKey, imageSignature, draftNotice;
        bool editMode;
        bool draftSaved = true;
        bool draftPending;
        long draftSaveRevision;
        CancellationTokenSource active;
        SceneSnapshot snapshot;
        SceneCatalog catalog;
        SceneDetail current;
        SceneImageSet images;
        string root, loadedRoot;
        bool allowed, loaded, suppress;
        public bool IsBusy { get; private set; }
        public SceneCanvas Canvas { get { return canvas; } }
        public SceneDraft Draft { get { return draft; } }
        public SceneEditorPanel Editor { get { return editor; } }
        public string StatusText { get { return status.Text; } }
        public event EventHandler BusyChanged;
        public ScenesPanel(AppStorage storage, Preferences preferences, IToolProvider tools, Func<Task> requireLogin, Action chooseFolder, IWallService wallService = null)
        {
            this.storage = storage; this.preferences = preferences; this.requireLogin = requireLogin; this.chooseFolder = chooseFolder; this.wallService = wallService;
            repository = new SceneRepository(storage, tools, new ProcessRunner()); imageLoader = new SceneImages(storage, tools, new ProcessRunner());
            draftStore = new SceneDraftStore(storage); draftSaver = new SceneDraftSaver(draftStore); draftSaver.Completed += DraftSaved; editor = new SceneEditorPanel(canvas);
            Dock = DockStyle.Fill; BackColor = Theme.Background; Padding = new Padding(26, 15, 26, 20);
            var layout = Rows(72, 77, -1, 42); Controls.Add(layout);
            var heading = Rows(43, -1); heading.Controls.Add(Theme.Label("Scene", 25F, Theme.Text, FontStyle.Bold), 0, 0);
            heading.Controls.Add(Theme.Label("Esplora i tuoi mondi e prepara modifiche in una bozza locale.", 10F, Theme.Muted, FontStyle.Regular), 0, 1); layout.Controls.Add(heading, 0, 0);
            var folder = new SurfacePanel { Dock = DockStyle.Fill, Padding = new Padding(14, 9, 12, 9), Margin = new Padding(0, 4, 0, 9) };
            var folderRow = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 1, Margin = Padding.Empty };
            folderRow.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            folderRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100)); folderRow.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 140));
            var folderLabels = Rows(20, -1); folderLabels.Controls.Add(Theme.Label("CARTELLA DATI FOUNDRY", 8F, Theme.Gold, FontStyle.Bold), 0, 0); path.AutoEllipsis = true; folderLabels.Controls.Add(path, 0, 1);
            var choose = new WebButton { Text = "Scegli cartella", Dock = DockStyle.Fill }; choose.Click += (s, e) => this.chooseFolder();
            folderRow.Controls.Add(folderLabels, 0, 0); folderRow.Controls.Add(choose, 1, 0); folder.Controls.Add(folderRow); layout.Controls.Add(folder, 0, 1);
            content = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 1, Margin = Padding.Empty };
            content.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            content.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 250)); content.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100)); layout.Controls.Add(content, 0, 2);
            listCard = new SurfacePanel { Dock = DockStyle.Fill, Padding = new Padding(10), Margin = new Padding(0, 0, 12, 0) };
            var list = Rows(20, 36, 38, 23, 32, -1); list.Controls.Add(Theme.Label("MONDO", 8F, Theme.Gold, FontStyle.Bold), 0, 0);
            worlds.DropDownStyle = ComboBoxStyle.DropDownList; list.Controls.Add(worlds, 0, 1); refresh.Click += async (s, e) => { if (IsBusy) { if (active != null) active.Cancel(); return; } await RunAsync(LoadWorldAsync); }; list.Controls.Add(refresh, 0, 2);
            list.Controls.Add(Theme.Label("CERCA SCENA", 8F, Theme.Muted, FontStyle.Regular), 0, 3); list.Controls.Add(search, 0, 4);
            scenes.Dock = DockStyle.Fill; scenes.BackColor = Theme.Surface; scenes.ForeColor = Theme.Text; scenes.BorderStyle = BorderStyle.None;
            scenes.DrawMode = DrawMode.OwnerDrawFixed; scenes.ItemHeight = 57; scenes.IntegralHeight = false;
            scenes.DrawItem += DrawSceneItem; list.Controls.Add(scenes, 0, 5); listCard.Controls.Add(list); content.Controls.Add(listCard, 0, 0);
            var viewer = new SurfacePanel { Dock = DockStyle.Fill, Padding = new Padding(11), Margin = Padding.Empty };
            viewerRows = Rows(34, 49, 38, 0, -1, 31); var top = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 5, RowCount = 1, Margin = Padding.Empty };
            top.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            top.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100)); top.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 60)); top.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 33)); top.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 33)); top.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 65));
            levels.DropDownStyle = ComboBoxStyle.DropDownList; top.Controls.Add(levels, 0, 0); zoom.TextAlign = ContentAlignment.MiddleCenter; top.Controls.Add(zoom, 1, 0);
            var minus = new WebButton { Text = "−", Dock = DockStyle.Fill }; minus.Click += (s, e) => canvas.ChangeZoom(1 / 1.25); top.Controls.Add(minus, 2, 0);
            var plus = new WebButton { Text = "+", Dock = DockStyle.Fill }; plus.Click += (s, e) => canvas.ChangeZoom(1.25); top.Controls.Add(plus, 3, 0);
            var fit = new WebButton { Text = "Adatta", Dock = DockStyle.Fill }; fit.Click += (s, e) => canvas.Fit(); top.Controls.Add(fit, 4, 0); viewerRows.Controls.Add(top, 0, 0);
            canvas.Settings = preferences.SceneView;
            AddFilter("Muri", preferences.SceneView.Walls, value => preferences.SceneView.Walls = value, "Mostra i segmenti dei muri e delle porte registrati in Foundry.");
            AddFilter("Luci", preferences.SceneView.Lights, value => preferences.SceneView.Lights = value, "Mostra la portata delle luci: non simula ombre, occlusione o animazioni.");
            AddFilter("Indicatori", preferences.SceneView.Indicators, value => preferences.SceneView.Indicators = value, "Mostra vertici dei muri, icone delle porte e sorgenti luminose.");
            grid = AddFilter("Griglia", preferences.SceneView.Grid, value => preferences.SceneView.Grid = value, "Reticolo quadrato; i muri e le luci seguono anche le coordinate delle scene esagonali.");
            AddFilter("Tile", preferences.SceneView.Tiles, value => preferences.SceneView.Tiles = value, "Mostra gli elementi immagine del livello.");
            AddFilter("Primo piano", preferences.SceneView.Foreground, value => preferences.SceneView.Foreground = value, "Mostra l'immagine di primo piano del livello.");
            AddFilter("Disattivati", preferences.SceneView.Hidden, value => preferences.SceneView.Hidden = value, "Include luci disattivate ed elementi immagine nascosti.");
            viewerRows.Controls.Add(filters, 0, 1);
            var editBar = new FlowLayoutPanel { Dock = DockStyle.Fill, WrapContents = false, AutoScroll = true, Margin = Padding.Empty };
            editToggle.AccessibleName = "Modifica locale"; editToggle.Click += (s, e) => SetEditMode(!editMode);
            blank.AccessibleName = "Bozza libera"; blank.Click += (s, e) => OpenBlankDraft();
            reset.Click += (s, e) => { if (draft != null) { canvas.CancelEditorGesture(); draft.Reset(); } };
            draftBadge.Dock = DockStyle.None; draftBadge.Size = new Size(355, 31); draftBadge.AutoEllipsis = true;
            foreach (Control control in new Control[] { editToggle, blank, reset, draftBadge }) { control.Margin = new Padding(1, 2, 5, 0); editBar.Controls.Add(control); }
            viewerRows.Controls.Add(editBar, 0, 2); viewerRows.Controls.Add(editor.Toolbar, 0, 3); editor.Toolbar.Visible = false;
            viewport = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 1, Margin = Padding.Empty };
            viewport.RowStyles.Add(new RowStyle(SizeType.Percent, 100)); viewport.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100)); viewport.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 0));
            viewport.Controls.Add(canvas, 0, 0); viewport.Controls.Add(editor, 1, 0); editor.Visible = false;
            viewerRows.Controls.Add(viewport, 0, 4); detail.AutoEllipsis = true; viewerRows.Controls.Add(detail, 0, 5); viewer.Controls.Add(viewerRows); content.Controls.Add(viewer, 1, 0);
            editor.Changed += (s, e) => DraftChanged();
            canvas.ImageDetailChanged += (s, e) => UpdateDraftBadge();
            editor.ImportImage += async (s, e) => await ImportImageAsync(false);
            editor.ChangeMap += async (s, e) => await ImportImageAsync(true);
            editor.AnalyzeWalls += async (s, e) => await AnalyzeWallsAsync();
            canvas.AllowDrop = true;
            canvas.DragEnter += (s, e) => { e.Effect = allowed && editMode && !IsBusy && e.Data.GetDataPresent(DataFormats.FileDrop) ? DragDropEffects.Copy : DragDropEffects.None; };
            canvas.DragDrop += async (s, e) => {
                if (!allowed || !editMode || IsBusy || !e.Data.GetDataPresent(DataFormats.FileDrop)) return;
                var files = (string[])e.Data.GetData(DataFormats.FileDrop);
                var point = canvas.ScenePoint(canvas.PointToClient(new Point(e.X, e.Y)), true);
                foreach (string file in files.Take(12)) await ImportLocalImageAsync(file, false, point);
            };
            status.AutoEllipsis = true; layout.Controls.Add(status, 0, 3);
            worlds.SelectedIndexChanged += async (s, e) => { if (!suppress && !IsBusy && allowed) await RunAsync(LoadWorldAsync); };
            scenes.SelectedIndexChanged += async (s, e) => { if (!suppress && !IsBusy && allowed) await RunAsync(LoadSceneAsync); };
            levels.SelectedIndexChanged += async (s, e) => { if (!suppress && !IsBusy && allowed) await RunAsync(LoadLevelAsync); };
            search.TextChanged += async (s, e) => { FilterScenes(null); if (!IsBusy && allowed) await RunAsync(LoadSceneAsync); };
            canvas.ZoomChanged += (s, e) => zoom.Text = Math.Round(canvas.Zoom * 100) + "%";
            VisibleChanged += async (s, e) => { if (Visible && allowed && !loaded && !IsBusy) await RunAsync(LoadWorldsAsync); };
        }
        static TableLayoutPanel Rows(params int[] heights)
        {
            var result = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = heights.Length, Margin = Padding.Empty, BackColor = Color.Transparent };
            foreach (int height in heights) result.RowStyles.Add(height < 0 ? new RowStyle(SizeType.Percent, 100) : new RowStyle(SizeType.Absolute, height)); return result;
        }
        CheckBox AddFilter(string label, bool initial, Action<bool> update, string hint)
        {
            var box = new CheckBox { Text = label, Checked = initial, AutoSize = true, ForeColor = Theme.Text, BackColor = Color.Transparent, Margin = new Padding(0, 2, 12, 1), Font = new Font("Segoe UI", 8.5F), AccessibleName = "Mostra " + label };
            box.CheckedChanged += (s, e) => { update(box.Checked); storage.SavePreferences(preferences); canvas.Invalidate(); };
            tips.SetToolTip(box, hint); filters.Controls.Add(box); return box;
        }
        void DrawSceneItem(object sender, DrawItemEventArgs e)
        {
            if (e.Index < 0) return; var scene = (SceneSummary)scenes.Items[e.Index]; bool selected = (e.State & DrawItemState.Selected) != 0;
            using (var brush = new SolidBrush(selected ? Color.FromArgb(57, 52, 42) : Theme.Surface)) e.Graphics.FillRectangle(brush, e.Bounds);
            using (var titleFont = new Font("Segoe UI", 9.5F, FontStyle.Bold)) using (var smallFont = new Font("Segoe UI", 8F))
            {
                TextRenderer.DrawText(e.Graphics, scene.Name, titleFont, new Rectangle(e.Bounds.X + 8, e.Bounds.Y + 7, e.Bounds.Width - 16, 22), selected ? Theme.Gold : Theme.Text, TextFormatFlags.EndEllipsis | TextFormatFlags.SingleLine);
                TextRenderer.DrawText(e.Graphics, scene.Details, smallFont, new Rectangle(e.Bounds.X + 8, e.Bounds.Y + 31, e.Bounds.Width - 16, 18), Theme.Muted, TextFormatFlags.EndEllipsis | TextFormatFlags.SingleLine);
            }
        }
        public void SetDataRoot(string value)
        {
            path.Text = String.IsNullOrEmpty(value) ? "Scegli la cartella Foundry per iniziare." : value; tips.SetToolTip(path, path.Text);
            if (String.Equals(root, value, StringComparison.OrdinalIgnoreCase)) return;
            root = value; loaded = false; ClearScene(); catalog = null;
            if (!IsBusy && snapshot != null) { snapshot.Dispose(); snapshot = null; }
            suppress = true; worlds.DataSource = null; scenes.DataSource = null; suppress = false;
            if (Visible && allowed && !IsBusy) BeginInitialLoad();
        }
        public void SetAccess(bool value)
        {
            bool changed = allowed != value; allowed = value; SetControls();
            if (!value && changed) { if (active != null) active.Cancel(); ClearScene(); loaded = false; }
            if (value && Visible && !loaded && !IsBusy) BeginInitialLoad();
        }
        async void BeginInitialLoad() { await RunAsync(LoadWorldsAsync); }
        void SetControls()
        {
            worlds.Enabled = scenes.Enabled = search.Enabled = allowed && !IsBusy;
            levels.Enabled = allowed && !IsBusy && current != null && current.Levels.Count > 1;
            filters.Enabled = allowed && current != null; grid.Enabled = current != null && current.GridType == 1;
            refresh.Enabled = allowed; refresh.Text = IsBusy ? "Annulla" : "Aggiorna";
            editToggle.Enabled = reset.Enabled = allowed && !IsBusy && draft != null; blank.Enabled = allowed && !IsBusy;
            editor.SetEditing(editMode && allowed && !IsBusy && draft != null);
        }
        async Task RunAsync(Func<CancellationToken, Task> action)
        {
            if (IsBusy || !allowed) return; IsBusy = true; active = new CancellationTokenSource(); SetControls(); if (BusyChanged != null) BusyChanged(this, EventArgs.Empty);
            try { await requireLogin(); await action(active.Token); }
            catch (OperationCanceledException) { if (!IsDisposed) status.Text = "Lettura annullata. Premi Aggiorna per riprovare."; }
            catch (Exception error) { if (!IsDisposed) { status.Text = error.Message; tips.SetToolTip(status, error.Message); } }
            finally
            {
                active.Dispose(); active = null; IsBusy = false;
                if (!IsDisposed) { SetControls(); if (BusyChanged != null) BusyChanged(this, EventArgs.Empty); }
                else if (snapshot != null) { try { snapshot.Dispose(); } catch (IOException) { } snapshot = null; }
            }
        }
        IProgress<string> Reporter() { return new Progress<string>(value => { if (!IsDisposed) status.Text = value; }); }
        async Task LoadWorldsAsync(CancellationToken cancellation)
        {
            loaded = true;
            if (String.IsNullOrEmpty(root)) { status.Text = "Scegli la cartella Foundry per visualizzare i suoi mondi."; return; }
            string selectedRoot = root; status.Text = "Ricerca dei mondi Foundry…";
            var list = await Task.Run(() => SceneFiles.Worlds(selectedRoot), cancellation);
            if (!String.Equals(root, selectedRoot, StringComparison.OrdinalIgnoreCase)) return;
            suppress = true; worlds.DataSource = list;
            var saved = list.FirstOrDefault(value => value.Id == preferences.LastWorldId); worlds.SelectedItem = saved ?? list.FirstOrDefault(); suppress = false;
            if (list.Count == 0) { status.Text = "Non ci sono mondi disponibili nella cartella selezionata."; return; }
            await LoadWorldAsync(cancellation);
        }
        async Task LoadWorldAsync(CancellationToken cancellation)
        {
            var world = worlds.SelectedItem as FoundryWorld;
            if (world == null) { await LoadWorldsAsync(cancellation); return; }
            string oldScene = current == null || catalog == null || catalog.WorldId != world.Id ? null : current.Id; ClearScene();
            catalog = null; suppress = true; scenes.DataSource = null; suppress = false;
            var progress = Reporter(); SceneSnapshot next = null;
            try
            {
                next = await Task.Run(() => repository.CaptureAsync(root, world.Id, progress.Report, cancellation), cancellation);
                var nextCatalog = await Task.Run(() => repository.CatalogAsync(next, cancellation), cancellation);
                cancellation.ThrowIfCancellationRequested();
                if (nextCatalog.Schema != 1 || nextCatalog.WorldId != world.Id) throw new IOException("La copia delle scene non corrisponde al mondo selezionato.");
                if (snapshot != null) snapshot.Dispose(); snapshot = next; next = null; catalog = nextCatalog; loadedRoot = root;
                preferences.LastWorldId = world.Id; storage.SavePreferences(preferences); FilterScenes(oldScene);
                status.Text = catalog.Scenes.Count + " scene · copia locale delle " + catalog.CapturedAt.ToLocalTime().ToString("HH:mm:ss") + ". Premi Aggiorna per leggere nuovi salvataggi.";
                if (scenes.SelectedItem != null) await LoadSceneAsync(cancellation);
            }
            finally { if (next != null) next.Dispose(); }
        }
        void FilterScenes(string selectedId)
        {
            if (selectedId == null && scenes.SelectedItem is SceneSummary) selectedId = ((SceneSummary)scenes.SelectedItem).Id;
            string term = search.Text.Trim(); var list = catalog == null ? new List<SceneSummary>() : catalog.Scenes.Where(value => term.Length == 0 || value.Name.IndexOf(term, StringComparison.CurrentCultureIgnoreCase) >= 0).ToList();
            suppress = true; scenes.DataSource = list; scenes.SelectedItem = list.FirstOrDefault(value => value.Id == selectedId) ?? list.FirstOrDefault(); suppress = false;
            if (list.Count == 0) ClearScene();
        }
        async Task LoadSceneAsync(CancellationToken cancellation)
        {
            var selected = scenes.SelectedItem as SceneSummary; if (selected == null || snapshot == null) return;
            status.Text = "Lettura di " + selected.Name + "…";
            var scene = await Task.Run(() => repository.DetailAsync(snapshot, selected.Id, cancellation), cancellation);
            cancellation.ThrowIfCancellationRequested();
            if (scene.Schema != 1 || scene.Id != selected.Id || scene.Levels == null || scene.Levels.Count == 0) throw new IOException("I dati della scena non sono validi.");
            AttachDraft(scene, (loadedRoot ?? root ?? "") + "|" + catalog.WorldId + "|" + scene.Id);
            await LoadLevelAsync(cancellation);
        }
        async Task LoadLevelAsync(CancellationToken cancellation)
        {
            var level = levels.SelectedItem as SceneLevel; if (level == null || current == null) return;
            if (draft != null && (canvas.Level == null || canvas.Level.Id != level.Id)) draft.Select(SceneSelectionKind.None, null);
            var old = images; images = null; canvas.SetScene(current, level, null, true); if (old != null) old.Dispose();
            detail.Text = current.Name + " · " + current.Walls.Count(value => SceneDetail.Included(value.Levels, level.Id)) + " muri · " + current.Lights.Count(value => SceneDetail.Included(value.Levels, level.Id)) + " luci";
            var progress = Reporter(); var loadedImages = await Task.Run(() => imageLoader.LoadLevelAsync(loadedRoot, current, level, progress.Report, cancellation), cancellation);
            if (cancellation.IsCancellationRequested || IsDisposed) { loadedImages.Dispose(); cancellation.ThrowIfCancellationRequested(); return; }
            images = loadedImages; canvas.SetScene(current, level, images, false);
            imageSignature = ImageSignature(current, level);
            UpdateDraftBadge();
            var warnings = (String.IsNullOrEmpty(draftNotice) ? new string[0] : new[] { draftNotice }).Concat(current.Warnings).Concat(images.Warnings).Distinct().ToList();
            string message = "Solo anteprima: le modifiche restano nell'app. Le luci indicano la portata, senza ombre o occlusione.";
            status.Text = warnings.Count == 0 ? message : warnings[0] + (warnings.Count > 1 ? " (" + warnings.Count + " avvisi)" : "");
            tips.SetToolTip(status, String.Join("\n", warnings.Concat(new[] { message })));
        }
        void ClearScene()
        {
            canvas.CancelEditorGesture(); editor.Bind(null); draft = null; draftKey = null; imageSignature = null; draftNotice = null;
            current = null; canvas.SetScene(null, null, null, true); if (images != null) { images.Dispose(); images = null; }
            suppress = true; levels.DataSource = null; suppress = false; detail.Text = "Mappa, muri e luci del livello selezionato";
        }
        void AttachDraft(SceneDetail source, string key)
        {
            var candidate = new SceneDraft(source); SceneDraft cached; draftNotice = null;
            if (drafts.TryGetValue(key, out cached) && cached.OriginalHash == candidate.OriginalHash) candidate = cached;
            else
            {
                try { if (!draftSaver.RestorePending(key, candidate) && !draftStore.Load(key, candidate)) draftNotice = "Bozza precedente non caricata: i dati Foundry sono cambiati o la bozza non è valida. Una nuova modifica la sostituirà."; }
                catch (Exception error) { draftNotice = "Bozza locale non caricata: " + error.Message; }
                drafts[key] = candidate;
                while (drafts.Count > 8) drafts.Remove(drafts.Keys.First(value => value != key));
            }
            draft = candidate; draftKey = key; current = draft.Scene; draftSaveRevision = draftSaver.PendingRevision(key); draftPending = draftSaveRevision != 0; draftSaved = !draftPending && draftSaver.LastError(key) == null; draft.Select(SceneSelectionKind.None, null);
            suppress = true; levels.DataSource = current.Levels; levels.SelectedItem = current.Levels.FirstOrDefault(value => value.Id == current.InitialLevel) ?? current.Levels[0]; suppress = false;
            editor.Bind(draft); UpdateDraftBadge();
        }
        public void SetEditMode(bool value)
        {
            if (value && draft == null) return; canvas.CancelEditorGesture(); editMode = value;
            content.SuspendLayout(); viewport.SuspendLayout();
            listCard.Visible = !value; content.ColumnStyles[0].Width = value ? 0 : 250;
            viewport.ColumnStyles[1].Width = value ? 240 : 0; editor.Visible = value; editor.Toolbar.Visible = value; viewerRows.RowStyles[3].Height = value ? 38 : 0;
            editToggle.Text = value ? "Torna all'elenco" : "Modifica locale"; editToggle.Primary = value; editToggle.Invalidate();
            if (value) foreach (var box in filters.Controls.OfType<CheckBox>().Where(box => new[] { "Muri", "Luci", "Tile", "Disattivati" }.Contains(box.Text))) box.Checked = true;
            viewport.ResumeLayout(); content.ResumeLayout(); SetControls(); canvas.Fit();
        }
        public void OpenBlankDraft()
        {
            if (!allowed || IsBusy) return;
            ClearScene(); suppress = true; scenes.SelectedIndex = -1; suppress = false;
            var scene = new SceneDetail { Schema = 1, Id = "local-editor-scene", Name = "Bozza libera", Width = 2400, Height = 1600, Padding = 0.1, GridType = 1, GridSize = 100, GridDistance = 5, GridUnits = "m", InitialLevel = "local-editor-level" };
            scene.Levels.Add(new SceneLevel { Id = scene.InitialLevel, Name = "Piano principale", BackgroundColor = "#343842" });
            AttachDraft(scene, "local-editor"); loadedRoot = root ?? "";
            images = new SceneImageSet(); canvas.SetScene(current, current.Levels[0], images, true);
            foreach (var box in filters.Controls.OfType<CheckBox>().Where(value => value.Text == "Griglia")) box.Checked = true;
            UpdateDraftBadge();
            SetEditMode(true); status.Text = "Bozza libera nell'app. Ripristina per ricominciare; nessuna scena viene creata in Foundry.";
            if (current.LocalAssets.Count > 0) BeginInvoke(new Action(async () => await RunAsync(LoadLevelAsync)));
        }
        static string ImageSignature(SceneDetail scene, SceneLevel level)
        { return level.Id + "|" + level.Background + "|" + level.Foreground + "|" + Json.Write(scene.LocalAssets) + "|" + Json.Write(scene.Tiles.Where(value => SceneDetail.Included(value.Levels, level.Id)).Select(value => new { value.Id, value.Src }).ToList()); }
        void UpdateDraftBadge()
        {
            draftBadge.Text = draft != null && draft.IsDirty ? (draftPending ? "BOZZA LOCALE · salvataggio in corso" : draftSaved ? "BOZZA LOCALE · salvata nell'app" : "BOZZA LOCALE · in memoria") : "FOUNDRY IN SOLA LETTURA";
            draftBadge.ForeColor = draft != null && draft.IsDirty ? Theme.Gold : Theme.Green;
            if (current != null && canvas.Level != null) detail.Text = current.Name + " · " + current.Walls.Count(value => SceneDetail.Included(value.Levels, canvas.Level.Id)) + " muri · " + current.Lights.Count(value => SceneDetail.Included(value.Levels, canvas.Level.Id)) + " luci · " + current.Tiles.Count(value => SceneDetail.Included(value.Levels, canvas.Level.Id)) + " immagini";
            if (current != null && canvas.Level != null && canvas.IsLoadingImageDetail) detail.Text += " · caricamento dettaglio";
            else if (current != null && canvas.Level != null && !String.IsNullOrEmpty(canvas.ImageDetailError)) { detail.Text += " · dettaglio non disponibile"; tips.SetToolTip(detail, canvas.ImageDetailError); }
        }
        void DraftChanged()
        {
            if (draft == null || IsDisposed) return;
            string levelId = canvas.Level == null ? current.InitialLevel : canvas.Level.Id;
            current = draft.Scene;
            if (!Object.ReferenceEquals(levels.DataSource, current.Levels))
            { suppress = true; levels.DataSource = current.Levels; levels.SelectedItem = current.Levels.FirstOrDefault(value => value.Id == levelId) ?? current.Levels[0]; suppress = false; }
            var level = (SceneLevel)levels.SelectedItem; canvas.SetScene(current, level, images, false);
            draftSaveRevision = draftSaver.Queue(draftKey, draft); draftPending = true; draftSaved = false;
            UpdateDraftBadge();
            if (!IsBusy && imageSignature != ImageSignature(current, level) && IsHandleCreated) BeginInvoke(new Action(async () => { if (!IsDisposed) await RunAsync(LoadLevelAsync); }));
        }
        void DraftSaved(SceneDraftSaveResult result)
        {
            if (!IsHandleCreated || IsDisposed || Disposing) return;
            try
            {
                BeginInvoke(new Action(() => {
                    if (IsDisposed || Disposing || result.Key != draftKey || result.Revision != draftSaveRevision) return;
                    draftPending = false; draftSaved = result.Error == null;
                    if (result.Error != null) status.Text = "Bozza in memoria, salvataggio locale non riuscito: " + result.Error.Message;
                    UpdateDraftBadge();
                }));
            }
            catch (InvalidOperationException) { }
        }
        public Task FlushDraftsAsync() { return draftSaver.FlushAsync(); }
        async Task ImportImageAsync(bool map)
        {
            if (!allowed || IsBusy || draft == null) return;
            using (var dialog = new OpenFileDialog { Title = map ? "Scegli l'immagine della mappa per la bozza" : "Aggiungi un'immagine alla bozza", Filter = "Immagini|*.png;*.jpg;*.jpeg;*.webp;*.gif;*.bmp", CheckFileExists = true, Multiselect = false })
            {
                if (dialog.ShowDialog(FindForm()) != DialogResult.OK) return;
                await ImportLocalImageAsync(dialog.FileName, map);
            }
        }
        public Task ImportLocalImageAsync(string file, bool map, PointF? point = null)
        {
            return RunAsync(async cancellation => {
                var progress = Reporter(); Size size;
                using (var image = await imageLoader.LoadLocalAssetAsync(file, progress.Report, cancellation)) size = image.Source.NativeSize;
                cancellation.ThrowIfCancellationRequested();
                string levelId = ((SceneLevel)levels.SelectedItem).Id;
                if (map) draft.ChangeMap(file, levelId, size); else draft.AddImage(file, size, point ?? canvas.SceneCenter, levelId);
                editor.SetTool(SceneEditTool.Select);
                foreach (var box in filters.Controls.OfType<CheckBox>().Where(value => value.Text == "Tile")) box.Checked = true;
                await LoadLevelAsync(cancellation);
            });
        }
        public void CancelPending() { if (active != null) active.Cancel(); }
        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                CancelPending(); ClearScene(); draftSaver.Completed -= DraftSaved; draftSaver.Dispose(); tips.Dispose();
                if (snapshot != null && !IsBusy) { try { snapshot.Dispose(); } catch (IOException) { } snapshot = null; }
            }
            base.Dispose(disposing);
        }
    }
}
