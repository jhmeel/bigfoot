// Bigfoot input helper.
//
// A tiny long-lived process that performs mouse/keyboard input with SendInput and reports
// global key state (for hold-to-talk and the Esc stop key). Talks to the Electron main process
// over stdin/stdout with a line protocol:
//
//   request:  <id>|<command>|<arg>|<arg>...      (text arguments are base64 UTF-8)
//   reply:    <id>|ok|<result>   or   <id>|err|<message>
//   event:    !|keys|<ctrl>,<alt>,<shift>,<win>   (sent whenever modifier state changes)
//             !|esc                                (physical Esc press, not injected by us)
//
//             !|wake|<confidence>                 (the assistant's name was heard)
//             !|dblclick|<x>,<y>                  (physical double-click on empty desktop space)
//
// Build (csc.exe ships with Windows in C:\Windows\Microsoft.NET\Framework64\v4.0.30319):
//   csc -nologo -optimize -target:exe -lib:%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\WPF
//       -r:System.Speech.dll -r:UIAutomationClient.dll -r:UIAutomationTypes.dll -r:WindowsBase.dll
//       -out:input-helper.exe InputHelper.cs

using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Speech.Recognition;
using System.Text;
using System.Threading;
using System.Windows.Automation;

/// <summary>
/// Reports real double-clicks on empty desktop space. The "empty" check runs off the hook thread
/// so the mouse never lags.
/// </summary>
internal static class DesktopClicks
{
    [StructLayout(LayoutKind.Sequential)]
    struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    struct MSLLHOOKSTRUCT { public POINT pt; public uint mouseData; public uint flags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public POINT pt; }

    delegate IntPtr HookProc(int code, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetWindowsHookEx(int id, HookProc proc, IntPtr mod, uint thread);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] static extern int GetMessage(out MSG msg, IntPtr hwnd, uint min, uint max);
    [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string name);
    [DllImport("user32.dll")] static extern uint GetDoubleClickTime();
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);

    const int WH_MOUSE_LL = 14;
    const int WM_LBUTTONDOWN = 0x0201;
    const uint LLMHF_INJECTED = 0x1;
    const uint GA_ROOT = 2;

    static HookProc proc; // must stay referenced or the GC collects the hook
    static volatile bool enabled;
    static uint lastTime;
    static POINT lastPt;
    static bool haveLast;

    public static void SetEnabled(bool on) { enabled = on; }

    public static void Start()
    {
        Thread t = new Thread(() =>
        {
            proc = Hook;
            IntPtr hook = SetWindowsHookEx(WH_MOUSE_LL, proc, GetModuleHandle(null), 0);
            if (hook == IntPtr.Zero) return;
            MSG msg;
            while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) { }
        });
        t.IsBackground = true;
        t.Start();
    }

    static IntPtr Hook(int code, IntPtr wParam, IntPtr lParam)
    {
        if (code >= 0 && enabled && (int)wParam == WM_LBUTTONDOWN)
        {
            MSLLHOOKSTRUCT m = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT));
            if ((m.flags & LLMHF_INJECTED) == 0)
            {
                bool quick = haveLast && unchecked(m.time - lastTime) <= GetDoubleClickTime();
                bool near = Math.Abs(m.pt.X - lastPt.X) <= GetSystemMetrics(36) && Math.Abs(m.pt.Y - lastPt.Y) <= GetSystemMetrics(37);
                if (quick && near)
                {
                    haveLast = false;
                    POINT p = m.pt;
                    ThreadPool.QueueUserWorkItem(_ => { if (IsEmptyDesktop(p)) InputHelper.Emit("!|dblclick|" + p.X + "," + p.Y); });
                }
                else
                {
                    haveLast = true;
                    lastTime = m.time;
                    lastPt = m.pt;
                }
            }
        }
        return CallNextHookEx(IntPtr.Zero, code, wParam, lParam);
    }

    static string ClassOf(IntPtr h)
    {
        StringBuilder sb = new StringBuilder(64);
        GetClassName(h, sb, sb.Capacity);
        return sb.ToString();
    }

    static bool IsEmptyDesktop(POINT p)
    {
        try
        {
            IntPtr hwnd = WindowFromPoint(p);
            string root = ClassOf(GetAncestor(hwnd, GA_ROOT));
            if (root != "Progman" && root != "WorkerW") return false;
            AutomationElement el = AutomationElement.FromPoint(new System.Windows.Point(p.X, p.Y));
            TreeWalker walker = TreeWalker.ControlViewWalker;
            for (int depth = 0; el != null && depth < 4; depth++)
            {
                ControlType type = el.Current.ControlType;
                if (type == ControlType.ListItem || type == ControlType.Button || type == ControlType.Edit) return false;
                if (type == ControlType.List || type == ControlType.Pane || type == ControlType.Window) return true;
                el = walker.GetParent(el);
            }
            return true;
        }
        catch
        {
            return false;
        }
    }
}

