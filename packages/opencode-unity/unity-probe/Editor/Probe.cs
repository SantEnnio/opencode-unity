// Records what the game does in Play mode and writes it, on stop, to
// Library/OpencodeUnity/probe/last-run.json. The opencode-unity plugin reads that file and reduces
// it to a few lines for the model: this side only records, it does not judge.
//
// Editor only. It adds nothing to the scene: a system is inserted into the player loop for the
// length of the run, and the only object it changes is Collider.providesContacts on the tracked
// objects, which Play mode reverts on stop.

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using Unity.Collections;
using UnityEditor;
using UnityEngine;
using UnityEngine.LowLevel;
#if OPENCODE_PROBE_INPUT
using UnityEngine.InputSystem;
using UnityEngine.InputSystem.Controls;
#endif

namespace OpencodeUnity.Probe
{
    [InitializeOnLoad]
    static class Probe
    {
        static Recorder current;
        static double nextPoll;
        static string refreshedFor;

        // The first frame (Awake, Start) runs before EnteredPlayMode reaches us, and an error there
        // pauses the game at once with Error Pause on. Logs are therefore caught from the moment
        // the scripts load for Play, and handed to the recorder when it starts.
        internal static readonly List<string[]> EarlyLogs = new List<string[]>();
        static bool catchingEarly;

        static void CatchEarly(string message, string stackTrace, LogType type)
        {
            lock (EarlyLogs) EarlyLogs.Add(new[] { message, stackTrace, ((int)type).ToString() });
        }

        internal static void StopCatchingEarly()
        {
            if (!catchingEarly) return;
            Application.logMessageReceivedThreaded -= CatchEarly;
            catchingEarly = false;
        }

        // Runs again after the domain reload that entering Play mode does, before EnteredPlayMode.
        static Probe()
        {
            EditorApplication.playModeStateChanged -= OnPlayModeChanged;
            EditorApplication.playModeStateChanged += OnPlayModeChanged;
            EditorApplication.update -= PollRequest;
            EditorApplication.update += PollRequest;
            if (EditorApplication.isPlayingOrWillChangePlaymode && !catchingEarly)
            {
                Application.logMessageReceivedThreaded += CatchEarly;
                catchingEarly = true;
            }
            // A test play that never ended (a crash, a killed Editor) must not leave the user's
            // Interaction Mode changed.
            if (!EditorApplication.isPlayingOrWillChangePlaymode && !File.Exists(AgentRun.RequestFile)) AgentRun.RestoreInteractionMode();
        }

        static void OnPlayModeChanged(PlayModeStateChange change)
        {
            try
            {
                if (change == PlayModeStateChange.EnteredPlayMode)
                {
                    current?.Stop();
                    current = new Recorder(AgentRun.Take());
                    current.Start();
                }
                else if (change == PlayModeStateChange.ExitingPlayMode && current != null)
                {
                    current.Stop();
                    current.Write();
                    current = null;
                }
                else if (change == PlayModeStateChange.EnteredEditMode)
                {
                    AgentRun.RestoreInteractionMode();
                }
            }
            catch (Exception error)
            {
                // Never break the user's Play button.
                Debug.LogWarning($"[opencode-unity probe] {error.Message}");
            }
        }

        // The plugin asks for a test play by writing a request file: no Pipeline package needed.
        static void PollRequest()
        {
            if (EditorApplication.timeSinceStartup < nextPoll) return;
            nextPoll = EditorApplication.timeSinceStartup + 0.5;
            try
            {
                // The user is playing: answer at once instead of letting the plugin wait for nothing.
                // Only once this domain's recorder exists, so the request that started it is not refused.
                if (EditorApplication.isPlaying)
                {
                    if (current != null && !current.ByAgent && AgentRun.Peek() is AgentRun busy) AgentRun.Refuse(busy.id, "playing");
                    return;
                }
                if (EditorApplication.isPlayingOrWillChangePlaymode || EditorApplication.isCompiling || EditorApplication.isUpdating) return;
                var request = AgentRun.Peek();
                if (request == null) return;
                // An Editor in the background does not import the scripts the model just changed:
                // the test would run the old code. Import once per request, and wait for the compile.
                if (refreshedFor != request.id)
                {
                    refreshedFor = request.id;
                    AssetDatabase.Refresh();
                    if (EditorApplication.isCompiling || EditorApplication.isUpdating) return;
                }
                // Unity refuses Play while scripts do not compile: say so instead of letting the plugin wait.
                if (EditorUtility.scriptCompilationFailed)
                {
                    AgentRun.Refuse(request.id, "compile");
                    return;
                }
                AgentRun.SetNoThrottling();
                EditorApplication.isPlaying = true;
            }
            catch (Exception error)
            {
                Debug.LogWarning($"[opencode-unity probe] {error.Message}");
            }
        }
    }

