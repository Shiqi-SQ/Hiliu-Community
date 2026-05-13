# Hiliu UIA Daemon — Windows UI Automation 长驻服务
#
# 协议：line-delimited JSON-RPC over stdin/stdout
#   请求行：{"id":<int>, "method":<string>, "params":<obj>}
#   响应行：{"id":<int>, "result":<any>}  或  {"id":<int>, "error":<string>}
#
# 设计要点：
#   1. AutomationElement 是 COM 代理，PS 进程不死它就活——所以 ref 池只是
#      string -> AutomationElement 的字典，元素本身存活靠 PS 进程托管。
#   2. 每次 snapshot 重置整个 ref 池——旧 ref 立刻失效、不会跨 snapshot 复用。
#      理由：UI 变化后旧元素可能已 disposed，留着易出"僵尸 ref"难调试。
#   3. ref 编号是 'e1' 'e2' 单调递增字符串。每次 snapshot 重置回 1。
#   4. 不主动推送（无 server-side notification）；保活由 Node 端 ping 心跳负责。
#
# 编码：必须强制 UTF-8——PS 5.1 默认 ASCII 会让中文窗口标题/控件名乱码。
#
# 性能注意：UIA TreeWalker 对深层窗口（如 Visual Studio）扫一次能 1-3s。
#   snapshot 默认深度限制 8 层，超出截断；模型可以指定 hwnd + 更深层深入。

# 启动参数：-ExcludePid 指 hiliu 主进程 PID。daemon 会按"该 pid + 它的整棵子进程树"
# 过滤窗口（Electron 的 4 个 BrowserWindow 各归属不同 renderer 子进程，单 PID 不够）。
# 不传 = 0 = 不过滤（裸跑 daemon 调试时方便）。
param([int]$ExcludePid = 0)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

# 加载 UIA 程序集——Win10/11 都自带，不需要安装任何东西
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
# System.Drawing——window_capture 用 Bitmap.Save 落 PNG 时要
Add-Type -AssemblyName System.Drawing

# user32.dll + gdi32.dll——枚举窗口 / 拿前台窗口 / SetForegroundWindow / 截屏
# RECT/POINT 必须按 Win32 内存布局 (Sequential)，否则 P/Invoke marshalling 出错。
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;

[StructLayout(LayoutKind.Sequential)]
public struct HiliuRect { public int Left; public int Top; public int Right; public int Bottom; }
[StructLayout(LayoutKind.Sequential)]
public struct HiliuPoint { public int X; public int Y; }

// HiliuKbInput：Win32 INPUT 结构在 keyboard 用途下的 explicit 布局。
// INPUT 是 union，x64 总 size = 40 字节（type 4 + padding 4 + 最大成员 MOUSEINPUT 32）。
// 这里只填 KEYBDINPUT 字段（offset 8 起的 24 字节），其余 padding 由 Size=40 兜住。
// 关键：dwExtraInfo 在 x64 是 ULONG_PTR=8 字节，要求 8 字节对齐 → offset 24。
[StructLayout(LayoutKind.Explicit, Size = 40)]
public struct HiliuKbInput {
    [FieldOffset(0)]  public uint type;          // INPUT_KEYBOARD = 1
    [FieldOffset(8)]  public ushort wVk;         // VK code, KEYEVENTF_UNICODE 时被忽略
    [FieldOffset(10)] public ushort wScan;       // KEYEVENTF_UNICODE 时这里放 UTF-16 码元
    [FieldOffset(12)] public uint dwFlags;       // 0x0004 = KEYEVENTF_UNICODE, 0x0002 = KEYEVENTF_KEYUP
    [FieldOffset(16)] public uint time;
    [FieldOffset(24)] public IntPtr dwExtraInfo; // ULONG_PTR
}

public class HiliuUiaWin {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    // ------ window_capture 路径 ------
    // PrintWindow(hWnd, hdcBlt, nFlags)：把窗口位图绘到 hdc。flags=2 (PW_RENDERFULLCONTENT)
    // 是关键——能让 Chromium / DWM compositor 配合渲染（默认 flags=0 对自绘窗口经常给空白）。
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
    [DllImport("user32.dll")] public static extern IntPtr GetWindowDC(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out HiliuRect rect);
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out HiliuRect rect);
    [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref HiliuPoint pt);
    // ------ focus_window 多级兜底 ------
    // AttachThreadInput / SwitchToThisWindow / keybd_event：用于绕开 Windows 焦点窃取保护
    // (LockSetForegroundWindow)。单次 SetForegroundWindow 在用户最近操作过别的窗口时几乎必失败，
    // 这三招组合是 Win32 业界处理"被前台锁拦下"的标准 workaround。
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
    // SwitchToThisWindow 是 undocumented 但从 Win XP 到 Win 11 一直可用——比 SetForegroundWindow
    // 更激进，能强行切窗口；MS 官方不推荐用，但对付焦点锁很好用。fAltTab=true 模拟 alt-tab 路径。
    [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab);
    // keybd_event：发一个 ALT 键的虚拟按下/弹起——骗过 LockSetForegroundWindow，让系统认为
    // "刚才有用户输入"，下一次 SetForegroundWindow 就放行。这是 Raymond Chen 在 Old New Thing
    // 里提到的常见绕法之一，比看起来更稳（不会真触发任何 ALT 菜单）。
    [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
    // ------ 底层键鼠 / 全局热键 ------
    // mouse_event 是 legacy API（XP 时代），SendInput 是后续推出的更现代版本。但 mouse_event
    // 在 Win10/11 都能正常工作而且签名简单（不用定义 INPUT struct），对桌宠场景够用。
    // dwFlags 位掩码：MOUSEEVENTF_LEFTDOWN=0x02 / LEFTUP=0x04 / RIGHTDOWN=0x08 / RIGHTUP=0x10
    //   / MIDDLEDOWN=0x20 / MIDDLEUP=0x40 / WHEEL=0x800（dwData 传滚动量，120=1 notch）
    [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, UIntPtr dwExtraInfo);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out HiliuPoint pt);
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int nIndex);
    // ------ 窗口管理扩展 ------
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndAfter, int X, int Y, int cx, int cy, uint uFlags);
    [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

    // ------ Unicode 文本输入（screen_type） ------
    // 现有 keybd_event 只接受 VK 码——发不出"周杰伦"这种 BMP 字符。
    // SendInput + KEYEVENTF_UNICODE 直接把 UTF-16 码元喂给系统，绕过 IME，
    // 让任何输入框（包括中文搜索框）都能直接接收文本，不依赖键盘布局/输入法状态。
    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint nInputs, [In] HiliuKbInput[] pInputs, int cbSize);

    // 把字符串转成 SendInput 的 UNICODE 事件流，每字符两次（Down + Up），
    // 字符间停 8ms 让目标窗口的输入处理跟得上（IME / 复杂控件偶尔会丢字）。
    // 返回成功"键事件"对数（即字符数），调用方比对入参长度判断是否全部送达。
    public static int TypeUnicode(string text) {
        if (string.IsNullOrEmpty(text)) return 0;
        int chars = 0;
        int size = Marshal.SizeOf(typeof(HiliuKbInput));
        foreach (char c in text) {
            HiliuKbInput[] inp = new HiliuKbInput[2];
            inp[0].type = 1;
            inp[0].wScan = (ushort)c;
            inp[0].dwFlags = 0x0004;             // KEYEVENTF_UNICODE
            inp[1].type = 1;
            inp[1].wScan = (ushort)c;
            inp[1].dwFlags = 0x0004 | 0x0002;    // UNICODE | KEYUP
            uint sent = SendInput(2, inp, size);
            if (sent == 2) chars++;
            System.Threading.Thread.Sleep(8);
        }
        return chars;
    }

    // ------ 全屏免打扰探测（SHQueryUserNotificationState） ------
    // QUERY_USER_NOTIFICATION_STATE 枚举：
    //   1=QUNS_NOT_PRESENT（用户离场/锁屏/未登录）
    //   2=QUNS_BUSY（任意全屏窗口在前台——多数视频播放器、Word 阅读模式）
    //   3=QUNS_RUNNING_D3D_FULL_SCREEN（D3D 独占全屏游戏）
    //   4=QUNS_PRESENTATION_MODE（PPT 演示模式）
    //   5=QUNS_ACCEPTS_NOTIFICATIONS（普通桌面可打扰）
    //   6=QUNS_QUIET_TIME（Win10+ 系统自动勿扰时段）
    //   7=QUNS_APP（Win10+ Modern App 全屏——含 Edge / 微信 PC 这种 UWP 全屏）
    // busy 映射：2/3/4/6——确实在使用全屏 / 演示 / 系统勿扰
    // available 映射：1/5/7——离场（无人看不必躲）/ 普通 / UWP（多数不影响交互）
    [DllImport("shell32.dll")]
    public static extern int SHQueryUserNotificationState(out int pquns);

    public static int GetPresenceRaw() {
        int state;
        int hr = SHQueryUserNotificationState(out state);
        if (hr != 0) return -1;
        return state;
    }
}
"@