/// <summary>
/// Offline speech through the Windows recognizer: wake-word spotting and a local transcription
/// fallback for when no cloud speech-to-text key is configured.
/// </summary>
internal static class Speech
{
    const float WakeConfidence = 0.72f;
    static SpeechRecognitionEngine wake;
    static readonly object Gate = new object();

    public static string StartWake(string namesCsv)
    {
        lock (Gate)
        {
            StopWakeLocked();
            List<string> phrases = new List<string>();
            foreach (string raw in namesCsv.Split(','))
            {
                string name = raw.Trim();
                if (name.Length == 0) continue;
                phrases.Add("hey " + name);
                phrases.Add("hi " + name);
                phrases.Add("okay " + name);
                phrases.Add(name);
            }
            if (phrases.Count == 0) throw new ArgumentException("no wake name");

            SpeechRecognitionEngine engine;
            try { engine = new SpeechRecognitionEngine(new System.Globalization.CultureInfo("en-US")); }
            catch { engine = new SpeechRecognitionEngine(); }

            Grammar wakeGrammar = new Grammar(new GrammarBuilder(new Choices(phrases.ToArray())));
            wakeGrammar.Name = "wake";
            // A catch-all competitor so ordinary speech doesn't get forced onto the wake phrases.
            GrammarBuilder anything = new GrammarBuilder();
            anything.AppendWildcard();
            Grammar garbage = new Grammar(anything);
            garbage.Name = "garbage";
            engine.LoadGrammar(wakeGrammar);
            engine.LoadGrammar(garbage);
            engine.SetInputToDefaultAudioDevice();
            engine.SpeechRecognized += (s, e) =>
            {
                if (e.Result.Grammar.Name == "wake" && e.Result.Confidence >= WakeConfidence)
                    InputHelper.Emit("!|wake|" + e.Result.Confidence.ToString("0.00", System.Globalization.CultureInfo.InvariantCulture));
            };
            engine.RecognizeAsync(RecognizeMode.Multiple);
            wake = engine;
            return engine.RecognizerInfo.Culture.Name;
        }
    }

    public static void StopWake() { lock (Gate) StopWakeLocked(); }

    static void StopWakeLocked()
    {
        if (wake == null) return;
        try { wake.RecognizeAsyncCancel(); } catch { }
        try { wake.Dispose(); } catch { }
        wake = null;
    }

    public static string TranscribeWav(string path)
    {
        using (SpeechRecognitionEngine engine = new SpeechRecognitionEngine())
        using (ManualResetEvent done = new ManualResetEvent(false))
        {
            engine.LoadGrammar(new DictationGrammar());
            engine.SetInputToWaveFile(path);
            StringBuilder text = new StringBuilder();
            Exception failure = null;
            engine.SpeechRecognized += (s, e) =>
            {
                if (text.Length > 0) text.Append(' ');
                text.Append(e.Result.Text);
            };
            // Completes when the file runs out of audio.
            engine.RecognizeCompleted += (s, e) => { failure = e.Error; done.Set(); };
            engine.RecognizeAsync(RecognizeMode.Multiple);
            if (!done.WaitOne(TimeSpan.FromSeconds(60))) engine.RecognizeAsyncCancel();
            if (failure != null && text.Length == 0) throw failure;
            return text.ToString();
        }
    }
}

