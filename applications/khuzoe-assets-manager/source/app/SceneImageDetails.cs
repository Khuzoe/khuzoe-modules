using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;

namespace KhuzoeAssetsManager
{
    internal sealed class SceneDetailPatch : IDisposable
    {
        public Bitmap Image; public SceneDetailSpec Spec;
        public long Bytes { get { return (long)Image.Width * Image.Height * 4; } }
        public void Dispose() { if (Image != null) Image.Dispose(); Image = null; }
    }
    internal sealed class SceneImageDetails : IDisposable
    {
        sealed class Entry { public SceneImageSource Source; public SceneDetailPatch Patch; public SceneDetailSpec Wanted, Failed; public long Version, Used; }
        sealed class Work { public Image Key; public Entry Entry; public SceneDetailSpec Spec; public long Version, Epoch; public CancellationTokenSource Cancellation; }
        sealed class Delivery { public Work Work; public Bitmap Image; public Exception Error; }
        readonly Dictionary<Image, Entry> entries = new Dictionary<Image, Entry>();
        readonly Dictionary<Image, Work> pending = new Dictionary<Image, Work>();
        readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer { Interval = 50 };
        readonly Stopwatch clock = Stopwatch.StartNew();
        readonly object gate = new object();
        readonly Action<bool> changed;
        readonly long budget;
        Delivery delivery;
        Work active;
        long epoch, used, due;
        bool disposed;
        public long Bytes { get; private set; }
        public bool IsBusy { get { return active != null || pending.Count > 0; } }
        public string Error { get; private set; }
        public SceneImageDetails(Action<bool> changed) : this(changed, 64L * 1024 * 1024) { }
        internal SceneImageDetails(Action<bool> changed, long budget) { this.changed = changed; this.budget = budget; timer.Tick += Tick; }
        public SceneDetailPatch Get(Image key) { Entry entry; return entries.TryGetValue(key, out entry) ? entry.Patch : null; }
        public void Request(Image key, SceneImageSource source, SceneDetailSpec spec)
        {
            if (disposed) return; Entry entry;
            if (!entries.TryGetValue(key, out entry)) { entry = new Entry { Source = source }; entries[key] = entry; }
            entry.Used = ++used;
            if (entry.Patch != null && entry.Patch.Spec.Region.Contains(spec.Region) && entry.Patch.Spec.Sample >= spec.Sample * .95)
            {
                if (entry.Wanted != null) { pending.Remove(key); entry.Version++; entry.Wanted = null; if (active != null && Object.ReferenceEquals(active.Key, key)) active.Cancellation.Cancel(); }
                return;
            }
            if (spec.Same(entry.Wanted) || spec.Same(entry.Failed)) return;
            bool wasBusy = IsBusy;
            entry.Wanted = spec; entry.Version++; Error = null;
            pending[key] = new Work { Key = key, Entry = entry, Spec = spec, Version = entry.Version, Epoch = epoch };
            if (active != null && Object.ReferenceEquals(active.Key, key)) active.Cancellation.Cancel();
            due = clock.ElapsedMilliseconds + 100; timer.Start(); if (!wasBusy) changed(false);
        }
        async void Decode(Work work)
        {
            Bitmap image = null; Exception error = null;
            try { image = await Task.Run(() => work.Entry.Source.ReadRegionAsync(work.Spec.Region, work.Spec.Output, work.Cancellation.Token), work.Cancellation.Token).ConfigureAwait(false); work.Cancellation.Token.ThrowIfCancellationRequested(); }
            catch (Exception failure) { if (image != null) image.Dispose(); image = null; error = failure; }
            lock (gate)
            {
                if (disposed) { if (image != null) image.Dispose(); work.Cancellation.Dispose(); return; }
                delivery = new Delivery { Work = work, Image = image, Error = error };
            }
        }
        void Tick(object sender, EventArgs e)
        {
            Delivery result; lock (gate) { result = delivery; delivery = null; }
            if (result != null)
            {
                var work = result.Work; bool valid = work.Epoch == epoch && work.Entry.Version == work.Version && !work.Cancellation.IsCancellationRequested;
                if (valid && result.Image != null)
                {
                    var patch = new SceneDetailPatch { Image = result.Image, Spec = work.Spec }; result.Image = null;
                    if (work.Entry.Patch != null) { Bytes -= work.Entry.Patch.Bytes; work.Entry.Patch.Dispose(); work.Entry.Patch = null; }
                    while (Bytes + patch.Bytes > budget && entries.Any(value => value.Value.Patch != null))
                    {
                        var oldest = entries.Where(value => value.Value.Patch != null).OrderBy(value => value.Value.Used).First().Value;
                        Bytes -= oldest.Patch.Bytes; oldest.Patch.Dispose(); oldest.Patch = null;
                    }
                    if (patch.Bytes <= budget) { work.Entry.Patch = patch; Bytes += patch.Bytes; } else patch.Dispose();
                    work.Entry.Wanted = null; work.Entry.Failed = null;
                }
                else if (valid) { work.Entry.Wanted = null; work.Entry.Failed = work.Spec; Error = result.Error == null ? "Dettaglio non disponibile." : result.Error.Message; }
                if (result.Image != null) result.Image.Dispose(); work.Cancellation.Dispose(); active = null; changed(valid && result.Error == null);
            }
            if (active == null && pending.Count > 0 && clock.ElapsedMilliseconds >= due)
            {
                active = pending.First().Value; pending.Remove(active.Key); active.Cancellation = new CancellationTokenSource(); Decode(active);
            }
            if (!IsBusy) timer.Stop();
        }
        public void Suspend()
        {
            pending.Clear(); foreach (var entry in entries.Values) { entry.Version++; entry.Wanted = null; }
            if (active != null) active.Cancellation.Cancel(); else timer.Stop();
        }
        public void Clear()
        {
            if (disposed) return;
            epoch++; Suspend(); foreach (var entry in entries.Values) if (entry.Patch != null) entry.Patch.Dispose(); entries.Clear(); Bytes = 0; Error = null;
        }
        public void Dispose()
        {
            if (disposed) return;
            Clear(); timer.Stop(); timer.Dispose();
            lock (gate) { disposed = true; if (delivery != null) { if (delivery.Image != null) delivery.Image.Dispose(); delivery.Work.Cancellation.Dispose(); delivery = null; } }
        }
    }
}
