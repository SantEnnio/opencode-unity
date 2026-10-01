// Keys pressed during a test play, on a virtual keyboard the probe adds for the run and removes
// after it. Input Actions bound to <Keyboard> listen to every keyboard, and the virtual one is made
// Keyboard.current, so scripts that read the keyboard directly see it too.

#if OPENCODE_PROBE_INPUT
using System;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.InputSystem;
using UnityEngine.InputSystem.LowLevel;

namespace OpencodeUnity.Probe
{
    sealed class InputScript
    {
        const double StartDelay = 0.5; // let Start/Awake run before the first key
        const double Gap = 0.1; // between two steps, so the same key pressed twice is two presses

        struct Change
        {
            public double at;
            public Key key;
            public bool down;
        }

        readonly List<Change> changes = new List<Change>();
        readonly HashSet<Key> held = new HashSet<Key>();
        int next;
        Keyboard device;
        InputSettings original;

        public InputScript(Step[] steps)
        {
            var t = StartDelay;
            foreach (var step in steps)
            {
                if (step.keys == null || step.keys.Length == 0)
                {
                    t += Math.Max(0, step.wait);
                    continue;
                }
                var hold = Math.Max(0.05, step.hold);
                foreach (var name in step.keys)
                {
                    if (!Enum.TryParse(name, true, out Key key) || key == Key.None) continue;
                    changes.Add(new Change { at = t, key = key, down = true });
                    changes.Add(new Change { at = t + hold, key = key, down = false });
                }
                t += hold + Gap;
            }
            changes.Sort((a, b) => a.at.CompareTo(b.at));
        }

        public void Begin()
        {
            // By default the Editor gives the keyboard to the game only while the Game view has focus,
            // and drops input when Unity is in the background. A copy of the settings changes that for
            // this run only: the project's own settings asset is never touched.
            original = InputSystem.settings;
            var temporary = ScriptableObject.Instantiate(original);
            temporary.backgroundBehavior = InputSettings.BackgroundBehavior.IgnoreFocus;
            temporary.editorInputBehaviorInPlayMode = InputSettings.EditorInputBehaviorInPlayMode.AllDeviceInputAlwaysGoesToGameView;
            InputSystem.settings = temporary;

            device = InputSystem.AddDevice<Keyboard>("OpencodeUnity Keyboard");
            device.MakeCurrent();
        }

        /// <summary>Applies every key change due by <paramref name="elapsed"/> real seconds.</summary>
        public void Update(double elapsed)
        {
            if (device == null) return;
            var changed = false;
            while (next < changes.Count && changes[next].at <= elapsed)
            {
                var change = changes[next++];
                if (change.down) held.Add(change.key);
                else held.Remove(change.key);
                changed = true;
            }
            if (!changed) return;
            var pressed = new Key[held.Count];
            held.CopyTo(pressed);
            InputSystem.QueueStateEvent(device, new KeyboardState(pressed));
        }

        public void End()
        {
            if (device != null)
            {
                if (held.Count > 0) InputSystem.QueueStateEvent(device, new KeyboardState());
                InputSystem.RemoveDevice(device);
                device = null;
            }
            if (original != null)
            {
                var temporary = InputSystem.settings;
                InputSystem.settings = original;
                if (temporary != original) UnityEngine.Object.DestroyImmediate(temporary);
                original = null;
            }
        }
    }
}
#endif