# Core Audio COM interfaces——set_volume / get_volume 用。
# IAudioEndpointVolume 的 vtable 顺序固定（按 MMDeviceAPI.h 头文件），多余方法用占位
# int f() / g() / h() / i() / j() / k() / l() 占住 slot；签名错位会让 SetMasterVolumeLevelScalar
# 实际打到别的方法上——MS 规约就是 vtable 索引 = COM 调用槽位。
# 不要扩展接口（哪怕只想加个 GetChannelCount），代价是重排所有占位。
Add-Type @"
using System;
using System.Runtime.InteropServices;

[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioEndpointVolume {
    int RegisterControlChangeNotify(IntPtr pNotify);
    int UnregisterControlChangeNotify(IntPtr pNotify);
    int GetChannelCount(out int pnChannelCount);
    int SetMasterVolumeLevel(float fLevelDB, ref Guid pguidEventContext);
    int SetMasterVolumeLevelScalar(float fLevel, ref Guid pguidEventContext);
    int GetMasterVolumeLevel(out float pfLevelDB);
    int GetMasterVolumeLevelScalar(out float pfLevel);
    int SetChannelVolumeLevel(uint nChannel, float fLevelDB, ref Guid pguidEventContext);
    int SetChannelVolumeLevelScalar(uint nChannel, float fLevel, ref Guid pguidEventContext);
    int GetChannelVolumeLevel(uint nChannel, out float pfLevelDB);
    int GetChannelVolumeLevelScalar(uint nChannel, out float pfLevel);
    int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, ref Guid pguidEventContext);
    int GetMute(out bool pbMute);
}

