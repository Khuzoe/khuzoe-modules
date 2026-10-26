using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using System.Runtime.InteropServices;

namespace KhuzoeUpdater
{
    internal static class Program
    {
        [STAThread]
        static void Main()
        {
            bool created;
            using (var mutex = new Mutex(true, "Local\\KhuzoeUpdater", out created))
            {
                if (!created) { MessageBox.Show("Khuzoe Updater è già aperto.", "Khuzoe Updater"); return; }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new MainForm());
            }
        }
    }
    internal static class Theme
    {
        public static readonly Color Background = Color.FromArgb(18, 17, 20);
        public static readonly Color Surface = Color.FromArgb(26, 25, 29);
        public static readonly Color Border = Color.FromArgb(47, 44, 49);
        public static readonly Color Text = Color.FromArgb(240, 235, 224);
        public static readonly Color Muted = Color.FromArgb(164, 158, 150);
        public static readonly Color Gold = Color.FromArgb(218, 187, 118);
        public static GraphicsPath Rounded(Rectangle rectangle, int radius)
        {
            int diameter = radius * 2;
            var path = new GraphicsPath();
            path.AddArc(rectangle.X, rectangle.Y, diameter, diameter, 180, 90);
            path.AddArc(rectangle.Right - diameter, rectangle.Y, diameter, diameter, 270, 90);
            path.AddArc(rectangle.Right - diameter, rectangle.Bottom - diameter, diameter, diameter, 0, 90);
            path.AddArc(rectangle.X, rectangle.Bottom - diameter, diameter, diameter, 90, 90);
            path.CloseFigure();
            return path;
        }
    }
    internal sealed class SurfacePanel : Panel
    {
        public SurfacePanel() { DoubleBuffered = true; BackColor = Theme.Surface; }
        protected override void OnPaintBackground(PaintEventArgs e)
        {
            using (var background = new SolidBrush(Parent == null ? Theme.Background : Parent.BackColor)) e.Graphics.FillRectangle(background, ClientRectangle);
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            using (var shape = Theme.Rounded(new Rectangle(0, 0, Width - 1, Height - 1), 12))
            using (var brush = new SolidBrush(BackColor))
            using (var pen = new Pen(Theme.Border))
            { e.Graphics.FillPath(brush, shape); e.Graphics.DrawPath(pen, shape); }
        }
    }
    internal sealed class WebButton : Button
    {
        public bool Primary { get; set; }
        bool hovered;
        public WebButton()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer, true);
            FlatStyle = FlatStyle.Flat; FlatAppearance.BorderSize = 0; Cursor = Cursors.Hand;
            Font = new Font("Segoe UI", 10F, FontStyle.Bold);
        }
        protected override void OnMouseEnter(EventArgs e) { hovered = true; Invalidate(); base.OnMouseEnter(e); }
        protected override void OnMouseLeave(EventArgs e) { hovered = false; Invalidate(); base.OnMouseLeave(e); }
        protected override void OnEnabledChanged(EventArgs e) { base.OnEnabledChanged(e); Invalidate(); }
        protected override void OnPaint(PaintEventArgs e)
        {
            using (var background = new SolidBrush(Parent == null ? Theme.Background : Parent.BackColor)) e.Graphics.FillRectangle(background, ClientRectangle);
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            Color fill = !Enabled ? Color.FromArgb(43, 40, 43) : Primary ? (hovered ? Color.FromArgb(235, 205, 140) : Theme.Gold) : (hovered ? Color.FromArgb(43, 40, 45) : Theme.Surface);
            Color ink = !Enabled ? Color.FromArgb(126, 120, 116) : Primary ? Theme.Background : Theme.Text;
            using (var shape = Theme.Rounded(new Rectangle(0, 0, Width - 1, Height - 1), 8))
            using (var brush = new SolidBrush(fill))
            using (var pen = new Pen(Primary ? fill : Theme.Border))
            { e.Graphics.FillPath(brush, shape); e.Graphics.DrawPath(pen, shape); }
            TextRenderer.DrawText(e.Graphics, Text, Font, ClientRectangle, ink, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
            if (Focused && ShowFocusCues) ControlPaint.DrawFocusRectangle(e.Graphics, Rectangle.Inflate(ClientRectangle, -5, -5), ink, fill);
        }
    }
    internal sealed class BrandHeader : Control
    {
        public BrandHeader()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            BackColor = Theme.Background; AccessibleName = "Khuzoe Updater"; AccessibleDescription = "Versione " + BuildConfig.Version; AccessibleRole = AccessibleRole.StaticText;
        }
        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            var mark = new Rectangle(0, 5, 48, 48);
            using (var shape = Theme.Rounded(mark, 12))
            using (var brush = new SolidBrush(Theme.Surface))
            using (var pen = new Pen(Theme.Border))
            { e.Graphics.FillPath(brush, shape); e.Graphics.DrawPath(pen, shape); }
            using (var initial = new Font("Georgia", 23F))
            using (var title = new Font("Segoe UI", 23F, FontStyle.Bold))
            using (var version = new Font("Segoe UI", 9F))
            {
                TextRenderer.DrawText(e.Graphics, "K", initial, mark, Theme.Gold, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
                TextRenderer.DrawText(e.Graphics, "Khuzoe Updater", title, new Rectangle(72, 0, Width - 160, 58), Theme.Text, TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding);
                TextRenderer.DrawText(e.Graphics, "v" + BuildConfig.Version, version, new Rectangle(Width - 80, 5, 80, 48), Theme.Muted, TextFormatFlags.Right | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding);
            }
        }
    }
    public sealed class MainForm : Form
    {
        readonly Label folder = new Label();
        readonly Label message = new Label();
        readonly WebButton choose = new WebButton();
        readonly WebButton refresh = new WebButton();
        readonly WebButton update = new WebButton { Primary = true };
        readonly DataGridView grid = new DataGridView();
        readonly ProgressBar bar = new ProgressBar();
        readonly Label summary = new Label();
        readonly Panel empty = new Panel();
        readonly Label emptyTitle = new Label();
        readonly Label emptyText = new Label();
        List<ModuleStatus> rows = new List<ModuleStatus>();
        Installation installation;
        bool busy;

        public MainForm()
        {
            Text = "Khuzoe Updater";
            Font = new Font("Segoe UI", 10F);
            BackColor = Theme.Background;
            ForeColor = Theme.Text;
            ClientSize = new Size(960, 770);
            MinimumSize = new Size(820, 640);
            StartPosition = FormStartPosition.CenterScreen;
            AutoScaleMode = AutoScaleMode.Dpi;
            var layout = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(32, 24, 32, 24), ColumnCount = 1, RowCount = 7 };
            layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 84));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 104));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 64));
            layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 46));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 4));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 64));
            var header = new BrandHeader { Dock = DockStyle.Fill, Margin = Padding.Empty };
            layout.Controls.Add(header, 0, 0);
            var folderCard = new SurfacePanel { Dock = DockStyle.Fill, Padding = new Padding(22, 14, 22, 14), Margin = Padding.Empty };
            var folderRow = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 2, BackColor = Theme.Surface };
            folderRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            folderRow.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 144));
            folderRow.RowStyles.Add(new RowStyle(SizeType.Absolute, 26));
            folderRow.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            folderRow.Controls.Add(new Label { Text = "INSTALLAZIONE FOUNDRY", ForeColor = Theme.Muted, Font = new Font("Segoe UI", 8F, FontStyle.Bold), Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft }, 0, 0);
            folder.Dock = DockStyle.Fill; folder.AutoEllipsis = true; folder.TextAlign = ContentAlignment.TopLeft; folder.Padding = new Padding(0, 5, 12, 0);
            choose.Text = "Scegli cartella"; choose.Dock = DockStyle.Fill; choose.Margin = new Padding(8, 15, 0, 15);
            choose.Click += async (s, e) => await ChooseFolder();
            folderRow.Controls.Add(folder, 0, 1); folderRow.Controls.Add(choose, 1, 0); folderRow.SetRowSpan(choose, 2);
            folderCard.Controls.Add(folderRow);
            layout.Controls.Add(folderCard, 0, 1);
            var section = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, Margin = Padding.Empty, Padding = new Padding(0, 20, 0, 6) };
            section.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50)); section.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
            section.Controls.Add(new Label { Text = "Moduli", Font = new Font("Segoe UI", 15F, FontStyle.Bold), Dock = DockStyle.Fill }, 0, 0);
            summary.Dock = DockStyle.Fill; summary.TextAlign = ContentAlignment.MiddleRight; summary.ForeColor = Theme.Muted; summary.Font = new Font("Segoe UI", 9F);
            section.Controls.Add(summary, 1, 0); layout.Controls.Add(section, 0, 2);
            var tableCard = new SurfacePanel { Dock = DockStyle.Fill, Padding = new Padding(16, 8, 16, 8), Margin = Padding.Empty };
            grid.Dock = DockStyle.Fill; grid.ReadOnly = true; grid.AllowUserToAddRows = false; grid.AllowUserToDeleteRows = false;
            grid.AllowUserToResizeRows = false; grid.RowHeadersVisible = false; grid.MultiSelect = false;
            grid.SelectionMode = DataGridViewSelectionMode.FullRowSelect; grid.BackgroundColor = Theme.Surface;
            grid.BorderStyle = BorderStyle.None; grid.CellBorderStyle = DataGridViewCellBorderStyle.SingleHorizontal;
            grid.GridColor = Color.FromArgb(40, 37, 43); grid.ColumnHeadersBorderStyle = DataGridViewHeaderBorderStyle.None;
            grid.DefaultCellStyle.Padding = new Padding(12, 0, 8, 0); grid.DefaultCellStyle.BackColor = Theme.Surface;
            grid.DefaultCellStyle.SelectionBackColor = Color.FromArgb(38, 34, 40); grid.DefaultCellStyle.SelectionForeColor = Theme.Text;
            grid.RowTemplate.Height = 52; grid.AutoSizeRowsMode = DataGridViewAutoSizeRowsMode.None;
            grid.AutoSizeColumnsMode = DataGridViewAutoSizeColumnsMode.Fill;
            grid.EnableHeadersVisualStyles = false;
            grid.ColumnHeadersDefaultCellStyle.BackColor = Theme.Surface;
            grid.ColumnHeadersDefaultCellStyle.ForeColor = Theme.Muted;
            grid.ColumnHeadersDefaultCellStyle.Font = new Font("Segoe UI", 8F, FontStyle.Bold);
            grid.ColumnHeadersDefaultCellStyle.Padding = new Padding(12, 0, 0, 0);
            grid.ColumnHeadersHeight = 42; grid.ColumnHeadersHeightSizeMode = DataGridViewColumnHeadersHeightSizeMode.DisableResizing;
            grid.DefaultCellStyle.ForeColor = Theme.Text; grid.ShowCellErrors = false; grid.ShowRowErrors = false;
            grid.Columns.Add(new DataGridViewTextBoxColumn { HeaderText = "Modulo", FillWeight = 42 });
            grid.Columns.Add(new DataGridViewTextBoxColumn { HeaderText = "Installato", FillWeight = 17 });
            grid.Columns.Add(new DataGridViewTextBoxColumn { HeaderText = "Disponibile", FillWeight = 17 });
            grid.Columns.Add(new DataGridViewTextBoxColumn { HeaderText = "Stato", FillWeight = 24 });
            grid.Columns.Add(new DataGridViewButtonColumn { HeaderText = "", AutoSizeMode = DataGridViewAutoSizeColumnMode.None, Width = 96, FlatStyle = FlatStyle.Flat });
            foreach (DataGridViewColumn column in grid.Columns) column.SortMode = DataGridViewColumnSortMode.NotSortable;
            grid.Columns[1].DefaultCellStyle.Font = new Font("Consolas", 10F); grid.Columns[1].DefaultCellStyle.ForeColor = Theme.Muted;
            grid.Columns[2].DefaultCellStyle.Font = new Font("Consolas", 10F);
            grid.CellPainting += PaintStatus;
            grid.CellContentClick += async (s, e) =>
            {
                if (!busy && e.ColumnIndex == 4 && e.RowIndex >= 0 && e.RowIndex < rows.Count && !rows[e.RowIndex].IsInstalled && rows[e.RowIndex].CanUpdate)
                    await Apply(rows[e.RowIndex]);
            };
            grid.CellDoubleClick += (s, e) => { if (e.RowIndex >= 0 && e.RowIndex < rows.Count && !String.IsNullOrEmpty(rows[e.RowIndex].Detail)) MessageBox.Show(this, rows[e.RowIndex].Detail, rows[e.RowIndex].Release.title); };
            empty.Dock = DockStyle.Fill; empty.BackColor = Theme.Surface; empty.Padding = new Padding(20);
            emptyTitle.Text = "Scegli la cartella di Foundry"; emptyTitle.Font = new Font("Segoe UI", 16F, FontStyle.Bold); emptyTitle.AutoSize = false; emptyTitle.TextAlign = ContentAlignment.MiddleCenter;
            emptyText.Text = "La scelta verrà ricordata."; emptyText.ForeColor = Theme.Muted; emptyText.TextAlign = ContentAlignment.MiddleCenter;
            empty.Controls.Add(emptyTitle); empty.Controls.Add(emptyText);
            empty.Resize += (s, e) => { emptyTitle.SetBounds(0, Math.Max(0, empty.Height / 2 - 38), empty.Width, 36); emptyText.SetBounds(0, empty.Height / 2 + 2, empty.Width, 28); };
            tableCard.Controls.Add(grid); tableCard.Controls.Add(empty); empty.BringToFront();
            layout.Controls.Add(tableCard, 0, 3);
            message.Dock = DockStyle.Fill; message.TextAlign = ContentAlignment.MiddleLeft; message.AutoEllipsis = true; message.ForeColor = Theme.Muted; message.Font = new Font("Segoe UI", 9F);
            layout.Controls.Add(message, 0, 4);
            bar.Dock = DockStyle.Fill; bar.Style = ProgressBarStyle.Marquee; bar.MarqueeAnimationSpeed = 0; bar.Visible = false;
            layout.Controls.Add(bar, 0, 5);
            var bottom = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 3, Margin = Padding.Empty };
            bottom.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            bottom.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 145));
            bottom.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 145));
            bottom.Controls.Add(new Label { Text = "Chiudi Foundry prima di aggiornare.", Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft, ForeColor = Theme.Muted, Font = new Font("Segoe UI", 9F) }, 0, 0);
            refresh.Text = "Ricontrolla"; refresh.Dock = DockStyle.Fill; refresh.Margin = new Padding(5, 12, 8, 4);
            update.Text = "Aggiorna"; update.Dock = DockStyle.Fill; update.Margin = new Padding(5, 12, 0, 4);
            refresh.Click += async (s, e) => await Check();
            update.Click += async (s, e) => await Apply();
            bottom.Controls.Add(refresh, 1, 0); bottom.Controls.Add(update, 2, 0);
            layout.Controls.Add(bottom, 0, 6);
            Controls.Add(layout);
            Shown += async (s, e) => await Startup();
            FormClosing += (s, e) => { if (busy) { e.Cancel = true; MessageBox.Show(this, "Attendi la fine dell'operazione.", Text); } };
            folder.Text = "Nessuna cartella selezionata";
            message.Text = "";
            refresh.Enabled = false; update.Enabled = false;
        }
        [DllImport("dwmapi.dll")]
        static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref int value, int size);
        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            int dark = 1;
            DwmSetWindowAttribute(Handle, 20, ref dark, sizeof(int));
        }
        void PaintStatus(object sender, DataGridViewCellPaintingEventArgs e)
        {
            if (e.RowIndex < 0 || e.RowIndex >= rows.Count) return;
            if (e.ColumnIndex == 4)
            {
                e.PaintBackground(e.ClipBounds, true);
                var item = rows[e.RowIndex];
                if (!item.IsInstalled && item.CanUpdate)
                {
                    var bounds = new Rectangle(e.CellBounds.X + 5, e.CellBounds.Y + (e.CellBounds.Height - 30) / 2, e.CellBounds.Width - 12, 30);
                    using (var shape = Theme.Rounded(bounds, 7))
                    using (var brush = new SolidBrush(busy ? Theme.Border : Theme.Gold)) e.Graphics.FillPath(brush, shape);
                    using (var font = new Font("Segoe UI", 8.5F, FontStyle.Bold))
                        TextRenderer.DrawText(e.Graphics, "Installa", font, bounds, busy ? Theme.Muted : Theme.Background, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
                }
                e.Handled = true; return;
            }
            if (e.ColumnIndex != 3) return;
            e.PaintBackground(e.ClipBounds, true);
            var row = rows[e.RowIndex];
            Color ink = row.CanUpdate ? Theme.Gold : row.Status == "Errore" ? Color.FromArgb(235, 148, 146) : Color.FromArgb(143, 202, 167);
            Color fill = row.CanUpdate ? Color.FromArgb(52, 43, 30) : row.Status == "Errore" ? Color.FromArgb(56, 33, 37) : Color.FromArgb(30, 45, 39);
            using (var font = new Font("Segoe UI", 8.5F))
            {
                int width = Math.Min(e.CellBounds.Width - 18, TextRenderer.MeasureText(row.Status, font).Width + 26);
                var bounds = new Rectangle(e.CellBounds.X + 10, e.CellBounds.Y + (e.CellBounds.Height - 28) / 2, width, 28);
                e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
                using (var shape = Theme.Rounded(bounds, 7))
                using (var brush = new SolidBrush(fill)) e.Graphics.FillPath(brush, shape);
                TextRenderer.DrawText(e.Graphics, row.Status, font, bounds, ink, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
            }
            e.Handled = true;
        }
        async Task Startup()
        {
            var saved = Settings.Load();
            if (String.IsNullOrWhiteSpace(saved.ModulesPath)) return;
            try
            {
                Paths.NoLinks(saved.ModulesPath);
                if (!Directory.Exists(saved.ModulesPath)) throw new IOException("La cartella salvata non è disponibile. Scegli di nuovo la cartella Foundry.");
                installation = new Installation { SelectedPath = saved.SelectedPath, ModulesPath = saved.ModulesPath, FoundryVersion = Paths.DetectVersion(saved.SelectedPath, saved.ModulesPath) };
                folder.Text = saved.ModulesPath;
                choose.Text = "Cambia";
                await Check();
            }
            catch (Exception ex) { ShowError(ex); }
        }
        async Task ChooseFolder()
        {
            using (var dialog = new FolderBrowserDialog { Description = "Scegli la cartella principale di Foundry (oppure la sua cartella dati)", ShowNewFolderButton = false })
            {
                if (installation != null) dialog.SelectedPath = installation.SelectedPath;
                if (dialog.ShowDialog(this) != DialogResult.OK) return;
                try
                {
                    var candidates = Paths.Find(dialog.SelectedPath);
                    if (candidates.Count == 0) throw new IOException("Non trovo la cartella modules di Foundry. Scegli la cartella principale di Foundry o la cartella dati.");
                    Installation selected = candidates.Count == 1 ? candidates[0] : SelectInstallation(candidates);
                    if (selected == null) return;
                    Settings.Save(new Preferences { SelectedPath = selected.SelectedPath, ModulesPath = selected.ModulesPath });
                    installation = selected; folder.Text = selected.ModulesPath; choose.Text = "Cambia";
                    await Check();
                }
                catch (Exception ex) { ShowError(ex); }
            }
        }
        Installation SelectInstallation(List<Installation> candidates)
        {
            using (var dialog = new Form { Text = "Quale cartella vuoi aggiornare?", Size = new Size(720, 230), StartPosition = FormStartPosition.CenterParent, MinimizeBox = false, MaximizeBox = false, Font = Font })
            {
                var list = new ListBox { Dock = DockStyle.Fill, HorizontalScrollbar = true };
                foreach (var candidate in candidates) list.Items.Add(candidate.ModulesPath);
                list.SelectedIndex = 0;
                var ok = new Button { Text = "Usa questa cartella", Dock = DockStyle.Bottom, Height = 42, DialogResult = DialogResult.OK };
                dialog.Controls.Add(list); dialog.Controls.Add(ok); dialog.AcceptButton = ok;
                return dialog.ShowDialog(this) == DialogResult.OK ? candidates[list.SelectedIndex] : null;
            }
        }
        void Busy(bool value)
        {
            busy = value; choose.Enabled = !value; refresh.Enabled = !value && installation != null;
            update.Enabled = !value && rows.Any(r => r.IsInstalled && r.CanUpdate); bar.MarqueeAnimationSpeed = value ? 25 : 0;
            bar.Visible = value;
            if (!value && rows.Count > 0) summary.Text = rows.Count(r => r.IsInstalled) + " installati · " + rows.Count(r => !r.IsInstalled) + " mancanti";
            grid.Invalidate();
        }
        void Render()
        {
            grid.Rows.Clear();
            empty.Visible = rows.Count == 0;
            if (empty.Visible && installation != null)
            {
                emptyTitle.Text = busy ? "Controllo degli aggiornamenti…" : "Nessun modulo da mostrare";
                emptyText.Text = busy ? "" : "Controlla la cartella selezionata o riprova.";
            }
            foreach (var row in rows)
            {
                int index = grid.Rows.Add(row.Release.title, row.IsInstalled ? row.LocalVersion ?? "?" : "—", row.Release.version, row.Status, !row.IsInstalled && row.CanUpdate ? "Installa" : "");
                foreach (DataGridViewCell cell in grid.Rows[index].Cells) cell.ToolTipText = row.Detail ?? row.Status;
            }
            grid.ClearSelection();
            grid.CurrentCell = null;
        }
        async Task Check()
        {
            if (installation == null || busy) return;
            Busy(true); update.Enabled = false; rows.Clear(); Render();
            summary.Text = "Verifica in corso";
            message.Text = "Controllo degli aggiornamenti…";
            try
            {
                installation.FoundryVersion = Paths.DetectVersion(installation.SelectedPath, installation.ModulesPath);
                var catalog = await Network.Catalog();
                rows = await Task.Run(() => Planner.Scan(installation, catalog));
                Render();
                int count = rows.Count(r => r.IsInstalled && r.CanUpdate), available = rows.Count(r => !r.IsInstalled && r.CanUpdate), errors = rows.Count(r => r.Status == "Errore");
                message.Text = rows.Count == 0 ? "Nessun modulo disponibile nel catalogo." :
                    count > 0 ? count + " moduli da aggiornare." : available > 0 ? "Premi Installa accanto ai moduli che vuoi aggiungere." : errors > 0 ? "Alcuni moduli richiedono attenzione: doppio clic sulla riga per i dettagli." : "Tutti i moduli sono aggiornati.";
            }
            catch (Exception ex) { ShowError(ex); }
            finally { Busy(false); }
        }
        async Task Apply(ModuleStatus target = null)
        {
            if (busy || installation == null) return;
            Busy(true);
            var progress = new Progress<string>(text => message.Text = text);
            try
            {
                var report = (IProgress<string>)progress;
                await Task.Run(() => Installer.Apply(installation, rows, text => report.Report(text), target == null ? null : new[] { target }));
                message.Text = target == null ? "Aggiornamento completato. Puoi aprire Foundry." : "Installazione completata. Abilita il modulo in Gestione moduli di Foundry.";
            }
            catch (Exception ex) { ShowError(ex); }
            finally { Render(); Busy(false); }
        }
        void ShowError(Exception error)
        {
            var ex = error is AggregateException ? error.GetBaseException() : error;
            string text = ex is UnauthorizedAccessException ? "Windows non consente di scrivere nella cartella scelta. Verifica i permessi; se necessario avvia l'Updater come amministratore." :
                ex is System.Net.Http.HttpRequestException ? "Non riesco a raggiungere GitHub. Controlla la connessione e riprova." :
                ex is TaskCanceledException ? "Il collegamento a GitHub ha impiegato troppo tempo. Riprova." : ex.Message;
            message.Text = text;
            MessageBox.Show(this, text, "Khuzoe Updater", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
    }
}
