using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace KhuzoeAssetsManager
{
    internal static class Program
    {
        [STAThread]
        static void Main(string[] args)
        {
            bool created;
            using (var mutex = new Mutex(true, "Local\\KhuzoeAssetsManager", out created))
            {
                if (!created) { MessageBox.Show("Khuzoe Assets Manager è già aperto.", "Khuzoe Assets Manager"); return; }
                Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
                try
                {
                    string state = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "KhuzoeAssetsManager");
                    int option = System.Array.IndexOf(args, "--state-dir");
                    if (option >= 0 && option + 1 < args.Length) state = Path.GetFullPath(args[option + 1]);
                    var storage = new AppStorage(state); StartupOptions.Apply(storage, args);
                    Application.Run(new MainForm(storage));
                }
                catch (Exception error) { MessageBox.Show("Impossibile aprire l’app.\n\n" + error.Message, "Khuzoe Assets Manager", MessageBoxButtons.OK, MessageBoxIcon.Error); }
            }
        }
    }
    public sealed class MainForm : Form
    {
        readonly AppStorage storage;
        readonly IUserSession auth;
        readonly Preferences preferences;
        readonly MusicLibrary library;
        readonly ToolsInstaller tools;
        readonly MusicDownloader downloader;
        readonly List<DownloadItem> jobs;
        readonly CancellationTokenSource lifetime = new CancellationTokenSource();
        CancellationTokenSource active, loginCancellation;
        bool working, analyzing, closingAfterCancel, queueDirty, validating = true;
        readonly System.Windows.Forms.Timer refreshTimer = new System.Windows.Forms.Timer { Interval = 350 };
        readonly Panel downloadControls = new Panel { Dock = DockStyle.Fill, BackColor = Color.Transparent };
        readonly TextBox links = Theme.TextBox("Link YouTube, uno per riga");
        readonly TextBox trackName = Theme.TextBox("Nome del brano, facoltativo");
        readonly ComboBox category = Theme.Combo("Categoria musicale");
        readonly TextBox directory = Theme.TextBox("Cartella di destinazione relativa ai dati Foundry");
        readonly ComboBox quality = Theme.Combo("Qualità MP3");
        readonly TextBox search = Theme.TextBox("Cerca nella raccolta");
        readonly Label folderText = Theme.Label("Scegli la cartella di Foundry per iniziare.", 9.5F, Theme.Muted, FontStyle.Regular);
        readonly Label accountText = Theme.Label("Sessione non collegata", 9F, Theme.Muted, FontStyle.Regular);
        readonly Label accountName = Theme.Label("Accesso Discord", 10F, Theme.Text, FontStyle.Bold);
        readonly Label statusText = Theme.Label("Accedi con Discord e scegli la cartella Foundry.", 9.5F, Theme.Muted, FontStyle.Regular);
        readonly Label metadataText = Theme.Label("Un link per riga. Per più brani verranno usati i titoli dei video.", 9F, Theme.Muted, FontStyle.Regular);
        readonly Label countText = Theme.Label("La tua raccolta musicale", 10F, Theme.Muted, FontStyle.Regular);
        readonly Label selectionText = Theme.Label("Seleziona un brano per ascoltarlo o aprire la sua cartella.", 8.5F, Theme.Muted, FontStyle.Regular);
        readonly ProgressBar progress = new ProgressBar { Dock = DockStyle.Fill, Height = 5, Maximum = 100, Style = ProgressBarStyle.Continuous };
        readonly WebButton login = new WebButton { Text = "Accedi con Discord", Primary = true, Dock = DockStyle.Fill };
        readonly WebButton logout = new WebButton { Text = "Esci dall’account", Dock = DockStyle.Fill };
        readonly WebButton download = new WebButton { Text = "Scarica MP3", Primary = true, Width = 165 };
        readonly WebButton analyze = new WebButton { Text = "Analizza link", Width = 135 };
        readonly WebButton stopQueue = new WebButton { Text = "Ferma coda", Width = 115 };
        readonly WebButton libraryTab = new WebButton { Text = "Raccolta", Width = 115, Primary = true };
        readonly WebButton queueTab = new WebButton { Text = "Coda", Width = 115 };
        readonly DataGridView trackGrid = Grid();
        readonly DataGridView queueGrid = Grid();
        readonly Panel gridHost = new Panel { Dock = DockStyle.Fill };
        readonly WebButton play = new WebButton { Text = "Ascolta", Width = 95 };
        readonly WebButton stopAudio = new WebButton { Text = "Stop", Width = 70 };
        readonly WebButton openTrack = new WebButton { Text = "Apri cartella", Width = 115 };
        readonly WebButton copyPath = new WebButton { Text = "Copia percorso", Width = 130 };
        readonly WebButton retry = new WebButton { Text = "Riprova selezionato", Width = 165 };
        readonly ToolTip tooltips = new ToolTip();
        readonly Panel workspace = new Panel { Dock = DockStyle.Fill, BackColor = Theme.Background };
        readonly WebButton musicNavigation = new WebButton { Text = "Musiche", Dock = DockStyle.Fill, Primary = true };
        readonly WebButton scenesNavigation = new WebButton { Text = "Scene", Dock = DockStyle.Fill };
        Control musicPage;
        ScenesPanel scenesPage;
        bool queueVisible;

        public MainForm(AppStorage storage) : this(storage, new DiscordAuth(storage)) { }
        public MainForm(AppStorage storage, IUserSession session) : this(storage, session, null) { }
        public MainForm(AppStorage storage, IUserSession session, IToolProvider sceneTools)
        {
            this.storage = storage; auth = session; preferences = storage.LoadPreferences(); library = new MusicLibrary(storage.Root);
            tools = new ToolsInstaller(storage); downloader = new MusicDownloader(storage, library, tools, new ProcessRunner());
            string queueFile = Path.Combine(storage.Root, "queue.json");
            jobs = File.Exists(queueFile) ? Json.Read<List<DownloadItem>>(File.ReadAllText(queueFile)) ?? new List<DownloadItem>() : new List<DownloadItem>();
            foreach (var item in jobs.Where(item => !new[] { "Completato", "Già presente", "Non riuscito", "Annullato", "Interrotto" }.Contains(item.Status))) { item.Status = "Interrotto"; item.Message = "L’app è stata chiusa. Seleziona il brano e premi Riprova."; }
            Text = "Khuzoe Assets Manager"; BackColor = Theme.Background; ForeColor = Theme.Text;
            Font = new Font("Segoe UI", 9.5F); AutoScaleMode = AutoScaleMode.Dpi;
            MinimumSize = new Size(1080, 800); Size = new Size(1280, 920); StartPosition = FormStartPosition.CenterScreen;
            BuildLayout();
            scenesPage = new ScenesPanel(storage, preferences, sceneTools ?? tools, RequireLoginAsync, ChooseFoundry) { Visible = false };
            scenesPage.BusyChanged += (sender, args) => UpdateAccess(); workspace.Controls.Add(scenesPage); scenesPage.SetDataRoot(preferences.DataRoot);
            musicNavigation.Click += (sender, args) => ShowSection(false); scenesNavigation.Click += (sender, args) => ShowSection(true);
            LoadPreferences(); UpdateAccess(); RefreshLibrary(); RefreshQueue(); ShowSection(preferences.ActiveTab == "scenes");
            Shown += async (sender, args) => await RunUi(async () => {
                try { if (await auth.VerifyAsync(lifetime.Token)) statusText.Text = "Account collegato. Le musiche vengono salvate direttamente nei dati Foundry."; }
                finally { validating = false; if (!IsDisposed) UpdateAccess(); }
            });
            refreshTimer.Tick += (sender, args) => { if (queueDirty) { queueDirty = false; RefreshQueue(); } }; refreshTimer.Start();
            FormClosing += OnFormClosing;
            FormClosed += (sender, args) => { scenesPage.CancelPending(); refreshTimer.Dispose(); tooltips.Dispose(); StopPlayback(); lifetime.Cancel(); auth.Dispose(); lifetime.Dispose(); };
        }
        static DataGridView Grid()
        {
            var grid = new DataGridView { Dock = DockStyle.Fill, BackgroundColor = Theme.Surface, BorderStyle = BorderStyle.None,
                ReadOnly = true, AllowUserToAddRows = false, AllowUserToDeleteRows = false, AllowUserToResizeRows = false,
                AutoGenerateColumns = false, RowHeadersVisible = false, MultiSelect = false, SelectionMode = DataGridViewSelectionMode.FullRowSelect,
                EnableHeadersVisualStyles = false, GridColor = Theme.Border, CellBorderStyle = DataGridViewCellBorderStyle.SingleHorizontal,
                AutoSizeColumnsMode = DataGridViewAutoSizeColumnsMode.Fill, RowTemplate = { Height = 34 } };
            grid.DefaultCellStyle = new DataGridViewCellStyle { BackColor = Theme.Surface, ForeColor = Theme.Text, SelectionBackColor = Color.FromArgb(61, 57, 47), SelectionForeColor = Theme.Text, Padding = new Padding(9, 0, 5, 0), Font = new Font("Segoe UI", 9F) };
            grid.ColumnHeadersDefaultCellStyle = new DataGridViewCellStyle { BackColor = Theme.Surface, ForeColor = Theme.Muted, SelectionBackColor = Theme.Surface, Font = new Font("Segoe UI", 8.5F, FontStyle.Bold), Padding = new Padding(9, 0, 0, 0) };
            grid.ColumnHeadersHeight = 34; grid.ColumnHeadersHeightSizeMode = DataGridViewColumnHeadersHeightSizeMode.DisableResizing;
            return grid;
        }
        static void Column(DataGridView grid, string field, string title, float weight)
        { grid.Columns.Add(new DataGridViewTextBoxColumn { DataPropertyName = field, HeaderText = title, FillWeight = weight, SortMode = DataGridViewColumnSortMode.NotSortable }); }
        static TableLayoutPanel Rows(params int[] heights)
        {
            var layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = heights.Length, Margin = Padding.Empty, Padding = Padding.Empty, BackColor = Color.Transparent };
            foreach (int height in heights) layout.RowStyles.Add(height < 0 ? new RowStyle(SizeType.Percent, 100) : new RowStyle(SizeType.Absolute, height));
            return layout;
        }
        static FlowLayoutPanel Buttons()
        { return new FlowLayoutPanel { Dock = DockStyle.Fill, WrapContents = false, Margin = Padding.Empty, Padding = Padding.Empty, BackColor = Color.Transparent }; }
        static Panel Field(string label, Control input)
        {
            var layout = Rows(23, -1); layout.Controls.Add(Theme.Label(label, 8.5F, Theme.Muted, FontStyle.Regular), 0, 0);
            input.Margin = new Padding(0, 3, 0, 0); layout.Controls.Add(input, 0, 1);
            var panel = new Panel { Dock = DockStyle.Fill, BackColor = Color.Transparent, Margin = new Padding(0, 0, 12, 4) }; panel.Controls.Add(layout); return panel;
        }
        void BuildLayout()
        {
            var shell = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 1, Margin = Padding.Empty };
            shell.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 205)); shell.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            Controls.Add(shell); shell.Controls.Add(BuildSidebar(), 0, 0);
            var main = Rows(83, 82, 284, 61, -1); main.Padding = new Padding(26, 12, 26, 20); musicPage = main; workspace.Controls.Add(main); shell.Controls.Add(workspace, 1, 0);
            var header = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, Margin = Padding.Empty };
            header.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100)); header.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 220));
            var title = Rows(44, -1); title.Controls.Add(Theme.Label("Musiche", 25F, Theme.Text, FontStyle.Bold), 0, 0);
            title.Controls.Add(Theme.Label("Prepara l’atmosfera della tua prossima sessione.", 10F, Theme.Muted, FontStyle.Regular), 0, 1); header.Controls.Add(title, 0, 0);
            var help = new WebButton { Text = "Come portarle in Foundry", Dock = DockStyle.Top, Height = 37, Margin = new Padding(0, 15, 0, 0) }; help.Click += (s, e) => ShowImportHelp(); header.Controls.Add(help, 1, 0); main.Controls.Add(header, 0, 0);

            var folderCard = new SurfacePanel { Dock = DockStyle.Fill, Padding = new Padding(16, 10, 12, 10), Margin = new Padding(0, 4, 0, 9) };
            var folderLayout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 3, RowCount = 2, Margin = Padding.Empty };
            folderLayout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100)); folderLayout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 137)); folderLayout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 110));
            folderLayout.RowStyles.Add(new RowStyle(SizeType.Absolute, 19)); folderLayout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            folderLayout.Controls.Add(Theme.Label("CARTELLA DATI FOUNDRY", 8F, Theme.Gold, FontStyle.Bold), 0, 0); folderText.AutoEllipsis = true; folderLayout.Controls.Add(folderText, 0, 1);
            var choose = new WebButton { Text = "Scegli cartella", Dock = DockStyle.Fill, Margin = new Padding(6, 3, 5, 3) }; choose.Click += (s, e) => ChooseFoundry();
            var open = new WebButton { Text = "Apri musiche", Dock = DockStyle.Fill, Margin = new Padding(3) }; open.Click += (s, e) => SafeAction(() => OpenMusic());
            folderLayout.Controls.Add(choose, 1, 0); folderLayout.SetRowSpan(choose, 2); folderLayout.Controls.Add(open, 2, 0); folderLayout.SetRowSpan(open, 2); folderCard.Controls.Add(folderLayout); main.Controls.Add(folderCard, 0, 1);

            var downloadCard = new SurfacePanel { Dock = DockStyle.Fill, Padding = new Padding(16, 10, 16, 11), Margin = new Padding(0, 0, 0, 8) }; downloadCard.Controls.Add(downloadControls);
            var fields = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 3, RowCount = 5, Margin = Padding.Empty };
            fields.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 48)); fields.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 29)); fields.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 23));
            foreach (int height in new[] { 74, 57, 57, 24, 38 }) fields.RowStyles.Add(new RowStyle(SizeType.Absolute, height));
            links.Multiline = true; links.ScrollBars = ScrollBars.Vertical; links.AcceptsReturn = true; links.MaxLength = 16000;
            fields.Controls.Add(Field("LINK YOUTUBE · UNO PER RIGA", links), 0, 0); fields.SetColumnSpan(fields.GetControlFromPosition(0, 0), 3);
            trackName.MaxLength = 160; category.MaxLength = 80; category.DropDownStyle = ComboBoxStyle.DropDown;
            fields.Controls.Add(Field("NOME DEL BRANO · FACOLTATIVO", trackName), 0, 1); fields.Controls.Add(Field("CATEGORIA", category), 1, 1); fields.SetColumnSpan(fields.GetControlFromPosition(1, 1), 2);
            fields.Controls.Add(Field("CARTELLA DI DESTINAZIONE", directory), 0, 2); fields.SetColumnSpan(fields.GetControlFromPosition(0, 2), 2);
            quality.DropDownStyle = ComboBoxStyle.DropDownList; quality.DrawMode = DrawMode.OwnerDrawFixed; quality.ItemHeight = 23;
            quality.DrawItem += (sender, args) => {
                using (var brush = new SolidBrush(Theme.Input)) args.Graphics.FillRectangle(brush, args.Bounds);
                if (args.Index >= 0) TextRenderer.DrawText(args.Graphics, Convert.ToString(quality.Items[args.Index]), quality.Font, args.Bounds, Theme.Text, TextFormatFlags.VerticalCenter | TextFormatFlags.Left);
                if ((args.State & DrawItemState.Focus) != 0) args.DrawFocusRectangle();
            };
            quality.Items.AddRange(new object[] { "128 kbps", "192 kbps", "256 kbps", "320 kbps" }); fields.Controls.Add(Field("QUALITÀ MP3", quality), 2, 2);
            metadataText.AutoEllipsis = true; fields.Controls.Add(metadataText, 0, 3); fields.SetColumnSpan(metadataText, 3);
            var commands = Buttons(); commands.Controls.Add(download); commands.Controls.Add(analyze);
            var browse = new WebButton { Text = "Scegli destinazione", Width = 160 }; browse.Click += (s, e) => ChooseDestination(); commands.Controls.Add(browse);
            fields.Controls.Add(commands, 0, 4); fields.SetColumnSpan(commands, 3); downloadControls.Controls.Add(fields); downloadCard.Controls.Add(downloadControls); main.Controls.Add(downloadCard, 0, 2);
            category.TextChanged += (s, e) => CategoryChanged(); download.Click += async (s, e) => await RunUi(EnqueueAsync); analyze.Click += async (s, e) => await RunUi(AnalyzeAsync);
            tooltips.SetToolTip(directory, "Percorso relativo ai dati Foundry, per esempio musics/youtube/combattimento. Le cartelle mancanti vengono create al salvataggio.");
            var activity = Rows(35, 6, -1); var activityRow = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, Margin = Padding.Empty };
            activityRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100)); activityRow.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 120));
            statusText.AutoEllipsis = true; activityRow.Controls.Add(statusText, 0, 0); stopQueue.Click += (s, e) => CancelAll(); activityRow.Controls.Add(stopQueue, 1, 0);
            activity.Controls.Add(activityRow, 0, 0); activity.Controls.Add(progress, 0, 1); main.Controls.Add(activity, 0, 3);

            var libraryCard = new SurfacePanel { Dock = DockStyle.Fill, Padding = new Padding(12, 8, 12, 9), Margin = Padding.Empty };
            var collection = Rows(54, -1, 25, 39); var collectionHeader = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, Margin = Padding.Empty };
            collectionHeader.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100)); collectionHeader.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 240));
            var tabs = Buttons(); libraryTab.Click += (s, e) => SwitchTab(false); queueTab.Click += (s, e) => SwitchTab(true); tabs.Controls.Add(libraryTab); tabs.Controls.Add(queueTab); collectionHeader.Controls.Add(tabs, 0, 0);
            search.Margin = new Padding(0, 6, 0, 0); search.TextChanged += (s, e) => RefreshLibrary(); collectionHeader.Controls.Add(Field("CERCA TITOLO, AUTORE O CATEGORIA", search), 1, 0);
            Column(trackGrid, "Title", "BRANO", 49); Column(trackGrid, "Category", "CATEGORIA", 25); Column(trackGrid, "DurationText", "DURATA", 13); Column(trackGrid, "Quality", "KBPS", 13);
            Column(queueGrid, "DisplayTitle", "BRANO", 37); Column(queueGrid, "Category", "CATEGORIA", 21); Column(queueGrid, "Status", "STATO", 22); Column(queueGrid, "Directory", "CARTELLA", 30);
            trackGrid.SelectionChanged += (s, e) => UpdateSelection(); queueGrid.SelectionChanged += (s, e) => UpdateSelection(); trackGrid.CellDoubleClick += (s, e) => SafeAction(PlaySelected);
            gridHost.Controls.Add(trackGrid); gridHost.Controls.Add(queueGrid); queueGrid.Visible = false;
            collection.Controls.Add(collectionHeader, 0, 0); collection.Controls.Add(gridHost, 0, 1); selectionText.AutoEllipsis = true; collection.Controls.Add(selectionText, 0, 2);
            var trackCommands = Buttons(); play.Click += (s, e) => SafeAction(PlaySelected); stopAudio.Click += (s, e) => StopPlayback(); openTrack.Click += (s, e) => SafeAction(OpenSelectedFolder); copyPath.Click += (s, e) => SafeAction(CopySelectedPath); retry.Click += async (s, e) => await RunUi(RetryAsync);
            trackCommands.Controls.Add(play); trackCommands.Controls.Add(stopAudio); trackCommands.Controls.Add(openTrack); trackCommands.Controls.Add(copyPath); trackCommands.Controls.Add(retry); collection.Controls.Add(trackCommands, 0, 3);
            libraryCard.Controls.Add(collection); main.Controls.Add(libraryCard, 0, 4);
        }
        Control BuildSidebar()
        {
            var sidebar = new Panel { Dock = DockStyle.Fill, BackColor = Theme.Sidebar, Padding = new Padding(20, 23, 18, 22) };
            var rows = Rows(55, 47, 18, 43, 56, -1, 28, 41, 42, 38, 30);
            var brand = Theme.Label("K", 29F, Theme.Gold, FontStyle.Bold); rows.Controls.Add(brand, 0, 0);
            rows.Controls.Add(Theme.Label("KHUZOE\nASSETS MANAGER", 11F, Theme.Text, FontStyle.Bold), 0, 1);
            rows.Controls.Add(Theme.Label("IL TUO TAVOLO, PRONTO.", 7F, Theme.Muted, FontStyle.Regular), 0, 2);
            rows.Controls.Add(musicNavigation, 0, 3);
            scenesNavigation.Margin = new Padding(3, 7, 3, 7); rows.Controls.Add(scenesNavigation, 0, 4);
            var bottom = Rows(46, 45, -1);
            var componentUpdate = new WebButton { Text = "Aggiorna strumenti", Dock = DockStyle.Fill }; componentUpdate.Click += async (s, e) => await RunUi(UpdateToolsAsync); tooltips.SetToolTip(componentUpdate, "Usa questo comando se YouTube cambia e i download smettono di funzionare."); bottom.Controls.Add(componentUpdate, 0, 0);
            countText.Text = "Musiche locali\nNessun servizio residente"; countText.Font = new Font("Segoe UI", 8.5F); bottom.Controls.Add(countText, 0, 1); rows.Controls.Add(bottom, 0, 5);
            rows.Controls.Add(accountName, 0, 6); accountText.AutoEllipsis = true; rows.Controls.Add(accountText, 0, 7);
            login.Click += async (s, e) => await RunUi(LoginAsync); logout.Click += (s, e) => { auth.Logout(); UpdateAccess(); }; rows.Controls.Add(login, 0, 8); rows.Controls.Add(logout, 0, 9);
            rows.Controls.Add(Theme.Label("VERSIONE " + BuildConfig.Version, 8F, Theme.Muted, FontStyle.Regular), 0, 10);
            sidebar.Controls.Add(rows); return sidebar;
        }
        void LoadPreferences()
        {
            foreach (string name in new[] { "Combattimento", "Esplorazione", "Atmosfera", "Taverna", "Epico", "Mistero", "Relax" }.Concat(preferences.CategoryFolders.Keys).Distinct(StringComparer.OrdinalIgnoreCase)) category.Items.Add(name);
            category.Text = preferences.Category; quality.SelectedIndex = System.Array.IndexOf(new[] { 128, 192, 256, 320 }, preferences.Quality);
            CategoryChanged(); UpdateFolderLabel();
        }
        void CategoryChanged()
        {
            string value;
            directory.Text = preferences.CategoryFolders.TryGetValue(category.Text.Trim(), out value) ? value : FoundryPaths.CategoryDirectory(category.Text);
        }
        void UpdateFolderLabel()
        {
            folderText.Text = String.IsNullOrEmpty(preferences.DataRoot) ? "Scegli la cartella di Foundry per iniziare." : preferences.DataRoot;
            tooltips.SetToolTip(folderText, folderText.Text);
        }
        void UpdateAccess()
        {
            downloadControls.Enabled = auth.IsAuthenticated && !analyzing && !validating;
            login.Enabled = !auth.IsAuthenticated && loginCancellation == null && !validating;
            login.Text = loginCancellation != null ? "Accesso in corso…" : "Accedi con Discord";
            logout.Enabled = auth.IsAuthenticated && !working && !analyzing && !validating && (scenesPage == null || !scenesPage.IsBusy);
            accountName.Text = auth.IsAuthenticated ? auth.DisplayName : "Accesso Discord";
            accountText.Text = auth.IsAuthenticated ? "Account collegato" : "Accedi per usare l’app";
            accountText.ForeColor = auth.IsAuthenticated ? Theme.Green : Theme.Muted;
            stopQueue.Enabled = working || analyzing || jobs.Any(item => item.Status == "In coda");
            trackGrid.Enabled = auth.IsAuthenticated; queueGrid.Enabled = auth.IsAuthenticated; UpdateSelection();
            if (scenesPage != null) scenesPage.SetAccess(auth.IsAuthenticated);
        }
        public void ShowSection(bool scenes)
        {
            if (scenesPage == null) return;
            musicPage.Visible = !scenes; scenesPage.Visible = scenes;
            if (scenes) scenesPage.BringToFront(); else musicPage.BringToFront();
            musicNavigation.Primary = !scenes; scenesNavigation.Primary = scenes; musicNavigation.Invalidate(); scenesNavigation.Invalidate();
            preferences.ActiveTab = scenes ? "scenes" : "music"; storage.SavePreferences(preferences);
        }
        async Task LoginAsync()
        {
            if (loginCancellation != null) return;
            loginCancellation = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token); UpdateAccess();
            try
            {
                statusText.Text = "Apertura dell’accesso Discord nel browser…";
                await auth.LoginAsync(url => OpenUrl(url.AbsoluteUri), message => statusText.Text = message, loginCancellation.Token);
                statusText.Text = "Benvenuto, " + auth.DisplayName + ". Scegli le musiche per la prossima sessione.";
            }
            finally { loginCancellation.Dispose(); loginCancellation = null; if (!IsDisposed) UpdateAccess(); }
        }
        async Task RequireLoginAsync()
        {
            if (!await auth.VerifyAsync(lifetime.Token)) { UpdateAccess(); throw new IOException("Accedi con Discord prima di usare l'app."); }
        }
        void ChooseFoundry()
        {
            SafeAction(() => {
                if (working || analyzing || validating || (scenesPage != null && scenesPage.IsBusy)) throw new IOException("Attendi la fine delle operazioni prima di cambiare installazione Foundry.");
                using (var dialog = new FolderBrowserDialog { Description = "Scegli la cartella principale di Foundry oppure la sua cartella dati", ShowNewFolderButton = false })
                {
                    if (!String.IsNullOrEmpty(preferences.SelectedPath)) dialog.SelectedPath = preferences.SelectedPath;
                    if (dialog.ShowDialog(this) != DialogResult.OK) return;
                    var candidates = FoundryPaths.Find(dialog.SelectedPath);
                    if (candidates.Count == 0) throw new IOException("Non trovo una cartella dati Foundry. Seleziona quella che contiene modules, worlds e systems, oppure la cartella principale dell’installazione.");
                    string chosen = candidates.Count == 1 ? candidates[0] : PickInstallation(candidates);
                    if (chosen == null) return;
                    preferences.SelectedPath = dialog.SelectedPath; preferences.DataRoot = chosen; storage.SavePreferences(preferences); UpdateFolderLabel(); RefreshLibrary(); if (scenesPage != null) scenesPage.SetDataRoot(chosen);
                }
            });
        }
        string PickInstallation(List<string> paths)
        {
            using (var dialog = new Form { Text = "Scegli l’installazione Foundry", Size = new Size(780, 260), StartPosition = FormStartPosition.CenterParent, BackColor = Theme.Background, ForeColor = Theme.Text, MinimizeBox = false, MaximizeBox = false, Padding = new Padding(15) })
            {
                var list = new ListBox { Dock = DockStyle.Fill, BackColor = Theme.Surface, ForeColor = Theme.Text, HorizontalScrollbar = true }; foreach (string item in paths) list.Items.Add(item); list.SelectedIndex = 0;
                var ok = new WebButton { Text = "Usa questa cartella", Dock = DockStyle.Bottom, Height = 40, Primary = true, DialogResult = DialogResult.OK }; dialog.Controls.Add(list); dialog.Controls.Add(ok); dialog.AcceptButton = ok;
                return dialog.ShowDialog(this) == DialogResult.OK ? (string)list.SelectedItem : null;
            }
        }
        void ChooseDestination()
        {
            SafeAction(() => {
                if (String.IsNullOrEmpty(preferences.DataRoot)) throw new IOException("Scegli prima la cartella Foundry.");
                string root = FoundryPaths.MusicDirectory(preferences.DataRoot, "musics", true);
                using (var dialog = new FolderBrowserDialog { Description = "Scegli una destinazione dentro la cartella musics", SelectedPath = root, ShowNewFolderButton = true })
                {
                    if (dialog.ShowDialog(this) != DialogResult.OK) return;
                    string selected = FoundryPaths.Full(dialog.SelectedPath), data = FoundryPaths.Full(preferences.DataRoot);
                    if (!selected.StartsWith(data + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new IOException("Scegli una cartella dentro musics/.");
                    string relative = selected.Substring(data.Length + 1).Replace('\\', '/'); FoundryPaths.MusicDirectory(data, relative, false); directory.Text = relative;
                }
            });
        }
        List<VideoLink> ReadLinks()
        {
            string[] lines = links.Text.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries).Select(value => value.Trim()).Where(value => value.Length > 0).ToArray();
            if (lines.Length == 0) throw new IOException("Incolla almeno un link YouTube.");
            if (lines.Length > 50) throw new IOException("Aggiungi al massimo 50 video alla volta.");
            return lines.Select(VideoLink.Parse).GroupBy(video => video.Id).Select(group => group.First()).ToList();
        }
        async Task EnqueueAsync()
        {
            if (analyzing || validating) return;
            var videos = ReadLinks();
            string root = FoundryPaths.Full(preferences.DataRoot ?? "."); FoundryPaths.MusicDirectory(root, directory.Text, false);
            if (String.IsNullOrWhiteSpace(category.Text)) throw new IOException("Indica una categoria musicale.");
            string destination = directory.Text.Trim().Replace('\\', '/').TrimEnd('/');
            string selectedCategory = category.Text.Trim(); int selectedQuality = new[] { 128, 192, 256, 320 }[Math.Max(0, quality.SelectedIndex)];
            string selectedName = trackName.Text.Trim(); validating = true; UpdateAccess();
            try { await RequireLoginAsync(); } finally { validating = false; UpdateAccess(); }
            int added = 0;
            foreach (var video in videos)
            {
                if (jobs.Any(item => item.Status == "In coda" && item.VideoId == video.Id && String.Equals(item.DataRoot, root, StringComparison.OrdinalIgnoreCase) && item.Directory == destination)) continue;
                jobs.Add(new DownloadItem { Url = video.Url, VideoId = video.Id, Name = videos.Count == 1 ? selectedName : "", Category = selectedCategory, DataRoot = root, Directory = destination, Quality = selectedQuality }); added++;
            }
            preferences.Category = selectedCategory; preferences.Quality = selectedQuality; preferences.CategoryFolders[selectedCategory] = destination; storage.SavePreferences(preferences);
            if (!category.Items.Contains(selectedCategory)) category.Items.Add(selectedCategory);
            SaveQueue(); links.Clear(); trackName.Clear(); metadataText.Text = added + " brani aggiunti alla coda."; SwitchTab(true); RefreshQueue();
            if (!working) await DrainAsync();
        }
        async Task AnalyzeAsync()
        {
            var videos = ReadLinks(); if (videos.Count != 1) throw new IOException("Per l’anteprima indica un solo link. Puoi scaricare più link insieme senza analizzarli prima.");
            if (working || analyzing || validating) throw new IOException("Attendi il completamento delle operazioni prima di analizzare un altro link.");
            analyzing = true; active = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token); UpdateAccess();
            try
            {
                await RequireLoginAsync();
                progress.Style = ProgressBarStyle.Marquee;
                var reporter = new Progress<string>(message => statusText.Text = message);
                var info = await Task.Run(() => downloader.AnalyzeAsync(videos[0].Url, message => ((IProgress<string>)reporter).Report(message), active.Token));
                metadataText.Text = info.Title + " · " + info.Author + " · " + info.DurationText;
                if (String.IsNullOrWhiteSpace(trackName.Text)) trackName.Text = info.Title;
                statusText.Text = "Anteprima pronta. Scegli la destinazione e premi Scarica MP3.";
            }
            finally { active.Dispose(); active = null; analyzing = false; progress.Style = ProgressBarStyle.Continuous; progress.Value = 0; UpdateAccess(); if (closingAfterCancel) Close(); }
        }
        async Task DrainAsync()
        {
            if (working) return; working = true; UpdateAccess();
            try
            {
                DownloadItem next;
                while (!lifetime.IsCancellationRequested && (next = jobs.FirstOrDefault(item => item.Status == "In coda")) != null)
                {
                    var item = next; active = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
                    try
                    {
                        await RequireLoginAsync();
                        var reporter = new Progress<JobProgress>(value => {
                            if (new[] { "Completato", "Già presente", "Non riuscito", "Annullato" }.Contains(item.Status)) return;
                            item.Status = value.Stage; item.Message = value.Message; queueDirty = true;
                            statusText.Text = value.Message; progress.Style = value.Indeterminate ? ProgressBarStyle.Marquee : ProgressBarStyle.Continuous;
                            if (!value.Indeterminate) progress.Value = Math.Max(0, Math.Min(100, value.Percent));
                        });
                        item.Status = "Preparazione"; SaveQueue(); queueDirty = true;
                        var result = await Task.Run(() => downloader.DownloadAsync(item, reporter, active.Token));
                        item.Status = result.Reused ? "Già presente" : "Completato"; item.Name = result.Track.Title;
                        item.Message = result.Warning ?? result.Track.RelativePath; statusText.Text = result.Warning ?? (result.Reused ? "Il brano è già presente nella cartella selezionata." : "MP3 salvato. Puoi importare la cartella nella playlist di Foundry.");
                        RefreshLibrary();
                    }
                    catch (OperationCanceledException) { item.Status = "Annullato"; item.Message = "Operazione annullata. Puoi riprovare."; statusText.Text = item.Message; }
                    catch (Exception error) { item.Status = "Non riuscito"; item.Message = error.Message; statusText.Text = error.Message; }
                    finally { active.Dispose(); active = null; progress.Style = ProgressBarStyle.Continuous; queueDirty = true; SaveQueue(); }
                    if (!auth.IsAuthenticated) { CancelAll(); break; }
                }
            }
            finally { working = false; UpdateAccess(); RefreshQueue(); if (closingAfterCancel) Close(); }
        }
        void SaveQueue()
        {
            if (jobs.Count > 200) jobs.RemoveAll(item => jobs.IndexOf(item) < jobs.Count - 200 && new[] { "Completato", "Già presente", "Non riuscito", "Annullato", "Interrotto" }.Contains(item.Status));
            Json.Save(Path.Combine(storage.Root, "queue.json"), jobs);
        }
        void CancelAll()
        {
            foreach (var job in jobs.Where(item => item.Status == "In coda")) { job.Status = "Annullato"; job.Message = "Rimosso dalla coda prima del download."; }
            if (active != null) active.Cancel(); SaveQueue(); RefreshQueue(); UpdateAccess();
        }
        async Task RetryAsync()
        {
            if (analyzing || validating) return;
            var selected = SelectedJob(); if (selected == null || !new[] { "Non riuscito", "Annullato", "Interrotto" }.Contains(selected.Status)) return;
            await RequireLoginAsync(); selected.Status = "In coda"; selected.Message = ""; SaveQueue(); RefreshQueue(); if (!working) await DrainAsync();
        }
        async Task UpdateToolsAsync()
        {
            if (working || analyzing || validating || (scenesPage != null && scenesPage.IsBusy)) throw new IOException("Attendi la fine delle operazioni prima di aggiornare gli strumenti.");
            analyzing = true; active = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token); UpdateAccess();
            try
            {
                await RequireLoginAsync();
                progress.Style = ProgressBarStyle.Marquee; var reporter = new Progress<string>(message => statusText.Text = message);
                await Task.Run(() => tools.UpdateAsync(message => ((IProgress<string>)reporter).Report(message), active.Token)); statusText.Text = "Strumenti aggiornati. Puoi riprovare i download.";
            }
            finally { active.Dispose(); active = null; analyzing = false; progress.Style = ProgressBarStyle.Continuous; UpdateAccess(); if (closingAfterCancel) Close(); }
        }
        void RefreshLibrary()
        {
            string text = search.Text.Trim();
            var records = library.All().Where(item => String.Equals(item.DataRoot, preferences.DataRoot, StringComparison.OrdinalIgnoreCase)
                && (text.Length == 0 || ((item.Title ?? "") + " " + (item.Author ?? "") + " " + (item.Category ?? "")).IndexOf(text, StringComparison.OrdinalIgnoreCase) >= 0)).ToList();
            trackGrid.DataSource = new BindingList<TrackRecord>(records); libraryTab.Text = "Raccolta · " + records.Count; UpdateSelection();
        }
        void RefreshQueue()
        {
            string selected = SelectedJob() == null ? null : SelectedJob().Id;
            queueGrid.DataSource = new BindingList<DownloadItem>(jobs.OrderByDescending(item => item.CreatedAt).ToList());
            if (selected != null) foreach (DataGridViewRow row in queueGrid.Rows) if (((DownloadItem)row.DataBoundItem).Id == selected) { row.Selected = true; queueGrid.CurrentCell = row.Cells[0]; break; }
            queueTab.Text = "Coda · " + jobs.Count(item => item.Status == "In coda" || item.Status == "Download" || item.Status == "Preparazione" || item.Status == "Conversione"); UpdateSelection();
        }
        void SwitchTab(bool queue)
        {
            queueVisible = queue; queueGrid.Visible = queue; trackGrid.Visible = !queue; queueTab.Primary = queue; libraryTab.Primary = !queue; queueTab.Invalidate(); libraryTab.Invalidate(); search.Enabled = !queue; UpdateSelection();
        }
        TrackRecord SelectedTrack() { return !queueVisible && trackGrid.CurrentRow != null ? trackGrid.CurrentRow.DataBoundItem as TrackRecord : null; }
        DownloadItem SelectedJob() { return queueGrid.CurrentRow == null ? null : queueGrid.CurrentRow.DataBoundItem as DownloadItem; }
        void UpdateSelection()
        {
            var track = SelectedTrack(); var job = queueVisible ? SelectedJob() : null;
            bool enabled = auth.IsAuthenticated && track != null;
            play.Enabled = openTrack.Enabled = copyPath.Enabled = enabled; stopAudio.Enabled = auth.IsAuthenticated;
            retry.Visible = queueVisible; retry.Enabled = auth.IsAuthenticated && !analyzing && !validating && job != null && new[] { "Non riuscito", "Annullato", "Interrotto" }.Contains(job.Status);
            play.Visible = stopAudio.Visible = openTrack.Visible = copyPath.Visible = !queueVisible;
            selectionText.Text = track != null ? track.RelativePath : job != null ? (job.Message ?? job.Url) : "Seleziona un brano per ascoltarlo o aprire la sua cartella.";
            tooltips.SetToolTip(selectionText, selectionText.Text);
        }
        void OpenMusic()
        {
            if (String.IsNullOrEmpty(preferences.DataRoot)) throw new IOException("Scegli prima la cartella Foundry.");
            string folder = FoundryPaths.MusicDirectory(preferences.DataRoot, "musics", true); OpenFolder(folder);
        }
        static void OpenFolder(string folder) { FoundryPaths.NoLinks(folder); if (!Directory.Exists(folder)) throw new IOException("La cartella non è disponibile."); Process.Start(new ProcessStartInfo { FileName = "explorer.exe", Arguments = ProcessRunner.Quote(folder), UseShellExecute = false }); }
        static void OpenUrl(string url) { Process.Start(new ProcessStartInfo { FileName = url, UseShellExecute = true }); }
        void OpenSelectedFolder() { var track = SelectedTrack(); if (track != null) OpenFolder(Path.GetDirectoryName(FoundryPaths.TrackFile(track.DataRoot, track))); }
        void CopySelectedPath() { var track = SelectedTrack(); if (track != null) { Clipboard.SetText(track.RelativePath); statusText.Text = "Percorso relativo copiato negli appunti."; } }
        [DllImport("winmm.dll", CharSet = CharSet.Unicode)] static extern int mciSendString(string command, System.Text.StringBuilder result, int length, IntPtr callback);
        void PlaySelected()
        {
            var track = SelectedTrack(); if (track == null) return;
            string file = FoundryPaths.TrackFile(track.DataRoot, track); if (!File.Exists(file)) throw new IOException("Il file non si trova più nella cartella salvata.");
            StopPlayback();
            if (mciSendString("open \"" + file + "\" type mpegvideo alias khuzoeAssetsPreview", null, 0, IntPtr.Zero) != 0 || mciSendString("play khuzoeAssetsPreview", null, 0, IntPtr.Zero) != 0) { StopPlayback(); throw new IOException("Windows non riesce a riprodurre questo file MP3."); }
            statusText.Text = "In ascolto · " + track.Title;
        }
        static void StopPlayback() { mciSendString("stop khuzoeAssetsPreview", null, 0, IntPtr.Zero); mciSendString("close khuzoeAssetsPreview", null, 0, IntPtr.Zero); }
        void ShowImportHelp()
        {
            MessageBox.Show(this, "1. Scarica le musiche nella cartella scelta, per esempio:\n   musics/youtube/combattimento\n\n2. In Foundry apri Playlist audio e crea o scegli una playlist.\n\n3. Fai clic destro sulla playlist e scegli Bulk Import Sounds.\n\n4. Seleziona la stessa cartella e premi Bulk Import.\n\nFoundry aggiunge i brani della cartella e salta quelli già presenti con lo stesso percorso. Puoi importare molti brani insieme.\n\nL’app salva i file: non modifica i database o le playlist dei mondi.", "Come portare le musiche in Foundry", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
        async Task RunUi(Func<Task> action)
        {
            try { await action(); }
            catch (OperationCanceledException) { if (!IsDisposed) statusText.Text = "Operazione annullata."; }
            catch (Exception error) { if (!IsDisposed) { statusText.Text = error.Message; MessageBox.Show(this, error.Message, "Khuzoe Assets Manager", MessageBoxButtons.OK, MessageBoxIcon.Information); } }
        }
        void SafeAction(Action action) { try { action(); } catch (Exception error) { MessageBox.Show(this, error.Message, "Khuzoe Assets Manager", MessageBoxButtons.OK, MessageBoxIcon.Information); } }
        void OnFormClosing(object sender, FormClosingEventArgs args)
        {
            if ((working || analyzing) && !closingAfterCancel)
            {
                args.Cancel = true;
                if (MessageBox.Show(this, "Ci sono operazioni in corso. Vuoi annullarle e chiudere l’app? I brani già salvati vengono conservati.", "Chiudi Khuzoe Assets Manager", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return;
                closingAfterCancel = true; scenesPage.CancelPending(); CancelAll(); if (analyzing) lifetime.Cancel(); return;
            }
            if (loginCancellation != null) loginCancellation.Cancel();
            if (working || analyzing) { args.Cancel = true; return; }
            if (scenesPage != null) scenesPage.CancelPending();
            lifetime.Cancel();
        }
    }
}