[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDevice {
    int Activate(ref Guid id, uint clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
    int OpenPropertyStore(uint stgmAccess, out IntPtr ppProperties);
    int GetId([MarshalAs(UnmanagedType.LPWStr)] out string ppstrId);
    int GetState(out uint pdwState);
}

[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(uint dataFlow, uint dwStateMask, out IntPtr ppDevices);
    int GetDefaultAudioEndpoint(uint dataFlow, uint role, out IMMDevice ppEndpoint);
}

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
public class MMDeviceEnumeratorComObject { }

public static class HiliuAudio {
    // PowerShell 5.1 对 COM 对象走 IDispatch（按方法名查表）——而 IAudioEndpointVolume
    // 不实现 IDispatch（纯 IUnknown vtable 接口），所以 PS 直接调 endpoint.SetMaster... 时
    // 报「[System.__ComObject] 不包含名为 SetMasterVolumeLevelScalar 的方法」。
    // 把所有调用包在 C# 静态方法里，C# 走真正的 vtable，PS 端只调 [HiliuAudio]::Xxx 即可。
    public static IAudioEndpointVolume GetEndpoint() {
        IMMDeviceEnumerator e = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
        IMMDevice dev;
        Marshal.ThrowExceptionForHR(e.GetDefaultAudioEndpoint(0u, 1u, out dev)); // eRender, eMultimedia
        Guid iid = typeof(IAudioEndpointVolume).GUID;
        object o;
        Marshal.ThrowExceptionForHR(dev.Activate(ref iid, 0x17u, IntPtr.Zero, out o)); // CLSCTX_ALL
        return (IAudioEndpointVolume)o;
    }

    public static int SetVolumePercent(int pct) {
        if (pct < 0) pct = 0;
        if (pct > 100) pct = 100;
        IAudioEndpointVolume ep = GetEndpoint();
        try {
            Guid g = Guid.Empty;
            Marshal.ThrowExceptionForHR(ep.SetMasterVolumeLevelScalar((float)(pct / 100.0), ref g));
            float cur = 0f;
            Marshal.ThrowExceptionForHR(ep.GetMasterVolumeLevelScalar(out cur));
            return (int)Math.Round(cur * 100);
        } finally {
            Marshal.FinalReleaseComObject(ep);
        }
    }

    public static bool SetMuteState(bool mute) {
        IAudioEndpointVolume ep = GetEndpoint();
        try {
            Guid g = Guid.Empty;
            Marshal.ThrowExceptionForHR(ep.SetMute(mute, ref g));
            bool cur = false;
            Marshal.ThrowExceptionForHR(ep.GetMute(out cur));
            return cur;
        } finally {
            Marshal.FinalReleaseComObject(ep);
        }
    }

    public static int GetVolumePercent() {
        IAudioEndpointVolume ep = GetEndpoint();
        try {
            float vol = 0f;
            Marshal.ThrowExceptionForHR(ep.GetMasterVolumeLevelScalar(out vol));
            return (int)Math.Round(vol * 100);
        } finally {
            Marshal.FinalReleaseComObject(ep);
        }
    }

    public static bool GetMuteState() {
        IAudioEndpointVolume ep = GetEndpoint();
        try {
            bool mute = false;
            Marshal.ThrowExceptionForHR(ep.GetMute(out mute));
            return mute;
        } finally {
            Marshal.FinalReleaseComObject(ep);
        }
    }
}
"@

# ============ 全局状态 ============

$script:elements = @{}        # ref(string) -> AutomationElement
$script:nextRef = 1
$script:startedAt = Get-Date

# 进程树排除集——含 hiliu 主进程 + 所有后代子进程。
# 缓存 5s——WMI 一次 30-80ms，按需刷新避免每次 list_windows 都查。
$script:excludePidSet = @{}
$script:excludePidCachedAt = [DateTime]::MinValue

function Get-ExcludedPidSet {
    if ($ExcludePid -le 0) { return @{} }
    $now = Get-Date
    if (($now - $script:excludePidCachedAt).TotalSeconds -lt 5 -and $script:excludePidSet.Count -gt 0) {
        return $script:excludePidSet
    }
    $set = @{ $ExcludePid = $true }
    $allProcs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Select-Object ProcessId, ParentProcessId
    if ($allProcs) {
        # 反复扫直到不再有新增——对 Electron 这种 main → renderer/gpu/utility 多层够用
        $changed = $true
        while ($changed) {
            $changed = $false
            foreach ($p in $allProcs) {
                $pidI = [int]$p.ProcessId
                $ppidI = [int]$p.ParentProcessId
                if ($set.ContainsKey($ppidI) -and -not $set.ContainsKey($pidI)) {
                    $set[$pidI] = $true
                    $changed = $true
                }
            }
        }
    }
    $script:excludePidSet = $set
    $script:excludePidCachedAt = $now
    return $set
}

function Test-IsHiliuPid([int]$procId) {
    if ($ExcludePid -le 0) { return $false }
    return (Get-ExcludedPidSet).ContainsKey($procId)
}

# ============ 辅助函数 ============

function Reply-Ok($id, $result) {
    $obj = [ordered]@{ id = $id; result = $result }
    $line = ConvertTo-Json $obj -Compress -Depth 30
    [Console]::Out.WriteLine($line)
    [Console]::Out.Flush()
}

function Reply-Err($id, $msg) {
    $obj = [ordered]@{ id = $id; error = [string]$msg }
    $line = ConvertTo-Json $obj -Compress -Depth 5
    [Console]::Out.WriteLine($line)
    [Console]::Out.Flush()
}

function Reset-Pool {
    $script:elements = @{}
    $script:nextRef = 1
}

function New-Ref($el) {
    $r = "e$script:nextRef"
    $script:nextRef++
    $script:elements[$r] = $el
    return $r
}

function Get-El($ref) {
    if (-not $script:elements.ContainsKey($ref)) {
        throw "ref '$ref' 不存在或已失效——重新 snapshot 后再试"
    }
    return $script:elements[$ref]
}

# ControlType 枚举映射成短英文名（snapshot 树里好认）
$script:ctMap = @{}
$script:ctMap[[System.Windows.Automation.ControlType]::Button.Id] = 'button'
$script:ctMap[[System.Windows.Automation.ControlType]::Calendar.Id] = 'calendar'
$script:ctMap[[System.Windows.Automation.ControlType]::CheckBox.Id] = 'checkbox'
$script:ctMap[[System.Windows.Automation.ControlType]::ComboBox.Id] = 'combobox'
$script:ctMap[[System.Windows.Automation.ControlType]::Custom.Id] = 'custom'
$script:ctMap[[System.Windows.Automation.ControlType]::DataGrid.Id] = 'grid'
$script:ctMap[[System.Windows.Automation.ControlType]::DataItem.Id] = 'griditem'
$script:ctMap[[System.Windows.Automation.ControlType]::Document.Id] = 'document'
$script:ctMap[[System.Windows.Automation.ControlType]::Edit.Id] = 'edit'
$script:ctMap[[System.Windows.Automation.ControlType]::Group.Id] = 'group'
$script:ctMap[[System.Windows.Automation.ControlType]::Header.Id] = 'header'
$script:ctMap[[System.Windows.Automation.ControlType]::HeaderItem.Id] = 'headeritem'
$script:ctMap[[System.Windows.Automation.ControlType]::Hyperlink.Id] = 'link'
$script:ctMap[[System.Windows.Automation.ControlType]::Image.Id] = 'image'
$script:ctMap[[System.Windows.Automation.ControlType]::List.Id] = 'list'
$script:ctMap[[System.Windows.Automation.ControlType]::ListItem.Id] = 'listitem'
$script:ctMap[[System.Windows.Automation.ControlType]::Menu.Id] = 'menu'
$script:ctMap[[System.Windows.Automation.ControlType]::MenuBar.Id] = 'menubar'
$script:ctMap[[System.Windows.Automation.ControlType]::MenuItem.Id] = 'menuitem'
$script:ctMap[[System.Windows.Automation.ControlType]::Pane.Id] = 'pane'
$script:ctMap[[System.Windows.Automation.ControlType]::ProgressBar.Id] = 'progress'
$script:ctMap[[System.Windows.Automation.ControlType]::RadioButton.Id] = 'radio'
$script:ctMap[[System.Windows.Automation.ControlType]::ScrollBar.Id] = 'scrollbar'
$script:ctMap[[System.Windows.Automation.ControlType]::Separator.Id] = 'separator'
$script:ctMap[[System.Windows.Automation.ControlType]::Slider.Id] = 'slider'
$script:ctMap[[System.Windows.Automation.ControlType]::Spinner.Id] = 'spinner'
$script:ctMap[[System.Windows.Automation.ControlType]::SplitButton.Id] = 'splitbutton'
$script:ctMap[[System.Windows.Automation.ControlType]::StatusBar.Id] = 'statusbar'
$script:ctMap[[System.Windows.Automation.ControlType]::Tab.Id] = 'tab'
$script:ctMap[[System.Windows.Automation.ControlType]::TabItem.Id] = 'tabitem'
$script:ctMap[[System.Windows.Automation.ControlType]::Table.Id] = 'table'
$script:ctMap[[System.Windows.Automation.ControlType]::Text.Id] = 'text'
$script:ctMap[[System.Windows.Automation.ControlType]::Thumb.Id] = 'thumb'
$script:ctMap[[System.Windows.Automation.ControlType]::TitleBar.Id] = 'titlebar'
$script:ctMap[[System.Windows.Automation.ControlType]::ToolBar.Id] = 'toolbar'
$script:ctMap[[System.Windows.Automation.ControlType]::ToolTip.Id] = 'tooltip'
$script:ctMap[[System.Windows.Automation.ControlType]::Tree.Id] = 'tree'
$script:ctMap[[System.Windows.Automation.ControlType]::TreeItem.Id] = 'treeitem'
$script:ctMap[[System.Windows.Automation.ControlType]::Window.Id] = 'window'

function Get-CtName($el) {
    try {
        $ct = $el.Current.ControlType
        if ($ct -and $script:ctMap.ContainsKey($ct.Id)) { return $script:ctMap[$ct.Id] }
        return 'unknown'
    } catch {
        return 'unknown'
    }
}

# 紧凑安全地拿元素 name，超长截断
function Get-ElName($el, [int]$maxLen = 80) {
    try {
        $n = $el.Current.Name
        if ($null -eq $n) { return '' }
        $n = $n -replace '[\r\n\t]+', ' '
        if ($n.Length -gt $maxLen) { return $n.Substring(0, $maxLen) + '…' }
        return $n
    } catch {
        return ''
    }
}

# 把树用文本缩进格式化——每行一个元素：
#   [ref] controltype "name" {flags}
# flags 例：(focused) (disabled) (off-screen) (value="xxx")
function Format-Node($el, [int]$depth, [int]$maxDepth, [System.Text.StringBuilder]$sb) {
    if ($depth -gt $maxDepth) {
        $sb.Append('  ' * $depth) | Out-Null
        $sb.AppendLine('… (deeper subtree truncated)') | Out-Null
        return
    }
    $ref = New-Ref $el
    $ct = Get-CtName $el
    $name = Get-ElName $el
    $flags = @()
    try { if ($el.Current.HasKeyboardFocus) { $flags += 'focused' } } catch {}
    try { if (-not $el.Current.IsEnabled) { $flags += 'disabled' } } catch {}
    try { if ($el.Current.IsOffscreen) { $flags += 'off-screen' } } catch {}
    # 如果是 edit / value 类，附带当前值（截断 60 字符）
    try {
        $vp = $null
        if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) {
            $v = $vp.Current.Value
            if ($v) {
                $v = $v -replace '[\r\n\t]+', ' '
                if ($v.Length -gt 60) { $v = $v.Substring(0, 60) + '…' }
                $flags += "value=`"$v`""
            }
        }
    } catch {}

    $line = ('  ' * $depth) + "[$ref] $ct"
    if ($name) { $line += " `"$name`"" }
    if ($flags.Count -gt 0) { $line += ' (' + ($flags -join ', ') + ')' }
    $sb.AppendLine($line) | Out-Null

    # 递归子元素——FindAll 比 TreeWalker 慢一点但稳定
    try {
        $children = $el.FindAll(
            [System.Windows.Automation.TreeScope]::Children,
            [System.Windows.Automation.Condition]::TrueCondition)
        foreach ($child in $children) {
            Format-Node $child ($depth + 1) $maxDepth $sb
        }
    } catch {
        # 子元素遍历失败（受保护进程 / 已 dispose）——静默跳过，不破坏整棵树
    }
}

# ============ 方法实现 ============

function Method-Ping($params) {
    $up = (Get-Date) - $script:startedAt
    return [ordered]@{
        pid = $PID
        uptimeMs = [int64]$up.TotalMilliseconds
        poolSize = $script:elements.Count
    }
}

function Method-ListWindows($params) {
    $list = @()
    $foreground = [HiliuUiaWin]::GetForegroundWindow()
    $script:_excludedPids = Get-ExcludedPidSet
    $cb = [HiliuUiaWin+EnumWindowsProc] {
        param([IntPtr]$hWnd, [IntPtr]$lParam)
        if (-not [HiliuUiaWin]::IsWindowVisible($hWnd)) { return $true }
        $len = [HiliuUiaWin]::GetWindowTextLength($hWnd)
        if ($len -le 0) { return $true }  # 无标题窗口太多噪音，跳过
        $sb = New-Object System.Text.StringBuilder ($len + 2)
        [void][HiliuUiaWin]::GetWindowText($hWnd, $sb, $sb.Capacity)
        $title = $sb.ToString()
        $procId = 0
        [void][HiliuUiaWin]::GetWindowThreadProcessId($hWnd, [ref]$procId)
        # 跳过 hiliu 自己（含整棵子进程树——4 个 BrowserWindow 各属不同 renderer）
        if ($script:_excludedPids.ContainsKey([int]$procId)) { return $true }
        $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
        $script:_listAcc.Add([ordered]@{
            hwnd = [int64]$hWnd
            title = $title
            processName = if ($proc) { $proc.ProcessName } else { '' }
            pid = [int]$procId
            isForeground = ($hWnd -eq $script:_foregroundHwnd)
            isMinimized = [HiliuUiaWin]::IsIconic($hWnd)
        }) | Out-Null
        return $true
    }
    $script:_listAcc = New-Object System.Collections.ArrayList
    $script:_foregroundHwnd = $foreground
    [void][HiliuUiaWin]::EnumWindows($cb, [IntPtr]::Zero)
    $list = $script:_listAcc.ToArray()
    Remove-Variable -Name '_listAcc' -Scope Script -ErrorAction SilentlyContinue
    Remove-Variable -Name '_foregroundHwnd' -Scope Script -ErrorAction SilentlyContinue
    Remove-Variable -Name '_excludedPids' -Scope Script -ErrorAction SilentlyContinue
    return $list
}

function Method-Snapshot($params) {
    $scope = if ($params.scope) { [string]$params.scope } else { 'foreground' }
    $maxDepth = if ($params.maxDepth) { [int]$params.maxDepth } else { 8 }
    if ($maxDepth -lt 1) { $maxDepth = 1 }
    if ($maxDepth -gt 16) { $maxDepth = 16 }

    Reset-Pool

    $root = $null
    if ($scope -eq 'foreground') {
        $hwnd = [HiliuUiaWin]::GetForegroundWindow()
        if ($hwnd -eq [IntPtr]::Zero) { throw '没有前台窗口（可能桌面空闲）' }
        # 用户当下焦点可能停在 hiliu 气泡——直接抓自己没意义，让模型走 list_windows
        $procIdOfFg = 0
        [void][HiliuUiaWin]::GetWindowThreadProcessId($hwnd, [ref]$procIdOfFg)
        if (Test-IsHiliuPid([int]$procIdOfFg)) {
            throw '当前前台窗口是 hiliu 自己（你在跟用户对话呢）。请先调 list_windows 拿到目标窗口的 hwnd，再用 scope=hwnd 抓 UI 树——比如用户最近聊到的那个 App。'
        }
        $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
    } elseif ($scope -eq 'hwnd') {
        if (-not $params.hwnd) { throw "scope=hwnd 必须指定 params.hwnd" }
        $hwnd = [IntPtr][int64]$params.hwnd
        $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
        if (-not $root) { throw "hwnd=$($params.hwnd) 不是有效窗口" }
    } elseif ($scope -eq 'desktop') {
        $root = [System.Windows.Automation.AutomationElement]::RootElement
        # 桌面太大——把 maxDepth 兜底压到 3
        if ($maxDepth -gt 3) { $maxDepth = 3 }
    } else {
        throw "未知 scope: $scope（可选：foreground|hwnd|desktop）"
    }

    $sb = New-Object System.Text.StringBuilder
    Format-Node $root 0 $maxDepth $sb

    return [ordered]@{
        scope = $scope
        maxDepth = $maxDepth
        refCount = ($script:nextRef - 1)
        tree = $sb.ToString()
    }
}

function Method-Inspect($params) {
    if (-not $params.ref) { throw 'inspect 缺 ref 参数' }
    $el = Get-El ([string]$params.ref)
    $info = [ordered]@{
        ref = $params.ref
        controlType = Get-CtName $el
        name = Get-ElName $el 200
    }
    try { $info.automationId = $el.Current.AutomationId } catch {}
    try { $info.className = $el.Current.ClassName } catch {}
    try { $info.isEnabled = $el.Current.IsEnabled } catch {}
    try { $info.isOffscreen = $el.Current.IsOffscreen } catch {}
    try { $info.hasKeyboardFocus = $el.Current.HasKeyboardFocus } catch {}
    try {
        $r = $el.Current.BoundingRectangle
        $info.bounds = [ordered]@{ x = [int]$r.X; y = [int]$r.Y; width = [int]$r.Width; height = [int]$r.Height }
    } catch {}
    try {
        $patterns = @()
        if ($el.GetSupportedPatterns()) {
            foreach ($p in $el.GetSupportedPatterns()) { $patterns += $p.ProgrammaticName }
        }
        $info.patterns = $patterns
    } catch {}
    try {
        $vp = $null
        if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) {
            $info.value = $vp.Current.Value
        }
    } catch {}
    return $info
}

function Method-Act($params) {
    if (-not $params.ref) { throw 'act 缺 ref 参数' }
    if (-not $params.kind) { throw 'act 缺 kind 参数' }
    $el = Get-El ([string]$params.ref)
    $kind = [string]$params.kind

    switch ($kind) {
        'invoke' {
            # 适用 button / link / menuitem 等可"按一下就触发"的元素
            $p = $null
            if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$p)) {
                $p.Invoke()
                return 'invoked'
            }
            # fallback：有些控件（toggle button）只暴露 Toggle 不暴露 Invoke
            $tp = $null
            if ($el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$tp)) {
                $tp.Toggle()
                return 'toggled (fallback from invoke)'
            }
            throw "ref '$($params.ref)' 不支持 invoke 也不支持 toggle"
        }
        'set_value' {
            if ($null -eq $params.value) { throw 'set_value 缺 value 参数' }
            $vp = $null
            if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) {
                $vp.SetValue([string]$params.value)
                return 'value set'
            }
            throw "ref '$($params.ref)' 不支持 ValuePattern——多见于复杂 edit / 自绘控件，可改用 send_keys"
        }
        'toggle' {
            $tp = $null
            if ($el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$tp)) {
                $tp.Toggle()
                return 'toggled'
            }
            throw "ref '$($params.ref)' 不支持 TogglePattern"
        }
        'focus' {
            try {
                $el.SetFocus()
                return 'focused'
            } catch {
                throw "聚焦失败：$($_.Exception.Message)"
            }
        }
        'expand' {
            $ep = $null
            if ($el.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$ep)) {
                $ep.Expand()
                return 'expanded'
            }
            throw "ref '$($params.ref)' 不支持 ExpandCollapsePattern"
        }
        'collapse' {
            $ep = $null
            if ($el.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$ep)) {
                $ep.Collapse()
                return 'collapsed'
            }
            throw "ref '$($params.ref)' 不支持 ExpandCollapsePattern"
        }
        'select' {
            $sp = $null
            if ($el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$sp)) {
                $sp.Select()
                return 'selected'
            }
            throw "ref '$($params.ref)' 不支持 SelectionItemPattern"
        }
        default {
            throw "未知 kind: $kind（支持：invoke|set_value|toggle|focus|expand|collapse|select）"
        }
    }
}