    /// <summary>One step of a key script: keys held together for a time, or a wait.</summary>
    [Serializable]
    sealed class Step
    {
        public string[] keys;
        public float hold;
        public float wait;
    }

    /// <summary>A test play asked for by the plugin: how long, which request it answers, which keys.</summary>
    [Serializable]
    sealed class AgentRun
    {
        public string id;
        public float seconds;
        public Step[] steps;
        public string script;

        const string PreviousModeKey = "OpencodeUnity.Probe.PreviousInteractionMode";
        const string InteractionModeKey = "InteractionMode";
        const int NoThrottling = 1;

        static string Dir => Path.Combine(Directory.GetParent(Application.dataPath).FullName, "Library", "OpencodeUnity", "probe");
        public static string RequestFile => Path.Combine(Dir, "request.json");

        [Serializable]
        sealed class Refusal
        {
            public string id;
            public string reason;
        }

        public static void Refuse(string id, string reason)
        {
            File.WriteAllText(Path.Combine(Dir, "refused.json"), JsonUtility.ToJson(new Refusal { id = id, reason = reason }));
            File.Delete(RequestFile);
        }

        /// <summary>The pending request, or null. Requests older than two minutes are dropped.</summary>
        public static AgentRun Peek()
        {
            if (!File.Exists(RequestFile)) return null;
            if ((DateTime.UtcNow - File.GetLastWriteTimeUtc(RequestFile)).TotalMinutes > 2)
            {
                File.Delete(RequestFile);
                return null;
            }
            var run = JsonUtility.FromJson<AgentRun>(File.ReadAllText(RequestFile));
            return run != null && !string.IsNullOrEmpty(run.id) ? run : null;
        }

        /// <summary>The request this Play answers, removed so it is answered once.</summary>
        public static AgentRun Take()
        {
            var run = Peek();
            if (run == null) return null;
            File.Delete(RequestFile);
            if (run.seconds <= 0 || run.seconds > 60) run.seconds = 5;
            // Started through the Pipeline package instead of by PollRequest: throttling is still on.
            SetNoThrottling();
            return run;
        }

        // Unity throttles an Editor in the background, and the game then barely advances. The mode
        // is a user preference for the whole Unity installation: changed for the test only.
        public static void SetNoThrottling()
        {
            if (!EditorPrefs.HasKey(PreviousModeKey)) EditorPrefs.SetInt(PreviousModeKey, EditorPrefs.GetInt(InteractionModeKey, 0));
            EditorPrefs.SetInt(InteractionModeKey, NoThrottling);
        }

        public static void RestoreInteractionMode()
        {
            if (!EditorPrefs.HasKey(PreviousModeKey)) return;
            EditorPrefs.SetInt(InteractionModeKey, EditorPrefs.GetInt(PreviousModeKey));
            EditorPrefs.DeleteKey(PreviousModeKey);
        }
    }

    sealed class Recorder
    {
        const float SampleInterval = 0.1f;
        const float RescanInterval = 1f;
        const int MaxObjects = 12;
        const int MaxSamples = 3000; // per object: 5 minutes at 10 Hz
        const int MaxLogEntries = 20;
        const int MaxContactPairs = 30;

        sealed class Tracked
        {
            public string path;
            public GameObject go;
            public Rigidbody body;
            public CharacterController controller;
            public bool dynamic;
            public float? spawned;
            public float? destroyed;
            public readonly List<float> samples = new List<float>(); // t, x, y, z, vx, vy, vz, active
            public Vector3 lastPosition;
            public float lastTime;
        }

        sealed class Count
        {
            public int count;
            public float first;
            public float held;
        }

