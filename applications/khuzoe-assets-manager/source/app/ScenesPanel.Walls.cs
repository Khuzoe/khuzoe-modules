using System;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace KhuzoeAssetsManager
{
    public sealed partial class ScenesPanel
    {
        public async Task AnalyzeWallsAsync()
        {
            if (!allowed || !editMode || IsBusy || draft == null || canvas.Level == null) return;
            try
            {
                IsBusy = true; SetControls(); if (BusyChanged != null) BusyChanged(this, EventArgs.Empty); await requireLogin(); canvas.CancelEditorGesture();
                var target = draft; string level = canvas.Level.Id, identity = SceneDraft.SceneIdentity(target.CommittedSnapshot);
                using (var form = new WallAnalysisForm(wallService, storage, draftKey, target, level, images, canvas.Settings, canvas.AnalysisArea))
                {
                    if (form.ShowDialog(FindForm()) != DialogResult.OK) return;
                    if (!Object.ReferenceEquals(target, draft) || identity != SceneDraft.SceneIdentity(draft.CommittedSnapshot) || !draft.Scene.Levels.Any(l => l.Id == level)) throw new InvalidOperationException("La scena è cambiata: i muri non sono stati aggiunti.");
                    int count = SceneWallAnalysis.AddToDraft(draft, form.AcceptedWalls, level);
                    form.Complete();
                    editor.SetTool(SceneEditTool.Select); status.Text = count + " muri aggiunti alla bozza locale. Annulla rimuove l’intero inserimento. Nessuna modifica è stata inviata a Foundry.";
                }
            }
            catch (Exception error) { if (!IsDisposed) status.Text = error.Message; }
            finally { IsBusy = false; if (!IsDisposed) { SetControls(); if (BusyChanged != null) BusyChanged(this, EventArgs.Empty); } }
        }
    }
}