function Method-Capture($params) {
    # params: { hwnd?: int64, scope?: 'full-window'|'client'|'screen', outputPath: string }
    #
    # 三档策略：
    #   - 'full-window'：整窗（含标题栏边框）。先 PrintWindow(flag=2 PW_RENDERFULLCONTENT)；
    #     失败兜底 BitBlt(GetWindowRect) 从屏幕抠——窗口需在前台且未遮挡
    #   - 'client'：仅 client 区。先 PrintWindow(flag=3 = PW_RENDERFULLCONTENT|PW_CLIENTONLY)；
    #     失败兜底 BitBlt(ClientToScreen + GetClientRect)
    #   - 'screen'：整屏 CopyFromScreen，不要 hwnd
    #
    # PrintWindow 不需要窗口在前台、不抢焦点——这是它比 BitBlt 兜底路径优越的关键。
    # 但对部分老 Chromium / 受 DPI 影响的窗口可能返回 false 或全黑，BitBlt 兜底是底线。

    if (-not $params.outputPath) { throw 'capture 缺 outputPath 参数' }
    $outputPath = [string]$params.outputPath
    $scope = if ($params.scope) { [string]$params.scope } else { 'full-window' }
    $fallbackUsed = $false
    $bitmap = $null
    $graphics = $null

    try {
        if ($scope -eq 'screen') {
            Add-Type -AssemblyName System.Windows.Forms
            $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
            $w = $bounds.Width
            $h = $bounds.Height
            $bitmap = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
            $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
            $graphics.CopyFromScreen(0, 0, 0, 0, (New-Object System.Drawing.Size($w, $h)))
        } else {
            if (-not $params.hwnd) { throw "scope=$scope 必须指定 params.hwnd（或改用 scope='screen' 抓整屏）" }
            $hwnd = [IntPtr][int64]$params.hwnd

            # 算尺寸——client 模式只取 client 区；full-window 取整窗
            $clientRect = New-Object HiliuRect
            $windowRect = New-Object HiliuRect
            if (-not [HiliuUiaWin]::GetWindowRect($hwnd, [ref]$windowRect)) {
                throw "GetWindowRect 失败 hwnd=$($params.hwnd)（窗口已关闭？）"
            }
            if (-not [HiliuUiaWin]::GetClientRect($hwnd, [ref]$clientRect)) {
                throw "GetClientRect 失败 hwnd=$($params.hwnd)"
            }
            if ($scope -eq 'client') {
                $w = $clientRect.Right - $clientRect.Left
                $h = $clientRect.Bottom - $clientRect.Top
            } else {
                $w = $windowRect.Right - $windowRect.Left
                $h = $windowRect.Bottom - $windowRect.Top
            }
            if ($w -le 0 -or $h -le 0) {
                throw "窗口尺寸异常 ${w}×${h}（最小化或 hwnd 失效，先 focus_window 再 capture）"
            }
            $maxDim = 4096
            if ($w -gt $maxDim -or $h -gt $maxDim) {
                throw "窗口尺寸 ${w}×${h} 超出 ${maxDim} 上限——巨幅窗口截图无意义"
            }

            $bitmap = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
            $graphics = [System.Drawing.Graphics]::FromImage($bitmap)

            # PrintWindow 主路径
            $hdc = $graphics.GetHdc()
            # flag: 2=PW_RENDERFULLCONTENT, 3=PW_RENDERFULLCONTENT|PW_CLIENTONLY
            $flag = if ($scope -eq 'client') { 3 } else { 2 }
            $printOk = $false
            try {
                $printOk = [HiliuUiaWin]::PrintWindow($hwnd, $hdc, [uint32]$flag)
            } catch {
                $printOk = $false
            }
            $graphics.ReleaseHdc($hdc)

            if (-not $printOk) {
                # BitBlt 兜底——窗口必须在前台且未被遮挡，否则抓到的是上层窗口
                $fallbackUsed = $true
                $graphics.Dispose()
                $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
                if ($scope -eq 'client') {
                    $pt = New-Object HiliuPoint
                    $pt.X = 0; $pt.Y = 0
                    [void][HiliuUiaWin]::ClientToScreen($hwnd, [ref]$pt)
                    $graphics.CopyFromScreen($pt.X, $pt.Y, 0, 0, (New-Object System.Drawing.Size($w, $h)))
                } else {
                    $graphics.CopyFromScreen($windowRect.Left, $windowRect.Top, 0, 0, (New-Object System.Drawing.Size($w, $h)))
                }
            }
        }

        # 输出 PNG——目录由 Node 端保证存在
        $bitmap.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)
        $sizeBytes = (Get-Item $outputPath).Length

        return [ordered]@{
            path = $outputPath
            width = $bitmap.Width
            height = $bitmap.Height
            sizeBytes = [int64]$sizeBytes
            fallbackUsed = $fallbackUsed
            scope = $scope
        }
    } finally {
        if ($graphics) { $graphics.Dispose() }
        if ($bitmap) { $bitmap.Dispose() }
    }
}