        readonly Dictionary<GameObject, Tracked> tracked = new Dictionary<GameObject, Tracked>();
        readonly List<Tracked> order = new List<Tracked>();
        readonly Dictionary<string, Count> logs = new Dictionary<string, Count>();
        readonly Dictionary<string, string[]> logParts = new Dictionary<string, string[]>();
        readonly Dictionary<string, Count> contacts = new Dictionary<string, Count>();
        readonly Dictionary<string, Count> keys = new Dictionary<string, Count>();
        readonly Dictionary<string, Count> actions = new Dictionary<string, Count>();
        readonly object logLock = new object();
        readonly List<string> watch = new List<string>();

        readonly AgentRun agentRun;
#if OPENCODE_PROBE_INPUT
        InputScript input;
#endif
        PlayerLoopSystem originalLoop;
        double realStart;
        int frameStart;
        float lastSample = -1f;
        float lastScan = -1f;
        float unfocused;
        float pausedTime;
        float? pausedAt;
        double pauseStarted = -1;
        float? lowestStatic;
        volatile float now;
        bool running;

        static string ProbeDir => Path.Combine(Directory.GetParent(Application.dataPath).FullName, "Library", "OpencodeUnity", "probe");

        public bool ByAgent => agentRun != null;

        public Recorder(AgentRun agentRun)
        {
            this.agentRun = agentRun;
        }

        public void Start()
        {
            realStart = Time.realtimeSinceStartupAsDouble;
            frameStart = Time.frameCount;
            ReadWatchList();
            lowestStatic = LowestStaticCollider();
            Scan(0f);

            Application.logMessageReceivedThreaded += OnLog;
            Probe.StopCatchingEarly();
            lock (Probe.EarlyLogs)
            {
                foreach (var log in Probe.EarlyLogs) OnLog(log[0], log[1], (LogType)int.Parse(log[2]));
                Probe.EarlyLogs.Clear();
            }
            Physics.ContactEvent += OnContacts;
            EditorApplication.pauseStateChanged += OnPause;
            // Already paused by an error in the first frame: the pause event came before us.
            if (EditorApplication.isPaused) OnPause(PauseState.Paused);
#if OPENCODE_PROBE_INPUT
            InputSystem.onActionChange += OnActionChange;
            if (agentRun?.steps != null && agentRun.steps.Length > 0)
            {
                input = new InputScript(agentRun.steps);
                input.Begin();
            }
#endif
            originalLoop = PlayerLoop.GetCurrentPlayerLoop();
            var loop = originalLoop;
            var systems = new List<PlayerLoopSystem>(loop.subSystemList);
            // After everything else in the frame: positions are final for this frame.
            systems.Add(new PlayerLoopSystem { type = typeof(Recorder), updateDelegate = Tick });
            loop.subSystemList = systems.ToArray();
            PlayerLoop.SetPlayerLoop(loop);
            // The Editor update keeps running while the game is paused (Error Pause), the player loop does not.
            if (agentRun != null) EditorApplication.update += StopWhenDone;
            running = true;
        }

        public void Stop()
        {
            if (!running) return;
            running = false;
            PlayerLoop.SetPlayerLoop(originalLoop);
            EditorApplication.update -= StopWhenDone;
            Application.logMessageReceivedThreaded -= OnLog;
            Physics.ContactEvent -= OnContacts;
            EditorApplication.pauseStateChanged -= OnPause;
            if (pauseStarted >= 0) pausedTime += (float)(Time.realtimeSinceStartupAsDouble - pauseStarted);
#if OPENCODE_PROBE_INPUT
            InputSystem.onActionChange -= OnActionChange;
            input?.End();
            input = null;
#endif
            Sample(Time.time, force: true);
        }

        void StopWhenDone()
        {
            if (running && Time.realtimeSinceStartupAsDouble - realStart >= agentRun.seconds) EditorApplication.isPlaying = false;
        }

        void Tick()
        {
            if (!Application.isPlaying) return;
            var t = Time.time;
            now = t;
            if (!Application.isFocused) unfocused += Time.unscaledDeltaTime;
#if OPENCODE_PROBE_INPUT
            input?.Update(Time.realtimeSinceStartupAsDouble - realStart);
#endif
            ReadInput(t);
            if (t - lastScan >= RescanInterval) Scan(t);
            if (t - lastSample >= SampleInterval) Sample(t, force: false);
        }

        // Paused by the user, or by the Console's Error Pause on the first exception: the game time
        // stops, and a report that does not say so looks like a game that ran for one second.
        void OnPause(PauseState state)
        {
            if (state == PauseState.Paused)
            {
                pauseStarted = Time.realtimeSinceStartupAsDouble;
                if (pausedAt == null) pausedAt = Time.time;
            }
            else if (pauseStarted >= 0)
            {
                pausedTime += (float)(Time.realtimeSinceStartupAsDouble - pauseStarted);
                pauseStarted = -1;
            }
        }

