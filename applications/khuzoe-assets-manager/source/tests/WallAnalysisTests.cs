using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace KhuzoeAssetsManager
{
    internal static partial class Tests
    {
        static async Task RunWalls()
        {
            await Test("Muri AI: piano completo con coordinate esterne, contesto e limiti", () => Sync(() => {
                foreach (var size in new[] { new RectangleF(-250, -150, 2048, 1143), new RectangleF(-20000, -10000, 120000, 80000) })
                {
                    var plan = SceneWallAnalysis.Plan(size, 1); Check(plan.tiles.Count > 0 && plan.tiles.Count <= 64, "unbounded tile plan");
                    Check(Math.Abs(plan.tiles.Sum(t => t.core.width * t.core.height) - size.Width * (double)size.Height) < size.Width * (double)size.Height * .00001, "missing map area");
                    foreach (var t in plan.tiles) Check(t.width <= 1280 && t.height <= 1280 && t.core.x >= t.frame.x && t.core.y >= t.frame.y && t.core.x + t.core.width <= t.frame.x + t.frame.width + .001, "lost context or raster budget");
                }
                Throws(() => SceneWallAnalysis.Plan(new RectangleF(0, 0, 0, 10), 1)); Throws(() => SceneWallAnalysis.Plan(new RectangleF(0, 0, 20, 10), Double.NaN));
                Check(!Json.Write(new WallFrame(1, 2, 3, 4)).Contains("Rectangle"), "transport leaked computed geometry");
            }));
            await Test("Muri AI: ricomposizione unisce estremi vicini conservando porte e scartando duplicati", () => Sync(() => {
                var job = WallResult("id"); job.walls = new List<WallSegment> {
                    new WallSegment { x1=0,y1=20,x2=40,y2=20 }, new WallSegment { x1=40.5,y1=20,x2=80,y2=20 },
                    new WallSegment { x1=80,y1=20,x2=40.5,y2=20,uncertain=true }, new WallSegment { x1=90,y1=20,x2=150,y2=20 }
                };
                var walls = SceneWallAnalysis.Walls(job, "main"); Check(walls.Count == 3 && walls[0].X2 == walls[1].X1 && walls[2].X1 - walls[1].X2 == 10 && walls[1].SuggestedUncertain, "seam, doorway or duplicate regression");
                job.walls.Add(new WallSegment { x1=Double.NaN }); Throws(() => SceneWallAnalysis.Walls(job, "main"));
            }));
            await Test("Muri AI: conferma additiva, una sola operazione annullabile e originale intatto", () => Sync(() => {
                var source = WallScene(); source.Walls.Add(new SceneWall { Id="existing",X1=0,Y1=10,X2=50,Y2=10,Levels=new[]{"main"} });
                string original = Json.Write(source); var draft = new SceneDraft(source); var suggestions = SceneWallAnalysis.Walls(WallResult("id"), "main");
                Check(SceneWallAnalysis.AddToDraft(draft, suggestions, "main") == 1 && source.Walls.Count == 1 && Json.Write(source) == original, "confirmation touched original");
                Check(SceneWallAnalysis.AddToDraft(draft, suggestions, "main") == 0, "duplicate confirmation"); draft.Undo(); Check(!draft.IsDirty && draft.Scene.Walls.Count == 1 && !draft.CanUndo, "batch is not one undo"); draft.Redo(); Check(draft.Scene.Walls.Count == 2, "redo lost suggestions");
            }));
            await Test("Muri AI: selezione area e zoom non modificano documenti, bozze o cronologia", () => WheelUi((canvas, form) => {
                var draft = new SceneDraft(WallScene()); canvas.Draft = draft; canvas.Editing = true; canvas.SetScene(draft.Scene, draft.Scene.Levels[0], null, true); canvas.Tool = SceneEditTool.Area;
                string before = draft.CommittedSnapshot; Mouse(canvas, "OnMouseDown", canvas.SceneScreen(-20, 10)); Mouse(canvas, "OnMouseMove", canvas.SceneScreen(150, 70)); Mouse(canvas, "OnMouseUp", canvas.SceneScreen(150, 70));
                Check(canvas.AnalysisArea.HasValue && canvas.AnalysisArea.Value.Left < 0 && !draft.CanUndo && Object.ReferenceEquals(before, draft.CommittedSnapshot), "area was snapped, serialized or saved");
                var area = canvas.AnalysisArea; Wheel(canvas, new Point(150, 150), 120); Check(canvas.AnalysisArea == area, "zoom changed world area");
                Mouse(canvas, "OnMouseDown", canvas.SceneScreen(20, 20)); Mouse(canvas, "OnMouseMove", canvas.SceneScreen(100, 50)); canvas.CancelEditorGesture(); Check(canvas.AnalysisArea == area, "cancel lost previous area");
            }));
            await Test("Muri AI: cattura da originali con immagini esterne, senza muri o luci", async () => {
                using (var original = new Bitmap(200, 100)) using (var outside = new Bitmap(20, 20)) using (var images = new SceneImageSet())
                {
                    using (var g = Graphics.FromImage(original)) { g.Clear(Color.Blue); g.FillRectangle(Brushes.Red, 50, 20, 20, 20); }
                    using (var g = Graphics.FromImage(outside)) g.Clear(Color.Lime);
                    var scene = WallScene(); scene.Tiles.Add(new SceneTile { Id="outside",X=-20,Y=50,Width=20,Height=20,Alpha=1,Levels=new[]{"main"},Textures=new SceneTexture() });
                    var capture = WallCapture(scene, images, original, outside); var frame = WallFrame.From(capture.Bounds);
                    using (var image = await capture.RenderAsync(new WallTile { frame=frame,width=230,height=100 }, CancellationToken.None))
                    { Check(image.GetPixel(90,30).R > 240 && image.GetPixel(180,50).B > 240 && image.GetPixel(10,50).G > 240, "capture used blurred preview, wrong placement or an overlay"); }
                }
            });
            await Test("Muri AI: recupero persistente conserva soltanto ricevuta e coordinate", () => Sync(() => {
                var storage = new AppStorage(NewDir("wall-receipt")); var store = new WallPendingStore(storage, "scene-key", "main"); var value = new WallPending { Id=Guid.NewGuid().ToString(),SceneHash="abc",LevelId="main",Frame=new WallFrame(-20,10,200,100) };
                store.Save(value); var loaded = new WallPendingStore(storage,"scene-key","main").Load(); Check(loaded.Id == value.Id && loaded.Frame.x == -20, "receipt did not roundtrip");
                var text = File.ReadAllText(Directory.GetFiles(Path.Combine(storage.Root,"scene-ai"))[0]); Check(!text.Contains("image") && !text.Contains("Bearer") && !text.Contains("data:"), "receipt retained image or credentials"); store.Clear(); Check(store.Load() == null, "receipt not removed");
            }));
            await Test("Muri AI: anteprima modificabile separata dalla bozza originale", () => WheelUi((canvas, owner) => {
                var scene = WallScene(); var target = new SceneDraft(scene); string before = target.Snapshot();
                using (var images = new SceneImageSet()) using (var original = new Bitmap(200,100))
                {
                    WallCapture(scene,images,original,null);
                    using (var review = new WallReviewForm(scene,"main",images,WallResult("id"),new SceneViewSettings()))
                    {
                        review.Show(owner); Application.DoEvents(); review.Draft.Select(SceneSelectionKind.Wall, review.Draft.Scene.Walls[0].Id); new WallProperties(review.Draft).X1 = -10;
                        Check(target.Snapshot() == before && Json.Write(scene) == before && !target.IsDirty, "preview wrote into original draft");
                        review.Draft.Undo(); Check(review.Draft.Scene.Walls[0].X1 == 10, "preview undo failed"); review.Close();
                    }
                }
            }));
            await Test("Muri AI: invio esplicito, risultato, revisione e conferma con servizio simulato", () => WheelUi((canvas, owner) => {
                var scene=WallScene(); var draft=new SceneDraft(scene); var storage=new AppStorage(NewDir("wall-flow")); var service=new FakeWallService(); string before=draft.Snapshot();
                using(var original=new Bitmap(200,100)) using(var images=new SceneImageSet())
                {
                    using(var g=Graphics.FromImage(original))g.Clear(Color.DarkSlateGray); WallCapture(scene,images,original,null);
                    using(var analysis=new WallAnalysisForm(service,storage,"flow",draft,"main",images,new SceneViewSettings(),null))
                    {
                        analysis.Show(owner); Pump(()=>Button(analysis,"Avvia analisi AI").Enabled); Check(service.Starts==0,"opening the dialog consumed AI");
                        Button(analysis,"Avvia analisi AI").PerformClick(); Pump(()=>Button(analysis,"Controlla muri").Enabled);
                        Check(service.Starts==1 && service.Request.tiles.All(t=>t.image.StartsWith("data:image/jpeg;base64,")) && draft.Snapshot()==before,"request or isolation failed");
                        Screenshot(analysis, Path.Combine(root,"walls-analysis.png"));
                        using(var timer=new System.Windows.Forms.Timer{Interval=20})
                        {
                            timer.Tick+=(s,e)=>{var review=Application.OpenForms.Cast<Form>().OfType<WallReviewForm>().FirstOrDefault(); if(review==null)return;timer.Stop();Screenshot(review,Path.Combine(root,"walls-review.png"));Button(review,"Aggiungi alla bozza").PerformClick();};timer.Start();Button(analysis,"Controlla muri").PerformClick();
                        }
                        Check(analysis.DialogResult==DialogResult.OK && analysis.AcceptedWalls.Count==1 && draft.Snapshot()==before,"review prematurely committed or failed");
                        SceneWallAnalysis.AddToDraft(draft,analysis.AcceptedWalls,"main");analysis.Complete();draft.Undo();Check(draft.Snapshot()==before,"final batch cannot be undone");
                    }
                    var store=new WallPendingStore(storage,"flow","main");Check(store.Load()==null,"accepted receipt not cleared");
                }
            }));
            await Test("Muri AI: risposta di invio persa recuperata senza una seconda chiamata di analisi", () => WallDialogTest(new FakeWallService { LoseResponse=true }, (form,service,draft) => {
                Button(form,"Avvia analisi AI").PerformClick(); Pump(()=>Button(form,"Recupera risultato").Enabled && service.Starts==1); Check(!Button(form,"Avvia analisi AI").Enabled,"ambiguous submission enabled a duplicate");
                Button(form,"Recupera risultato").PerformClick();Pump(()=>Button(form,"Controlla muri").Enabled);Check(service.Starts==1 && service.Gets==1 && !draft.IsDirty,"recovery posted a new analysis or wrote the draft");
            }));
            await Test("Muri AI: interruzione durante l’attesa ferma i ritagli successivi", () => WallDialogTest(new FakeWallService { Waiting=true }, (form,service,draft) => {
                Button(form,"Avvia analisi AI").PerformClick();Pump(()=>service.Starts==1 && Button(form,"Interrompi analisi").Enabled);Button(form,"Interrompi analisi").PerformClick();Pump(()=>service.Stops==1 && Button(form,"Recupera risultato").Enabled);Check(service.Starts==1 && !draft.IsDirty,"stop changed the draft or resubmitted");
            }));
            await Test("Muri AI: richiesta mancante recuperabile senza bloccare nuove analisi", () => WallDialogTest(new FakeWallService { LoseResponse=true, Missing=true }, (form,service,draft) => {
                Button(form,"Avvia analisi AI").PerformClick();Pump(()=>service.Starts==1 && Button(form,"Recupera risultato").Enabled);Button(form,"Recupera risultato").PerformClick();Pump(()=>Button(form,"Scarta risultato").Enabled);Button(form,"Scarta risultato").PerformClick();Check(Button(form,"Avvia analisi AI").Enabled && service.Starts==1,"missing receipt trapped UI or restarted AI");
            }));
        }
        static Task WallDialogTest(FakeWallService service,Action<WallAnalysisForm,FakeWallService,SceneDraft> action)
        {
            return WheelUi((canvas,owner)=>{var scene=WallScene();var draft=new SceneDraft(scene);using(var image=new Bitmap(200,100))using(var images=new SceneImageSet()){WallCapture(scene,images,image,null);using(var form=new WallAnalysisForm(service,new AppStorage(NewDir("wall-dialog-"+Guid.NewGuid().ToString("N").Substring(0,5))),"dialog",draft,"main",images,new SceneViewSettings(),null)){form.Show(owner);Pump(()=>Button(form,"Avvia analisi AI").Enabled);action(form,service,draft);form.Close();}}});
        }
        static SceneDetail WallScene()
        { var scene=new SceneDetail {Id="walls-test",Name="Mappa test",Width=200,Height=100,Padding=0,GridSize=10,GridDistance=5,GridType=1,InitialLevel="main"};scene.Levels.Add(new SceneLevel{Id="main",Name="Piano",Background="map",BackgroundColor="#333333"});return scene; }
        static WallJob WallResult(string id)
        { return new WallJob {id=id,status="ready",model="mock-vision",total=1,completed=1,frame=new WallFrame(0,0,200,100),walls=new List<WallSegment>{new WallSegment{x1=10,y1=20,x2=150,y2=20,uncertain=true}},inputTokens=500,outputTokens=100}; }
        static SceneCapture WallCapture(SceneDetail scene,SceneImageSet images,Bitmap original,Bitmap outside)
        {
            images.Background=new Bitmap(2,1); using(var g=Graphics.FromImage(images.Background))g.Clear(Color.Magenta);
            images.Sources[images.Background]=new SceneImageSource("original",original.Size,(region,size,token)=>{token.ThrowIfCancellationRequested();using(var crop=original.Clone(region,PixelFormat.Format32bppArgb))return Task.FromResult(new Bitmap(crop,size));});
            if(outside!=null){var preview=new Bitmap(1,1);images.Tiles["outside"]=preview;images.Sources[preview]=new SceneImageSource("outside",outside.Size,(region,size,token)=>{token.ThrowIfCancellationRequested();using(var crop=outside.Clone(region,PixelFormat.Format32bppArgb))return Task.FromResult(new Bitmap(crop,size));});}
            return new SceneCapture(scene,scene.Levels[0],images,new SceneViewSettings());
        }
        static IEnumerable<Control> WallControls(Control root) { foreach(Control control in root.Controls){yield return control;foreach(var child in WallControls(control))yield return child;} }
        static Button Button(Control parent,string text) { return WallControls(parent).OfType<Button>().First(b=>b.Text==text); }
        sealed class FakeWallService:IWallService
        {
            public int Starts,Gets,Stops; public bool LoseResponse,Waiting,Missing; public WallRequest Request;
            public Task<WallCapabilities> CapabilitiesAsync(CancellationToken token){return Task.FromResult(new WallCapabilities{ok=true,version=1,enabled=true,model="mock-vision",maxTiles=64,maxBytes=15*1024*1024});}
            WallJob Result(string id){var job=WallResult(id);if(Request!=null)job.frame=Request.frame;if(Waiting){job.status="running";job.completed=0;job.walls.Clear();}return job;}
            public Task<WallJob> StartWallsAsync(WallRequest request,CancellationToken token){Starts++;Request=request;if(LoseResponse)return Task.FromException<WallJob>(new IOException("Simulated lost response"));return Task.FromResult(Result(request.id));}
            public Task<WallJob> GetWallsAsync(string id,CancellationToken token){Gets++;if(Missing)return Task.FromException<WallJob>(new WallMissingException());return Task.FromResult(Result(id));}
            public Task<WallJob> StopWallsAsync(string id,CancellationToken token){Stops++;var job=Result(id);job.status="stopped";return Task.FromResult(job);}
        }
    }
}