internal static class InputHelper
{
    // ------------------------------------------------------------------ Win32
    [StructLayout(LayoutKind.Sequential)]
    struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    struct MOUSEINPUT { public int dx; public int dy; public int mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Explicit)]
    struct INPUTUNION
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct INPUT { public uint type; public INPUTUNION u; }

    const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
    const uint MOUSEEVENTF_LEFTDOWN = 0x0002, MOUSEEVENTF_LEFTUP = 0x0004;
    const uint MOUSEEVENTF_RIGHTDOWN = 0x0008, MOUSEEVENTF_RIGHTUP = 0x0010;
    const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020, MOUSEEVENTF_MIDDLEUP = 0x0040;
    const uint MOUSEEVENTF_WHEEL = 0x0800, MOUSEEVENTF_HWHEEL = 0x1000;
    const uint KEYEVENTF_EXTENDEDKEY = 0x0001, KEYEVENTF_KEYUP = 0x0002, KEYEVENTF_UNICODE = 0x0004;
    static readonly IntPtr INJECTED_TAG = new IntPtr(0x42554459); // "BUDY", marks our own input

    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);

    static readonly object OutLock = new object();
    static long lastInjectTicks;

    // ------------------------------------------------------------------ entry
    [STAThread]
    static int Main()
    {
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } // per-monitor v2: coordinates are physical pixels
        catch { try { SetProcessDPIAware(); } catch { } }

        Console.InputEncoding = Encoding.UTF8;
        Console.OutputEncoding = new UTF8Encoding(false);

        Thread watcher = new Thread(WatchKeys);
        watcher.IsBackground = true;
        watcher.Start();
        DesktopClicks.Start();

        Emit("!|ready");
        string line;
        while ((line = Console.In.ReadLine()) != null)
        {
            if (line.Length == 0) continue;
            string[] parts = line.Split('|');
            string id = parts[0];
            try
            {
                string result = Handle(parts);
                Emit(id + "|ok|" + (result ?? ""));
            }
            catch (Exception ex)
            {
                Emit(id + "|err|" + ex.Message.Replace('|', '/').Replace('\n', ' ').Replace('\r', ' '));
            }
        }
        return 0;
    }

    internal static void Emit(string s)
    {
        lock (OutLock)
        {
            Console.Out.WriteLine(s);
            Console.Out.Flush();
        }
    }

    static string Arg(string[] p, int i) { if (p.Length <= i) throw new ArgumentException("missing argument " + i); return p[i]; }
    static int IntArg(string[] p, int i) { return int.Parse(Arg(p, i)); }
    static string TextArg(string[] p, int i) { return Encoding.UTF8.GetString(Convert.FromBase64String(Arg(p, i))); }

    static string Handle(string[] p)
    {
        string cmd = Arg(p, 1);
        switch (cmd)
        {
            case "ping": return "pong";
            case "move": MoveTo(IntArg(p, 2), IntArg(p, 3)); return null;
            case "click": Click(Arg(p, 2), IntArg(p, 3)); return null;
            case "down": Button(Arg(p, 2), true); return null;
            case "up": Button(Arg(p, 2), false); return null;
            case "scroll": Scroll(IntArg(p, 2), IntArg(p, 3)); return null;
            case "keys": KeyCombo(Arg(p, 2), p.Length > 3 ? IntArg(p, 3) : 1); return null;
            case "keydown": KeysUpDown(Arg(p, 2), true); return null;
            case "keyup": KeysUpDown(Arg(p, 2), false); return null;
            case "type": TypeText(TextArg(p, 2)); return null;
            case "pos":
                {
                    POINT pt;
                    GetCursorPos(out pt);
                    return pt.X + "," + pt.Y;
                }
            case "wake": return Speech.StartWake(TextArg(p, 2));
            case "wake-off": Speech.StopWake(); return null;
            case "dblclick": DesktopClicks.SetEnabled(Arg(p, 2) == "1"); return null;
            case "transcribe": return Convert.ToBase64String(Encoding.UTF8.GetBytes(Speech.TranscribeWav(TextArg(p, 2))));
            case "title":
                {
                    IntPtr h = GetForegroundWindow();
                    int len = GetWindowTextLength(h);
                    StringBuilder sb = new StringBuilder(len + 1);
                    GetWindowText(h, sb, sb.Capacity);
                    return Convert.ToBase64String(Encoding.UTF8.GetBytes(sb.ToString()));
                }
            default: throw new ArgumentException("unknown command " + cmd);
        }
    }

    // ------------------------------------------------------------------ mouse
    static INPUT Mouse(uint flags, int data)
    {
        INPUT i = new INPUT();
        i.type = INPUT_MOUSE;
        i.u.mi.dwFlags = flags;
        i.u.mi.mouseData = data;
        i.u.mi.dwExtraInfo = INJECTED_TAG;
        return i;
    }

    static void Send(List<INPUT> inputs)
    {
        Interlocked.Exchange(ref lastInjectTicks, DateTime.UtcNow.Ticks);
        INPUT[] arr = inputs.ToArray();
        uint sent = SendInput((uint)arr.Length, arr, Marshal.SizeOf(typeof(INPUT)));
        if (sent != arr.Length)
            throw new InvalidOperationException("Windows blocked the input (error " + Marshal.GetLastWin32Error() + "). An elevated window may be focused.");
    }

    static void MoveTo(int x, int y)
    {
        if (!SetCursorPos(x, y)) throw new InvalidOperationException("SetCursorPos failed");
    }

    static void ButtonFlags(string button, out uint down, out uint up)
    {
        switch (button)
        {
            case "left": down = MOUSEEVENTF_LEFTDOWN; up = MOUSEEVENTF_LEFTUP; break;
            case "right": down = MOUSEEVENTF_RIGHTDOWN; up = MOUSEEVENTF_RIGHTUP; break;
            case "middle": down = MOUSEEVENTF_MIDDLEDOWN; up = MOUSEEVENTF_MIDDLEUP; break;
            default: throw new ArgumentException("unknown button " + button);
        }
    }

    static void Click(string button, int count)
    {
        uint down, up;
        ButtonFlags(button, out down, out up);
        for (int c = 0; c < Math.Max(1, Math.Min(count, 3)); c++)
        {
            List<INPUT> l = new List<INPUT>();
            l.Add(Mouse(down, 0));
            l.Add(Mouse(up, 0));
            Send(l);
            if (c + 1 < count) Thread.Sleep(60);
        }
    }

    static void Button(string button, bool press)
    {
        uint down, up;
        ButtonFlags(button, out down, out up);
        List<INPUT> l = new List<INPUT>();
        l.Add(Mouse(press ? down : up, 0));
        Send(l);
    }

    static void Scroll(int dx, int dy)
    {
        List<INPUT> l = new List<INPUT>();
        if (dy != 0) l.Add(Mouse(MOUSEEVENTF_WHEEL, dy * 120));
        if (dx != 0) l.Add(Mouse(MOUSEEVENTF_HWHEEL, dx * 120));
        if (l.Count > 0) Send(l);
    }

    // ------------------------------------------------------------------ keyboard
    static readonly HashSet<int> ExtendedKeys = new HashSet<int>(new int[] {
        0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2D, 0x2E, // pgup pgdn end home arrows ins del
        0x5B, 0x5C, 0x5D, 0x6F, 0x90, 0xA3, 0xA5, 0x2C             // win menu divide numlock rctrl ralt prtsc
    });

    static INPUT Key(int vk, bool up)
    {
        INPUT i = new INPUT();
        i.type = INPUT_KEYBOARD;
        i.u.ki.wVk = (ushort)vk;
        i.u.ki.dwFlags = (up ? KEYEVENTF_KEYUP : 0) | (ExtendedKeys.Contains(vk) ? KEYEVENTF_EXTENDEDKEY : 0);
        i.u.ki.dwExtraInfo = INJECTED_TAG;
        return i;
    }

    static int[] ParseVks(string csv)
    {
        string[] items = csv.Split(',');
        int[] vks = new int[items.Length];
        for (int i = 0; i < items.Length; i++) vks[i] = int.Parse(items[i]);
        return vks;
    }

    static void KeyCombo(string csv, int repeat)
    {
        int[] vks = ParseVks(csv);
        for (int r = 0; r < Math.Max(1, Math.Min(repeat, 100)); r++)
        {
            List<INPUT> l = new List<INPUT>();
            foreach (int vk in vks) l.Add(Key(vk, false));
            for (int k = vks.Length - 1; k >= 0; k--) l.Add(Key(vks[k], true));
            Send(l);
            Thread.Sleep(25);
        }
    }

    static void KeysUpDown(string csv, bool down)
    {
        int[] vks = ParseVks(csv);
        List<INPUT> l = new List<INPUT>();
        if (down) foreach (int vk in vks) l.Add(Key(vk, false));
        else for (int k = vks.Length - 1; k >= 0; k--) l.Add(Key(vks[k], true));
        Send(l);
    }

    static void TypeText(string text)
    {
        // KEYEVENTF_UNICODE types any character regardless of keyboard layout, without the clipboard.
        foreach (char ch in text)
        {
            List<INPUT> l = new List<INPUT>();
            if (ch == '\n') { l.Add(Key(0x0D, false)); l.Add(Key(0x0D, true)); }
            else if (ch == '\r') continue;
            else if (ch == '\t') { l.Add(Key(0x09, false)); l.Add(Key(0x09, true)); }
            else
            {
                INPUT d = new INPUT();
                d.type = INPUT_KEYBOARD;
                d.u.ki.wScan = ch;
                d.u.ki.dwFlags = KEYEVENTF_UNICODE;
                d.u.ki.dwExtraInfo = INJECTED_TAG;
                INPUT u = d;
                u.u.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
                l.Add(d);
                l.Add(u);
            }
            Send(l);
            Thread.Sleep(6);
        }
    }

    // ------------------------------------------------------------------ global key watcher
    static bool Down(int vk) { return (GetAsyncKeyState(vk) & 0x8000) != 0; }

    static void WatchKeys()
    {
        string last = "";
        bool escWasDown = false;
        while (true)
        {
            // Ignore key state briefly after we inject input, so our own keystrokes never
            // trigger hold-to-talk or the stop key.
            bool recentlyInjected = (DateTime.UtcNow.Ticks - Interlocked.Read(ref lastInjectTicks)) < TimeSpan.FromMilliseconds(250).Ticks;
            bool ctrl = Down(0x11), alt = Down(0x12), shift = Down(0x10), win = Down(0x5B) || Down(0x5C);
            string state = (ctrl ? "1" : "0") + "," + (alt ? "1" : "0") + "," + (shift ? "1" : "0") + "," + (win ? "1" : "0");
            if (!recentlyInjected && state != last)
            {
                last = state;
                Emit("!|keys|" + state);
            }
            bool esc = Down(0x1B);
            if (esc && !escWasDown && !recentlyInjected) Emit("!|esc");
            escWasDown = esc;
            Thread.Sleep(20);
        }
    }
}