        void ReadWatchList()
        {
            var file = Path.Combine(ProbeDir, "watch.json");
            if (!File.Exists(file)) return;
            foreach (Match m in Regex.Matches(File.ReadAllText(file), "\"(/[^\"]+)\""))
                watch.Add(Regex.Unescape(m.Groups[1].Value));
        }

        static float? LowestStaticCollider()
        {
            float? lowest = null;
            foreach (var collider in UnityEngine.Object.FindObjectsByType<Collider>(FindObjectsSortMode.None))
            {
                if (collider.attachedRigidbody != null || collider.isTrigger) continue;
                var y = collider.bounds.min.y;
                if (lowest == null || y < lowest) lowest = y;
            }
            return lowest;
        }

        // What the model touched first, then whatever moves by physics or by a character controller.
        void Scan(float t)
        {
            lastScan = t;
            foreach (var path in watch)
            {
                var go = GameObject.Find(path);
                if (go != null) Track(go, t);
            }
            foreach (var body in UnityEngine.Object.FindObjectsByType<Rigidbody>(FindObjectsSortMode.None)) Track(body.gameObject, t);
            foreach (var controller in UnityEngine.Object.FindObjectsByType<CharacterController>(FindObjectsSortMode.None)) Track(controller.gameObject, t);
        }

        void Track(GameObject go, float t)
        {
            if (tracked.Count >= MaxObjects || tracked.ContainsKey(go)) return;
            var item = new Tracked
            {
                path = PathOf(go.transform),
                go = go,
                body = go.GetComponent<Rigidbody>(),
                controller = go.GetComponent<CharacterController>(),
                spawned = t > 0f ? t : (float?)null,
                lastPosition = go.transform.position,
                lastTime = t,
            };
            item.dynamic = item.controller != null || (item.body != null && !item.body.isKinematic);
            foreach (var collider in go.GetComponentsInChildren<Collider>()) collider.providesContacts = true;
            tracked[go] = item;
            order.Add(item);
        }

        void Sample(float t, bool force)
        {
            lastSample = t;
            foreach (var item in order)
            {
                if (item.destroyed != null) continue;
                if (item.go == null)
                {
                    item.destroyed = t;
                    continue;
                }
                if (item.samples.Count >= MaxSamples * 8 && !force) continue;
                var p = item.go.transform.position;
                Vector3 v;
                if (item.body != null) v = item.body.linearVelocity;
                else if (item.controller != null) v = item.controller.velocity;
                else v = t > item.lastTime ? (p - item.lastPosition) / (t - item.lastTime) : Vector3.zero;
                item.lastPosition = p;
                item.lastTime = t;
                item.samples.AddRange(new[] { t, p.x, p.y, p.z, v.x, v.y, v.z, item.go.activeInHierarchy ? 1f : 0f });
            }
        }

        void ReadInput(float t)
        {
#if OPENCODE_PROBE_INPUT
            // Keys already down when Play starts (the Cmd/Ctrl+P that started it, a stale state) are
            // not the player's input, and neither is anything typed while Unity is in the background.
            if (Time.frameCount - frameStart < 3 || (!Application.isFocused && input == null)) return;
            var keyboard = Keyboard.current;
            if (keyboard != null)
            {
                foreach (var key in keyboard.allKeys)
                {
                    if (key == null) continue;
                    if (key.wasPressedThisFrame) Bump(keys, key.displayName ?? key.name, t);
                    if (key.isPressed && keys.TryGetValue(key.displayName ?? key.name, out var held)) held.held += Time.unscaledDeltaTime;
                }
            }
            var mouse = Mouse.current;
            if (mouse != null)
            {
                if (mouse.leftButton.wasPressedThisFrame) Bump(keys, "Mouse left", t);
                if (mouse.rightButton.wasPressedThisFrame) Bump(keys, "Mouse right", t);
            }
            var gamepad = Gamepad.current;
            if (gamepad != null)
            {
                foreach (var control in gamepad.allControls)
                    if (control is ButtonControl button && button.wasPressedThisFrame) Bump(keys, $"Gamepad {button.displayName}", t);
            }
#endif
        }

#if OPENCODE_PROBE_INPUT
        void OnActionChange(object item, InputActionChange change)
        {
            if (change != InputActionChange.ActionPerformed || !(item is InputAction action)) return;
            var name = action.actionMap != null ? $"{action.actionMap.name}/{action.name}" : action.name;
            Bump(actions, name, now);
        }
#endif

