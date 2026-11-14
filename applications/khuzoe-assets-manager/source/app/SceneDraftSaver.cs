using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;

namespace KhuzoeAssetsManager
{
    internal sealed class SceneDraftSaveResult
    {
        public string Key; public long Revision; public Exception Error;
    }
    // Queue immutable committed snapshots. The writer never reads the scene being edited on the UI thread.
    internal sealed class SceneDraftSaver : IDisposable
    {
        sealed class Work { public string Key, OriginalHash, Snapshot; public bool Dirty; public long Revision; }
        readonly object gate = new object();
        readonly Dictionary<string, Work> pending = new Dictionary<string, Work>();
        readonly Dictionary<string, Work> latest = new Dictionary<string, Work>();
        readonly Dictionary<string, SceneDraftSaveResult> results = new Dictionary<string, SceneDraftSaveResult>();
        readonly Action<string, string, string, bool> save;
        Task worker = Task.FromResult(true);
        long revision;
        bool running, disposed;
        public event Action<SceneDraftSaveResult> Completed;
        public SceneDraftSaver(SceneDraftStore store) : this(store.SaveSnapshot) { }
        internal SceneDraftSaver(Action<string, string, string, bool> save) { this.save = save; }
        public long Queue(string key, SceneDraft draft)
        {
            lock (gate)
            {
                if (disposed) throw new ObjectDisposedException("SceneDraftSaver");
                var work = new Work { Key = key, Revision = ++revision, OriginalHash = draft.OriginalHash, Snapshot = draft.CommittedSnapshot, Dirty = draft.IsDirty };
                pending[key] = work; latest[key] = work; results.Remove(key);
                if (!running) { running = true; worker = Task.Run((Action)Run); }
                return work.Revision;
            }
        }
        void Run()
        {
            while (true)
            {
                Work work;
                lock (gate) { if (pending.Count == 0) { running = false; return; } work = pending.First().Value; pending.Remove(work.Key); }
                var result = new SceneDraftSaveResult { Key = work.Key, Revision = work.Revision };
                try { save(work.Key, work.OriginalHash, work.Snapshot, work.Dirty); } catch (Exception error) { result.Error = error; }
                lock (gate)
                {
                    if (latest[work.Key].Revision == work.Revision) { latest.Remove(work.Key); results[work.Key] = result; }
                }
                var completed = Completed; if (completed != null) completed(result);
            }
        }
        public long PendingRevision(string key) { lock (gate) { Work value; return latest.TryGetValue(key, out value) ? value.Revision : 0; } }
        public bool RestorePending(string key, SceneDraft draft)
        {
            Work work; lock (gate) { if (!latest.TryGetValue(key, out work) || work.OriginalHash != draft.OriginalHash) return false; }
            draft.RestoreSnapshot(work.Snapshot); return true;
        }
        public Exception LastError(string key) { lock (gate) { SceneDraftSaveResult value; return results.TryGetValue(key, out value) ? value.Error : null; } }
        public Task FlushAsync() { lock (gate) return worker; }
        public void Dispose() { Task flush; lock (gate) { disposed = true; flush = worker; } flush.GetAwaiter().GetResult(); }
    }
}
