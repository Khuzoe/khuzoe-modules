using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

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
    public sealed class MainForm : Form
    {
        readonly Label folder = new Label();
        readonly Label message = new Label();
        readonly Button choose = new Button();
        readonly Button refresh = new Button();
        readonly Button update = new Button();
        readonly DataGridView grid = new DataGridView();
        readonly ProgressBar bar = new ProgressBar();
        List<ModuleStatus> rows = new List<ModuleStatus>();
        Installation installation;
        bool busy;

        public MainForm()
        {
            Text = "Khuzoe Updater";
            Font = new Font("Segoe UI", 10F);
            BackColor = Color.FromArgb(247, 248, 251);
            ForeColor = Color.FromArgb(30, 38, 51);
            ClientSize = new Size(820, 540);
            MinimumSize = new Size(740, 510);
            StartPosition = FormStartPosition.CenterScreen;
            AutoScaleMode = AutoScaleMode.Dpi;
            var layout = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(24), ColumnCount = 1, RowCount = 7 };
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 46));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 36));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 52));
            layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 48));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 8));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 50));
            var title = new Label { Text = "Khuzoe Updater", Font = new Font("Segoe UI", 21F, FontStyle.Bold), Dock = DockStyle.Fill };
            layout.Controls.Add(title, 0, 0);
            layout.Controls.Add(new Label { Text = "Gli aggiornamenti dei tuoi moduli, in un solo posto.", Dock = DockStyle.Fill, ForeColor = Color.DimGray }, 0, 1);
            var folderRow = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2 };
            folderRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            folderRow.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 125));
            folder.Dock = DockStyle.Fill; folder.AutoEllipsis = true; folder.TextAlign = ContentAlignment.MiddleLeft;
            choose.Text = "Scegli cartella"; choose.Dock = DockStyle.Fill; choose.Margin = new Padding(8, 5, 0, 7);
            choose.Click += async (s, e) => await ChooseFolder();
            folderRow.Controls.Add(folder, 0, 0); folderRow.Controls.Add(choose, 1, 0);
            layout.Controls.Add(folderRow, 0, 2);
            grid.Dock = DockStyle.Fill; grid.ReadOnly = true; grid.AllowUserToAddRows = false; grid.AllowUserToDeleteRows = false;
            grid.AllowUserToResizeRows = false; grid.RowHeadersVisible = false; grid.MultiSelect = false;
            grid.SelectionMode = DataGridViewSelectionMode.FullRowSelect; grid.BackgroundColor = Color.White;
            grid.BorderStyle = BorderStyle.None; grid.AutoSizeRowsMode = DataGridViewAutoSizeRowsMode.AllCells;
            grid.DefaultCellStyle.Padding = new Padding(6); grid.DefaultCellStyle.SelectionBackColor = Color.FromArgb(232, 237, 246);
            grid.DefaultCellStyle.SelectionForeColor = ForeColor; grid.AlternatingRowsDefaultCellStyle.BackColor = Color.FromArgb(249, 250, 252);
            grid.AutoSizeColumnsMode = DataGridViewAutoSizeColumnsMode.Fill;
            grid.EnableHeadersVisualStyles = false;
            grid.ColumnHeadersDefaultCellStyle.BackColor = Color.FromArgb(232, 237, 244);
            grid.ColumnHeadersDefaultCellStyle.ForeColor = Color.FromArgb(30, 38, 51);
            grid.ColumnHeadersDefaultCellStyle.Font = new Font("Segoe UI", 9F, FontStyle.Bold);
            grid.ColumnHeadersHeight = 34;
            grid.DefaultCellStyle.ForeColor = Color.FromArgb(30, 38, 51);
            grid.Columns.Add(new DataGridViewTextBoxColumn { HeaderText = "Modulo", FillWeight = 42 });
            grid.Columns.Add(new DataGridViewTextBoxColumn { HeaderText = "Installato", FillWeight = 17 });
            grid.Columns.Add(new DataGridViewTextBoxColumn { HeaderText = "Disponibile", FillWeight = 17 });
            grid.Columns.Add(new DataGridViewTextBoxColumn { HeaderText = "Stato", FillWeight = 24 });
            grid.CellDoubleClick += (s, e) => { if (e.RowIndex >= 0 && e.RowIndex < rows.Count && !String.IsNullOrEmpty(rows[e.RowIndex].Detail)) MessageBox.Show(this, rows[e.RowIndex].Detail, rows[e.RowIndex].Release.title); };
            layout.Controls.Add(grid, 0, 3);
            message.Dock = DockStyle.Fill; message.TextAlign = ContentAlignment.MiddleLeft; message.AutoEllipsis = true;
            layout.Controls.Add(message, 0, 4);
            bar.Dock = DockStyle.Fill; bar.Style = ProgressBarStyle.Marquee; bar.MarqueeAnimationSpeed = 0;
            layout.Controls.Add(bar, 0, 5);
            var bottom = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 3 };
            bottom.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            bottom.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 145));
            bottom.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 145));
            bottom.Controls.Add(new Label { Text = "v" + BuildConfig.Version + " · Chiudi Foundry prima di aggiornare.", Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft, ForeColor = Color.DimGray, Font = new Font("Segoe UI", 8F) }, 0, 0);
            refresh.Text = "Ricontrolla"; refresh.Dock = DockStyle.Fill; refresh.Margin = new Padding(5, 9, 5, 0);
            update.Text = "Aggiorna"; update.Dock = DockStyle.Fill; update.Margin = new Padding(5, 9, 0, 0);
            update.BackColor = Color.FromArgb(47, 79, 134); update.ForeColor = Color.White; update.FlatStyle = FlatStyle.Flat;
            refresh.Click += async (s, e) => await Check();
            update.Click += async (s, e) => await Apply();
            bottom.Controls.Add(refresh, 1, 0); bottom.Controls.Add(update, 2, 0);
            layout.Controls.Add(bottom, 0, 6);
            Controls.Add(layout);
            Shown += async (s, e) => await Startup();
            FormClosing += (s, e) => { if (busy) { e.Cancel = true; MessageBox.Show(this, "Attendi la fine dell'operazione.", Text); } };
            folder.Text = "Nessuna cartella selezionata";
            message.Text = "Scegli la cartella principale di Foundry.";
            refresh.Enabled = false; update.Enabled = false;
            update.BackColor = Color.FromArgb(220, 225, 234);
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
                    if (candidates.Count == 0) throw new IOException("Non trovo una cartella modules con moduli installati. Scegli la cartella principale di Foundry o la cartella dati.");
                    Installation selected = candidates.Count == 1 ? candidates[0] : SelectInstallation(candidates);
                    if (selected == null) return;
                    Settings.Save(new Preferences { SelectedPath = selected.SelectedPath, ModulesPath = selected.ModulesPath });
                    installation = selected; folder.Text = selected.ModulesPath;
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
            update.Enabled = !value && rows.Any(r => r.CanUpdate); bar.MarqueeAnimationSpeed = value ? 25 : 0;
            update.BackColor = update.Enabled ? Color.FromArgb(47, 79, 134) : Color.FromArgb(220, 225, 234);
        }
        void Render()
        {
            grid.Rows.Clear();
            foreach (var row in rows)
            {
                int index = grid.Rows.Add(row.Release.title, row.LocalVersion ?? "?", row.Release.version, row.Status);
                grid.Rows[index].Cells[3].Style.ForeColor = row.CanUpdate ? Color.FromArgb(36, 92, 166) : row.Status == "Errore" ? Color.Firebrick : Color.FromArgb(37, 113, 73);
                foreach (DataGridViewCell cell in grid.Rows[index].Cells) cell.ToolTipText = row.Detail ?? row.Status;
            }
            grid.ClearSelection();
        }
        async Task Check()
        {
            if (installation == null || busy) return;
            Busy(true); update.Enabled = false; rows.Clear(); Render();
            message.Text = "Controllo degli aggiornamenti…";
            try
            {
                installation.FoundryVersion = Paths.DetectVersion(installation.SelectedPath, installation.ModulesPath);
                var catalog = await Network.Catalog();
                rows = await Task.Run(() => Planner.Scan(installation, catalog));
                Render();
                int count = rows.Count(r => r.CanUpdate), errors = rows.Count(r => r.Status == "Errore");
                message.Text = rows.Count == 0 ? "Nessun modulo Khuzoe installato nella cartella scelta." :
                    count > 0 ? count + " moduli da aggiornare." : errors > 0 ? "Alcuni moduli richiedono attenzione: doppio clic sulla riga per i dettagli." : "Tutti i moduli sono aggiornati.";
            }
            catch (Exception ex) { ShowError(ex); }
            finally { Busy(false); }
        }
        async Task Apply()
        {
            if (busy || installation == null) return;
            Busy(true);
            var progress = new Progress<string>(text => message.Text = text);
            try
            {
                var report = (IProgress<string>)progress;
                await Task.Run(() => Installer.Apply(installation, rows, text => report.Report(text)));
                message.Text = "Aggiornamento completato. Puoi aprire Foundry.";
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