        static Count Bump(Dictionary<string, Count> into, string key, float t)
        {
            if (!into.TryGetValue(key, out var entry)) into[key] = entry = new Count { first = t };
            entry.count++;
            return entry;
        }

        // May run on any thread: only touches its own locked collections and the cached time.
        void OnLog(string message, string stackTrace, LogType type)
        {
            if (type != LogType.Exception && type != LogType.Error && type != LogType.Assert) return;
            var firstLine = (message ?? "").Split('\n')[0].Trim();
            if (firstLine.StartsWith("[opencode-unity probe]")) return;
            var kind = type == LogType.Exception ? firstLine.Split(':')[0].Trim() : type.ToString();
            // The first frame in the project's own code: the line the model can fix. Unity's and
            // .NET's own frames come first when the error is raised inside the engine.
            var where = "";
            foreach (var line in (stackTrace ?? "").Split('\n'))
            {
                var trimmed = line.Trim();
                if (trimmed.Length == 0) continue;
                var engine = trimmed.StartsWith("UnityEngine.") || trimmed.StartsWith("UnityEditor.") || trimmed.StartsWith("System.") || trimmed.StartsWith("Unity.");
                if (where.Length == 0 && !trimmed.StartsWith("UnityEngine.Debug")) where = trimmed;
                if (!engine)
                {
                    where = trimmed;
                    break;
                }
            }
            if (firstLine.Length > 200) firstLine = firstLine.Substring(0, 200);
            var key = $"{kind}|{firstLine}|{where}";
            lock (logLock)
            {
                if (!logs.ContainsKey(key) && logs.Count >= MaxLogEntries) return;
                Bump(logs, key, now);
                logParts[key] = new[] { kind, firstLine, where };
            }
        }

        void OnContacts(PhysicsScene scene, NativeArray<ContactPairHeader>.ReadOnly headers)
        {
            for (var i = 0; i < headers.Length; i++)
            {
                var header = headers[i];
                for (var j = 0; j < header.pairCount; j++)
                {
                    ref readonly var pair = ref header.GetContactPair(j);
                    if (!pair.isCollisionEnter || pair.collider == null || pair.otherCollider == null) continue;
                    var a = PathOf(pair.collider.transform);
                    var b = PathOf(pair.otherCollider.transform);
                    var key = string.CompareOrdinal(a, b) <= 0 ? $"{a}|{b}" : $"{b}|{a}";
                    if (!contacts.ContainsKey(key) && contacts.Count >= MaxContactPairs) continue;
                    Bump(contacts, key, now);
                }
            }
        }

        static string PathOf(Transform transform)
        {
            var path = "/" + transform.name;
            for (var parent = transform.parent; parent != null; parent = parent.parent) path = "/" + parent.name + path;
            return path;
        }

        public void Write()
        {
            var json = new StringBuilder(4096);
            json.Append("{\"version\":1");
            json.Append(",\"id\":\"").Append(DateTime.UtcNow.Ticks).Append('"');
            json.Append(",\"startedBy\":").Append(Str(agentRun != null ? "agent" : "user"));
            json.Append(",\"requestId\":").Append(agentRun != null ? Str(agentRun.id) : "null");
            json.Append(",\"input\":").Append(agentRun != null && !string.IsNullOrEmpty(agentRun.script) ? Str(agentRun.script) : "null");
            json.Append(",\"endedAt\":\"").Append(DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture)).Append('"');
            json.Append(",\"unity\":").Append(Str(Application.unityVersion));
            json.Append(",\"scene\":").Append(Str(UnityEngine.SceneManagement.SceneManager.GetActiveScene().path));
            json.Append(",\"gameTime\":").Append(Num(Time.time));
            json.Append(",\"realTime\":").Append(Num((float)(Time.realtimeSinceStartupAsDouble - realStart)));
            json.Append(",\"frames\":").Append(Time.frameCount - frameStart);
            json.Append(",\"unfocusedTime\":").Append(Num(unfocused));
            json.Append(",\"pausedTime\":").Append(Num(pausedTime));
            json.Append(",\"pausedAt\":").Append(pausedAt.HasValue ? Num(pausedAt.Value) : "null");
            json.Append(",\"lowestStatic\":").Append(lowestStatic.HasValue ? Num(lowestStatic.Value) : "null");
#if OPENCODE_PROBE_INPUT
            json.Append(",\"inputSystem\":true");
#else
            json.Append(",\"inputSystem\":false");
#endif

