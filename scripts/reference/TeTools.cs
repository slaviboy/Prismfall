using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

namespace TeTools
{
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    class MMDeviceEnumeratorCom { }

    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator
    {
        [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
        [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
    }

    [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice
    {
        [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
    }

    [Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioClient
    {
        [PreserveSig] int Initialize(int shareMode, int streamFlags, long bufferDuration, long periodicity, IntPtr format, IntPtr sessionGuid);
        [PreserveSig] int GetBufferSize(out uint frames);
        [PreserveSig] int GetStreamLatency(out long latency);
        [PreserveSig] int GetCurrentPadding(out uint padding);
        [PreserveSig] int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closest);
        [PreserveSig] int GetMixFormat(out IntPtr format);
        [PreserveSig] int GetDevicePeriod(out long def, out long min);
        [PreserveSig] int Start();
        [PreserveSig] int Stop();
        [PreserveSig] int Reset();
        [PreserveSig] int SetEventHandle(IntPtr h);
        [PreserveSig] int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
    }

    [Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioCaptureClient
    {
        [PreserveSig] int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devPos, out ulong qpcPos);
        [PreserveSig] int ReleaseBuffer(uint frames);
        [PreserveSig] int GetNextPacketSize(out uint frames);
    }

    /// <summary>Records what the default output device plays (WASAPI loopback) to a WAV file.</summary>
    public static class Loopback
    {
        public static string Record(string path, double seconds)
        {
            var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorCom());
            IMMDevice device;
            Check(enumerator.GetDefaultAudioEndpoint(0, 0, out device), "GetDefaultAudioEndpoint");
            Guid iidClient = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
            object o;
            Check(device.Activate(ref iidClient, 23, IntPtr.Zero, out o), "Activate");
            var client = (IAudioClient)o;
            IntPtr fmt;
            Check(client.GetMixFormat(out fmt), "GetMixFormat");
            ushort tag = (ushort)Marshal.ReadInt16(fmt, 0);
            ushort channels = (ushort)Marshal.ReadInt16(fmt, 2);
            int rate = Marshal.ReadInt32(fmt, 4);
            ushort blockAlign = (ushort)Marshal.ReadInt16(fmt, 12);
            ushort bits = (ushort)Marshal.ReadInt16(fmt, 14);
            bool isFloat = tag == 3;
            if (tag == 0xFFFE)
            {
                byte[] g = new byte[16];
                Marshal.Copy(fmt + 24, g, 0, 16);
                isFloat = new Guid(g) == new Guid("00000003-0000-0010-8000-00aa00389b71");
            }
            const int LOOPBACK = 0x00020000;
            Check(client.Initialize(0, LOOPBACK, 10000000, 0, fmt, IntPtr.Zero), "Initialize");
            Guid iidCapture = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");
            object c;
            Check(client.GetService(ref iidCapture, out c), "GetService");
            var capture = (IAudioCaptureClient)c;

            var data = new MemoryStream();
            long framesWritten = 0;
            var sw = Stopwatch.StartNew();
            DateTime start = DateTime.UtcNow;
            Check(client.Start(), "Start");
            byte[] buf = new byte[blockAlign * rate];
            while (sw.Elapsed.TotalSeconds < seconds)
            {
                Thread.Sleep(5);
                uint packet;
                Check(capture.GetNextPacketSize(out packet), "GetNextPacketSize");
                while (packet > 0)
                {
                    IntPtr p; uint frames; uint flags; ulong devPos; ulong qpc;
                    Check(capture.GetBuffer(out p, out frames, out flags, out devPos, out qpc), "GetBuffer");
                    int bytes = (int)frames * blockAlign;
                    if (bytes > buf.Length) buf = new byte[bytes];
                    if ((flags & 2) != 0) Array.Clear(buf, 0, bytes);
                    else Marshal.Copy(p, buf, 0, bytes);
                    data.Write(buf, 0, bytes);
                    framesWritten += frames;
                    capture.ReleaseBuffer(frames);
                    Check(capture.GetNextPacketSize(out packet), "GetNextPacketSize");
                }
                // Loopback delivers nothing while nothing plays: pad silence so time stays aligned.
                long expected = (long)(sw.Elapsed.TotalSeconds * rate);
                if (expected - framesWritten > rate / 10)
                {
                    long pad = expected - framesWritten - rate / 50;
                    byte[] z = new byte[pad * blockAlign];
                    data.Write(z, 0, z.Length);
                    framesWritten += pad;
                }
            }
            client.Stop();
            using (var f = File.Create(path))
            using (var w = new BinaryWriter(f))
            {
                int dataLen = (int)data.Length;
                w.Write(new[] { (byte)'R', (byte)'I', (byte)'F', (byte)'F' });
                w.Write(36 + dataLen);
                w.Write(new[] { (byte)'W', (byte)'A', (byte)'V', (byte)'E', (byte)'f', (byte)'m', (byte)'t', (byte)' ' });
                w.Write(16);
                w.Write((short)(isFloat ? 3 : 1));
                w.Write((short)channels);
                w.Write(rate);
                w.Write(rate * blockAlign);
                w.Write((short)blockAlign);
                w.Write((short)bits);
                w.Write(new[] { (byte)'d', (byte)'a', (byte)'t', (byte)'a' });
                w.Write(dataLen);
                data.Position = 0;
                data.CopyTo(f);
            }
            return string.Format("{0} Hz, {1} ch, {2} bit {3}, {4:F2} s, started {5:O}", rate, channels, bits, isFloat ? "float" : "pcm", framesWritten / (double)rate, start);
        }

        static void Check(int hr, string what)
        {
            if (hr != 0) throw new Exception(what + " failed: 0x" + hr.ToString("X8"));
        }
    }

    /// <summary>Keyboard input by scan code (games read scan codes), and focusing the game window.</summary>
    public static class Keys
    {
        [StructLayout(LayoutKind.Sequential)]
        struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
        [StructLayout(LayoutKind.Sequential)]
        struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
        [StructLayout(LayoutKind.Explicit)]
        struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
        [StructLayout(LayoutKind.Sequential)]
        struct INPUT { public uint type; public InputUnion u; }

        [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
        [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
        [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
        [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);

        const uint KEYUP = 0x0002, SCANCODE = 0x0008, EXTENDED = 0x0001;

        static void Send(ushort scan, bool extended, bool up)
        {
            var i = new INPUT { type = 1 };
            i.u.ki = new KEYBDINPUT { wVk = 0, wScan = scan, dwFlags = SCANCODE | (extended ? EXTENDED : 0) | (up ? KEYUP : 0) };
            SendInput(1, new[] { i }, Marshal.SizeOf(typeof(INPUT)));
        }

        static bool Lookup(string name, out ushort scan, out bool ext)
        {
            ext = false; scan = 0;
            switch (name.ToLowerInvariant())
            {
                case "up": scan = 0x48; ext = true; return true;
                case "down": scan = 0x50; ext = true; return true;
                case "left": scan = 0x4B; ext = true; return true;
                case "right": scan = 0x4D; ext = true; return true;
                case "enter": scan = 0x1C; return true;
                case "esc": scan = 0x01; return true;
                case "space": scan = 0x39; return true;
                case "z": scan = 0x2C; return true;
                case "x": scan = 0x2D; return true;
                case "c": scan = 0x2E; return true;
                case "a": scan = 0x1E; return true;
                case "s": scan = 0x1F; return true;
                case "q": scan = 0x10; return true;
                case "e": scan = 0x12; return true;
                case "tab": scan = 0x0F; return true;
                case "shift": scan = 0x2A; return true;
                case "pgup": scan = 0x49; ext = true; return true;
                case "pgdn": scan = 0x51; ext = true; return true;
                case "backspace": scan = 0x0E; return true;
            }
            return false;
        }

        [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lp);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, System.Text.StringBuilder sb, int max);
        [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
        delegate bool EnumProc(IntPtr h, IntPtr lp);

        /// <summary>Visible top-level windows whose title contains `part`: "hwnd pid title" lines.</summary>
        public static string Windows(string part)
        {
            var sb = new System.Text.StringBuilder();
            EnumWindows((h, lp) =>
            {
                if (!IsWindowVisible(h)) return true;
                var t = new System.Text.StringBuilder(256);
                GetWindowText(h, t, 256);
                if (t.Length > 0 && t.ToString().IndexOf(part, StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    uint pid;
                    GetWindowThreadProcessId(h, out pid);
                    sb.AppendLine(h.ToInt64() + " " + pid + " " + t);
                }
                return true;
            }, IntPtr.Zero);
            return sb.ToString();
        }

        public static string FocusHandle(long hwnd)
        {
            IntPtr h = new IntPtr(hwnd);
            keybd_event(0x12, 0, 0, UIntPtr.Zero);
            keybd_event(0x12, 0, 2, UIntPtr.Zero);
            SetForegroundWindow(h);
            Thread.Sleep(200);
            return GetForegroundWindow() == h ? "focused" : "focus failed";
        }

        static bool ForegroundIs(uint pid)
        {
            uint fg;
            GetWindowThreadProcessId(GetForegroundWindow(), out fg);
            return fg == pid;
        }

        /// <summary>Like Sequence, but every key is sent only while process `pid` owns the foreground window.</summary>
        public static string SequenceFor(uint pid, string seq, int gapMs)
        {
            int sent = 0;
            foreach (var raw in seq.Split(','))
            {
                var tok = raw.Trim();
                if (tok.Length == 0) continue;
                if (tok.StartsWith("wait:")) { Thread.Sleep(int.Parse(tok.Substring(5))); continue; }
                int hold = 45;
                string key = tok;
                if (tok.StartsWith("hold:"))
                {
                    var parts = tok.Split(':');
                    key = parts[1];
                    hold = int.Parse(parts[2]);
                }
                ushort scan; bool ext;
                if (!Lookup(key, out scan, out ext)) return "unknown key " + key;
                if (!ForegroundIs(pid)) return "stopped after " + sent + ": the game is not in the foreground";
                Send(scan, ext, false);
                Thread.Sleep(hold);
                Send(scan, ext, true);
                Thread.Sleep(gapMs);
                sent++;
            }
            return "sent " + sent;
        }

        /// <summary>Taps keys in order: "down,down,enter", "wait:500", "hold:right:300".</summary>
        static string Sequence(string seq, int gapMs)
        {
            int sent = 0;
            foreach (var raw in seq.Split(','))
            {
                var tok = raw.Trim();
                if (tok.Length == 0) continue;
                if (tok.StartsWith("wait:")) { Thread.Sleep(int.Parse(tok.Substring(5))); continue; }
                int hold = 45;
                string key = tok;
                if (tok.StartsWith("hold:"))
                {
                    var parts = tok.Split(':');
                    key = parts[1];
                    hold = int.Parse(parts[2]);
                }
                ushort scan; bool ext;
                if (!Lookup(key, out scan, out ext)) return "unknown key " + key;
                Send(scan, ext, false);
                Thread.Sleep(hold);
                Send(scan, ext, true);
                Thread.Sleep(gapMs);
                sent++;
            }
            return "sent " + sent;
        }

        [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
        [DllImport("user32.dll")] static extern void mouse_event(uint flags, int dx, int dy, uint data, UIntPtr extra);

        /// <summary>Left-click at a screen point, only while process `pid` owns the foreground window.</summary>
        public static string ClickFor(uint pid, int x, int y)
        {
            if (!ForegroundIs(pid)) return "not clicked: the window is not in the foreground";
            SetCursorPos(x, y);
            Thread.Sleep(60);
            mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);
            Thread.Sleep(50);
            mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
            return "clicked";
        }

        public static string Focus(string processName)
        {
            foreach (var p in Process.GetProcessesByName(processName))
            {
                IntPtr h = p.MainWindowHandle;
                if (h == IntPtr.Zero) continue;
                // An Alt tap lets a background process take the foreground.
                keybd_event(0x12, 0, 0, UIntPtr.Zero);
                keybd_event(0x12, 0, 2, UIntPtr.Zero);
                ShowWindow(h, 9);
                SetForegroundWindow(h);
                Thread.Sleep(150);
                uint pid;
                GetWindowThreadProcessId(GetForegroundWindow(), out pid);
                return pid == p.Id ? "focused " + p.ProcessName + " " + p.Id : "focus failed (foreground pid " + pid + ")";
            }
            return "no window for " + processName;
        }
    }
}