function Method-FocusWindow($params) {
    if (-not $params.hwnd) { throw 'focus_window 缺 hwnd 参数' }
    $hwnd = [IntPtr][int64]$params.hwnd

    # Step 1：最小化先 SW_RESTORE 弹出来（不依赖前台权限，IsIconic 状态下必成功）
    if ([HiliuUiaWin]::IsIconic($hwnd)) {
        # SW_RESTORE = 9
        [void][HiliuUiaWin]::ShowWindow($hwnd, 9)
        # 等一帧让 DWM compositor 把窗口画出来——立刻 SetForeground 偶尔窗口还是隐身
        Start-Sleep -Milliseconds 80
    }

    # Step 2：直接 SetForegroundWindow——大多数场景这就够（用户刚才点过 hiliu，或当前没前台进程）
    if ([HiliuUiaWin]::SetForegroundWindow($hwnd)) {
        if ([HiliuUiaWin]::GetForegroundWindow() -eq $hwnd) {
            return 'foreground (direct)'
        }
    }

    # Step 3：AttachThreadInput trick——把 PowerShell 的输入线程附到当前前台窗口的线程上，
    # "借"它的前台权限，再调 SetForegroundWindow。这对付 QQ音乐 / 微信 / 视频播放器
    # 这种用户最近活动过的窗口锁住焦点的场景最有效。
    $foreHwnd = [HiliuUiaWin]::GetForegroundWindow()
    if ($foreHwnd -ne [IntPtr]::Zero -and $foreHwnd -ne $hwnd) {
        $forePid = 0
        $foreThread = [HiliuUiaWin]::GetWindowThreadProcessId($foreHwnd, [ref]$forePid)
        $myThread = [HiliuUiaWin]::GetCurrentThreadId()
        if ($foreThread -ne 0 -and $foreThread -ne $myThread) {
            $attached = [HiliuUiaWin]::AttachThreadInput($foreThread, $myThread, $true)
            try {
                [void][HiliuUiaWin]::BringWindowToTop($hwnd)
                [void][HiliuUiaWin]::SetForegroundWindow($hwnd)
            } finally {
                if ($attached) {
                    [void][HiliuUiaWin]::AttachThreadInput($foreThread, $myThread, $false)
                }
            }
            if ([HiliuUiaWin]::GetForegroundWindow() -eq $hwnd) {
                return 'foreground (attach-thread)'
            }
        }
    }

    # Step 4：ALT key trick——发一个 ALT 键的按下/弹起，骗过 LockSetForegroundWindow。
    # 系统判定「最近有用户输入」就会放行下一次 SetForegroundWindow。
    # VK_MENU=0x12，KEYEVENTF_KEYUP=0x0002；不会真触发 ALT 菜单（按下立即弹起 + 没有焦点窗口接收）
    [HiliuUiaWin]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
    [HiliuUiaWin]::keybd_event(0x12, 0, 0x0002, [UIntPtr]::Zero)
    if ([HiliuUiaWin]::SetForegroundWindow($hwnd)) {
        if ([HiliuUiaWin]::GetForegroundWindow() -eq $hwnd) {
            return 'foreground (alt-key)'
        }
    }

    # Step 5：SwitchToThisWindow——undocumented 但从 XP 到 Win11 都还能用，比 SetForeground 更激进
    [HiliuUiaWin]::SwitchToThisWindow($hwnd, $true)
    Start-Sleep -Milliseconds 50
    if ([HiliuUiaWin]::GetForegroundWindow() -eq $hwnd) {
        return 'foreground (switch-to-this)'
    }

    # 五招都不行——通常是用户当前在跑全屏 App / 屏保 / UAC 弹窗等高优先级前台
    throw 'focus_window 四级兜底（direct / attach-thread / alt-key / switch-to-this）均未把窗口拉到前台。可能用户正在跑全屏应用占着焦点锁——可以改用 ui_act 模拟点任务栏图标，或者直接 window_capture 截图（PrintWindow 不要求窗口在前台，对最小化窗口也能截，Chromium 类除外）'
}

# ============ P0-2 底层键鼠 / 全局热键 ============

# 鼠标按钮 → mouse_event 标志位
function Get-MouseFlags([string]$button) {
    switch ($button.ToLower()) {
        'left'   { return @{ down = 0x0002; up = 0x0004 } }
        'right'  { return @{ down = 0x0008; up = 0x0010 } }
        'middle' { return @{ down = 0x0020; up = 0x0040 } }
        default  { throw "未知 button：$button（应为 left/right/middle）" }
    }
}