            json.Append(",\"logs\":[");
            lock (logLock)
            {
                var first = true;
                foreach (var entry in logs)
                {
                    var parts = logParts[entry.Key];
                    if (!first) json.Append(',');
                    first = false;
                    json.Append("{\"kind\":").Append(Str(parts[0])).Append(",\"message\":").Append(Str(parts[1])).Append(",\"where\":").Append(Str(parts[2]));
                    json.Append(",\"count\":").Append(entry.Value.count).Append(",\"first\":").Append(Num(entry.Value.first)).Append('}');
                }
            }
            json.Append(']');

            json.Append(",\"objects\":[");
            for (var i = 0; i < order.Count; i++)
            {
                var item = order[i];
                if (i > 0) json.Append(',');
                json.Append("{\"path\":").Append(Str(item.path));
                json.Append(",\"body\":").Append(Str(item.controller != null ? "CharacterController" : item.body != null ? "Rigidbody" : "none"));
                json.Append(",\"dynamic\":").Append(item.dynamic ? "true" : "false");
                json.Append(",\"spawned\":").Append(item.spawned.HasValue ? Num(item.spawned.Value) : "null");
                json.Append(",\"destroyed\":").Append(item.destroyed.HasValue ? Num(item.destroyed.Value) : "null");
                json.Append(",\"samples\":[");
                for (var s = 0; s + 7 < item.samples.Count; s += 8)
                {
                    if (s > 0) json.Append(',');
                    json.Append('[');
                    for (var k = 0; k < 8; k++)
                    {
                        if (k > 0) json.Append(',');
                        json.Append(Num(item.samples[s + k]));
                    }
                    json.Append(']');
                }
                json.Append("]}");
            }
            json.Append(']');

            json.Append(",\"contacts\":[");
            var firstContact = true;
            foreach (var entry in contacts)
            {
                var pair = entry.Key.Split('|');
                if (!firstContact) json.Append(',');
                firstContact = false;
                json.Append("{\"a\":").Append(Str(pair[0])).Append(",\"b\":").Append(Str(pair[1]));
                json.Append(",\"count\":").Append(entry.Value.count).Append(",\"first\":").Append(Num(entry.Value.first)).Append('}');
            }
            json.Append(']');

            AppendCounts(json, "keys", "key", keys, withHeld: true);
            AppendCounts(json, "actions", "action", actions, withHeld: false);
            json.Append('}');

            Directory.CreateDirectory(ProbeDir);
            var file = Path.Combine(ProbeDir, "last-run.json");
            var temp = file + ".tmp";
            File.WriteAllText(temp, json.ToString(), new UTF8Encoding(false));
            if (File.Exists(file)) File.Delete(file);
            File.Move(temp, file);
        }

        static void AppendCounts(StringBuilder json, string field, string name, Dictionary<string, Count> counts, bool withHeld)
        {
            json.Append(",\"").Append(field).Append("\":[");
            var first = true;
            foreach (var entry in counts)
            {
                if (!first) json.Append(',');
                first = false;
                json.Append("{\"").Append(name).Append("\":").Append(Str(entry.Key));
                json.Append(",\"count\":").Append(entry.Value.count).Append(",\"first\":").Append(Num(entry.Value.first));
                if (withHeld) json.Append(",\"held\":").Append(Num(entry.Value.held));
                json.Append('}');
            }
            json.Append(']');
        }

        static string Num(float value)
        {
            if (float.IsNaN(value) || float.IsInfinity(value)) return "null";
            return Math.Round(value, 3).ToString("0.###", CultureInfo.InvariantCulture);
        }

        static string Str(string value)
        {
            var text = new StringBuilder("\"");
            foreach (var c in value ?? "")
            {
                if (c == '"' || c == '\\') text.Append('\\').Append(c);
                else if (c < ' ') text.Append("\\u").Append(((int)c).ToString("x4"));
                else text.Append(c);
            }
            return text.Append('"').ToString();
        }
    }
}