function Method-ScreenClick($params) {
    $x = if ($null -ne $params.x) { [int]$params.x } else { -1 }
    $y = if ($null -ne $params.y) { [int]$params.y } else { -1 }
    $button = if ($params.button) { [string]$params.button } else { 'left' }
    $clicks = if ($null -ne $params.clicks) { [int]$params.clicks } else { 1 }
    if ($clicks -lt 1 -or $clicks -gt 3) { throw 'clicks 必须 1-3' }

    # x/y 任一未给则原位点击；都给了先移动光标
    if ($x -ge 0 -and $y -ge 0) {
        [void][HiliuUiaWin]::SetCursorPos($x, $y)
        Start-Sleep -Milliseconds 20
    } else {
        $pt = New-Object HiliuPoint
        [void][HiliuUiaWin]::GetCursorPos([ref]$pt)
        $x = $pt.X; $y = $pt.Y
    }

    $flags = Get-MouseFlags $button
    for ($i = 0; $i -lt $clicks; $i++) {
        [HiliuUiaWin]::mouse_event([uint32]$flags.down, 0, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 30
        [HiliuUiaWin]::mouse_event([uint32]$flags.up, 0, 0, 0, [UIntPtr]::Zero)
        if ($i -lt ($clicks - 1)) { Start-Sleep -Milliseconds 60 }
    }
    return @{ x = $x; y = $y; button = $button; clicks = $clicks }
}

function Method-ScreenMove($params) {
    if ($null -eq $params.x -or $null -eq $params.y) { throw 'screen_move 缺 x / y 参数' }
    $x = [int]$params.x; $y = [int]$params.y
    [void][HiliuUiaWin]::SetCursorPos($x, $y)
    return @{ x = $x; y = $y }
}

function Method-ScreenScroll($params) {
    if ($null -eq $params.delta) { throw 'screen_scroll 缺 delta 参数' }
    $x = if ($null -ne $params.x) { [int]$params.x } else { -1 }
    $y = if ($null -ne $params.y) { [int]$params.y } else { -1 }
    $delta = [int]$params.delta  # 正向上、负向下；120 = 1 notch
    if ($x -ge 0 -and $y -ge 0) {
        [void][HiliuUiaWin]::SetCursorPos($x, $y)
        Start-Sleep -Milliseconds 20
    }
    # MOUSEEVENTF_WHEEL = 0x0800
    # mouse_event 的 dwData 在 wheel 模式下是 signed int，但参数声明 uint——
    # 用 [BitConverter] 双向转换确保负数正确传递（-120 → 0xFFFFFF88）
    $deltaUint = [System.BitConverter]::ToUInt32([System.BitConverter]::GetBytes($delta), 0)
    [HiliuUiaWin]::mouse_event(0x0800, 0, 0, $deltaUint, [UIntPtr]::Zero)
    return @{ delta = $delta }
}

function Method-ScreenDrag($params) {
    if ($null -eq $params.fromX -or $null -eq $params.fromY -or
        $null -eq $params.toX -or $null -eq $params.toY) {
        throw 'screen_drag 缺 fromX / fromY / toX / toY 参数'
    }
    $fromX = [int]$params.fromX; $fromY = [int]$params.fromY
    $toX = [int]$params.toX; $toY = [int]$params.toY
    $button = if ($params.button) { [string]$params.button } else { 'left' }
    $flags = Get-MouseFlags $button

    [void][HiliuUiaWin]::SetCursorPos($fromX, $fromY)
    Start-Sleep -Milliseconds 50
    [HiliuUiaWin]::mouse_event([uint32]$flags.down, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 80

    # 分 10 段平滑插值——直接跳目标点 OS 不会识别为 drag
    $steps = 10
    for ($i = 1; $i -le $steps; $i++) {
        $px = [int]($fromX + ($toX - $fromX) * $i / $steps)
        $py = [int]($fromY + ($toY - $fromY) * $i / $steps)
        [void][HiliuUiaWin]::SetCursorPos($px, $py)
        Start-Sleep -Milliseconds 20
    }

    [HiliuUiaWin]::mouse_event([uint32]$flags.up, 0, 0, 0, [UIntPtr]::Zero)
    return @{ from = @{ x = $fromX; y = $fromY }; to = @{ x = $toX; y = $toY }; button = $button }
}

# ============ global_hotkey ============

# 通用 VK 表：按键名（小写）→ Virtual Key Code
$script:VkMap = @{
    'ctrl' = 0x11; 'control' = 0x11
    'shift' = 0x10
    'alt' = 0x12; 'menu' = 0x12
    'win' = 0x5B; 'lwin' = 0x5B; 'rwin' = 0x5C; 'cmd' = 0x5B; 'super' = 0x5B
    'tab' = 0x09
    'esc' = 0x1B; 'escape' = 0x1B
    'enter' = 0x0D; 'return' = 0x0D
    'space' = 0x20
    'backspace' = 0x08; 'bksp' = 0x08
    'delete' = 0x2E; 'del' = 0x2E
    'insert' = 0x2D; 'ins' = 0x2D
    'home' = 0x24; 'end' = 0x23
    'pageup' = 0x21; 'pgup' = 0x21
    'pagedown' = 0x22; 'pgdn' = 0x22
    'up' = 0x26; 'down' = 0x28; 'left' = 0x25; 'right' = 0x27
    'capslock' = 0x14; 'numlock' = 0x90; 'scrolllock' = 0x91
    'printscreen' = 0x2C; 'prtsc' = 0x2C
    'f1' = 0x70; 'f2' = 0x71; 'f3' = 0x72; 'f4' = 0x73
    'f5' = 0x74; 'f6' = 0x75; 'f7' = 0x76; 'f8' = 0x77
    'f9' = 0x78; 'f10' = 0x79; 'f11' = 0x7A; 'f12' = 0x7B
    # 媒体键——直接走 hotkey 路径就够，不必单独 method
    'play' = 0xB3; 'playpause' = 0xB3; 'stop' = 0xB2
    'next' = 0xB0; 'prev' = 0xB1; 'previous' = 0xB1
    'volumeup' = 0xAF; 'volup' = 0xAF
    'volumedown' = 0xAE; 'voldown' = 0xAE
    'volumemute' = 0xAD; 'mute' = 0xAD
    # 标点（少量常用——更多走字面字符路径）
    ',' = 0xBC; '.' = 0xBE; '/' = 0xBF; ';' = 0xBA
    "'" = 0xDE; '[' = 0xDB; ']' = 0xDD; '\' = 0xDC
    '-' = 0xBD; '=' = 0xBB; '`' = 0xC0
}

function Resolve-Vk([string]$key) {
    $k = $key.Trim().ToLower()
    if ($script:VkMap.ContainsKey($k)) { return $script:VkMap[$k] }
    # 单字母 / 数字
    if ($k.Length -eq 1) {
        $c = [byte][char]$k.ToUpper()
        if ($c -ge 0x30 -and $c -le 0x39) { return $c }  # '0'-'9'
        if ($c -ge 0x41 -and $c -le 0x5A) { return $c }  # 'A'-'Z'
    }
    throw "无法识别的按键名：$key"
}

function Method-GlobalHotkey($params) {
    if (-not $params.keys) { throw 'global_hotkey 缺 keys 参数' }
    $keys = [string]$params.keys

    # 解析 "ctrl+shift+t" → @(0x11, 0x10, 0x54)
    $parts = $keys.Split('+') | ForEach-Object { $_.Trim() } | Where-Object { $_ }
    if ($parts.Count -eq 0) { throw 'keys 字段空' }

    $vks = @()
    foreach ($p in $parts) { $vks += (Resolve-Vk $p) }

    # 按顺序 down 所有键，停 30ms，再倒序 up——模拟人按组合键的物理时序
    foreach ($vk in $vks) {
        [HiliuUiaWin]::keybd_event([byte]$vk, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 20
    }
    Start-Sleep -Milliseconds 30
    for ($i = $vks.Count - 1; $i -ge 0; $i--) {
        [HiliuUiaWin]::keybd_event([byte]$vks[$i], 0, 0x0002, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 20
    }

    return @{ keys = $keys; vk_count = $vks.Count }
}

function Method-ScreenType($params) {
    if (-not $params.PSObject.Properties['text']) { throw 'screen_type 需要 text 参数' }
    $text = [string]$params.text
    if ($text.Length -eq 0) { return [ordered]@{ chars_typed = 0; total = 0 } }
    if ($text.Length -gt 1000) { throw 'screen_type text 过长（>1000 字符）——一次输入这么多通常意味着用错了工具，请拆分' }

    # 不会自己按 Enter——提交动作交给 global_hotkey({keys:'Enter'})。
    # 调用前由模型保证目标输入框已获得焦点（先 screen_click 点过去）。
    $sent = [HiliuUiaWin]::TypeUnicode($text)
    return [ordered]@{ chars_typed = $sent; total = $text.Length }
}

# ============ 全屏免打扰探测（presence_state） ============
#
# 给 main 端 src/main/system/presence.ts 用——判定当前是不是该让
# Hiliu 整体进入「隐身」状态（桌宠 hide + 推送阻断）。
# 任何非「2/3/4/6」的枚举都算 available——保守路线，避免误判封死功能。
function Method-PresenceState($params) {
    $raw = [HiliuUiaWin]::GetPresenceRaw()
    if ($raw -lt 0) { throw '调用 SHQueryUserNotificationState 失败' }
    $busy = ($raw -eq 2) -or ($raw -eq 3) -or ($raw -eq 4) -or ($raw -eq 6)
    return [ordered]@{
        state = $(if ($busy) { 'busy' } else { 'available' })
        raw   = $raw
    }
}

# ============ P0-3 OCR (Windows.Media.Ocr WinRT) ============
#
# 设计取舍：
# - 走 WinRT 而不是 Tesseract——Windows 10/11 自带 OCR 引擎，识别中英都不用安装
#   额外语言包就有英文，中文需要用户在 设置→时间和语言→语言 装 zh-CN 语言包。
# - PS 5.1 调 WinRT 三件套约束：
#   1) 类型必须用 [Type,Asm,ContentType=WindowsRuntime] 显式引用一次触发投影注册
#   2) IAsyncOperation<T> 没 await，靠 WindowsRuntimeSystemExtensions.AsTask 桥到 Task
#   3) WinRT 类型构造用 ::new() 即可（PS 5.0+ 支持）
# - 输入只接受文件路径——不接 base64：避免一张图 base64 600KB 撑爆 stdin 单行。
#   模型先 window_capture 落盘 → 用返回的 localPath 调 screen_ocr。

# 懒加载状态——避免 daemon 启动期就吃 WinRT 类型表注册的 200ms 开销
$script:OcrTypesLoaded = $false
$script:OcrAsTaskMethod = $null

function Initialize-OcrTypes {
    if ($script:OcrTypesLoaded) { return }
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    # 触发各 WinRT 命名空间的投影类型注册——第一次访问才会真正绑定
    $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]
    $null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType=WindowsRuntime]
    $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
    $null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
    $null = [Windows.Globalization.Language, Windows.Globalization, ContentType=WindowsRuntime]
    $null = [Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType=WindowsRuntime]
    $null = [Windows.Media.Ocr.OcrResult, Windows.Media.Ocr, ContentType=WindowsRuntime]

    # 找到 generic AsTask<T>(IAsyncOperation<T>) 重载——反射缓存一次后续复用
    $script:OcrAsTaskMethod = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and
        $_.IsGenericMethodDefinition -and
        $_.GetGenericArguments().Count -eq 1 -and
        $_.GetParameters().Count -eq 1 -and
        $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    } | Select-Object -First 1

    if (-not $script:OcrAsTaskMethod) {
        throw 'OCR 初始化失败：找不到 WindowsRuntimeSystemExtensions.AsTask<T> 反射入口'
    }
    $script:OcrTypesLoaded = $true
}

function Await-WinRTOp($op, [type]$resultType) {
    $task = $script:OcrAsTaskMethod.MakeGenericMethod($resultType).Invoke($null, @($op))
    return $task.GetAwaiter().GetResult()
}

function Method-ScreenOcr($params) {
    $path = [string]$params.path
    if (-not $path) { throw 'screen_ocr 缺 path 参数' }
    if (-not (Test-Path -LiteralPath $path)) { throw "路径不存在：$path" }

    $lang = $null
    if ($params.PSObject.Properties['lang'] -and $params.lang) {
        $lang = [string]$params.lang
    }

    # 锚点解析——bbox 默认是图像坐标（0,0=图左上）；给了 hwnd 就主动加上窗口屏幕位置，
    # 让 bbox 直接是屏幕坐标，模型 screen_click 时不用再手算偏移。
    # 适配 window_capture(scope='full-window')——那种截图的 (0,0) 正好是 GetWindowRect.{Left,Top}。
    # client 区截图模型自己不要传 hwnd（差一个边框 + 标题栏的偏移）。
    $anchorX = 0
    $anchorY = 0
    $coordSystem = 'image'
    if ($params.PSObject.Properties['hwnd'] -and $params.hwnd) {
        $hwnd = [IntPtr][int]$params.hwnd
        $rect = New-Object HiliuRect
        if ([HiliuUiaWin]::GetWindowRect($hwnd, [ref]$rect)) {
            $anchorX = $rect.Left
            $anchorY = $rect.Top
            $coordSystem = 'screen'
        } else {
            throw "无法获取窗口 hwnd=$($params.hwnd) 的屏幕位置——窗口可能已关闭"
        }
    }

    Initialize-OcrTypes

    # ProviderPath 拿到去掉 PS 前缀的真实 Win32 路径
    $absPath = (Resolve-Path -LiteralPath $path).ProviderPath

    # 1) 文件 → 流
    $fileOp = [Windows.Storage.StorageFile]::GetFileFromPathAsync($absPath)
    $file = Await-WinRTOp $fileOp ([Windows.Storage.StorageFile])
    $streamOp = $file.OpenAsync([Windows.Storage.FileAccessMode]::Read)
    $stream = Await-WinRTOp $streamOp ([Windows.Storage.Streams.IRandomAccessStream])

    try {
        # 2) BitmapDecoder → SoftwareBitmap
        $decoderOp = [Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)
        $decoder = Await-WinRTOp $decoderOp ([Windows.Graphics.Imaging.BitmapDecoder])
        $sbOp = $decoder.GetSoftwareBitmapAsync()
        $softwareBitmap = Await-WinRTOp $sbOp ([Windows.Graphics.Imaging.SoftwareBitmap])

        # 3) OcrEngine——auto = 跟用户系统首选语言；显式 lang 则强行用那个
        $engine = $null
        if ($lang) {
            try {
                $langObj = [Windows.Globalization.Language]::new($lang)
            } catch {
                throw "不支持的语言代码：$lang（应为 BCP-47 格式如 zh-CN/en-US）"
            }
            $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($langObj)
            if (-not $engine) {
                throw "系统未安装 OCR 语言包：$lang。在 Windows 设置→时间和语言→语言 里安装。"
            }
        } else {
            $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
            if (-not $engine) {
                throw '系统没有任何可用 OCR 语言包。在 Windows 设置→时间和语言→语言 里至少装一种（中文用 zh-CN）。'
            }
        }
        $usedLang = $engine.RecognizerLanguage.LanguageTag

        # 4) 识别
        $ocrOp = $engine.RecognizeAsync($softwareBitmap)
        $result = Await-WinRTOp $ocrOp ([Windows.Media.Ocr.OcrResult])

        # 5) 行级 bounding box——OcrLine 自身没有 box，要从 Words 取并集
        $lines = New-Object System.Collections.ArrayList
        foreach ($line in $result.Lines) {
            $minX = [double]::MaxValue; $minY = [double]::MaxValue
            $maxX = [double]::MinValue; $maxY = [double]::MinValue
            $hasBox = $false
            foreach ($word in $line.Words) {
                $box = $word.BoundingRect
                if ($box.X -lt $minX) { $minX = $box.X }
                if ($box.Y -lt $minY) { $minY = $box.Y }
                $right = $box.X + $box.Width
                $bottom = $box.Y + $box.Height
                if ($right -gt $maxX) { $maxX = $right }
                if ($bottom -gt $maxY) { $maxY = $bottom }
                $hasBox = $true
            }
            $entry = [ordered]@{ text = $line.Text }
            if ($hasBox) {
                $entry.x = [int]$minX + $anchorX
                $entry.y = [int]$minY + $anchorY
                $entry.w = [int]($maxX - $minX)
                $entry.h = [int]($maxY - $minY)
            }
            [void]$lines.Add($entry)
        }

        return [ordered]@{
            text = $result.Text
            lang = $usedLang
            lineCount = $lines.Count
            coordSystem = $coordSystem
            anchor = [ordered]@{ x = $anchorX; y = $anchorY }
            lines = $lines
        }
    } finally {
        if ($stream) { $stream.Dispose() }
    }
}

# ============ P1-1 应用启动器 ============
#
# 思路：扫两个 Start Menu 目录所有 .lnk + Get-StartApps 返回的 UWP，
# 统一成 {name, type, target, args} 列表；模糊匹配按打分排序：
#   完全匹配（不区分大小写）= 100；前缀匹配 = 80；包含 = 60；都不中 = 0
# 60s 缓存——开机后第一次扫 ~200ms（用户机器约 200-500 个 .lnk），后续命中缓存。

$script:appCache = $null
$script:appCacheAt = [DateTime]::MinValue

function Get-AllInstalledApps {
    $now = Get-Date
    if ($script:appCache -and ($now - $script:appCacheAt).TotalSeconds -lt 60) {
        return $script:appCache
    }
    $list = New-Object System.Collections.ArrayList

    # 1) Start Menu .lnk——传统桌面应用
    $dirs = @(
        [Environment]::GetFolderPath('CommonStartMenu'),
        [Environment]::GetFolderPath('StartMenu')
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }

    $shell = New-Object -ComObject WScript.Shell
    try {
        foreach ($dir in $dirs) {
            $lnks = Get-ChildItem -LiteralPath $dir -Recurse -Filter '*.lnk' -ErrorAction SilentlyContinue
            foreach ($lnk in $lnks) {
                try {
                    $sc = $shell.CreateShortcut($lnk.FullName)
                    $target = $sc.TargetPath
                    if (-not $target) { continue }
                    # 跳过 uninstaller / readme / help 这类噪音
                    $baseName = [IO.Path]::GetFileNameWithoutExtension($lnk.Name)
                    if ($baseName -match '^(?i)(uninstall|卸载|readme|help|帮助|说明)') { continue }
                    [void]$list.Add([ordered]@{
                        name = $baseName
                        type = 'lnk'
                        target = $target
                        args = $sc.Arguments
                        workingDir = $sc.WorkingDirectory
                    })
                } catch { }
            }
        }
    } finally {
        # WScript.Shell COM 对象释放——不释放会泄露
        [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)
    }

    # 2) UWP / Store apps——Get-StartApps 返回 Name + AppID
    try {
        $uwp = Get-StartApps -ErrorAction SilentlyContinue
        if ($uwp) {
            foreach ($app in $uwp) {
                # 已在 .lnk 里出现的同名跳过——避免重复
                $name = [string]$app.Name
                if (-not $name) { continue }
                $dup = $false
                foreach ($x in $list) { if ($x.name -ieq $name) { $dup = $true; break } }
                if ($dup) { continue }
                [void]$list.Add([ordered]@{
                    name = $name
                    type = 'uwp'
                    target = "shell:AppsFolder\$($app.AppID)"
                    args = ''
                    workingDir = ''
                })
            }
        }
    } catch { }

    $script:appCache = $list
    $script:appCacheAt = $now
    return $list
}

function Find-AppMatches([string]$query, [int]$limit = 5) {
    $apps = Get-AllInstalledApps
    if (-not $query) { return @() }
    $q = $query.Trim().ToLower()
    $scored = New-Object System.Collections.ArrayList
    foreach ($app in $apps) {
        $name = [string]$app.name
        $lname = $name.ToLower()
        $score = 0
        if ($lname -eq $q) { $score = 100 }
        elseif ($lname.StartsWith($q)) { $score = 80 }
        elseif ($lname.Contains($q)) { $score = 60 }
        if ($score -gt 0) {
            [void]$scored.Add([ordered]@{ score = $score; app = $app })
        }
    }
    return $scored | Sort-Object -Property @{Expression='score';Descending=$true}, @{Expression={$_.app.name.Length}} | Select-Object -First $limit
}

function Method-LaunchApp($params) {
    $query = [string]$params.query
    if (-not $query) { throw 'launch_app 缺 query 参数' }
    $matches = Find-AppMatches $query 5
    if (-not $matches -or $matches.Count -eq 0) {
        throw "找不到匹配「$query」的应用。试试用 list_installed_apps 看有哪些。"
    }
    $best = $matches[0].app
    # 多个候选且最高分不是完全匹配 → 提示模糊
    $ambiguous = $matches.Count -gt 1 -and $matches[0].score -lt 100
    try {
        if ($best.type -eq 'uwp') {
            Start-Process -FilePath 'explorer.exe' -ArgumentList $best.target -ErrorAction Stop
        } elseif ($best.args) {
            Start-Process -FilePath $best.target -ArgumentList $best.args -WorkingDirectory $best.workingDir -ErrorAction Stop
        } else {
            $wd = if ($best.workingDir) { $best.workingDir } else { Split-Path -Parent $best.target }
            Start-Process -FilePath $best.target -WorkingDirectory $wd -ErrorAction Stop
        }
    } catch {
        throw "启动失败：$($_.Exception.Message)（target=$($best.target)）"
    }
    $candidates = New-Object System.Collections.ArrayList
    foreach ($m in $matches) {
        [void]$candidates.Add([ordered]@{ name = $m.app.name; type = $m.app.type; score = $m.score })
    }
    return [ordered]@{
        launched = [ordered]@{ name = $best.name; type = $best.type; target = $best.target }
        ambiguous = $ambiguous
        candidates = $candidates
    }
}

function Method-ListInstalledApps($params) {
    $apps = Get-AllInstalledApps
    $filter = if ($params.PSObject.Properties['filter']) { [string]$params.filter } else { '' }
    $limit = if ($params.PSObject.Properties['limit']) { [int]$params.limit } else { 50 }
    if ($limit -le 0) { $limit = 50 }
    if ($limit -gt 500) { $limit = 500 }
    $filtered = if ($filter) {
        $matches = Find-AppMatches $filter $limit
        $matches | ForEach-Object { $_.app }
    } else {
        $apps | Select-Object -First $limit
    }
    $items = New-Object System.Collections.ArrayList
    foreach ($a in $filtered) {
        [void]$items.Add([ordered]@{ name = $a.name; type = $a.type })
    }
    return [ordered]@{
        total = $apps.Count
        returned = $items.Count
        filter = $filter
        items = $items
    }
}

# ============ P1-2 窗口管理扩展 ============
#
# 现成 P/Invoke：SetWindowPos / ShowWindow / PostMessage / GetClassName / GetWindowRect
# ShowWindow 命令码：
#   SW_HIDE=0 / SW_SHOWNORMAL=1 / SW_SHOWMINIMIZED=2 / SW_SHOWMAXIMIZED=3
#   SW_SHOW=5 / SW_MINIMIZE=6 / SW_RESTORE=9
# WM_CLOSE=0x0010 — 优雅关窗（让应用走自己的退出流程，比 TerminateProcess 安全）

function Resolve-Hwnd($params) {
    if (-not $params.PSObject.Properties['hwnd'] -or -not $params.hwnd) {
        throw '缺 hwnd 参数（用 list_windows 拿）'
    }
    return [IntPtr][int]$params.hwnd
}

function Method-WindowMove($params) {
    $hwnd = Resolve-Hwnd $params
    $x = [int]$params.x
    $y = [int]$params.y
    # SWP_NOSIZE=0x0001, SWP_NOZORDER=0x0004, SWP_NOACTIVATE=0x0010
    $flags = 0x0001 -bor 0x0004 -bor 0x0010
    if (-not [HiliuUiaWin]::SetWindowPos($hwnd, [IntPtr]::Zero, $x, $y, 0, 0, $flags)) {
        throw '移动窗口失败（SetWindowPos 返回 false）'
    }
    return [ordered]@{ hwnd = "0x$($hwnd.ToInt64().ToString('x'))"; x = $x; y = $y }
}

function Method-WindowResize($params) {
    $hwnd = Resolve-Hwnd $params
    $w = [int]$params.width
    $h = [int]$params.height
    if ($w -le 0 -or $h -le 0) { throw 'width/height 必须是正整数' }
    # SWP_NOMOVE=0x0002, SWP_NOZORDER=0x0004, SWP_NOACTIVATE=0x0010
    $flags = 0x0002 -bor 0x0004 -bor 0x0010
    if (-not [HiliuUiaWin]::SetWindowPos($hwnd, [IntPtr]::Zero, 0, 0, $w, $h, $flags)) {
        throw '调整窗口大小失败（SetWindowPos 返回 false）'
    }
    return [ordered]@{ hwnd = "0x$($hwnd.ToInt64().ToString('x'))"; width = $w; height = $h }
}

function Method-WindowState($params) {
    $hwnd = Resolve-Hwnd $params
    $action = [string]$params.action
    $cmd = switch ($action) {
        'minimize' { 6 }   # SW_MINIMIZE
        'maximize' { 3 }   # SW_SHOWMAXIMIZED
        'restore'  { 9 }   # SW_RESTORE
        'hide'     { 0 }   # SW_HIDE
        'show'     { 5 }   # SW_SHOW
        default    { throw "未知 action：$action（应为 minimize/maximize/restore/hide/show）" }
    }
    [void][HiliuUiaWin]::ShowWindow($hwnd, $cmd)
    return [ordered]@{ hwnd = "0x$($hwnd.ToInt64().ToString('x'))"; action = $action }
}

function Method-WindowClose($params) {
    $hwnd = Resolve-Hwnd $params
    # WM_CLOSE = 0x0010；PostMessage 异步发送，应用走自己的退出流程
    [void][HiliuUiaWin]::PostMessage($hwnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
    return [ordered]@{ hwnd = "0x$($hwnd.ToInt64().ToString('x'))"; signal = 'WM_CLOSE' }
}

# ============ P2 系统状态 ============

function Method-SetVolume($params) {
    # 走 [HiliuAudio]::Xxx 静态方法——绕开 PS 5.1 的 IDispatch-only COM 调用机制。
    # 详见 HiliuAudio 类上方注释。
    if ($params.PSObject.Properties['mute']) {
        $cur = [HiliuAudio]::SetMuteState([bool]$params.mute)
        return [ordered]@{ mute = $cur }
    }
    if (-not $params.PSObject.Properties['percent']) {
        throw 'set_volume 需要 percent (0-100) 或 mute (bool) 参数'
    }
    $cur = [HiliuAudio]::SetVolumePercent([int]$params.percent)
    return [ordered]@{ percent = $cur }
}

function Method-GetVolume($params) {
    return [ordered]@{
        percent = [HiliuAudio]::GetVolumePercent()
        mute = [HiliuAudio]::GetMuteState()
    }
}

function Method-GetWifiStatus($params) {
    # netsh wlan show interfaces：返回当前 WLAN 接口的连接状态、SSID、信号强度
    # 不依赖 PowerShell module（NetWlan*），那个在 Win10 家庭版有时缺
    $output = & netsh wlan show interfaces 2>&1
    $exit = $LASTEXITCODE
    if ($exit -ne 0) {
        # 没装无线网卡 / 服务未启动 → 返回 connected=false 而不是 throw
        return [ordered]@{
            connected = $false
            reason = 'netsh wlan 失败：' + ($output -join ' ').Trim()
        }
    }
    $text = $output -join "`n"
    # 中英文系统输出关键字都吃——netsh 跟系统语言走
    $state = ''
    $ssid = ''
    $signal = $null
    foreach ($line in $output) {
        $l = [string]$line
        if ($l -match '^\s*(?:State|状态)\s*[:：]\s*(.+?)\s*$') { $state = $matches[1] }
        elseif ($l -match '^\s*SSID\s*[:：]\s*(.+?)\s*$' -and -not ($l -match 'BSSID')) { $ssid = $matches[1] }
        elseif ($l -match '^\s*(?:Signal|信号)\s*[:：]\s*(\d+)') { $signal = [int]$matches[1] }
    }
    $connected = ($state -match '(?i)connected|已连接')
    return [ordered]@{
        connected = $connected
        state = $state
        ssid = $ssid
        signalPercent = $signal
    }
}

# ============ 主循环 ============

# 启动信号——Node 端拿到这行 banner 才认为 daemon ready
$banner = [ordered]@{ ready = $true; pid = $PID; protocol = 'hiliu-uia/1' }
[Console]::Out.WriteLine((ConvertTo-Json $banner -Compress))
[Console]::Out.Flush()

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }  # stdin EOF -> Node 侧关闭，正常退出
    $line = $line.Trim()
    if (-not $line) { continue }

    $req = $null
    try { $req = ConvertFrom-Json $line } catch {
        Reply-Err 0 "JSON 解析失败：$($_.Exception.Message)"
        continue
    }
    $id = if ($null -ne $req.id) { $req.id } else { 0 }
    $method = [string]$req.method

    try {
        $result = switch ($method) {
            'ping'         { Method-Ping $req.params }
            'list_windows' { Method-ListWindows $req.params }
            'snapshot'     { Method-Snapshot $req.params }
            'inspect'      { Method-Inspect $req.params }
            'act'          { Method-Act $req.params }
            'focus_window' { Method-FocusWindow $req.params }
            'capture'      { Method-Capture $req.params }
            'screen_click'  { Method-ScreenClick $req.params }
            'screen_move'   { Method-ScreenMove $req.params }
            'screen_scroll' { Method-ScreenScroll $req.params }
            'screen_drag'   { Method-ScreenDrag $req.params }
            'global_hotkey' { Method-GlobalHotkey $req.params }
            'screen_type'   { Method-ScreenType $req.params }
            'presence_state' { Method-PresenceState $req.params }
            'screen_ocr'   { Method-ScreenOcr $req.params }
            'launch_app'         { Method-LaunchApp $req.params }
            'list_installed_apps' { Method-ListInstalledApps $req.params }
            'window_move'        { Method-WindowMove $req.params }
            'window_resize'      { Method-WindowResize $req.params }
            'window_state'       { Method-WindowState $req.params }
            'window_close'       { Method-WindowClose $req.params }
            'set_volume'         { Method-SetVolume $req.params }
            'get_volume'         { Method-GetVolume $req.params }
            'get_wifi_status'    { Method-GetWifiStatus $req.params }
            'shutdown'     {
                Reply-Ok $id 'bye'
                exit 0
            }
            default        { throw "未知方法：$method" }
        }
        Reply-Ok $id $result
    } catch {
        Reply-Err $id $_.Exception.Message
    }
}
